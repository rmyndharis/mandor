import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { addWorktree } from "../src/git.ts";
import { projectDir, projectIdFor } from "../src/home.ts";
import { checkClonePath, emptyProjectConfig, loadProjectConfig, provisionWorktree, type ProjectConfig } from "../src/provision.ts";
import { GRADLE_ADD_DIRS } from "../src/spikes.ts";
import { temp, tempHome, tempRepo } from "./helpers.ts";

const home = tempHome();
const launcher = join(import.meta.dirname, "..", "bin", "mandor");
const setupLog = join(home, "logs", "setup-task.log");

const must = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

// A repository whose committed .gitignore ignores build/, *.bin and local.properties, holding the given files
// uncommitted, and a fresh worktree of it under the mandor home, where mandor puts its worktrees (worktree git
// calls refuse others). The worktree's base commit also tracks base's files and links, which the main checkout, back
// on main, does not: a goal tip need not match the main checkout.
function fixture(files: Record<string, string> = {}, base: { files?: Record<string, string>; links?: Record<string, string> } = {}): { repo: string; wt: string } {
  const repo = tempRepo();
  writeFileSync(join(repo, ".gitignore"), "build/\n*.bin\nlocal.properties\n");
  must(repo, "add", ".gitignore");
  must(repo, "commit", "-q", "-m", "Ignore build outputs");
  const tracked = [...Object.keys(base.files ?? {}), ...Object.keys(base.links ?? {})];
  if (tracked.length > 0) {
    must(repo, "checkout", "-q", "-b", "base");
    for (const [p, body] of Object.entries(base.files ?? {})) {
      mkdirSync(dirname(join(repo, p)), { recursive: true });
      writeFileSync(join(repo, p), body);
    }
    for (const [p, target] of Object.entries(base.links ?? {})) {
      mkdirSync(dirname(join(repo, p)), { recursive: true });
      symlinkSync(target, join(repo, p));
    }
    must(repo, "add", "-f", "--", ...tracked);
    must(repo, "commit", "-q", "-m", "Track base files");
    must(repo, "checkout", "-q", "main");
  }
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  const wt = join(mkdtempSync(join(home, "wt-")), "task");
  addWorktree(repo, wt, "wip/task", tracked.length > 0 ? "base" : "HEAD");
  return { repo, wt };
}

// A directory outside every repository and worktree, holding one file that provisioning must never touch.
function outsideDir(): string {
  const dir = temp("mandor-outside-");
  writeFileSync(join(dir, "precious.txt"), "user data\n");
  return dir;
}

const config = (clone: string[], more: Partial<ProjectConfig> = {}): ProjectConfig => ({ ...emptyProjectConfig(), clone, ...more });
const listing = (dir: string) => readdirSync(dir).sort();
const projectFile = (repo: string) => join(projectDir(projectIdFor(repo)), "project.json");
const cli = (repo: string, ...args: string[]) => spawnSync(launcher, ["project", "setup", ...args], { cwd: repo, encoding: "utf8" });

test("an ignored directory holding a.keystore, .env and CLAUDE.md clones everything else", () => {
  const { repo, wt } = fixture({ "build/a.keystore": "k", "build/.env": "e", "build/CLAUDE.md": "c", "build/out.txt": "o", "build/sub/deep.txt": "d" });
  const r = provisionWorktree(repo, wt, config(["build"]));
  assert.deepEqual(r, { cloned: 2, skipped: ["build/.env", "build/CLAUDE.md", "build/a.keystore"] });
  assert.deepEqual(listing(join(wt, "build")), ["out.txt", "sub"]);
  assert.equal(readFileSync(join(wt, "build/sub/deep.txt"), "utf8"), "d");
});

test("a clean ignored directory is cloned with one cp", (t) => {
  const { repo, wt } = fixture({ "build/gen/a.txt": "a", "build/gen/sub/b.txt": "b", "build/other.txt": "x" });
  const spawn = t.mock.method(childProcess, "spawnSync");
  // The trailing slash is dropped: BSD cp would copy the directory's contents instead of the directory.
  const r = provisionWorktree(repo, wt, config(["build/gen/"]));
  const cps = spawn.mock.calls.filter((c) => c.arguments[0] === "/bin/cp").map((c) => c.arguments[1]);
  assert.deepEqual(cps, [["-c", "-R", join(repo, "build/gen"), `${join(wt, "build")}/`]]);
  assert.deepEqual(r, { cloned: 2, skipped: [] });
  assert.deepEqual(listing(join(wt, "build")), ["gen"]);
  assert.equal(readFileSync(join(wt, "build/gen/sub/b.txt"), "utf8"), "b");
  assert.equal(statSync(join(wt, "build")).mode & 0o777, 0o700);
});

test("a file clone path lands in its tracked parent, and a missing parent is created at 0700", (t) => {
  const { repo, wt } = fixture({ "android/local.properties": "sdk.dir=/x\n", "build/config.json": "{}" }, { files: { "android/build.gradle": "g" } });
  const spawn = t.mock.method(childProcess, "spawnSync");
  const r = provisionWorktree(repo, wt, config(["android/local.properties", "build/config.json"]));
  assert.deepEqual(r, { cloned: 2, skipped: [] });
  const cps = spawn.mock.calls.filter((c) => c.arguments[0] === "/bin/cp").map((c) => c.arguments[1]);
  assert.deepEqual(cps, [
    ["-c", "-R", join(repo, "android/local.properties"), `${join(wt, "android")}/`],
    ["-c", "-R", join(repo, "build/config.json"), `${join(wt, "build")}/`],
  ]);
  assert.deepEqual(listing(join(wt, "android")), ["build.gradle", "local.properties"]);
  assert.equal(readFileSync(join(wt, "android/local.properties"), "utf8"), "sdk.dir=/x\n");
  assert.equal(statSync(join(wt, "build")).mode & 0o777, 0o700);
});

test("clone paths are deduplicated, and one inside another is refused", () => {
  const { repo, wt } = fixture({ "build/a.txt": "a", "build/.env": "s", "build/sub/b.txt": "b" });
  symlinkSync("a.txt", join(repo, "build/link"));
  // Each spelling of build is cloned once: a second pass would meet the files and the link the first one made.
  assert.deepEqual(provisionWorktree(repo, wt, config(["build", "build/", "./build"])), { cloned: 3, skipped: ["build/.env"] });
  const other = fixture({ "build/sub/b.txt": "b" });
  assert.throws(() => provisionWorktree(other.repo, other.wt, config(["build/sub", "build"])),
    /^Error: refusing clone path build\/sub: it lies inside clone path build$/);
  assert.equal(existsSync(join(other.wt, "build")), false);
  const r = cli(repo, "--clone", "build", "--clone", "build/", "--clone", "./build");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).clone, ["build"]);
  assert.match(cli(repo, "--clone", "build/sub", "--clone", "build").stderr, /refusing clone path build\/sub: it lies inside clone path build/);
});

test("--clone _docs refused", () => {
  const repo = tempRepo();
  const r = cli(repo, "--clone", "_docs");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing clone path _docs: /);
  assert.equal(r.stdout, "");
  assert.equal(existsSync(projectFile(repo)), false);
});

test("--clone .claude refused", () => {
  const repo = tempRepo();
  const r = cli(repo, "--clone", ".claude/");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing clone path \.claude\/: /);
  assert.equal(r.stdout, "");
  assert.equal(existsSync(projectFile(repo)), false);
});

test("clone paths are normalized, and refused outside the repository, in .git, or when denied or agent paths", () => {
  assert.equal(checkClonePath("build/", []), "build");
  assert.equal(checkClonePath("./build//gen/", []), "build/gen");
  const refused = ["", ".", "/", "/etc", "../x", "a/../b", ".git", ".GIT/hooks", "_DOCS", "x/_docs/", ".Claude/skills", "x/.CLAUDE",
    "Claude.md", "app/.ENV", "app/.env.local", "release.KEYSTORE", "app/upload.jks", "android/Signing.properties", "sub/.cursor",
    ".github/instructions", "zcode.json", "gemini.local.md"];
  for (const p of refused) assert.throws(() => checkClonePath(p, []), /^Error: refusing clone path /, p);
  assert.throws(() => checkClonePath("certs/x.P12", ["**/*.p12"]), /^Error: refusing clone path certs\/x\.P12: /);
});

test("a directory with tracked files refused", () => {
  const { repo, wt } = fixture({ "assets/logo.txt": "l", "assets/blob.bin": "b" });
  must(repo, "add", "assets/logo.txt");
  must(repo, "commit", "-q", "-m", "Add logo");
  assert.throws(() => provisionWorktree(repo, wt, config(["assets"])), /^Error: refusing clone path assets: it holds tracked files$/);
  assert.equal(existsSync(join(wt, "assets")), false);
});

test("a non-ignored untracked path refused", () => {
  const { repo, wt } = fixture({ "build/a.txt": "a", "notes/todo.txt": "t", "notes/x.bin": "b" });
  // Every path is checked before any is copied, so the refusal leaves build/ uncloned too.
  assert.throws(() => provisionWorktree(repo, wt, config(["build", "notes"])), /^Error: refusing clone path notes: it holds untracked files that are not ignored$/);
  assert.equal(existsSync(join(wt, "build")), false);
});

test("symlinks recreated", () => {
  // The keystore makes provisioning copy file by file, where cp would follow a link and copy its target's bytes.
  const { repo, wt } = fixture({ "build/a.txt": "a", "build/a.keystore": "k", "build/sub/c.txt": "c" });
  const links = { "build/rel": "a.txt", "build/abs": "/etc/hosts", "build/dangling": "missing.txt", "build/dirlink": "sub" };
  for (const [p, target] of Object.entries(links)) symlinkSync(target, join(repo, p));
  const r = provisionWorktree(repo, wt, config(["build"]));
  assert.deepEqual(r, { cloned: 6, skipped: ["build/a.keystore"] });
  for (const [p, target] of Object.entries(links)) assert.equal(readlinkSync(join(wt, p)), target, p);
  assert.equal(readFileSync(join(wt, "build/sub/c.txt"), "utf8"), "c");
});

test("a symlink that leads to a denied or agent file is skipped", () => {
  const { repo, wt } = fixture({ ".env": "secret", "AGENTS.md": "a", "android/signing.properties": "s", "build/keep.txt": "k" });
  symlinkSync(".env", join(repo, "innocent"));
  const links = { "build/env": "../.env", "build/abs": join(repo, "android/signing.properties"), "build/chain": "../innocent", "build/agent": "../AGENTS.md", "build/ok": "keep.txt" };
  for (const [p, target] of Object.entries(links)) symlinkSync(target, join(repo, p));
  const r = provisionWorktree(repo, wt, config(["build"]));
  assert.deepEqual(r, { cloned: 2, skipped: ["build/abs", "build/agent", "build/chain", "build/env"] });
  assert.deepEqual(listing(join(wt, "build")), ["keep.txt", "ok"]);
  assert.equal(readlinkSync(join(wt, "build/ok")), "keep.txt");
});

test("a link that lands on a directory at, above or inside the main checkout is skipped", () => {
  const elsewhere = outsideDir();
  const { repo, wt } = fixture({ "android/signing.properties": "storePassword=hunter2", "build/a.txt": "a", "build/sub/c.txt": "c" });
  // signing.properties is denied by name, but a link to its directory would let the worktree read it all the same.
  const links = { "build/cfg": join(repo, "android"), "build/root": repo, "build/up": dirname(repo), "build/slash": "/",
    "build/sdk": elsewhere, "build/rel": "../android", "build/inner": "sub" };
  for (const [p, target] of Object.entries(links)) symlinkSync(target, join(repo, p));
  const r = provisionWorktree(repo, wt, config(["build"]));
  assert.deepEqual(r, { cloned: 5, skipped: ["build/cfg", "build/root", "build/slash", "build/up"] });
  // Recreated, ../android lands in the worktree, not the main checkout; a directory elsewhere is kept, unchecked.
  assert.deepEqual(listing(join(wt, "build")), ["a.txt", "inner", "rel", "sdk", "sub"]);
  assert.equal(readFileSync(join(wt, "build/sdk/precious.txt"), "utf8"), "user data\n");
});

test("case variants and nested denied or agent files are skipped", () => {
  const denied = ["build/A.KEYSTORE", "build/release.JKS", "build/app/Signing.Properties", "build/x/.ENV", "build/x/y/.env.Local",
    "build/deep/Claude.md", "build/deep/.Claude/settings.json", "build/deep/.cursor/rules", "build/_DOCS/plan.md",
    "build/x/.github/instructions/a.md", "build/claude.local.md", "build/z/my.p12"];
  const { repo, wt } = fixture(Object.fromEntries([...denied, "build/keep.txt", "build/x/y/keep.txt"].map((p) => [p, "x"])));
  const r = provisionWorktree(repo, wt, config(["build"], { deny: ["**/*.P12"] }));
  assert.equal(r.cloned, 2);
  assert.deepEqual([...r.skipped].sort(), [...denied].sort());
  assert.deepEqual(listing(join(wt, "build")), ["keep.txt", "x"]);
  assert.deepEqual(listing(join(wt, "build/x")), ["y"]);
  assert.deepEqual(listing(join(wt, "build/x/y")), ["keep.txt"]);
});

test("a directory named like a denied file is skipped with everything under it", () => {
  const denied = ["build/.env/prod", "build/cfg/.env.d/db.env", "build/old.keystore/inner.txt", "build/x/secrets/token.txt"];
  const { repo, wt } = fixture(Object.fromEntries([...denied, "build/keep.txt", "build/cfg/keep.txt"].map((p) => [p, "x"])));
  const r = provisionWorktree(repo, wt, config(["build"], { deny: ["**/secrets"] }));
  assert.equal(r.cloned, 2);
  assert.deepEqual([...r.skipped].sort(), [...denied].sort());
  assert.deepEqual(listing(join(wt, "build")), ["cfg", "keep.txt"]);
  assert.deepEqual(listing(join(wt, "build/cfg")), ["keep.txt"]);
  assert.throws(() => checkClonePath("app/.env/sub", []), /^Error: refusing clone path app\/\.env\/sub: /);
  assert.throws(() => checkClonePath("app/.env.local", []), /^Error: refusing clone path app\/\.env\.local: /);
  assert.equal(checkClonePath("app/.env.example", []), "app/.env.example");
  assert.throws(() => checkClonePath("x/secrets/a", ["**/secrets"]), /^Error: refusing clone path x\/secrets\/a: /);
});

test("file-by-file copies run one cp per destination directory, in batches", (t) => {
  const many = Array.from({ length: 300 }, (_, i) => `build/many/f${i}.txt`);
  const { repo, wt } = fixture(Object.fromEntries([...many, "build/one/a.txt", "build/.env"].map((p) => [p, p])));
  const spawn = t.mock.method(childProcess, "spawnSync");
  const r = provisionWorktree(repo, wt, config(["build"]));
  assert.deepEqual(r, { cloned: 301, skipped: ["build/.env"] });
  const cps = spawn.mock.calls.filter((c) => c.arguments[0] === "/bin/cp").map((c) => c.arguments[1] as string[]);
  assert.deepEqual(cps.map((a) => [a.length - 2, a.at(-1)]), [[256, `${join(wt, "build/many")}/`], [44, `${join(wt, "build/many")}/`], [1, `${join(wt, "build/one")}/`]]);
  assert.equal(readdirSync(join(wt, "build/many")).length, 300);
  assert.equal(readFileSync(join(wt, "build/many/f299.txt"), "utf8"), "build/many/f299.txt");
});

test("a nested repository inside a cloned path is skipped, as git never lists its files", () => {
  const { repo, wt } = fixture({ "build/a.txt": "a", "build/vendor/lib/.env": "secret", "build/vendor/lib/code.c": "c" });
  must(join(repo, "build/vendor/lib"), "init", "-q");
  const r = provisionWorktree(repo, wt, config(["build"]));
  assert.deepEqual(r, { cloned: 1, skipped: ["build/vendor/lib/"] });
  assert.deepEqual(listing(join(wt, "build")), ["a.txt"]);
});

test("entries git never lists are never copied, and force file-by-file copying", (t) => {
  // git lists no entry named .git in any case, nor anything under one that is no repository, nor a FIFO, so a single
  // cp of build/ would copy all of them unchecked.
  const { repo, wt } = fixture({ ".env": "secret", "build/a.txt": "a", "build/w/keep.txt": "k", "build/w/.git": "gitdir: /nowhere\n",
    "build/x/keep.txt": "k", "build/x/.git/CLAUDE.md": "c", "build/x/.git/signing.properties": "s", "build/y/keep.txt": "k",
    "build/z/.GIT/AGENTS.md": "a" });
  symlinkSync(join(repo, ".env"), join(repo, "build/y/.git"));
  execFileSync("mkfifo", [join(repo, "build/fifo")]);
  const spawn = t.mock.method(childProcess, "spawnSync");
  const r = provisionWorktree(repo, wt, config(["build"]));
  assert.deepEqual(r, { cloned: 4, skipped: ["build/fifo", "build/w/.git", "build/x/.git/", "build/y/.git", "build/z/.GIT/"] });
  const cps = spawn.mock.calls.filter((c) => c.arguments[0] === "/bin/cp").map((c) => c.arguments[1] as string[]);
  assert.equal(cps.filter((a) => a.includes("-R")).length, 0);
  // z held nothing but its .GIT, so nothing in it is recreated.
  assert.deepEqual(listing(join(wt, "build")), ["a.txt", "w", "x", "y"]);
  for (const d of ["w", "x", "y"]) assert.deepEqual(listing(join(wt, "build", d)), ["keep.txt"], d);
});

test("empty directories are cloned by the single cp, and do not count as entries git left out", (t) => {
  const { repo, wt } = fixture({ "build/a.txt": "a", "build/sub/b.txt": "b" });
  for (const d of ["build/empty", "build/nest/deeper", "build/sub/inner"]) mkdirSync(join(repo, d), { recursive: true });
  const spawn = t.mock.method(childProcess, "spawnSync");
  const r = provisionWorktree(repo, wt, config(["build"]));
  assert.deepEqual(r, { cloned: 2, skipped: [] });
  const cps = spawn.mock.calls.filter((c) => c.arguments[0] === "/bin/cp").map((c) => c.arguments[1]);
  assert.deepEqual(cps, [["-c", "-R", join(repo, "build"), `${wt}/`]]);
  for (const d of ["build/empty", "build/nest/deeper", "build/sub/inner"]) assert.ok(statSync(join(wt, d)).isDirectory(), d);
});

test("file-by-file copying recreates the empty directories that hold no skipped entry", (t) => {
  // The FIFO is an entry git never lists, so it forces file-by-file copying, and is skipped.
  const { repo, wt } = fixture({ "build/a.txt": "a" });
  for (const d of ["build/empty", "build/nest/deeper", "build/pipes"]) mkdirSync(join(repo, d), { recursive: true });
  execFileSync("mkfifo", [join(repo, "build/pipes/fifo")]);
  const spawn = t.mock.method(childProcess, "spawnSync");
  const r = provisionWorktree(repo, wt, config(["build"]));
  assert.deepEqual(r, { cloned: 1, skipped: ["build/pipes/fifo"] });
  const cps = spawn.mock.calls.filter((c) => c.arguments[0] === "/bin/cp").map((c) => c.arguments[1] as string[]);
  assert.equal(cps.filter((a) => a.includes("-R")).length, 0);
  assert.deepEqual(listing(join(wt, "build")), ["a.txt", "empty", "nest"]);
  assert.deepEqual(listing(join(wt, "build/nest")), ["deeper"]);
  for (const d of ["build/empty", "build/nest/deeper"]) assert.deepEqual(listing(join(wt, d)), [], d);
});

test("names stored decomposed are matched with git's precomposed listing and cloned as stored", (t) => {
  // git reports names in NFC on macOS (core.precomposeUnicode), while readdir returns them as stored, here in NFD.
  const [file, dir] = ["caf\u00e9.txt", "r\u00e9s"].map((n) => n.normalize("NFD"));
  const { repo, wt } = fixture({ "build/a.txt": "a", [`build/${file}`]: "c", [`build/${dir}/x.txt`]: "x" });
  assert.ok(readdirSync(join(repo, "build")).includes(file), "stored decomposed");
  const spawn = t.mock.method(childProcess, "spawnSync");
  const r = provisionWorktree(repo, wt, config(["build"]));
  assert.deepEqual(r, { cloned: 3, skipped: [] });
  assert.equal(spawn.mock.calls.filter((c) => c.arguments[0] === "/bin/cp").length, 1);
  assert.deepEqual(listing(join(wt, "build")), ["a.txt", file, dir].sort());
  assert.equal(readFileSync(join(wt, "build", dir, "x.txt"), "utf8"), "x");
});

test("a path git lists nothing under is never copied", () => {
  // On a case-insensitive volume cp would find build/ under the name Build, and follow the link to reach build/sub.
  const { repo, wt } = fixture({ "build/.env": "secret", "build/sub/a.txt": "a" });
  symlinkSync("build", join(repo, "link"));
  const r = provisionWorktree(repo, wt, config(["Build", "link/sub"]));
  assert.deepEqual(r, { cloned: 0, skipped: [] });
  assert.deepEqual(listing(wt), [".git", ".gitignore", "README.md"]);
});

test("a different volume is refused, with the way out", (t) => {
  const { repo, wt } = fixture({ "build/a.txt": "a" });
  const real = fs.statSync;
  t.mock.method(fs, "statSync", ((p: string) => (p === wt ? { ...real(p), dev: real(p).dev + 1 } : real(p))) as any);
  const spawn = t.mock.method(childProcess, "spawnSync");
  assert.throws(() => provisionWorktree(repo, wt, config(["build"])), /^Error: refusing to provision .*: not on the same volume as .*; .*MANDOR_HOME must be on the repository's volume$/);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(existsSync(join(wt, "build")), false);
});

test("a different volume does not matter when no clone path is set", (t) => {
  const { repo, wt } = fixture({ "build/a.txt": "a" });
  const real = fs.statSync;
  t.mock.method(fs, "statSync", ((p: string) => (p === wt ? { ...real(p), dev: real(p).dev + 1 } : real(p))) as any);
  const spawn = t.mock.method(childProcess, "spawnSync");
  assert.deepEqual(provisionWorktree(repo, wt, config([])), { cloned: 0, skipped: [] });
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(existsSync(join(wt, "build")), false);
});

test("a destination that is not a clean mandor worktree of the repository is refused before anything is copied", () => {
  const { repo, wt } = fixture({ "build/a.txt": "a" });
  const other = fixture().repo; // a checkout outside the mandor home
  assert.throws(() => provisionWorktree(repo, other, config(["build"])), /not under the mandor home/);
  assert.equal(existsSync(join(other, "build")), false);
  writeFileSync(join(wt, "stray.txt"), "s");
  assert.throws(() => provisionWorktree(repo, wt, config(["build"])), /^Error: refusing to provision .*: it is not clean$/);
  assert.equal(existsSync(join(wt, "build")), false);
});

test("a link the worktree's base tracks on the way to a destination is refused before anything is written", () => {
  const outside = outsideDir();
  const cases: [string[], Record<string, string>, Record<string, string>, RegExp][] = [
    // One cp of build, where the base tracks build itself as a link.
    [["build"], { "build/a.txt": "a" }, { build: outside }, /: build already exists$/],
    // One cp of build/gen, through a link at its parent.
    [["build/gen"], { "build/gen/x.txt": "x" }, { build: outside }, /: build is a symlink or not a directory$/],
    // File by file (the .env forces it), into the linked directory.
    [["build"], { "build/a.txt": "a", "build/.env": "s" }, { build: outside }, /: build is a symlink or not a directory$/],
    // File by file, onto a link the base tracks at the destination file itself.
    [["build"], { "build/a.txt": "OVERWRITTEN", "build/.env": "s" }, { "build/a.txt": join(outside, "precious.txt") }, /: build\/a\.txt already exists$/],
  ];
  for (const [clone, files, links, refusal] of cases) {
    const { repo, wt } = fixture(files, { links });
    assert.throws(() => provisionWorktree(repo, wt, config(clone)), refusal, JSON.stringify(links));
    for (const [p, target] of Object.entries(links)) assert.equal(readlinkSync(join(wt, p)), target);
    assert.deepEqual(listing(outside), ["precious.txt"]);
    assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "user data\n");
  }
});

test("setup is spawned with stdin ignored, output to the log, a 30 minute timeout and SIGKILL", (t) => {
  const { repo, wt } = fixture();
  const spawn = t.mock.method(childProcess, "spawnSync");
  provisionWorktree(repo, wt, config([], { setup: "true" }));
  const calls = spawn.mock.calls.filter((c) => c.arguments[0] === "/bin/sh");
  assert.equal(calls.length, 1);
  type Options = { cwd: string; env: Record<string, string>; stdio: unknown[]; timeout: number; killSignal: string };
  const [, args, opts] = calls[0].arguments as unknown as [string, string[], Options];
  assert.deepEqual(args, ["-c", "true"]);
  assert.equal(opts.cwd, wt);
  assert.equal(opts.stdio[0], "ignore");
  assert.equal(typeof opts.stdio[1], "number");
  assert.equal(opts.stdio[2], opts.stdio[1]);
  assert.equal(opts.timeout, 30 * 60 * 1000);
  assert.equal(opts.killSignal, "SIGKILL");
  assert.equal(opts.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(opts.env.MANDOR_HOME, undefined);
});

test("setup runs in the worktree with the worker environment, logging to a file", () => {
  const { repo, wt } = fixture({ "build/a.txt": "a" });
  const setup = 'echo "marker-env prompt=$GIT_TERMINAL_PROMPT home=$MANDOR_HOME cwd=$(pwd)"; echo gen > build/gen.txt';
  provisionWorktree(repo, wt, config(["build"], { setup }));
  assert.equal(readFileSync(join(wt, "build/gen.txt"), "utf8"), "gen\n");
  assert.ok(readFileSync(setupLog, "utf8").includes(`marker-env prompt=0 home= cwd=${wt}\n`));
  assert.equal(statSync(setupLog).mode & 0o777, 0o600);
});

test("setup output that is not ignored fails", () => {
  const { repo, wt } = fixture({ "build/a.txt": "a" });
  assert.throws(() => provisionWorktree(repo, wt, config(["build"], { setup: "echo stray > stray.txt" })), /^Error: provisioning left untracked files$/);
});

test("a failing setup throws and points at its log", () => {
  const { repo, wt } = fixture();
  assert.throws(() => provisionWorktree(repo, wt, config([], { setup: "echo marker-fail >&2; exit 3" })),
    (e: Error) => e.message === `setup failed (exit 3); see ${setupLog}`);
  assert.ok(readFileSync(setupLog, "utf8").includes("marker-fail\n"));
});

test("project setup writes project.json", () => {
  const repo = tempRepo();
  assert.deepEqual(loadProjectConfig(projectIdFor(repo)), emptyProjectConfig()); // before any setup
  const r = cli(repo, "--generator", "build/=scripts/build.sh", "--clone", "build/", "--clone", "android/local.properties",
    "--setup", "make stubs", "--shared", "CHANGELOG.md", "--shared", "docs/", "--deny", "**/*.p12", "--generator", "build=scripts/*.py",
    "--worker-network");
  assert.equal(r.status, 0, r.stderr);
  const want: ProjectConfig = {
    clone: ["build", "android/local.properties"], setup: "make stubs", shared: ["CHANGELOG.md", "docs/"], deny: ["**/*.p12"],
    generators: { build: ["scripts/build.sh", "scripts/*.py"] }, workerNetwork: true, workerAddDirs: [],
  };
  assert.deepEqual(JSON.parse(r.stdout), want);
  assert.deepEqual(loadProjectConfig(projectIdFor(repo)), want);
  assert.equal(statSync(projectFile(repo)).mode & 0o777, 0o600);
  // A --deny applies to every --clone, whatever the order, and a generator must name a clone path.
  assert.match(cli(repo, "--clone", "certs/key.p12", "--deny", "**/*.p12").stderr, /refusing clone path certs\/key\.p12: /);
  assert.match(cli(repo, "--clone", "build", "--generator", "out=x.sh").stderr, /refusing --generator out=x\.sh: /);
  assert.deepEqual(loadProjectConfig(projectIdFor(repo)), want);
});

test("--worker-add-dir accepts the ~ and the absolute form of a GRADLE_ADD_DIRS entry and stores the absolute path", (t) => {
  if (GRADLE_ADD_DIRS.length === 0) return t.skip("GRADLE_ADD_DIRS is empty");
  const repo = tempRepo();
  const [first, last] = [GRADLE_ADD_DIRS[0], GRADLE_ADD_DIRS[GRADLE_ADD_DIRS.length - 1]];
  const r = cli(repo, "--worker-add-dir", `~/${first}`, "--worker-add-dir", `${resolve(homedir(), last)}/`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).workerAddDirs, [resolve(homedir(), first), resolve(homedir(), last)]);
  const bad = cli(repo, "--worker-add-dir", join(homedir(), ".ssh"));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /refusing --worker-add-dir /);
});
