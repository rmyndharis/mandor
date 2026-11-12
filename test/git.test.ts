import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs, { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  addWorktree, apply3way, applyCheck, applyToIndex, assertCommitIdentity, assertHeadIdentity, branchExists, changedPaths, commitStaged, configuredDrivers, configuredPromisors, deleteBranchAt,
  diffSinceBaseBytes, diffStat, dropLastCommit, git, ignoredChanged, indexLockPath, indexTree, isClean, isPlaceholderEmail, migrateObjects, projectRoot,
  pathsAwayFromBase, removeOwnedWorktree, removeTree, resetHardHead, resetTo, revParse, stagedDiff, worktreeAddRunning, worktreeRoot, writeConfined, firstLine, assertOutsideSharedTemp,
} from "../src/git.ts";
import { diffSinceBase, temp as tempDir, tempHome, tempRepo } from "./helpers.ts";

// Real paths, so they compare equal to what git reports (/var is a symlink on macOS).
const temp = () => tempDir("mandor-git-");
// Worktree git calls run only in worktrees under the mandor home, as mandor places them.
const home = tempHome();
const owned = () => mkdtempSync(join(home, "wt-"));
// A linked worktree made with plain git wherever a test puts it: addWorktree refuses a path outside the mandor home.
const plainAdd = (repo: string, path: string, branch: string, base: string) => must(repo, "worktree", "add", "-q", "-b", branch, path, base);

// Setup runs git directly and throws on failure, so a broken setup can never pass a refusal test.
function must(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

const read = (p: string) => readFileSync(p, "utf8");
const branches = (repo: string) => must(repo, "branch", "--format=%(refname:short)").trim().split("\n").sort();
// What the index holds against HEAD, asked of git directly: the code under test reads it only for a commit.
const stagedPaths = (_repo: string, wt: string): string[] =>
  must(wt, "diff-index", "--cached", "--no-renames", "--ignore-submodules=dirty", "--name-only", "-z", "HEAD", "--").split("\0").filter(Boolean);

// Sets environment variables only while fn runs; the git children the calls spawn inherit them.
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// An executable hook in the repository's shared hooks directory, which every worktree runs.
const hook = (repo: string, name: string, body: string) => writeFileSync(join(repo, ".git", "hooks", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

// Every call bound to a repository and one of its worktrees. The last argument is the ref, patch file or sha
// each call takes; the refusal tests never get that far.
const bound: ((repo: string, worktree: string, arg: string) => unknown)[] = [
  isClean, resetTo, resetHardHead, diffSinceBaseBytes, stagedDiff, diffStat, indexTree, indexLockPath,
  applyCheck, applyToIndex, apply3way, (repo, worktree) => commitStaged(repo, worktree, [], "Add", true), dropLastCommit,
  (repo, worktree) => assertCommitIdentity(repo, worktree, true), (repo, worktree) => assertHeadIdentity(repo, worktree, true),
  (repo, worktree, base) => pathsAwayFromBase(repo, worktree, base, ["AGENTS.md"]),
];

// A temp repo plus a linked worktree on wip/task at the repo's first commit.
function withWorktree(): { repo: string; wt: string; base: string } {
  const repo = tempRepo();
  const base = revParse(repo, "HEAD");
  const wt = join(owned(), "task");
  addWorktree(repo, wt, "wip/task", base);
  return { repo, wt, base };
}

// An integration worktree is on a non-wip branch; commitStaged runs only there, never in a worker's wip/ worktree.
function withIntegration(): { repo: string; wt: string; base: string } {
  const repo = tempRepo();
  const base = revParse(repo, "HEAD");
  const wt = join(owned(), "int");
  addWorktree(repo, wt, "goal", base);
  return { repo, wt, base };
}

// A patch file outside every repository, as mandor keeps them.
function patchOf(repo: string, wt: string, base: string): string {
  const p = join(temp(), "task.patch");
  writeFileSync(p, diffSinceBaseBytes(repo, wt, base));
  return p;
}

const TEN = Array.from({ length: 10 }, (_, i) => String(i + 1));
const tenWith = (edits: Record<number, string>) => `${TEN.map((l, i) => edits[i + 1] ?? l).join("\n")}\n`;

// A task worktree and a goal worktree forked from one base that holds f.txt with ten numbered lines.
function forked(): { repo: string; base: string; task: string; goal: string } {
  const repo = tempRepo();
  writeFileSync(join(repo, "f.txt"), tenWith({}));
  must(repo, "add", "f.txt");
  must(repo, "commit", "-qm", "Add lines");
  const base = revParse(repo, "HEAD");
  const task = join(owned(), "task");
  const goal = join(owned(), "goal");
  addWorktree(repo, task, "wip/task", base);
  addWorktree(repo, goal, "wip/goal", base);
  return { repo, base, task, goal };
}

// A whole repository a worker could build in any directory it can write, whose admin dir and back-pointer agree
// with each other and name the worktree. The worktree's .git is pointed at it, as plain discovery would follow.
function plantFakeRepository(repo: string, wt: string, base: string, at: string, config: string): void {
  mkdirSync(join(at, "objects", "info"), { recursive: true });
  mkdirSync(join(at, "refs", "heads", "wip"), { recursive: true });
  writeFileSync(join(at, "objects", "info", "alternates"), `${join(repo, ".git", "objects")}\n`);
  writeFileSync(join(at, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(at, "refs", "heads", "wip", "x"), `${base}\n`);
  writeFileSync(join(at, "config"), `[core]\n\trepositoryformatversion = 0\n${config}`);
  const admin = join(at, "worktrees", "x");
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, "HEAD"), "ref: refs/heads/wip/x\n");
  writeFileSync(join(admin, "commondir"), "../..\n");
  writeFileSync(join(admin, "gitdir"), `${join(wt, ".git")}\n`);
  writeFileSync(join(wt, ".git"), `gitdir: ${admin}\n`);
  assert.equal(must(wt, "rev-parse", "--absolute-git-dir").trim(), admin);
}

// A script that leaves a marker file behind, so a test can see whether git ever ran it.
function markerScript(dir: string, name: string): string {
  const script = join(dir, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch '${join(dir, `${name}.ran`)}'\nexit 1\n`, { mode: 0o755 });
  return script;
}
const ran = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".ran"));

test("projectRoot from inside a linked worktree returns the main root", () => {
  const { repo, wt, base } = withWorktree();
  mkdirSync(join(wt, "sub"));
  assert.equal(projectRoot(wt), repo);
  assert.equal(projectRoot(join(wt, "sub")), repo);
  assert.equal(projectRoot(repo), repo);
  assert.equal(projectRoot(temp()), null);
  assert.equal(projectRoot(join(temp(), "missing")), null);
  // addWorktree creates the branch itself, so a second worktree on it fails.
  assert.throws(() => addWorktree(repo, join(temp(), "again"), "wip/task", base), /already exists/);
});

test("projectRoot returns the work tree of a repository whose git directory lives elsewhere", () => {
  // The second git directory is named like a standard one, but it is not inside the work tree.
  for (const gitdir of [join(temp(), "gitdir"), join(temp(), ".git")]) {
    const work = join(temp(), "work");
    must(temp(), "init", "-q", "-b", "main", "--separate-git-dir", gitdir, work);
    mkdirSync(join(work, "sub"));
    assert.equal(projectRoot(work), work, gitdir);
    assert.equal(projectRoot(join(work, "sub")), work, gitdir);
  }
  // Nothing in a git directory kept elsewhere points back to its work tree, so a linked worktree of it, which git lists
  // under the git directory and not under the work tree, can only be taken as a root of its own.
  const work = join(temp(), "work");
  must(temp(), "init", "-q", "-b", "main", "--separate-git-dir", join(temp(), "gitdir"), work);
  must(work, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "Initial commit");
  const linked = join(temp(), "linked");
  must(work, "worktree", "add", "-q", "-b", "wip/linked", linked);
  assert.equal(projectRoot(linked), linked);
  assert.equal(projectRoot(work), work);
});

test("projectRoot returns a submodule's own work tree, and no root for a bare repository", () => {
  const inner = tempRepo();
  const outer = tempRepo();
  must(outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "inner");
  assert.equal(projectRoot(join(outer, "inner")), join(outer, "inner"));
  assert.equal(projectRoot(outer), outer);
  const bare = join(temp(), "bare.git");
  must(temp(), "init", "-q", "--bare", bare);
  assert.equal(projectRoot(bare), null);
});

test("diffSinceBase covers committed, modified, untracked, deleted and renamed files, with renames as delete plus add", () => {
  const repo = tempRepo();
  for (const f of ["mod.txt", "del.txt", "old.txt", "link.txt"]) writeFileSync(join(repo, f), `${f}\n`.repeat(20));
  must(repo, "add", "-A");
  must(repo, "commit", "-qm", "Add files");
  const base = revParse(repo, "HEAD");
  const wt = join(owned(), "task");
  addWorktree(repo, wt, "wip/task", base);
  writeFileSync(join(wt, "committed.txt"), "c\n");
  must(wt, "add", "committed.txt");
  must(wt, "commit", "-qm", "Add committed");
  writeFileSync(join(wt, "mod.txt"), "changed\n");
  writeFileSync(join(wt, "untracked.txt"), "u\n");
  writeFileSync(join(wt, "blob.bin"), Buffer.from([0, 1, 2, 255, 0]));
  unlinkSync(join(wt, "del.txt"));
  must(wt, "mv", "old.txt", "new.txt");
  unlinkSync(join(wt, "link.txt"));
  symlinkSync("README.md", join(wt, "link.txt"));

  const diff = diffSinceBase(repo, wt, base);
  // Git itself sees the rename, so the delete plus add below comes from --no-renames.
  assert.match(must(wt, "diff", "--cached", "-M", base), /rename from old\.txt/);
  assert.ok(!diff.includes("rename from"));
  assert.match(diff, /GIT binary patch/);
  assert.deepEqual(changedPaths(diff), [
    { path: "blob.bin", status: "A" },
    { path: "committed.txt", status: "A" },
    { path: "del.txt", status: "D" },
    // A file replaced by a symlink is a delete plus an add of the same path.
    { path: "link.txt", status: "D" },
    { path: "link.txt", status: "A" },
    { path: "mod.txt", status: "M" },
    { path: "new.txt", status: "A" },
    { path: "old.txt", status: "D" },
    { path: "untracked.txt", status: "A" },
  ]);

  // The patch rebuilds the worktree's exact tree on the base, and commits with the changedPaths set.
  const target = join(owned(), "integration");
  addWorktree(repo, target, "goal", base);
  const patch = join(temp(), "accepted.patch");
  writeFileSync(patch, diff);
  assert.equal(applyCheck(repo, target, patch), true);
  applyToIndex(repo, target, patch);
  commitStaged(repo, target, changedPaths(diff).map((c) => c.path), "Apply task", true);
  assert.equal(revParse(target, "HEAD^{tree}"), stagedDiff(repo, wt, base).tree);
});

test("diffs, staged paths and applies ignore user diff, submodule and whitespace config", () => {
  const repo = tempRepo();
  const first = revParse(repo, "HEAD");
  writeFileSync(join(repo, "ten.txt"), tenWith({}));
  must(repo, "add", "ten.txt");
  // A gitlink needs no submodule repository; worktrees check it out as an empty directory.
  must(repo, "update-index", "--add", "--cacheinfo", `160000,${first},sub`);
  must(repo, "commit", "-qm", "Add lines and a gitlink");
  const base = revParse(repo, "HEAD");
  const config = [
    ["diff.external", "/usr/bin/false"], ["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"],
    ["color.diff", "always"], ["diff.bin.textconv", "od -c"], ["diff.context", "0"],
    ["diff.submodule", "log"], ["diff.ignoreSubmodules", "all"], ["apply.whitespace", "error"],
  ];
  for (const [k, v] of config) must(repo, "config", k, v);
  writeFileSync(join(repo, ".git", "info", "attributes"), "*.bin diff=bin\n");
  const wt = join(owned(), "task");
  addWorktree(repo, wt, "wip/task", base);
  writeFileSync(join(wt, "a.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(wt, "trail.txt"), "trailing   \n");
  writeFileSync(join(wt, "ten.txt"), tenWith({ 5: "five" }));
  // A worker can hide a gitlink bump from diffs with an ignore line of its own.
  writeFileSync(join(wt, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = all\n');
  must(wt, "update-index", "--cacheinfo", `160000,${base},sub`);
  must(wt, "add", "-A");
  // The config is live: a porcelain diff runs the external command and dies.
  assert.throws(() => must(wt, "diff", "--cached", base));

  const diff = diffSinceBase(repo, wt, base);
  const paths = [".gitmodules", "a.bin", "sub", "ten.txt", "trail.txt"];
  assert.deepEqual(changedPaths(diff), paths.map((path) => ({ path, status: path === "sub" || path === "ten.txt" ? "M" : "A" })));
  assert.deepEqual(stagedPaths(repo, wt), paths);
  assert.match(diff, /GIT binary patch/);
  assert.match(diff, /^\+Subproject commit /m);
  assert.match(diff, /^ 4\n-5\n\+five\n 6$/m);
  const stat = diffStat(repo, wt, base);
  assert.ok(!diff.includes("\x1b[") && !stat.includes("\x1b["));
  assert.match(stat, /^ sub +\| +2 \+-$/m);

  const patch = join(temp(), "accepted.patch");
  writeFileSync(patch, diff);
  const [one, two] = [join(owned(), "one"), join(owned(), "two")];
  addWorktree(repo, one, "goal", base);
  addWorktree(repo, two, "wip/two", base);
  assert.equal(applyCheck(repo, one, patch), true);
  applyToIndex(repo, one, patch);
  assert.equal(read(join(one, "trail.txt")), "trailing   \n");
  commitStaged(repo, one, changedPaths(diff).map((c) => c.path), "Apply task", true);
  assert.equal(revParse(one, "HEAD^{tree}"), must(wt, "write-tree").trim());
  assert.deepEqual(apply3way(repo, two, patch), { applied: true, conflicted: [] });
  assert.equal(read(join(two, "trail.txt")), "trailing   \n");
});

test("changedPaths handles a path with a space and a non-ASCII name", () => {
  const { repo, wt, base } = withWorktree();
  // " b/" inside a name, a quote, and a non-ASCII letter next to an escaped quote.
  const names = ["my file.txt", "x b/c d.txt", "caf\u00e9.txt", 'say "ol\u00e9".txt'];
  mkdirSync(join(wt, "x b"));
  for (const n of names) writeFileSync(join(wt, n), "x\n");
  const listed = (diff: string) => changedPaths(diff).map((c) => `${c.status} ${c.path}`).sort();
  const expected = names.map((n) => `A ${n}`).sort();

  const quoted = diffSinceBase(repo, wt, base);
  assert.ok(quoted.includes('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n'));
  assert.deepEqual(listed(quoted), expected);
  assert.deepEqual(changedPaths(stagedDiff(repo, wt, base).text).map((c) => c.path).sort(), [...names].sort());
  // Without quotePath, non-ASCII bytes stay raw, also inside a quoted name.
  must(repo, "config", "core.quotePath", "false");
  const raw = diffSinceBase(repo, wt, base);
  assert.ok(raw.includes("diff --git a/caf\u00e9.txt b/caf\u00e9.txt\n"));
  assert.ok(raw.includes('diff --git "a/say \\"ol\u00e9\\".txt" "b/say \\"ol\u00e9\\".txt"\n'));
  assert.deepEqual(listed(raw), expected);

  assert.deepEqual(changedPaths(""), []);
  // A header in another format (diff.noprefix) is refused, never guessed.
  assert.throws(() => changedPaths("diff --git my file.txt my file.txt\n"), /unexpected diff header/);
});

test("applyCheck false leaves files untouched", () => {
  const { repo, base, task, goal } = forked();
  writeFileSync(join(task, "f.txt"), tenWith({ 5: "task" }));
  const patch = patchOf(repo, task, base);
  writeFileSync(join(goal, "f.txt"), tenWith({ 5: "goal" }));
  must(goal, "commit", "-qam", "Edit goal");
  const head = revParse(goal, "HEAD");
  assert.equal(applyCheck(repo, goal, patch), false);
  assert.throws(() => applyToIndex(repo, goal, patch), /patch does not apply/);
  assert.equal(read(join(goal, "f.txt")), tenWith({ 5: "goal" }));
  assert.equal(isClean(repo, goal), true);
  assert.equal(revParse(goal, "HEAD"), head);
});

test("apply3way: real conflict reports conflicted paths", () => {
  const { repo, base, task, goal } = forked();
  writeFileSync(join(task, "f.txt"), tenWith({ 5: "task" }));
  const patch = patchOf(repo, task, base);
  writeFileSync(join(goal, "f.txt"), tenWith({ 5: "goal" }));
  must(goal, "commit", "-qam", "Edit goal");
  assert.deepEqual(apply3way(repo, goal, patch), { applied: true, conflicted: ["f.txt"] });
  assert.match(read(join(goal, "f.txt")), /^<<<<<<< [^]*\ngoal\n[^]*\ntask\n>>>>>>> /m);
});

test("apply3way: two-lines-apart edits merge cleanly", () => {
  const { repo, base, task, goal } = forked();
  writeFileSync(join(task, "f.txt"), tenWith({ 3: "task" }));
  const patch = patchOf(repo, task, base);
  writeFileSync(join(goal, "f.txt"), tenWith({ 5: "goal" }));
  must(goal, "commit", "-qam", "Edit goal");
  // The goal's edit sits in the patch context, so only the three-way merge can apply it.
  assert.equal(applyCheck(repo, goal, patch), false);
  assert.deepEqual(apply3way(repo, goal, patch), { applied: true, conflicted: [] });
  assert.equal(read(join(goal, "f.txt")), tenWith({ 3: "task", 5: "goal" }));
  assert.deepEqual(stagedPaths(repo, goal), ["f.txt"]);
});

test("apply3way: modify/delete returns applied false", () => {
  const { repo, base, task, goal } = forked();
  writeFileSync(join(task, "f.txt"), tenWith({ 5: "task" }));
  const patch = patchOf(repo, task, base);
  must(goal, "rm", "-q", "f.txt");
  must(goal, "commit", "-qm", "Remove lines");
  const head = revParse(goal, "HEAD");
  assert.deepEqual(apply3way(repo, goal, patch), { applied: false, conflicted: [] });
  assert.equal(existsSync(join(goal, "f.txt")), false);
  assert.equal(isClean(repo, goal), true);
  assert.equal(revParse(goal, "HEAD"), head);
});

test("commitStaged refuses t@t.t", () => {
  const { repo, wt, base } = withIntegration();
  writeFileSync(join(wt, "a.txt"), "a\n");
  must(wt, "add", "a.txt");
  must(wt, "config", "user.email", "t@t.t");
  for (const allow of [false, true]) assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", allow), /"t@t\.t"/);
  // The identity is checked before the staged set, so a wrong set still reports the identity.
  assert.throws(() => commitStaged(repo, wt, ["other.txt"], "Add a", true), /"t@t\.t" is a placeholder/);
  // An empty local value also hides any global identity.
  must(wt, "config", "user.email", "");
  assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", true), /GIT_AUTHOR_IDENT email "" is a placeholder/);
  must(wt, "config", "user.email", "test@example.invalid");
  assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", false), /"test@example\.invalid"/);
  assert.equal(revParse(wt, "HEAD"), base);
  assert.deepEqual(stagedPaths(repo, wt), ["a.txt"]);
  // The test identity passes only through the in-process option.
  const sha = commitStaged(repo, wt, ["a.txt"], "Add a", true);
  assert.notEqual(sha, base);
  assert.equal(sha, revParse(wt, "HEAD"));
  assert.equal(must(wt, "log", "-1", "--format=%ae %s"), "test@example.invalid Add a\n");
});

test("assertCommitIdentity reads the identity a commit would carry and refuses a placeholder", () => {
  const { repo, wt } = withIntegration();
  const refused = (allow: boolean, re: RegExp) => assert.throws(() => assertCommitIdentity(repo, wt, allow), re);
  // The test identity of tempRepo passes only when it is allowed.
  refused(false, /GIT_AUTHOR_IDENT email "test@example\.invalid" is a placeholder/);
  assertCommitIdentity(repo, wt, true);
  // author.* and committer.* win over user.*, as they do for the commit itself, even with user.email unset.
  must(repo, "config", "--unset", "user.email");
  for (const who of ["author", "committer"]) {
    must(repo, "config", `${who}.name`, "Dev");
    must(repo, "config", `${who}.email`, "dev@host.test");
  }
  assertCommitIdentity(repo, wt, false);
  must(repo, "config", "committer.email", "t@t.t");
  refused(true, /GIT_COMMITTER_IDENT email "t@t\.t" is a placeholder/);
  assert.equal(revParse(wt, "HEAD"), revParse(repo, "refs/heads/main"));
});

test("commitStaged checks the identity git will use, not only user.email", () => {
  const { repo, wt, base } = withIntegration();
  writeFileSync(join(wt, "a.txt"), "a\n");
  must(wt, "add", "a.txt");
  const refused = (re: RegExp) => assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", true), re);
  // user.email (the test identity, allowed here) passes, so each refusal comes from an override.
  withEnv({ GIT_AUTHOR_EMAIL: "t@t.t" }, () => refused(/GIT_AUTHOR_IDENT email "t@t\.t" is a placeholder/));
  for (const [key, ident] of [["author.email", "GIT_AUTHOR_IDENT"], ["committer.email", "GIT_COMMITTER_IDENT"]]) {
    must(repo, "config", key, "t@t.t");
    refused(new RegExp(`${ident} email "t@t\\.t" is a placeholder`));
    must(repo, "config", "--unset", key);
  }
  // With no email configured anywhere, git would guess one from the user and host names.
  must(repo, "config", "--unset", "user.email");
  const empty = join(temp(), "empty.gitconfig");
  writeFileSync(empty, "");
  withEnv({ GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: "1", EMAIL: "guess@host.invalid" }, () => {
    assert.match(must(wt, "var", "GIT_AUTHOR_IDENT"), /<[^<>]+>/);
    refused(/no GIT_AUTHOR_IDENT: [^]*auto-detection is disabled/);
  });
  assert.equal(revParse(wt, "HEAD"), base);
});

test("commitStaged refuses a commit a hook changed and moves HEAD back", () => {
  const { repo, wt, base } = withIntegration();
  writeFileSync(join(wt, "a.txt"), "a\n");
  must(wt, "add", "a.txt");
  hook(repo, "pre-commit", "echo hooked >> a.txt\ngit add a.txt");
  assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", true), /a commit hook changed the commit, so nothing was committed; tell the user: a commit hook of the repository rewrites commits, which accept does not allow/);
  assert.equal(revParse(wt, "HEAD"), base);
  unlinkSync(join(repo, ".git", "hooks", "pre-commit"));
  hook(repo, "commit-msg", 'printf "\\nChange-Id: I0000000000000000000000000000000000000000\\n" >> "$1"');
  assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", true), /a commit hook changed the commit, so nothing was committed; tell the user: a commit hook of the repository rewrites commits, which accept does not allow/);
  assert.equal(revParse(wt, "HEAD"), base);
  unlinkSync(join(repo, ".git", "hooks", "commit-msg"));
  // Hooks still run; one that changes nothing lets the commit through, with the message stored as given.
  const marker = join(temp(), "ran");
  hook(repo, "pre-commit", `touch '${marker}'`);
  const message = "Add a  \n\n\nBody line with trailing spaces  ";
  const sha = commitStaged(repo, wt, ["a.txt"], message, true);
  assert.ok(existsSync(marker));
  assert.equal(sha, revParse(wt, "HEAD"));
  assert.equal(must(wt, "log", "-1", "--format=%B").trimEnd(), message.trimEnd());
});

test("commitStaged refuses a leftover merge, cherry-pick, revert or rebase before committing", () => {
  const { repo, wt, base } = withIntegration();
  writeFileSync(join(wt, "a.txt"), "a\n");
  must(wt, "add", "a.txt");
  // Someone else's commit, by a placeholder identity.
  const side = must(repo, "-c", "user.name=Junk", "-c", "user.email=t@t.t", "commit-tree", "-p", base, "-m", "Side work", `${base}^{tree}`).trim();
  const gitDir = must(wt, "rev-parse", "--absolute-git-dir").trim();
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    if (name.startsWith("rebase-")) mkdirSync(join(gitDir, name));
    else writeFileSync(join(gitDir, name), `${side}\n`);
    assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", true), new RegExp(`refusing to commit in .*: ${name} present`));
    assert.equal(revParse(wt, "HEAD"), base);
    rmSync(join(gitDir, name), { recursive: true });
  }
  const sha = commitStaged(repo, wt, ["a.txt"], "Add a", true);
  assert.equal(must(wt, "log", "-1", "--format=%P %ae", sha), `${base} test@example.invalid\n`);
});

test("commitStaged rolls back a hook that re-parents, amends with a placeholder, or adds a commit", () => {
  const { repo, wt, base } = withIntegration();
  writeFileSync(join(wt, "a.txt"), "a\n");
  must(wt, "add", "a.txt");
  const rolledBack = () => {
    assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", true), /a commit hook changed the commit, so nothing was committed; tell the user: a commit hook of the repository rewrites commits, which accept does not allow/);
    assert.equal(revParse(wt, "HEAD"), base);
  };
  // Same tree and message, with an injected commit underneath.
  hook(repo, "post-commit", 'x=$(git commit-tree "HEAD~1^{tree}" -p HEAD~1 -m Injected)\nn=$(git commit-tree "HEAD^{tree}" -p "$x" -m "Add a")\ngit update-ref HEAD "$n"');
  rolledBack();
  // Same tree, message and parent, with a placeholder committer (hooks inherit GIT_AUTHOR_*, so the author stays).
  hook(repo, "post-commit", '[ -n "$AMENDED" ] && exit 0\nAMENDED=1 git -c user.email=t@t.t -c user.name=Junk commit -q --amend --no-edit --reset-author');
  rolledBack();
  // Same tree, message, parent and committer, with a placeholder author.
  hook(repo, "post-commit", '[ -n "$AMENDED" ] && exit 0\nAMENDED=1 git commit -q --amend --no-edit --author="Junk <t@t.t>"');
  rolledBack();
  // A second commit on top: the rollback goes to the recorded tip, not to HEAD~1.
  hook(repo, "post-commit", 'n=$(git commit-tree "HEAD^{tree}" -p HEAD -m Extra)\ngit update-ref HEAD "$n"');
  rolledBack();
  unlinkSync(join(repo, ".git", "hooks", "post-commit"));
  assert.notEqual(commitStaged(repo, wt, ["a.txt"], "Add a", true), base);
});

test("commitStaged rolls back the branch it committed on, even when a hook checks out another", () => {
  const { repo, wt, base } = withIntegration();
  writeFileSync(join(wt, "a.txt"), "a\n");
  must(wt, "add", "a.txt");
  const side = must(repo, "commit-tree", "-p", base, "-m", "Side", `${base}^{tree}`).trim();
  must(repo, "branch", "side", side);
  hook(repo, "post-commit", "git checkout -q side");
  assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", true), /a commit hook changed the commit, so nothing was committed; tell the user: a commit hook of the repository rewrites commits, which accept does not allow/);
  assert.equal(must(wt, "symbolic-ref", "HEAD"), "refs/heads/goal\n");
  assert.equal(revParse(repo, "refs/heads/goal"), base);
  assert.equal(revParse(repo, "refs/heads/side"), side);
});

test("commitStaged sees a cherry-pick or revert in progress in a reftable repository", (t) => {
  const repo = temp();
  if (git(["init", "-q", "-b", "main", "--ref-format=reftable"], repo).code !== 0) return t.skip("this git cannot create a reftable repository");
  must(repo, "config", "user.name", "Test");
  must(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "README.md"), "r\n");
  must(repo, "add", "README.md");
  must(repo, "commit", "-qm", "Initial commit");
  const base = revParse(repo, "HEAD");
  const wt = join(owned(), "int");
  addWorktree(repo, wt, "goal", base);
  writeFileSync(join(wt, "a.txt"), "a\n");
  must(wt, "add", "a.txt");
  const side = must(repo, "-c", "user.name=Junk", "-c", "user.email=t@t.t", "commit-tree", "-p", base, "-m", "Side work", `${base}^{tree}`).trim();
  const gitDir = must(wt, "rev-parse", "--absolute-git-dir").trim();
  for (const name of ["CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    must(wt, "update-ref", name, side);
    // The ref store holds it, so there is no file to find.
    assert.equal(existsSync(join(gitDir, name)), false);
    assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", true), new RegExp(`refusing to commit in .*: ${name} present`));
    assert.equal(revParse(wt, "HEAD"), base);
    must(wt, "update-ref", "-d", name);
  }
});

test("diffSinceBaseBytes keeps a Latin-1 file byte-exact through applyToIndex", () => {
  const repo = tempRepo();
  writeFileSync(join(repo, "latin1.txt"), Buffer.from("caf\xe9\n", "latin1"));
  must(repo, "add", "latin1.txt");
  must(repo, "commit", "-qm", "Add a Latin-1 file");
  const base = revParse(repo, "HEAD");
  const wt = join(owned(), "task");
  addWorktree(repo, wt, "wip/task", base);
  const edited = Buffer.from("caf\xe9\nna\xefve\n", "latin1");
  writeFileSync(join(wt, "latin1.txt"), edited);

  const bytes = diffSinceBaseBytes(repo, wt, base);
  assert.ok(bytes.includes(Buffer.from("\n caf\xe9\n+na\xefve\n", "latin1")));
  assert.equal(diffSinceBase(repo, wt, base), bytes.toString());
  const target = join(owned(), "integration");
  addWorktree(repo, target, "wip/integration", base);
  // The decoded text has lost the bytes, so a patch written from it no longer applies.
  const lossy = join(temp(), "lossy.patch");
  writeFileSync(lossy, diffSinceBase(repo, wt, base));
  assert.equal(applyCheck(repo, target, lossy), false);
  const patch = join(temp(), "accepted.patch");
  writeFileSync(patch, bytes);
  applyToIndex(repo, target, patch);
  assert.deepEqual(readFileSync(join(target, "latin1.txt")), edited);
  assert.deepEqual(stagedPaths(repo, target), ["latin1.txt"]);
});

test("commitStaged refuses a different staged set", () => {
  const { repo, wt, base } = withIntegration();
  writeFileSync(join(wt, "a.txt"), "a\n");
  writeFileSync(join(wt, "b.txt"), "b\n");
  must(wt, "add", "a.txt", "b.txt");
  writeFileSync(join(wt, "README.md"), "unstaged edit\n");
  writeFileSync(join(wt, "c.txt"), "untracked\n");
  assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", true), /staged but not reviewed \["b\.txt"\], reviewed but not staged \[\]/);
  assert.throws(() => commitStaged(repo, wt, ["a.txt", "b.txt", "c.txt"], "Add a", true), /staged but not reviewed \[\], reviewed but not staged \["c\.txt"\]/);
  assert.equal(revParse(wt, "HEAD"), base);
  // Sets, not lists: order and repeats do not matter.
  const sha = commitStaged(repo, wt, ["b.txt", "a.txt", "a.txt"], "Add a and b", true);
  assert.equal(revParse(wt, "HEAD"), sha);
  assert.equal(must(wt, "show", "--name-only", "--format=", "HEAD"), "a.txt\nb.txt\n");
  // commitStaged never stages: the unstaged edit and the untracked file stay out of the commit.
  assert.equal(must(wt, "status", "--porcelain"), " M README.md\n?? c.txt\n");
});

test("dropLastCommit refuses when HEAD moved, when dirty, and when pushed", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(wt, "a.txt"), "a\n");
  must(wt, "add", "a.txt");
  must(wt, "commit", "-qm", "Add a");
  const first = revParse(wt, "HEAD");

  assert.throws(() => dropLastCommit(repo, wt, base), /HEAD is/);
  writeFileSync(join(wt, "stray.txt"), "s\n");
  assert.throws(() => dropLastCommit(repo, wt, first), /not clean/);
  unlinkSync(join(wt, "stray.txt"));
  // Pushed only to a bare repository inside this test's temp dir.
  const remote = temp();
  must(remote, "init", "-q", "--bare");
  must(wt, "remote", "add", "origin", remote);
  must(wt, "push", "-q", "origin", "wip/task");
  must(wt, "fetch", "-q", "origin");
  assert.notEqual(must(wt, "branch", "-r", "--contains", "HEAD").trim(), "");
  assert.throws(() => dropLastCommit(repo, wt, first), /remote/);
  assert.equal(revParse(wt, "HEAD"), first);
  assert.ok(existsSync(join(wt, "a.txt")));

  // An unpushed last commit is dropped, and the worktree stays clean, even with a file named like the ref.
  writeFileSync(join(wt, "HEAD~1"), "b\n");
  must(wt, "add", "--", "HEAD~1");
  must(wt, "commit", "-qm", "Add b");
  dropLastCommit(repo, wt, revParse(wt, "HEAD"));
  assert.equal(revParse(wt, "HEAD"), first);
  assert.equal(existsSync(join(wt, "HEAD~1")), false);
  assert.equal(isClean(repo, wt), true);
});

test("removeTree removes a tree a worker made read-only and immutable, and a link at its path without following it", () => {
  const dir = owned();
  const tree = join(dir, "tree");
  mkdirSync(join(tree, "ro", "sub"), { recursive: true });
  writeFileSync(join(tree, "ro", "sub", "f"), "x\n");
  writeFileSync(join(tree, "ro", "sub", "g"), "y\n");
  spawnSync("/usr/bin/chflags", ["uchg", join(tree, "ro", "sub", "f")]);
  spawnSync("/usr/bin/chflags", ["uappnd", join(tree, "ro", "sub", "g")]);
  chmodSync(join(tree, "ro", "sub"), 0o500);
  chmodSync(join(tree, "ro"), 0o500);
  removeTree(tree);
  assert.equal(existsSync(tree), false);
  // A link that a worker put at the path is removed, and what it leads to stays.
  const precious = join(dir, "precious");
  mkdirSync(precious);
  writeFileSync(join(precious, "keep"), "keep\n");
  symlinkSync(precious, join(dir, "link"));
  removeTree(join(dir, "link"));
  assert.equal(lstatSync(join(dir, "link"), { throwIfNoEntry: false }), undefined);
  assert.equal(read(join(precious, "keep")), "keep\n");
  // A home reached through a link is removed too, as the sandbox matches the real path.
  const home = join(dir, "home");
  mkdirSync(join(home, "inner"), { recursive: true });
  symlinkSync(home, join(dir, "viahome"));
  removeTree(join(dir, "viahome", "inner"));
  assert.equal(existsSync(join(home, "inner")), false);
});

test("writeConfined writes a file as a private one, makes the directories on the way, keeps bytes as they are, and replaces a file or a link at its name", () => {
  const dir = owned();
  const root = join(dir, "root");
  mkdirSync(root);
  writeConfined(root, "a/b/c.json", "one\n");
  assert.equal(read(join(root, "a", "b", "c.json")), "one\n");
  assert.equal(lstatSync(join(root, "a", "b", "c.json")).mode & 0o777, 0o600);
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  writeConfined(root, "bin", bytes);
  assert.deepEqual(fs.readFileSync(join(root, "bin")), bytes);
  writeConfined(root, "bin", "second\n");
  assert.equal(read(join(root, "bin")), "second\n");
  // A link at the name is replaced, and what it led to stays.
  const precious = join(dir, "precious");
  writeFileSync(precious, "keep\n");
  symlinkSync(precious, join(root, "linked"));
  writeConfined(root, "linked", "new\n");
  assert.equal(read(precious), "keep\n");
  assert.equal(lstatSync(join(root, "linked")).isFile(), true);
  assert.equal(read(join(root, "linked")), "new\n");
  assert.deepEqual(readdirSync(root).sort(), ["a", "bin", "linked"], "no temporary file is left");
});

test("writeConfined writes nothing outside its root, whether a link is in the way to the file, is the root itself, or is a directory at the file's name", () => {
  const dir = owned();
  const victim = join(dir, "victim");
  mkdirSync(victim);
  const root = join(dir, "root");
  mkdirSync(join(root, "d"), { recursive: true });
  symlinkSync(victim, join(root, "way"));
  assert.throws(() => writeConfined(root, "way/key.json", "secret\n"), /^Error: could not write .*way\/key\.json: EPERM: operation not permitted, .*; tell the user, who removes what is in the way$/);
  const linkedRoot = join(dir, "linked-root");
  symlinkSync(victim, linkedRoot);
  assert.throws(() => writeConfined(linkedRoot, "key.json", "secret\n"), /^Error: could not write .*linked-root\/key\.json: .*not permitted/);
  assert.deepEqual(readdirSync(victim), [], "nothing was written where a link leads");
  // A directory at the name is refused, and a link at the name that leads to one outside is replaced by the file: what it led to stays.
  assert.throws(() => writeConfined(root, "d", "x\n"), /^Error: could not write .*\/d: .*\/d is a directory/);
  assert.deepEqual(readdirSync(join(root, "d")), []);
  symlinkSync(victim, join(root, "dirlink"));
  writeConfined(root, "dirlink", "x\n");
  assert.equal(lstatSync(join(root, "dirlink")).isFile(), true);
  assert.deepEqual(readdirSync(victim), []);
  assert.deepEqual(readdirSync(root).sort(), ["d", "dirlink", "way"], "no temporary file is left");
});

test("writeConfined holds against a worker that swaps a directory for a link while it writes", () => {
  const dir = owned();
  const victim = join(dir, "victim");
  mkdirSync(victim);
  const root = join(dir, "root");
  mkdirSync(root);
  // A second process flips the directory the file goes in between a directory and a link out, as fast as it can.
  const flip = `const fs=require("fs");const [root,victim]=process.argv.slice(1);const d=root+"/sub";
    for(;;){try{fs.rmSync(d,{recursive:true,force:true});fs.mkdirSync(d)}catch{}try{fs.rmSync(d,{recursive:true,force:true});fs.symlinkSync(victim,d)}catch{}}`;
  const racer = spawn(process.execPath, ["-e", flip, root, victim], { stdio: "ignore" });
  let written = 0;
  let refused = 0;
  try {
    for (let i = 0; i < 150; i++) {
      try {
        writeConfined(root, "sub/key.json", "secret\n");
        written++;
      } catch {
        refused++;
      }
    }
  } finally {
    racer.kill("SIGKILL");
  }
  assert.deepEqual(readdirSync(victim), [], `nothing reached where the link leads (${written} written, ${refused} refused)`);
  assert.ok(written + refused === 150 && refused > 0, "the link was there for some of the writes");
});

test("writeConfined names its temporary file at random, so links planted at the names to come get nothing written through them", () => {
  const dir = owned();
  const outside = join(dir, "outside");
  mkdirSync(outside);
  const victim = join(outside, "victim.txt");
  writeFileSync(victim, "keep\n");
  const root = join(dir, "root");
  mkdirSync(root);
  const target = join(root, "key.json");
  // The processes that start next take process ids just above that of a command started now, and a hard link to a file
  // outside the root is written through by the confined process whatever the sandbox says of the path it was opened by.
  const last = spawnSync("/usr/bin/true").pid!;
  for (let i = 1; i <= 4000; i++) fs.linkSync(victim, `${target}.${((last + i - 100) % 99900) + 100}.tmp`); // ids wrap at 99999 and start again at 100
  writeConfined(root, "key.json", "secret\n");
  assert.equal(read(victim), "keep\n", "what the planted links lead to is untouched");
  assert.equal(lstatSync(target).nlink, 1, "the name is a file of its own, not a link to the victim");
  assert.equal(lstatSync(target).mode & 0o777, 0o600);
  assert.equal(read(target), "secret\n");
});

test("writeConfined replaces a link at its name that leads to a directory, and never moves the file into it", () => {
  const dir = owned();
  const root = join(dir, "root");
  mkdirSync(join(root, "stash"), { recursive: true });
  symlinkSync(join(root, "stash"), join(root, "name"));
  writeConfined(root, "name", "x\n");
  assert.equal(lstatSync(join(root, "name")).isFile(), true);
  assert.equal(read(join(root, "name")), "x\n");
  assert.deepEqual(readdirSync(join(root, "stash")), []);
});

test("writeConfined keeps every byte of data larger than a pipe buffer", () => {
  const root = join(owned(), "root");
  const bytes = Buffer.from(Array.from({ length: 400_000 }, (_, i) => i % 251));
  mkdirSync(root);
  writeConfined(root, "big", bytes);
  assert.deepEqual(fs.readFileSync(join(root, "big")), bytes);
});

test("writeConfined and removeTree say what stopped them when sandbox-exec cannot apply a profile, whatever the size of the data", () => {
  const root = join(owned(), "root");
  mkdirSync(root);
  const script = join(temp(), "nested.ts");
  writeFileSync(script, `import { removeTree, writeConfined } from ${JSON.stringify(join(import.meta.dirname, "..", "src", "git.ts"))};
    const say = (f: () => void): string => { try { f(); return "no error"; } catch (e) { return (e as Error).message; } };
    const root = process.argv[2];
    console.log(JSON.stringify({ small: say(() => writeConfined(root, "f", "x\\n")), large: say(() => writeConfined(root, "f", Buffer.alloc(400_000, 1))), remove: say(() => removeTree(root)) }));
  `);
  // Another sandbox around the call, as Claude Code's Bash sandbox is: a profile with a deny rule cannot be applied inside it.
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", process.execPath, script, root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const said = JSON.parse(r.stdout) as Record<string, string>;
  for (const key of ["small", "large", "remove"]) {
    assert.match(said[key], /sandbox_apply/, key);
    assert.match(said[key], /; run mandor outside Claude Code's Bash sandbox, which sandbox-exec cannot nest in$/, key);
    assert.doesNotMatch(said[key], /EPIPE|removes what is in the way|if it stays/, key);
  }
  assert.equal(existsSync(join(root, "f")), false);
});

test("firstLine reads what a confined command printed, and what ended it when it printed nothing or never ran", () => {
  assert.equal(firstLine({ stderr: "a\nb\n", status: 1, signal: null }), "a");
  assert.equal(firstLine({ error: new Error("spawnSync x EPIPE"), stderr: "sandbox-exec: sandbox_apply: Operation not permitted\n", status: 71, signal: null }), "sandbox-exec: sandbox_apply: Operation not permitted");
  assert.equal(firstLine({ error: new Error("spawnSync x EAGAIN"), stderr: undefined as never, status: null, signal: null }), "spawnSync x EAGAIN", "a command that could not start has no stderr at all");
  assert.equal(firstLine({ stderr: "", status: 3, signal: null }), "exit 3");
  assert.equal(firstLine({ stderr: "", status: null, signal: "SIGKILL" }), "exit SIGKILL");
  assert.equal(firstLine({ stderr: "x\u001b[31my\n", status: 1, signal: null }), "x?[31my");
});

test("a removal that fails on a file named after sandbox_apply keeps the step for a file in the way", () => {
  const tree = join(owned(), "tree");
  mkdirSync(tree);
  const stuck = join(tree, "sandbox_apply");
  writeFileSync(stuck, "a\n");
  spawnSync("/bin/chmod", ["+a", "everyone deny delete", stuck]);
  try {
    assert.throws(() => removeTree(tree), /^Error: could not remove .*tree: rm: .*sandbox_apply: .*; if it stays, tell the user, who removes it$/);
  } finally {
    spawnSync("/bin/chmod", ["-N", stuck]);
  }
  removeTree(tree);
});

test("writeConfined runs in an environment of its own, so the lead's NODE_OPTIONS change neither what it says nor what it writes", () => {
  const dir = owned();
  const victim = join(dir, "victim");
  mkdirSync(victim);
  const root = join(dir, "root");
  mkdirSync(root);
  symlinkSync(victim, join(root, "way"));
  const noise = join(temp(), "noise.cjs");
  writeFileSync(noise, 'process.stderr.write("NOISE OF A REQUIRE HOOK\\n");\n');
  withEnv({ NODE_OPTIONS: `--require ${noise}` }, () => {
    assert.throws(() => writeConfined(root, "way/f", "x\n"), (e: Error) => /EPERM: operation not permitted/.test(e.message) && !/NOISE/.test(e.message), "a failure says its own cause");
    writeConfined(root, "ok", "x\n");
  });
  assert.equal(read(join(root, "ok")), "x\n");
  if (process.allowedNodeEnvironmentFlags.has("--experimental-default-type")) {
    withEnv({ NODE_OPTIONS: "--experimental-default-type=module" }, () => writeConfined(root, "esm", "y\n"));
    assert.equal(read(join(root, "esm")), "y\n", "whatever default module type is asked for");
  }
  assert.deepEqual(readdirSync(victim), []);
});

test("writeConfined into a directory that cannot be written says to repair its permissions, not to look for what is in the way", (t) => {
  const root = join(owned(), "root");
  mkdirSync(root);
  chmodSync(root, 0o500);
  t.after(() => chmodSync(root, 0o700));
  assert.throws(() => writeConfined(root, "f", "x\n"), /^Error: could not write .*\/f: EACCES: permission denied, .*; tell the user, who repairs the permissions of that directory$/);
});

test("assertOutsideSharedTemp refuses a state home or a repository under the shared temporary directories, and nothing else", () => {
  const away = join(homedir(), "mandor-no-such-directory"); // never made: only its real form is looked at
  const refusal = (what: string) => new RegExp(`^Error: refusing ${what} .+: it lies under .+, which the workers of a project set up with --shared-temp may write; tell the user, who `);
  withEnv({ MANDOR_HOME: join(away, ".mandor") }, () => {
    assertOutsideSharedTemp(join(away, "repo"));
    assert.throws(() => assertOutsideSharedTemp(join(tmpdir(), "repo")), refusal("the repository"));
    assert.throws(() => assertOutsideSharedTemp("/tmp/work/repo"), /lies under \/private\/tmp,/);
    assert.throws(() => assertOutsideSharedTemp("/private/var/folders/zz/yy/C/repo"), /lies under \/private\/var\/folders,/);
    assert.throws(() => assertOutsideSharedTemp(join(tmpdir(), "repo")), /moves the repository or runs mandor project setup --update --no-shared-temp$/);
  });
  withEnv({ MANDOR_HOME: join(tmpdir(), "state") }, () => {
    assert.throws(() => assertOutsideSharedTemp(join(away, "repo")), refusal("the mandor home"));
    assert.throws(() => assertOutsideSharedTemp(join(away, "repo")), /sets MANDOR_HOME elsewhere or runs mandor project setup --update --no-shared-temp$/);
  });
  // The lead's own TMPDIR counts too, wherever it lies: it is what a worker's TMPDIR is copied from.
  withEnv({ MANDOR_HOME: join(away, ".mandor"), TMPDIR: join(away, "scratch") }, () => {
    assert.throws(() => assertOutsideSharedTemp(join(away, "scratch", "repo")), /lies under .*scratch,/);
    assertOutsideSharedTemp(join(away, "repo"));
  });
  // A path that reaches the shared directory through a link is judged by where it really is.
  const link = join(temp(), "link");
  symlinkSync(tmpdir(), link);
  withEnv({ MANDOR_HOME: join(away, ".mandor") }, () => assert.throws(() => assertOutsideSharedTemp(join(link, "repo")), refusal("the repository")));
});

test("removeOwnedWorktree refuses a path outside the root and a non-wip branch", () => {
  const repo = tempRepo();
  const base = revParse(repo, "HEAD");
  const root = join(temp(), "root");
  mkdirSync(root);
  const add = (path: string, branch: string) => (plainAdd(repo, path, branch, base), path);
  const mine = add(join(root, "owned"), "wip/owned");
  const keep = add(join(root, "keep"), "wip/keep");
  // Shares the root's name as a prefix, but is a sibling directory.
  const sibling = add(`${root}-x`, "wip/sibling");
  const feature = add(join(root, "feature"), "feature/x");
  symlinkSync(sibling, join(root, "link"));

  for (const p of [sibling, join(root, "link"), root]) {
    assert.throws(() => removeOwnedWorktree(repo, p, "wip/sibling", root), /not under/);
  }
  assert.throws(() => removeOwnedWorktree(repo, feature, "feature/x", root), /not a wip\/ branch/);
  assert.ok(existsSync(join(sibling, "README.md")) && existsSync(join(feature, "README.md")));
  const all = ["feature/x", "main", "wip/keep", "wip/owned", "wip/sibling"];
  assert.deepEqual(branches(repo), all);

  writeFileSync(join(mine, "README.md"), "dirty\n");
  removeOwnedWorktree(repo, mine, "wip/owned", root);
  // A null branch removes only the worktree.
  removeOwnedWorktree(repo, keep, null, root);
  assert.equal(existsSync(mine) || existsSync(keep), false);
  assert.deepEqual(branches(repo), all.filter((b) => b !== "wip/owned"));
  assert.equal(must(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 3);
});

test("isPlaceholderEmail table", async (t) => {
  // email, then the result without and with allowTestIdentity
  const table: [string, boolean, boolean][] = [
    ["", true, true],
    ["you@example.com", true, true],
    ["t@t.t", true, true],
    ["a@b.invalid", true, false],
    ["no-at-sign", true, true],
    ["@b.invalid", true, true],
    ["a@nodot", true, true],
    ["a@localhost", true, true],
    ["a@example.org", true, true],
    ["a@example.net", true, true],
    [" You@Example.COM ", true, true],
    ["a@mail.example.com", true, true],
    ["T@T.T", true, true],
    // A trailing root dot, whitespace or a second @ must not hide a placeholder.
    ["t@t.t.", true, true],
    ["you@example.com.", true, true],
    ["a@b.invalid.", true, false],
    ["a@t.t..", true, true],
    ["t@t.t x@mail.test", true, true],
    ["a b@mail.test", true, true],
    ["x@mail.test@t.t", true, true],
    ["x@mail.test", false, false],
  ];
  for (const [email, plain, allowed] of table) {
    assert.equal(isPlaceholderEmail(email, false), plain, email);
    assert.equal(isPlaceholderEmail(email, true), allowed, email);
  }
  // A real address comes from this checkout's own identity, so none is written here.
  const real = git(["config", "user.email"], join(import.meta.dirname, "..")).stdout.trim();
  await t.test("this checkout's own user.email is real", { skip: real === "" && "this checkout has no user.email" }, () => {
    assert.equal(isPlaceholderEmail(real, false), false, `this checkout's user.email "${real}" must be a real address`);
  });
});

test("git() returns more than 1 MiB of output intact", () => {
  const repo = tempRepo();
  const big = "0123456789abcdef".repeat(128 * 1024);
  writeFileSync(join(repo, "big.txt"), big);
  must(repo, "add", "big.txt");
  must(repo, "commit", "-qm", "Add big");
  const r = git(["cat-file", "-p", "HEAD:big.txt"], repo);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 2 * 1024 * 1024);
  assert.ok(r.stdout === big);
  // A spawn failure is a failure, not an empty success.
  const missing = git(["status"], join(repo, "missing"));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /ENOENT/);
});

test("resetTo and resetHardHead refuse the main working tree", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(repo, "README.md"), "user edit\n");
  writeFileSync(join(repo, "notes.txt"), "user notes\n");
  // The user's own checkout is outside the mandor home.
  assert.throws(() => resetTo(repo, repo, base), /not under the mandor home/);
  assert.throws(() => resetHardHead(repo, repo), /not under the mandor home/);
  assert.equal(read(join(repo, "README.md")), "user edit\n");
  assert.equal(read(join(repo, "notes.txt")), "user notes\n");
  // A main checkout inside the home is no worktree of the repository, and its own repository is inside the home.
  const clone = join(owned(), "clone");
  must(home, "clone", "-q", repo, clone);
  writeFileSync(join(clone, "README.md"), "clone edit\n");
  assert.throws(() => resetTo(repo, clone, base), /not a worktree of/);
  assert.throws(() => resetHardHead(clone, clone), /its repository .*clone\/\.git is inside the mandor home/);
  assert.equal(read(join(clone, "README.md")), "clone edit\n");
  // A repository argument that holds no repository fails at rev-parse.
  assert.throws(() => resetTo(owned(), wt, base), /rev-parse/);

  // In a linked worktree: untracked files go, ignored files survive. The ref is also a file name.
  writeFileSync(join(repo, ".git", "info", "exclude"), "ignored.txt\n");
  must(repo, "branch", "README.md", base);
  writeFileSync(join(wt, "a.txt"), "a\n");
  must(wt, "add", "a.txt");
  must(wt, "commit", "-qm", "Add a");
  writeFileSync(join(wt, "README.md"), "task edit\n");
  writeFileSync(join(wt, "untracked.txt"), "u\n");
  writeFileSync(join(wt, "ignored.txt"), "i\n");
  resetTo(repo, wt, "README.md");
  assert.equal(revParse(wt, "HEAD"), base);
  assert.equal(read(join(wt, "README.md")), "temp repo\n");
  assert.equal(existsSync(join(wt, "a.txt")) || existsSync(join(wt, "untracked.txt")), false);
  assert.equal(read(join(wt, "ignored.txt")), "i\n");
  writeFileSync(join(wt, "README.md"), "staged edit\n");
  must(wt, "add", "README.md");
  resetHardHead(repo, wt);
  assert.equal(isClean(repo, wt), true);
  assert.equal(read(join(wt, "README.md")), "temp repo\n");
});

test("an inherited GIT_WORK_TREE cannot make resetTo touch the main checkout", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(repo, "README.md"), "user edit\n");
  writeFileSync(join(repo, "notes.txt"), "user notes\n");
  writeFileSync(join(wt, "untracked.txt"), "u\n");
  withEnv({ GIT_WORK_TREE: repo }, () => resetTo(repo, wt, base));
  assert.equal(read(join(repo, "README.md")), "user edit\n");
  assert.equal(read(join(repo, "notes.txt")), "user notes\n");
  // The reset ran in the worktree it was given.
  assert.equal(existsSync(join(wt, "untracked.txt")), false);
});

test("a linked worktree outside the mandor home, or below a worktree's top, is refused", () => {
  const { repo, wt, base } = withWorktree();
  const outside = join(temp(), "outside");
  plainAdd(repo, outside, "wip/outside", base);
  writeFileSync(join(outside, "x.txt"), "x\n");
  for (const call of bound) assert.throws(() => call(repo, outside, base), /not under the mandor home/);
  mkdirSync(join(wt, "sub"));
  writeFileSync(join(wt, "sub", "keep.txt"), "k\n");
  for (const call of bound) assert.throws(() => call(repo, join(wt, "sub"), base), /not a worktree of/);
  // Neither add -A nor clean ran in either place.
  assert.equal(must(outside, "status", "--porcelain", "--untracked-files=all"), "?? x.txt\n");
  assert.equal(must(wt, "status", "--porcelain", "--untracked-files=all"), "?? sub/keep.txt\n");
});

test("a call naming a repository the worktree does not belong to is refused", () => {
  const { repo, wt, base } = withWorktree();
  const other = tempRepo();
  writeFileSync(join(wt, "x.txt"), "x\n");
  for (const call of bound) assert.throws(() => call(other, wt, base), /not a worktree of/);
  // Two admin dirs naming one worktree are refused rather than chosen between.
  const admin = must(wt, "rev-parse", "--absolute-git-dir").trim();
  cpSync(admin, `${admin}-copy`, { recursive: true });
  for (const call of bound) assert.throws(() => call(repo, wt, base), /named by more than one admin dir of/);
  assert.equal(must(wt, "status", "--porcelain", "--untracked-files=all"), "?? x.txt\n");
});

test("a worktree whose .git is a symlink to another worktree's .git still works on its own", () => {
  const { repo, wt, base } = withWorktree();
  const userWt = join(temp(), "feature-wt");
  must(repo, "worktree", "add", "-q", "-b", "feature", userWt, base);
  writeFileSync(join(userWt, "staged.txt"), "staged\n");
  must(userWt, "add", "staged.txt");
  // Only the pointer's directory is resolved, so the link the worker put at its .git is never followed.
  unlinkSync(join(wt, ".git"));
  symlinkSync(join(userWt, ".git"), join(wt, ".git"));
  writeFileSync(join(wt, "task.txt"), "t\n");
  assert.deepEqual(changedPaths(diffSinceBase(repo, wt, base)), [{ path: "task.txt", status: "A" }]);
  resetTo(repo, wt, base);
  assert.equal(existsSync(join(wt, "task.txt")), false);
  assert.equal(must(userWt, "status", "--porcelain"), "A  staged.txt\n");
  assert.equal(revParse(repo, "refs/heads/feature"), base);
});

test("an old git that echoes the unknown --path-format flag is refused", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(wt, "u.txt"), "u\n");
  // git before 2.31 does not know --path-format, so rev-parse prints it back as a line of output.
  const bin = temp();
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const fake = [
    "#!/bin/sh",
    'if [ "$1" = rev-parse ]; then',
    '  shift; set -- rev-parse $(for a in "$@"; do [ "$a" = --path-format=absolute ] && echo --path-format-unknown || echo "$a"; done)',
    "fi",
    `exec '${realGit}' "$@"`,
  ];
  writeFileSync(join(bin, "git"), `${fake.join("\n")}\n`, { mode: 0o755 });
  withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => {
    assert.equal(must(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"), "--path-format-unknown\n.git\n");
    for (const call of bound) assert.throws(() => call(repo, wt, base), /did not give one absolute common dir; mandor needs git 2\.31 or later, so update git$/);
  });
  assert.equal(must(wt, "status", "--porcelain", "--untracked-files=all"), "?? u.txt\n");
});

test("a worktree whose .git points at another worktree's admin dir still works on its own", () => {
  const { repo, wt, base } = withWorktree();
  // The user's own linked worktree on feature, with a commit and a staged file.
  const userWt = join(temp(), "feature-wt");
  must(repo, "worktree", "add", "-q", "-b", "feature", userWt, base);
  writeFileSync(join(userWt, "f.txt"), "user work\n");
  must(userWt, "add", "f.txt");
  must(userWt, "commit", "-qm", "User work on feature");
  writeFileSync(join(userWt, "staged.txt"), "staged\n");
  must(userWt, "add", "staged.txt");
  const feature = revParse(repo, "refs/heads/feature");
  // The worker writes only its own worktree's .git file.
  writeFileSync(join(wt, ".git"), `gitdir: ${must(userWt, "rev-parse", "--absolute-git-dir").trim()}\n`);
  writeFileSync(join(wt, "task.txt"), "t\n");
  assert.deepEqual(changedPaths(diffSinceBase(repo, wt, base)), [{ path: "task.txt", status: "A" }]);
  resetTo(repo, wt, base);
  assert.equal(existsSync(join(wt, "task.txt")), false);
  assert.equal(revParse(repo, "refs/heads/wip/task"), base);
  assert.equal(revParse(repo, "refs/heads/feature"), feature);
  assert.equal(must(userWt, "status", "--porcelain"), "A  staged.txt\n");
});

test("a worktree whose .git points at a git dir made inside it still works on its own", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(repo, "later.txt"), "later\n");
  must(repo, "add", "later.txt");
  must(repo, "commit", "-qm", "User commit on main");
  const main = revParse(repo, "refs/heads/main");
  writeFileSync(join(repo, "README.md"), "user edit\n");
  // A git dir of the worker's own making that shares the user's repository, with HEAD on main.
  const fake = join(wt, ".fakegit");
  mkdirSync(fake);
  writeFileSync(join(fake, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(fake, "commondir"), `${join(repo, ".git")}\n`);
  writeFileSync(join(wt, ".git"), `gitdir: ${fake}\n`);
  writeFileSync(join(wt, "task.txt"), "t\n");
  resetTo(repo, wt, base);
  // The reset ran on wip/task in the real worktree, so the fake git dir went with the other untracked files.
  assert.equal(existsSync(join(wt, "task.txt")) || existsSync(fake), false);
  assert.equal(revParse(repo, "refs/heads/wip/task"), base);
  assert.equal(revParse(repo, "refs/heads/main"), main);
  assert.equal(must(repo, "status", "--porcelain"), " M README.md\n");
});

test("a worktree whose .git names a repository built inside it never runs that repository's config", () => {
  const { repo, wt, base } = withWorktree();
  const markers = temp();
  plantFakeRepository(repo, wt, base, join(wt, "fc"), `\tfsmonitor = ${markerScript(markers, "fsmonitor")}\n`);
  writeFileSync(join(wt, "task.txt"), "t\n");
  // The fake repository is only files in the real worktree, and add -A stages them like any other.
  assert.ok(changedPaths(diffSinceBase(repo, wt, base)).some((c) => c.path === "fc/config"));
  assert.match(diffStat(repo, wt, base), /task\.txt/);
  resetTo(repo, wt, base);
  assert.equal(existsSync(join(wt, "task.txt")) || existsSync(join(wt, "fc")), false);
  assert.deepEqual(ran(markers), []);
});

test("staging on a copy of the index keeps git's protection against an edit of the same size within the second of the last index write", async () => {
  const { repo, wt, base } = withWorktree();
  const file = join(wt, "README.md");
  const when = new Date(Math.floor(Date.now() / 1000) * 1000);
  utimesSync(file, when, when);
  const adminIndex = join(execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: wt, encoding: "utf8" }).trim(), "index");
  must(wt, "update-index", "--refresh");
  utimesSync(adminIndex, when, when);
  const before = readFileSync(file, "utf8");
  // The same size, and the modification time the index recorded: only the index's own timestamp can tell the file is racily clean.
  writeFileSync(file, before.replace(/^./, "X"));
  utimesSync(file, when, when);
  await sleep(1100);
  assert.deepEqual(changedPaths(stagedDiff(repo, wt, base).text), [{ path: "README.md", status: "M" }]);
});

test("ignoredChanged counts the ignored files whose status changed since a time, by their first path segment, and no file that git does not ignore", () => {
  const { repo, wt } = withWorktree();
  writeFileSync(join(wt, ".gitignore"), "build/\n*.local\nnode_modules/\n");
  mkdirSync(join(wt, "build", "deep"), { recursive: true });
  writeFileSync(join(wt, "build", "deep", "a.js"), "x\n");
  writeFileSync(join(wt, "build", "b.js"), "x\n");
  writeFileSync(join(wt, "run.local"), "x\n");
  mkdirSync(join(wt, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(wt, "node_modules", "pkg", "i.js"), "x\n");
  // A worker can set the modification time of its own file back, but not the time its status changed.
  utimesSync(join(wt, "node_modules", "pkg", "i.js"), new Date(2000, 0, 1), new Date(2000, 0, 1));
  writeFileSync(join(wt, "plain.txt"), "not ignored\n");
  assert.deepEqual(ignoredChanged(repo, wt, Date.now() - 60_000), [{ path: "build/", files: 2 }, { path: "node_modules/", files: 1 }, { path: "run.local", files: 1 }]);
  assert.deepEqual(ignoredChanged(repo, wt, Date.now() + 60_000), [], "nothing changed after a later time");
});

test("ignoredChanged counts a path it cannot read as changed, and passes no error on", () => {
  const { repo, wt } = withWorktree();
  writeFileSync(join(wt, ".gitignore"), "build/\n");
  mkdirSync(join(wt, "build", "sub"), { recursive: true });
  writeFileSync(join(wt, "build", "sub", "a.js"), "x\n");
  // A directory that can be listed and not searched: git names its file, and looking at the file fails with EACCES.
  chmodSync(join(wt, "build", "sub"), 0o600);
  try {
    assert.deepEqual(ignoredChanged(repo, wt, Date.now() + 60_000), [{ path: "build/", files: 1 }], "what cannot be shown unchanged counts, whatever the time");
  } finally {
    chmodSync(join(wt, "build", "sub"), 0o755);
  }
});

test("a staging removes what a killed one left in the staging directory an hour ago or more, and keeps a newer one", () => {
  const { repo, wt, base } = withWorktree();
  const stages = join(home, "stage");
  mkdirSync(join(stages, "s-killed", "objects", "ab"), { recursive: true });
  writeFileSync(join(stages, "s-killed", "objects", "ab", "tmp_obj_1"), "left\n");
  mkdirSync(join(stages, "s-running"));
  const old = new Date(Date.now() - 2 * 3_600_000);
  utimesSync(join(stages, "s-killed"), old, old);
  diffStat(repo, wt, base);
  assert.deepEqual(readdirSync(stages), ["s-running"]);
  rmSync(join(stages, "s-running"), { recursive: true });
});

test("staging reads the files whatever the user's configuration trusts of the stat data an index holds", async () => {
  for (const [key, value] of [["core.ignoreStat", "true"], ["core.trustctime", "false"], ["core.checkStat", "minimal"]]) {
    const repo = tempRepo();
    must(repo, "config", key, value);
    const base = revParse(repo, "HEAD");
    const wt = join(owned(), "task");
    addWorktree(repo, wt, "wip/task", base);
    // A checkout that is not racy any more: the file is ten seconds older than the index that records it.
    const file = join(wt, "README.md");
    const past = new Date(Date.now() - 10_000);
    utimesSync(file, past, past);
    must(wt, "-c", "core.ignoreStat=false", "update-index", "--really-refresh");
    // The same size, the same inode and the recorded modification time: only the change time moved, which git reads in whole
    // seconds, so a second goes by first.
    await sleep(1100);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace(/\w/, (c) => (c === "z" ? "y" : "z")));
    utimesSync(file, past, past);
    assert.match(diffStat(repo, wt, base), /README\.md/, `${key}=${value}`);
  }
});

test("staging a worktree whose index is split reads the whole of it, and leaves no shared index in the git directory", () => {
  const repo = tempRepo();
  must(repo, "config", "core.splitIndex", "true");
  const base = revParse(repo, "HEAD");
  const wt = join(owned(), "task");
  addWorktree(repo, wt, "wip/task", base);
  must(wt, "update-index", "--split-index");
  const admin = must(wt, "rev-parse", "--absolute-git-dir").trim();
  const shared = () => readdirSync(admin).filter((n) => n.startsWith("sharedindex.")).sort();
  assert.ok(shared().length > 0, "the index is split");
  const before = shared();
  writeFileSync(join(wt, "README.md"), "changed\n");
  writeFileSync(join(wt, "new.txt"), "new\n");
  assert.match(diffStat(repo, wt, base), /README\.md[\s\S]*new\.txt/);
  assert.deepEqual(shared(), before, "nothing was written beside the worker's own index");
});

test("staging works in a repository whose path holds a colon, as the alternate object directory is quoted", () => {
  const colon = join(temp(), "a:b");
  mkdirSync(colon);
  must(colon, "init", "-q", "-b", "main");
  must(colon, "config", "user.name", "Test");
  must(colon, "config", "user.email", "test@example.invalid");
  writeFileSync(join(colon, "README.md"), "temp repo\n");
  must(colon, "add", "README.md");
  must(colon, "commit", "-q", "-m", "Initial commit");
  const base = revParse(colon, "HEAD");
  const wt = join(owned(), "task");
  addWorktree(colon, wt, "wip/task", base);
  writeFileSync(join(wt, "README.md"), "changed\n");
  assert.match(diffStat(colon, wt, base), /README\.md/);
  // The apply reads the blobs of the index through the same alternate directory.
  const patch = patchOf(colon, wt, base);
  const other = join(owned(), "other");
  addWorktree(colon, other, "wip/other", base);
  applyToIndex(colon, other, patch);
  assert.equal(read(join(other, "README.md")), "changed\n");
});

test("ignoredChanged goes by a link's own status time and not by the file it leads to", async () => {
  const { repo, wt } = withWorktree();
  writeFileSync(join(wt, ".gitignore"), "cache/\n");
  mkdirSync(join(wt, "cache"));
  const target = join(temp(), "old.txt");
  writeFileSync(target, "old\n");
  await sleep(60);
  const since = Date.now();
  await sleep(60);
  symlinkSync(target, join(wt, "cache", "link"));
  assert.deepEqual(ignoredChanged(repo, wt, since), [{ path: "cache/", files: 1 }]);
});

// A repository that holds agent files of its own, and a task worktree at its first commit.
function withAgentFiles(attributes = ""): { repo: string; wt: string; base: string } {
  const repo = tempRepo();
  mkdirSync(join(repo, ".codex"), { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "rules\n");
  writeFileSync(join(repo, ".codex", "config.toml"), "model = \"x\"\n");
  const tracked = ["AGENTS.md", ".codex/config.toml"];
  if (attributes !== "") {
    writeFileSync(join(repo, ".gitattributes"), attributes);
    tracked.push(".gitattributes");
  }
  must(repo, "add", "--", ...tracked);
  must(repo, "commit", "-q", "-m", "Add agent files");
  const base = revParse(repo, "HEAD");
  const wt = join(owned(), "task");
  addWorktree(repo, wt, "wip/task", base);
  return { repo, wt, base };
}

const NAMES = [".codex", "AGENTS.md", "CLAUDE.md", ".agents", "GEMINI.md"];

test("pathsAwayFromBase lists what a worktree holds under the named entries that its base commit does not hold as it is", () => {
  const { repo, wt, base } = withAgentFiles();
  const away = () => pathsAwayFromBase(repo, wt, base, NAMES).sort();
  assert.deepEqual(away(), [], "the repository's own files, as they are");
  assert.deepEqual(pathsAwayFromBase(repo, wt, base, []), [], "no entry named");
  writeFileSync(join(wt, ".codex", "extra.toml"), "x\n");
  writeFileSync(join(wt, "CLAUDE.md"), "x\n");
  assert.deepEqual(away(), [".codex/extra.toml", "CLAUDE.md"], "a file the base lacks, in a directory it has or beside it");
  // A path git ignores is as much in the way: the next tool reads it all the same.
  writeFileSync(join(wt, ".gitignore"), ".agents/\nGEMINI.md\n");
  mkdirSync(join(wt, ".agents"));
  writeFileSync(join(wt, ".agents", "s.md"), "x\n");
  writeFileSync(join(wt, "GEMINI.md"), "x\n");
  assert.deepEqual(away(), [".agents", ".codex/extra.toml", "CLAUDE.md", "GEMINI.md"], "an entry the base lacks is named by itself");
  rmSync(join(wt, ".codex", "extra.toml"));
  rmSync(join(wt, "CLAUDE.md"));
  rmSync(join(wt, ".agents"), { recursive: true });
  rmSync(join(wt, "GEMINI.md"));
  assert.deepEqual(away(), []);
  // A tracked file that was changed is no longer the repository's own, and one that was removed plants nothing.
  writeFileSync(join(wt, "AGENTS.md"), "new rules\n");
  assert.deepEqual(away(), ["AGENTS.md"]);
  writeFileSync(join(wt, "AGENTS.md"), "rules\n");
  assert.deepEqual(away(), []);
  unlinkSync(join(wt, ".codex", "config.toml"));
  assert.deepEqual(away(), [], "a removed file is not planted");
});

test("pathsAwayFromBase sees a tracked file that became a link, and a change that the worker's own index hides", () => {
  const { repo, wt, base } = withAgentFiles();
  const away = () => pathsAwayFromBase(repo, wt, base, NAMES).sort();
  unlinkSync(join(wt, "AGENTS.md"));
  symlinkSync("/etc/hosts", join(wt, "AGENTS.md"));
  assert.deepEqual(away(), ["AGENTS.md"], "a link in place of the file");
  unlinkSync(join(wt, "AGENTS.md"));
  writeFileSync(join(wt, "AGENTS.md"), "rules\n");
  assert.deepEqual(away(), []);
  // The worker can tell its own git to stop looking at a file, or at its place in the tree.
  writeFileSync(join(wt, "AGENTS.md"), "steer\n");
  must(wt, "update-index", "--assume-unchanged", "AGENTS.md");
  writeFileSync(join(wt, ".codex", "config.toml"), "mcp\n");
  must(wt, "update-index", "--skip-worktree", ".codex/config.toml");
  assert.deepEqual(must(wt, "status", "--porcelain"), "", "the worker's own git shows nothing");
  assert.deepEqual(away(), [".codex/config.toml", "AGENTS.md"]);
});

test("pathsAwayFromBase names an entry the base lacks by its name alone, whatever its contents let git list, and fails closed on a directory it cannot read", () => {
  const { repo, wt, base } = withAgentFiles();
  const away = () => pathsAwayFromBase(repo, wt, base, NAMES).sort();
  // A directory the base lacks, that can be searched and not listed: git lists nothing, and the file is still opened by name.
  mkdirSync(join(wt, ".agents"));
  writeFileSync(join(wt, ".agents", "hooks.json"), "{}\n");
  chmodSync(join(wt, ".agents"), 0o311);
  try {
    assert.deepEqual(away(), [".agents"]);
  } finally {
    chmodSync(join(wt, ".agents"), 0o755);
  }
  rmSync(join(wt, ".agents"), { recursive: true });
  // A file that git does not list at all, a pipe.
  spawnSync("/usr/bin/mkfifo", [join(wt, "GEMINI.md")]);
  assert.deepEqual(away(), ["GEMINI.md"]);
  unlinkSync(join(wt, "GEMINI.md"));
  // A directory the base holds, with an unreadable one inside it that holds a new file.
  mkdirSync(join(wt, ".codex", "sub"));
  writeFileSync(join(wt, ".codex", "sub", "hooks.json"), "{}\n");
  chmodSync(join(wt, ".codex", "sub"), 0o311);
  try {
    assert.deepEqual(away(), [".codex/sub"]);
  } finally {
    chmodSync(join(wt, ".codex", "sub"), 0o755);
  }
  rmSync(join(wt, ".codex", "sub"), { recursive: true });
  assert.deepEqual(away(), []);
});

test("pathsAwayFromBase ignores the executable bit, reads names as they are, and sees a file the worker staged in its own index", () => {
  const { repo, wt, base } = withAgentFiles();
  chmodSync(join(wt, "AGENTS.md"), 0o755);
  assert.deepEqual(pathsAwayFromBase(repo, wt, base, NAMES), [], "a mode alone is no content a tool reads");
  chmodSync(join(wt, "AGENTS.md"), 0o644);
  // A name that holds a glob character names that file and no other: the base tracks claude.*.md, and a file the glob would
  // match lies untracked beside it.
  const globbed = tempRepo();
  writeFileSync(join(globbed, "claude.*.md"), "rules\n");
  must(globbed, "add", "--", ":(literal)claude.*.md");
  must(globbed, "commit", "-q", "-m", "Add a name with a glob");
  const globBase = revParse(globbed, "HEAD");
  const globWt = join(owned(), "task");
  addWorktree(globbed, globWt, "wip/task", globBase);
  writeFileSync(join(globWt, "claude.x.md"), "x\n");
  assert.deepEqual(pathsAwayFromBase(globbed, globWt, globBase, ["claude.*.md"]), []);
  // The worker's own git is told to hold what it added, and it is still away from the base.
  writeFileSync(join(wt, ".codex", "extra.toml"), "x\n");
  must(wt, "add", "-f", ".codex/extra.toml");
  assert.deepEqual(pathsAwayFromBase(repo, wt, base, NAMES), [".codex/extra.toml"]);
});

test("pathsAwayFromBase reads a base with thousands of tracked files under an agent directory", () => {
  const repo = tempRepo();
  mkdirSync(join(repo, ".claude"));
  const long = "x".repeat(100);
  for (let i = 0; i < 7000; i++) writeFileSync(join(repo, ".claude", `${String(i).padStart(5, "0")}${long}`), "a\n");
  must(repo, "add", ".claude");
  must(repo, "commit", "-q", "-m", "Add many");
  const base = revParse(repo, "HEAD");
  const wt = join(owned(), "task");
  addWorktree(repo, wt, "wip/task", base);
  assert.deepEqual(pathsAwayFromBase(repo, wt, base, [".claude"]), []);
  writeFileSync(join(wt, ".claude", `00042${long}`), "changed\n");
  assert.deepEqual(pathsAwayFromBase(repo, wt, base, [".claude"]), [`.claude/00042${long}`]);
});

test("pathsAwayFromBase reads a file as the repository's own rules for line endings do, so a checkout with them is not a change", () => {
  const { repo, wt, base } = withAgentFiles("AGENTS.md text eol=crlf\n");
  assert.equal(readFileSync(join(wt, "AGENTS.md"), "utf8"), "rules\r\n", "the checkout converted it");
  assert.deepEqual(pathsAwayFromBase(repo, wt, base, NAMES), []);
  writeFileSync(join(wt, "AGENTS.md"), "other\r\n");
  assert.deepEqual(pathsAwayFromBase(repo, wt, base, NAMES), ["AGENTS.md"]);
});

const objectIds = (repo: string): string[] =>
  execFileSync("git", ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean).sort();

test("staging for a read leaves the repository's objects and the worker's index as they were, and nothing of its own behind", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(wt, "new.txt"), "a worker's file\n");
  writeFileSync(join(wt, "README.md"), "changed by the worker\n");
  const blob = execFileSync("git", ["hash-object", "new.txt"], { cwd: wt, encoding: "utf8" }).trim();
  const adminIndex = join(execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: wt, encoding: "utf8" }).trim(), "index");
  const objects = objectIds(repo);
  const index = readFileSync(adminIndex);
  const staged = stagedDiff(repo, wt, base);
  assert.deepEqual(changedPaths(staged.text).map((c) => c.path).sort(), ["README.md", "new.txt"]);
  assert.match(diffStat(repo, wt, base), /new\.txt +\| 1 \+/);
  assert.match(diffSinceBaseBytes(repo, wt, base).toString(), /\+a worker's file/);
  assert.deepEqual(objectIds(repo), objects, "no object was written into the repository");
  assert.equal(spawnSync("git", ["cat-file", "-e", blob], { cwd: repo }).status, 1, "the worker's file is in no object store of the repository");
  assert.ok(readFileSync(adminIndex).equals(index), "the worker's index is as it was");
  assert.deepEqual(readdirSync(join(process.env.MANDOR_HOME!, "stage")), [], "no private directory stays");
});

test("a worktree whose .git names a fake repository outside the mandor home never runs its core.fsmonitor", () => {
  const { repo, wt, base } = withWorktree();
  const main = revParse(repo, "refs/heads/main");
  // Outside the home, where a worker sandbox may also write (/tmp, $TMPDIR, an add-dir).
  const markers = temp();
  plantFakeRepository(repo, wt, base, join(temp(), "fc"), `\tfsmonitor = ${markerScript(markers, "fsmonitor")}\n`);
  writeFileSync(join(wt, "a.txt"), "a\n");
  // Every hardened call works on the real worktree, and none runs the fake config's fsmonitor.
  const bytes = diffSinceBaseBytes(repo, wt, base);
  assert.deepEqual(ran(markers), []);
  assert.deepEqual(changedPaths(bytes.toString()), [{ path: "a.txt", status: "A" }]);
  assert.deepEqual(changedPaths(diffSinceBase(repo, wt, base)), [{ path: "a.txt", status: "A" }]);
  assert.match(diffStat(repo, wt, base), /^ a\.txt \| 1 \+$/m);
  assert.equal(isClean(repo, wt), false);
  const patch = join(temp(), "accepted.patch");
  writeFileSync(patch, bytes);
  rmSync(join(wt, "a.txt")); // staging for a read stages nothing in the worktree, so the reset has nothing to take away
  resetHardHead(repo, wt);
  assert.equal(applyCheck(repo, wt, patch), true);
  applyToIndex(repo, wt, patch);
  resetHardHead(repo, wt);
  assert.deepEqual(apply3way(repo, wt, patch), { applied: true, conflicted: [] });
  resetTo(repo, wt, base);
  assert.equal(isClean(repo, wt), true);
  assert.deepEqual(ran(markers), []);
  assert.equal(revParse(repo, "refs/heads/main"), main);
});

test("commitStaged on an integration worktree whose .git names a fake repository runs none of its hooks", () => {
  const { repo, wt, base } = withIntegration();
  const markers = temp();
  const hooks = temp();
  for (const name of ["pre-commit", "commit-msg", "post-commit"]) {
    writeFileSync(join(hooks, name), `#!/bin/sh\ntouch '${join(markers, `${name}.ran`)}'\n`, { mode: 0o755 });
  }
  // The integration worktree's .git is rewritten to a fake repository, with an identity and hooks of its own.
  plantFakeRepository(repo, wt, base, join(temp(), "fc"), `\thooksPath = ${hooks}\n[user]\n\tname = Test\n\temail = test@example.invalid\n`);
  writeFileSync(join(wt, "a.txt"), "a\n");
  // What an accept does: the patch goes into the index of the integration worktree, which a commit then reads.
  const patch = join(temp(), "accepted.patch");
  writeFileSync(patch, diffSinceBaseBytes(repo, wt, base));
  rmSync(join(wt, "a.txt"));
  applyToIndex(repo, wt, patch);
  const sha = commitStaged(repo, wt, ["a.txt"], "Add a", true);
  assert.deepEqual(ran(markers), []);
  assert.equal(revParse(repo, "refs/heads/goal"), sha);
  assert.equal(must(repo, "log", "-1", "--format=%s", sha), "Add a\n");
});

// git fires these around index changes, reads and commits; any one firing means a worker hook ran.
const HOOK_NAMES = ["post-index-change", "reference-transaction", "post-checkout", "pre-applypatch", "post-applypatch", "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"];

test("a relative core.hooksPath in the user's config runs no worker hook in the hardened calls", () => {
  const repo = tempRepo();
  // The husky pattern: a relative hooksPath git resolves against the worktree root, which the worker controls.
  must(repo, "config", "core.hooksPath", ".husky/_");
  const base = revParse(repo, "HEAD");
  const markers = temp();
  let n = 0;
  // A fresh worktree per call, with the worker's hooks planted, so a "no fire" is never stale state.
  const attacked = (): string => {
    const wt = join(owned(), `husky${n}`);
    addWorktree(repo, wt, `wip/husky${n++}`, base);
    mkdirSync(join(wt, ".husky", "_"), { recursive: true });
    for (const h of HOOK_NAMES) writeFileSync(join(wt, ".husky", "_", h), `#!/bin/sh\ntouch '${join(markers, `${h}.ran`)}'\n`, { mode: 0o755 });
    return wt;
  };
  const clear = () => { for (const f of readdirSync(markers)) rmSync(join(markers, f)); };
  const noHook = (label: string, f: () => void) => { clear(); f(); assert.deepEqual(ran(markers), [], label); };

  // The attack is live: a plain git add in such a worktree fires the worker's post-index-change.
  const live = attacked();
  writeFileSync(join(live, "p.txt"), "p\n");
  must(live, "add", "-A");
  assert.ok(ran(markers).length > 0, "the relative hooksPath attack is not live");

  // A patch to feed the apply calls, built in a worktree without the attack.
  const src = join(owned(), "src");
  addWorktree(repo, src, "wip/src", base);
  writeFileSync(join(src, "applied.txt"), "x\n");
  const patch = join(temp(), "p.patch");
  writeFileSync(patch, diffSinceBaseBytes(repo, src, base));

  for (const call of [diffSinceBaseBytes, diffStat, isClean]) {
    const wt = attacked();
    writeFileSync(join(wt, "u.txt"), "u\n");
    noHook(call.name, () => call(repo, wt, base));
  }
  for (const call of [applyCheck, applyToIndex, apply3way]) {
    noHook(call.name, () => call(repo, attacked(), patch));
  }
  noHook("resetHardHead", () => resetHardHead(repo, attacked()));
  noHook("resetTo", () => resetTo(repo, attacked(), base));
  // dropLastCommit needs a clean worktree, so commit the hooks and one more commit to drop.
  const drop = attacked();
  must(drop, "add", "-A");
  must(drop, "commit", "-qm", "hooks");
  writeFileSync(join(drop, "extra.txt"), "e\n");
  must(drop, "add", "extra.txt");
  must(drop, "commit", "-qm", "extra");
  noHook("dropLastCommit", () => dropLastCommit(repo, drop, revParse(drop, "HEAD")));
});

test("a hardened call refuses when the empty-hooks directory is not empty", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(wt, "u.txt"), "u\n");
  const hooks = join(home, "empty-hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
  assert.throws(() => diffSinceBase(repo, wt, base), /empty-hooks is not empty/);
  // commitStaged keeps the user's hooks, so it does not consult empty-hooks.
  unlinkSync(join(hooks, "pre-commit"));
});

test("commitStaged refuses a worktree on a wip/ branch", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(wt, "a.txt"), "a\n");
  must(wt, "add", "a.txt");
  assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", true), /HEAD is refs\/heads\/wip\/task, not an integration branch/);
  assert.equal(revParse(wt, "HEAD"), base);
  assert.equal(must(wt, "status", "--porcelain"), "A  a.txt\n");
});

test("commitStaged refuses a detached HEAD", () => {
  const { repo, wt, base } = withIntegration();
  writeFileSync(join(wt, "a.txt"), "a\n");
  must(wt, "add", "a.txt");
  must(wt, "checkout", "-q", "--detach");
  assert.throws(() => commitStaged(repo, wt, ["a.txt"], "Add a", true), /HEAD is detached, not an integration branch/);
  assert.equal(revParse(wt, "HEAD"), base);
  assert.equal(must(wt, "status", "--porcelain"), "A  a.txt\n");
});

// A patch for the apply calls of `bound`, built before the repo carries a driver: a bound call refuses one afterwards.
function patchBeforeDrivers(repo: string, base: string): string {
  const src = join(owned(), "src");
  addWorktree(repo, src, "wip/src", base);
  writeFileSync(join(src, "p.txt"), "x\n");
  return patchOf(repo, src, base);
}

test("a filter or merge driver with a worktree-relative command is refused by every bound call", () => {
  const { repo, wt, base } = withWorktree();
  const patch = patchBeforeDrivers(repo, base);
  // The user's own config names worktree-relative driver commands (the ./tools/*.sh husky or lfs mistake).
  must(repo, "config", "filter.foo.clean", "./tools/clean.sh");
  must(repo, "config", "filter.foo.smudge", "./tools/smudge.sh");
  must(repo, "config", "merge.bar.driver", "./tools/merge.sh %O %A %B");
  const markers = temp();
  mkdirSync(join(wt, "tools"));
  for (const s of ["clean", "smudge", "merge"]) writeFileSync(join(wt, "tools", `${s}.sh`), `#!/bin/sh\ntouch '${join(markers, `${s}.ran`)}'\ncat\n`, { mode: 0o755 });
  writeFileSync(join(wt, ".gitattributes"), "*.dat filter=foo\nmerged.txt merge=bar\n");
  writeFileSync(join(wt, "data.dat"), "payload\n");
  for (const call of bound) assert.throws(() => call(repo, wt, patch), /defines .*filter\.foo\.clean.*merge\.bar\.driver; filter and merge drivers are not supported/);
  assert.deepEqual(ran(markers), []);
});

test("a driver with an absolute or a bare command is refused by every bound call too, until it is removed", () => {
  const { repo, wt, base } = withWorktree();
  const patch = patchBeforeDrivers(repo, base);
  const clean = join(temp(), "clean.sh");
  writeFileSync(clean, "#!/bin/sh\ncat\n", { mode: 0o755 });
  for (const [key, value] of [["filter.foo.clean", clean], ["merge.bar.driver", "true some/path %A"], ["filter.baz.process", "git-lfs filter-process"]]) {
    must(repo, "config", key, value);
    for (const call of bound) assert.throws(() => call(repo, wt, patch), new RegExp(`defines ${key.replaceAll(".", "\\.")}; filter and merge drivers are not supported`), key);
    must(repo, "config", "--unset", key);
    assert.doesNotThrow(() => isClean(repo, wt), key);
  }
});

test("a driver that only the worktree's configuration defines is refused by every bound call", () => {
  const { repo, wt, base } = withWorktree();
  const patch = patchBeforeDrivers(repo, base);
  // The include applies while HEAD is a wip/ branch, as in every task worktree, and not in the main checkout.
  const include = join(temp(), "drivers.gitconfig");
  writeFileSync(include, '[filter "foo"]\n\tclean = /bin/cat\n');
  must(repo, "config", "includeIf.onbranch:wip/**.path", include);
  assert.deepEqual(configuredDrivers(repo), []);
  for (const call of bound) assert.throws(() => call(repo, wt, patch), /defines filter\.foo\.clean; filter and merge drivers are not supported/);
});

test("a driver that only the worktree's own configuration file defines is refused by every bound call", () => {
  const { repo, wt, base } = withWorktree();
  const patch = patchBeforeDrivers(repo, base);
  must(repo, "config", "core.repositoryformatversion", "1");
  must(repo, "config", "extensions.worktreeConfig", "true");
  must(wt, "config", "--worktree", "filter.foo.clean", "/bin/cat");
  assert.deepEqual(configuredDrivers(repo), []);
  for (const call of bound) assert.throws(() => call(repo, wt, patch), /defines filter\.foo\.clean; filter and merge drivers are not supported/);
});

// In a partial clone git fetches an object it lacks from the remote by itself, which no command of mandor may start.
const PROMISOR_KEYS = [["extensions.partialclone", "origin"], ["remote.origin.promisor", "true"]];

test("a promisor remote is refused by every bound call, whichever key marks it, until it is removed", () => {
  const { repo, wt, base } = withWorktree();
  const patch = patchBeforeDrivers(repo, base);
  for (const [key, value] of PROMISOR_KEYS) {
    must(repo, "config", key, value);
    assert.deepEqual(configuredPromisors(repo), [key], key);
    for (const call of bound) assert.throws(() => call(repo, wt, patch), new RegExp(`defines ${key.replaceAll(".", "\\.")}; a partial clone is not supported`), key);
    must(repo, "config", "--unset", key);
    assert.deepEqual(configuredPromisors(repo), [], key);
    assert.doesNotThrow(() => isClean(repo, wt), key);
  }
  // The filter alone makes no remote one that git fetches from.
  must(repo, "config", "remote.origin.partialclonefilter", "blob:none");
  assert.deepEqual(configuredPromisors(repo), []);
  assert.doesNotThrow(() => isClean(repo, wt));
});

test("a promisor remote that only the worktree's configuration defines is refused by every bound call", () => {
  const { repo, wt, base } = withWorktree();
  const patch = patchBeforeDrivers(repo, base);
  const include = join(temp(), "promisor.gitconfig");
  writeFileSync(include, '[remote "origin"]\n\tpromisor = true\n');
  must(repo, "config", "includeIf.onbranch:wip/**.path", include);
  assert.deepEqual(configuredPromisors(repo), []);
  for (const call of bound) assert.throws(() => call(repo, wt, patch), /defines remote\.origin\.promisor; a partial clone is not supported/);
});

test("a bound call reads the configuration through the worktree's admin dir, not through its own .git file", () => {
  const { repo, wt, base } = withWorktree();
  const patch = patchBeforeDrivers(repo, base);
  must(repo, "config", "filter.foo.clean", "/bin/cat");
  // A worker may rewrite the pointer file of its worktree to name a repository that holds no driver.
  writeFileSync(join(wt, ".git"), `gitdir: ${join(tempRepo(), ".git")}\n`);
  for (const call of bound) assert.throws(() => call(repo, wt, patch), /defines filter\.foo\.clean; filter and merge drivers are not supported/);
});

test("a configuration that cannot be read refuses every bound call", () => {
  const { repo, wt, base } = withWorktree();
  const patch = patchBeforeDrivers(repo, base);
  const broken = join(temp(), "broken.gitconfig");
  writeFileSync(broken, "[filter\n");
  // Read only where HEAD is a wip/ branch, so the main checkout still reads its configuration.
  must(repo, "config", "includeIf.onbranch:wip/**.path", broken);
  assert.deepEqual(configuredDrivers(repo), []);
  for (const call of bound) assert.throws(() => call(repo, wt, patch), /cannot read the git config of /);
});

test("a GIT_CONFIG in the environment does not hide the drivers that git itself reads", () => {
  const { repo, wt, base } = withWorktree();
  const patch = patchBeforeDrivers(repo, base);
  must(repo, "config", "filter.foo.clean", "/bin/cat");
  withEnv({ GIT_CONFIG: "/dev/null" }, () => {
    assert.deepEqual(configuredDrivers(repo), ["filter.foo.clean"]);
    for (const call of bound) assert.throws(() => call(repo, wt, patch), /defines filter\.foo\.clean; filter and merge drivers are not supported/);
  });
});

test("a new worktree is checked out bound and confined, so a driver that only its configuration defines never runs", () => {
  const repo = tempRepo();
  writeFileSync(join(repo, ".gitattributes"), "data.txt filter=foo\n");
  writeFileSync(join(repo, "data.txt"), "data\n");
  must(repo, "add", ".gitattributes", "data.txt");
  must(repo, "commit", "-qm", "Add data");
  const markers = temp();
  const smudge = join(temp(), "smudge.sh");
  writeFileSync(smudge, `#!/bin/sh\ntouch '${join(markers, "smudge.ran")}'\ncat\n`, { mode: 0o755 });
  const include = join(temp(), "drivers.gitconfig");
  writeFileSync(include, `[filter "foo"]\n\tsmudge = ${smudge}\n`);
  // Read only while HEAD is a wip/ branch, so the main checkout shows no driver and the worktree does.
  must(repo, "config", "includeIf.onbranch:wip/**.path", include);
  assert.deepEqual(configuredDrivers(repo), []);
  assert.throws(() => addWorktree(repo, join(owned(), "task"), "wip/task", revParse(repo, "HEAD")), /defines filter\.foo\.smudge; filter and merge drivers are not supported/);
  assert.deepEqual(ran(markers), []);
});

test("creating a worktree checks every tracked file out and runs none of the repository's checkout hooks", () => {
  const repo = tempRepo();
  writeFileSync(join(repo, "f.txt"), "x\n");
  must(repo, "add", "f.txt");
  must(repo, "commit", "-qm", "Add f");
  const markers = temp();
  const wt = join(owned(), "task");
  hook(repo, "post-checkout", `touch '${join(markers, "post-checkout.ran")}'`);
  // The checkout runs confined, where only the worktree can be written, so the marker of this hook lies there.
  hook(repo, "post-index-change", `touch '${join(wt, "post-index-change.ran")}'`);
  configuredHook(repo, "mark", join(wt, "configured.ran"), ["post-index-change"]);
  addWorktree(repo, wt, "wip/task", revParse(repo, "HEAD"));
  assert.equal(readFileSync(join(wt, "f.txt"), "utf8"), "x\n");
  assert.equal(isClean(repo, wt), true);
  assert.equal(must(wt, "symbolic-ref", "HEAD").trim(), "refs/heads/wip/task");
  assert.deepEqual(ran(markers), []);
  assert.deepEqual([existsSync(join(wt, "post-index-change.ran")), existsSync(join(wt, "configured.ran"))], [false, false]);
});

test("a new worktree is created under submodule.recurse with an initialized submodule", () => {
  const sub = tempRepo();
  const repo = tempRepo();
  must(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
  must(repo, "commit", "-qm", "Add the submodule");
  must(repo, "config", "submodule.recurse", "true");
  const wt = join(owned(), "task");
  addWorktree(repo, wt, "wip/task", revParse(repo, "HEAD"));
  assert.equal(existsSync(join(wt, ".gitmodules")), true);
  resetHardHead(repo, wt);
  assert.equal(isClean(repo, wt), true);
});

test("both steps of a worktree creation carry the tag that a reservation looks for", async () => {
  const repo = tempRepo();
  const wt = join(owned(), "task");
  const fake = join(temp(), "bin");
  mkdirSync(fake);
  const real = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  // The confined checkout stops here, as a command killed in the middle of it would leave it.
  writeFileSync(join(fake, "git"), `#!/bin/sh\ncase " $* " in *" read-tree "*) sleep 30; exit 1;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const code = `import { addWorktree } from ${JSON.stringify(new URL("../src/git.ts", import.meta.url).href)}; addWorktree(${JSON.stringify(repo)}, ${JSON.stringify(wt)}, "wip/task", "HEAD");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, PATH: `${fake}:${process.env.PATH}` }, stdio: "ignore", detached: true });
  try {
    let command = "";
    for (const end = Date.now() + 20_000; !command.includes("read-tree") && Date.now() < end; await sleep(100)) {
      const pid = worktreeAddRunning(wt);
      command = pid === null ? "" : spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
    }
    assert.ok(command.includes("read-tree"), "the process of the checkout shows the tag");
  } finally {
    process.kill(-child.pid!, "SIGKILL");
  }
});

// A hook defined in the configuration (git 2.54 and later) is not found in the hooks directory that the bound calls empty.
// It touches the marker. Returns whether this git runs such hooks: an older one ignores the keys and runs nothing.
function configuredHook(repo: string, name: string, marker: string, events: string[]): boolean {
  must(repo, "config", `hook.${name}.command`, `cat >/dev/null; touch '${marker}'`);
  for (const event of events) must(repo, "config", "--add", `hook.${name}.event`, event);
  return spawnSync("git", ["hook", "list", events[0]], { cwd: repo, encoding: "utf8" }).stdout.includes(name);
}

test("a hook that the configuration defines runs in no bound call, whatever its name, and runs in the commit of an accept", () => {
  const { repo, wt, base } = withWorktree();
  // The confined calls can write only the worktree, so the markers lie there. A name may hold an equals sign.
  const marks = ["mark", "a=b"].map((name, i) => ({ name, file: join(wt, `${i}.ran`) }));
  for (const m of marks) configuredHook(repo, m.name, m.file, ["post-index-change", "reference-transaction"]);
  writeFileSync(join(wt, "a.txt"), "a\n");
  isClean(repo, wt);
  diffStat(repo, wt, base);
  stagedDiff(repo, wt, base);
  diffSinceBaseBytes(repo, wt, base);
  resetHardHead(repo, wt);
  for (const m of marks) assert.equal(existsSync(m.file), false, m.name);
  // A ref moved by a bound call fires the reference-transaction hooks too.
  const int = withIntegration();
  writeFileSync(join(int.wt, "a.txt"), "a\n");
  must(int.wt, "add", "a.txt");
  must(int.wt, "commit", "-qm", "Add a");
  const moved = join(int.wt, "moved.ran");
  configuredHook(int.repo, "mark", moved, ["reference-transaction"]);
  dropLastCommit(int.repo, int.wt, revParse(int.wt, "HEAD"));
  assert.equal(existsSync(moved), false);
  const accepted = temp();
  const control = configuredHook(int.repo, "control", join(accepted, "control.ran"), ["post-commit"]);
  writeFileSync(join(int.wt, "b.txt"), "b\n");
  must(int.wt, "add", "b.txt");
  commitStaged(int.repo, int.wt, ["b.txt"], "Add b", true);
  if (control) assert.deepEqual(ran(accepted), ["control.ran"]);
});

test("a signing program that is a path relative to the worktree is refused at the commit, and an absolute or a bare one is not", () => {
  const { repo, wt } = withIntegration();
  const markers = temp();
  writeFileSync(join(wt, "a.txt"), "a\n");
  writeFileSync(join(wt, "sign.sh"), `#!/bin/sh\ntouch '${join(markers, "sign.ran")}'\nexit 1\n`, { mode: 0o755 });
  must(wt, "add", "a.txt", "sign.sh");
  must(repo, "config", "commit.gpgSign", "true");
  // The program of each format, a tilde (git before 2.51 does not expand it), and the command for the default ssh key.
  for (const [key, value] of [["gpg.program", "./sign.sh"], ["gpg.openpgp.program", "./sign.sh"], ["gpg.x509.program", "bin/sign.sh"],
    ["gpg.ssh.program", "~/bin/sign"], ["gpg.ssh.defaultKeyCommand", "./sign.sh --flag"]]) {
    must(repo, "config", key, value);
    assert.throws(() => commitStaged(repo, wt, ["a.txt", "sign.sh"], "Add a", true), new RegExp(`config ${key.toLowerCase().replaceAll(".", "\\.")} "${value.replaceAll(".", "\\.")}" is relative to the worktree`), key);
    must(repo, "config", "--unset", key);
  }
  assert.deepEqual(ran(markers), []);
  // A bare name is looked up on the PATH, which is scrubbed of relative entries, and an absolute path is the user's own.
  must(repo, "config", "commit.gpgSign", "false");
  must(repo, "config", "gpg.program", "gpg");
  must(repo, "config", "gpg.ssh.program", "/usr/bin/ssh-keygen");
  must(repo, "config", "gpg.ssh.defaultKeyCommand", "ssh-add -L");
  commitStaged(repo, wt, ["a.txt", "sign.sh"], "Add a", true);
});

test("a relative or empty PATH entry cannot run a worktree script named as a bare driver command", () => {
  const { repo, wt } = withWorktree();
  // A git call that is not bound does not refuse a bare driver; the PATH scrub is what keeps it from resolving inside the worktree.
  must(repo, "config", "filter.foo.clean", "evilcmd");
  const markers = temp();
  writeFileSync(join(wt, "evilcmd"), `#!/bin/sh\ntouch '${join(markers, "evil.ran")}'\ncat\n`, { mode: 0o755 });
  writeFileSync(join(wt, ".gitattributes"), "*.dat filter=foo\n");
  writeFileSync(join(wt, "data.dat"), "payload\n");
  // '.' and the empty entry both mean the current directory; without the scrub, evilcmd resolves to ./evilcmd.
  withEnv({ PATH: `.:${delimiter}${process.env.PATH}` }, () => git(["add", "-A"], wt));
  assert.deepEqual(ran(markers), []);
});

test("a nested repository inside the worktree runs none of its config in the hardened calls", () => {
  const { repo, wt, base } = withWorktree();
  // Inside the worktree, where even the confined calls may write, so a hook or filter that runs can leave its mark.
  const markers = join(wt, "markers");
  mkdirSync(markers);
  // A nested repository tracked as a gitlink, carrying a worker-written fsmonitor and a clean filter it uses.
  const sub = join(wt, "sub");
  mkdirSync(sub);
  must(sub, "init", "-q", "-b", "main");
  must(sub, "config", "user.name", "T");
  must(sub, "config", "user.email", "t@example.invalid");
  must(sub, "config", "core.fsmonitor", markerScript(markers, "fsmonitor"));
  must(sub, "config", "filter.x.clean", `sh -c 'touch "${join(markers, "filter.ran")}"; cat'`);
  writeFileSync(join(sub, ".gitattributes"), "* filter=x\n");
  writeFileSync(join(sub, "f.txt"), "f\n");
  must(sub, "add", "-A");
  must(sub, "commit", "-qm", "sub");
  must(wt, "add", "sub");
  must(wt, "commit", "-qm", "Add gitlink");
  writeFileSync(join(sub, "dirty.txt"), "d\n"); // leaves the nested work tree dirty
  // A future mtime forces git to re-stat the gitlink, so any command that inspects it does so every time (not raced).
  const touch = () => utimesSync(sub, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  touch();
  // The attack is live: a plain status that inspects submodules fires the nested fsmonitor.
  must(wt, "status", "--ignore-submodules=none");
  assert.ok(ran(markers).length > 0, "the nested repository is not inspected by a plain recursive status");

  const other = join(owned(), "other");
  addWorktree(repo, other, "wip/other", revParse(repo, "HEAD"));
  writeFileSync(join(other, "applied.txt"), "x\n");
  const patch = join(temp(), "p.patch");
  writeFileSync(patch, diffSinceBaseBytes(repo, other, revParse(repo, "HEAD")));

  for (const [label, f] of [
    ["diffSinceBaseBytes", () => diffSinceBaseBytes(repo, wt, base)],
    ["diffStat", () => diffStat(repo, wt, base)],
    ["isClean", () => isClean(repo, wt)],
    ["apply3way", () => apply3way(repo, wt, patch)],
  ] as [string, () => void][]) {
    for (const g of readdirSync(markers)) rmSync(join(markers, g));
    touch();
    f();
    assert.deepEqual(ran(markers), [], label);
  }
});

test("resetTo removes a nested repository left in the worktree", () => {
  const { repo, wt, base } = withWorktree();
  // An untracked nested repository: clean -fd would leave it, clean -ffd removes it.
  const sub = join(wt, "sub");
  mkdirSync(sub);
  must(sub, "init", "-q");
  writeFileSync(join(sub, "f.txt"), "f\n");
  writeFileSync(join(wt, "task.txt"), "t\n");
  resetTo(repo, wt, base);
  assert.equal(existsSync(sub) || existsSync(join(wt, "task.txt")), false);
  assert.equal(isClean(repo, wt), true);
});

test("resetTo refuses a worktree whose HEAD is not a wip/ branch", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(wt, "a.txt"), "a\n");
  must(wt, "add", "a.txt");
  must(wt, "commit", "-qm", "Add a");
  must(wt, "checkout", "-q", "-b", "feature");
  const feature = revParse(wt, "HEAD");
  assert.throws(() => resetTo(repo, wt, base), /HEAD is refs\/heads\/feature, not a wip\/ branch/);
  must(wt, "checkout", "-q", "--detach");
  assert.throws(() => resetTo(repo, wt, base), /HEAD is detached, not a wip\/ branch/);
  assert.equal(revParse(repo, "refs/heads/feature"), feature);
  // Back on its wip/ branch, the reset goes through.
  must(wt, "checkout", "-q", "wip/task");
  resetTo(repo, wt, base);
  assert.equal(revParse(wt, "HEAD"), base);
});

test("an inherited GIT_INDEX_FILE cannot make diffSinceBase rewrite the user's index", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(repo, "staged.txt"), "s\n");
  must(repo, "add", "staged.txt");
  writeFileSync(join(wt, "task.txt"), "t\n");
  const diff = withEnv({ GIT_INDEX_FILE: join(repo, ".git", "index") }, () => diffSinceBase(repo, wt, base));
  assert.deepEqual(changedPaths(diff), [{ path: "task.txt", status: "A" }]);
  assert.equal(must(repo, "status", "--porcelain"), "A  staged.txt\n");
});

test("a mandor home spelled in another case still owns its worktrees", (t) => {
  const upper = home.toUpperCase();
  if (!existsSync(upper)) return t.skip("the file system is case-sensitive");
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(wt, "task.txt"), "t\n");
  // realpathSync keeps the spelling it is given, and only the native call returns the one on disk.
  assert.equal(realpathSync(upper), upper);
  assert.equal(realpathSync.native(upper), home);
  withEnv({ MANDOR_HOME: upper }, () => {
    assert.deepEqual(changedPaths(diffSinceBase(repo, wt, base)), [{ path: "task.txt", status: "A" }]);
    resetTo(repo, wt, base);
  });
  assert.equal(existsSync(join(wt, "task.txt")), false);
});

test("isClean counts an untracked file even with status.showUntrackedFiles=no, and ignores ignored files", () => {
  const { repo, wt } = withWorktree();
  must(repo, "config", "status.showUntrackedFiles", "no");
  writeFileSync(join(repo, ".git", "info", "exclude"), "ignored.txt\n");
  writeFileSync(join(wt, "ignored.txt"), "i\n");
  assert.equal(isClean(repo, wt), true);
  mkdirSync(join(wt, "new"));
  writeFileSync(join(wt, "new", "untracked.txt"), "u\n");
  // The config hides the file from a plain status.
  assert.equal(must(wt, "status", "--porcelain"), "");
  assert.equal(isClean(repo, wt), false);
  rmSync(join(wt, "new"), { recursive: true });
  writeFileSync(join(wt, "README.md"), "edit\n");
  assert.equal(isClean(repo, wt), false);
  assert.throws(() => isClean(temp(), wt), /rev-parse/);
});

test("diffStat lists an untracked new file", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(wt, "new.txt"), "n\n");
  const stat = diffStat(repo, wt, base);
  assert.match(stat, /^ new\.txt \| 1 \+$/m);
  assert.match(stat, /1 file changed, 1 insertion\(\+\)/);
});

// A git earlier on PATH that logs every call and then runs the real one, followed by a command of the test's choosing.
function wrappedGit(after: string): { path: string; calls: () => string[] } {
  const dir = temp();
  const log = join(dir, "calls");
  const real = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "git"), `#!/bin/sh\necho "$*" >> "${log}"\n"${real}" "$@"\ncode=$?\n${after}\nexit $code\n`, { mode: 0o755 });
  return { path: `${dir}${delimiter}${process.env.PATH}`, calls: () => read(log).split("\n").filter(Boolean) };
}

test("stagedDiff stages once, so its patch and its text hold the same change", () => {
  const { repo, wt, base } = withWorktree();
  const notes = join(wt, "notes.txt");
  writeFileSync(notes, "first\n");
  // A process left in the worktree could rewrite the file at any moment, here right after each read of the staged change.
  const fake = wrappedGit(`case "$*" in *diff-tree*) echo second > "${notes}";; esac`);
  const { bytes, text } = withEnv({ PATH: fake.path }, () => stagedDiff(repo, wt, base));
  const calls = fake.calls();
  const adds = calls.filter((c) => / add -A /.test(c));
  const trees = calls.filter((c) => c.endsWith(" write-tree"));
  const diffs = calls.filter((c) => c.includes(" diff-tree "));
  assert.deepEqual([adds.length, trees.length, diffs.length], [1, 1, 3], calls.join("\n"));
  assert.ok(calls.indexOf(adds[0]) < calls.indexOf(trees[0]) && calls.indexOf(trees[0]) < calls.indexOf(diffs[0]), "stages, then fixes the tree, then reads");
  for (const view of [bytes.toString(), text]) {
    assert.match(view, /^\+first$/m);
    assert.doesNotMatch(view, /second/);
  }
});

test("stagedDiff's two views come from one tree, even when the index is rewritten between them", () => {
  const { repo, wt, base } = withWorktree();
  const notes = join(wt, "notes.txt");
  writeFileSync(notes, "notes\na line the guards must read\n");
  // A process that can write the worktree's index gives it the clean form right after the patch was read.
  const real = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  const fake = wrappedGit(`case "$*" in *--binary*) echo notes > "${notes}"; ( unset GIT_DIR GIT_WORK_TREE; cd "${wt}" && "${real}" add notes.txt );; esac`);
  const { bytes, text } = withEnv({ PATH: fake.path }, () => stagedDiff(repo, wt, base));
  assert.match(bytes.toString(), /^\+a line the guards must read$/m);
  assert.match(text, /^\+a line the guards must read$/m);
});

test("stagedDiff's patch is byte-exact and its text shows what a -diff entry or a NUL byte hides", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(wt, ".gitattributes"), "hidden.txt -diff\n");
  writeFileSync(join(wt, "hidden.txt"), "a hidden line\n");
  writeFileSync(join(wt, "nul.txt"), "a\0b\nbeside a NUL\n");
  writeFileSync(join(wt, "latin1.txt"), Buffer.from("caf\xe9\n", "latin1"));
  const { bytes, text } = stagedDiff(repo, wt, base);
  for (const line of ["a hidden line", "beside a NUL"]) {
    assert.ok(text.includes(`+${line}\n`), line);
    assert.ok(!bytes.includes(line), line);
  }
  assert.ok(bytes.includes(Buffer.from("+caf\xe9\n", "latin1")));
  assert.deepEqual(changedPaths(text).map((c) => c.path), [".gitattributes", "hidden.txt", "latin1.txt", "nul.txt"]);
  // The same bytes the index-side diff gives, which the other callers read.
  assert.deepEqual(bytes, diffSinceBaseBytes(repo, wt, base));
  // The patch applies as it is, and the tree written from it is the one the worktree staged.
  const target = join(owned(), "integration");
  addWorktree(repo, target, "wip/integration", base);
  const patch = join(temp(), "accepted.patch");
  writeFileSync(patch, bytes);
  applyToIndex(repo, target, patch);
  assert.equal(indexTree(repo, target), stagedDiff(repo, wt, base).tree);
  assert.deepEqual(readFileSync(join(target, "latin1.txt")), Buffer.from("caf\xe9\n", "latin1"));
});

test("removeOwnedWorktree removes a worktree whose .git the worker rewrote, deleted or replaced", () => {
  const repo = tempRepo();
  const base = revParse(repo, "HEAD");
  const root = temp();
  const decoy = tempRepo();
  const decoyHead = revParse(decoy, "HEAD");
  const shapes: Record<string, (dotGit: string) => void> = {
    decoy: (g) => writeFileSync(g, `gitdir: ${join(decoy, ".git")}\n`),
    garbage: (g) => writeFileSync(g, "not a pointer\n"),
    deleted: (g) => rmSync(g),
    directory: (g) => {
      rmSync(g);
      mkdirSync(join(g, "hooks"), { recursive: true });
      writeFileSync(join(g, "config"), "[core]\n\trepositoryformatversion = 0\n");
    },
    link: (g) => {
      rmSync(g);
      symlinkSync(join(decoy, ".git"), g);
    },
  };
  for (const [name, plant] of Object.entries(shapes)) {
    const wt = join(root, name);
    plainAdd(repo, wt, `wip/${name}`, base);
    plant(join(wt, ".git"));
    removeOwnedWorktree(repo, wt, `wip/${name}`, root);
    assert.equal(existsSync(wt), false, name);
    assert.equal(branches(repo).includes(`wip/${name}`), false, name);
  }
  assert.equal(must(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
  assert.equal(revParse(decoy, "HEAD"), decoyHead);
  assert.equal(must(decoy, "status", "--porcelain"), "");
  assert.ok(existsSync(join(decoy, ".git", "HEAD")), "a link at .git is removed, never followed");
});

test("removing a worktree never writes through a link that a process left in it keeps planting at .git", async () => {
  const repo = tempRepo();
  const base = revParse(repo, "HEAD");
  const root = temp();
  const victim = join(tempRepo(), ".git", "config");
  const before = read(victim);
  // Ends by itself once the worktree is gone, or after 30 s.
  const survivor = `
    const fs = require("fs");
    const [dotGit, victim, ready] = process.argv.slice(1);
    fs.writeFileSync(ready, "");
    for (const end = Date.now() + 30000; Date.now() < end;) {
      try { fs.unlinkSync(dotGit); } catch {}
      try { fs.symlinkSync(victim, dotGit); } catch (e) { if (e.code === "ENOENT") process.exit(0); }
    }`;
  for (let i = 0; i < 25; i++) {
    const wt = join(root, `w${i}`);
    plainAdd(repo, wt, `wip/w${i}`, base);
    const ready = join(root, `ready-${i}`);
    const child = spawn(process.execPath, ["-e", survivor, join(wt, ".git"), victim, ready], { stdio: "ignore" });
    let refused = false;
    try {
      while (!existsSync(ready)) await sleep(2);
      await sleep(5);
      try {
        removeOwnedWorktree(repo, wt, null, root);
      } catch {
        refused = true; // the removal fails closed
      }
    } finally {
      child.kill("SIGKILL");
    }
    assert.equal(read(victim), before, `try ${i} wrote through the link`);
    assert.ok(refused || !existsSync(wt), `try ${i} neither removed the worktree nor said so`);
  }
});

// Swaps a directory for a link to a victim and back in a tight loop, each step on its own, so a removal that takes the
// link or the directory does not stop it. The sub is relative, so it keeps swapping even if the removal renames the
// worktree first; its cwd is the worktree. Ends by itself after 30 s.
const swapper = `
  const fs = require("fs");
  const [sub, victim, ready] = process.argv.slice(1);
  const aside = sub + ".held";
  const quiet = (f) => { try { f(); } catch {} };
  fs.writeFileSync(ready, "");
  for (const end = Date.now() + 30000; Date.now() < end;) {
    quiet(() => fs.renameSync(sub, aside));
    quiet(() => fs.symlinkSync(victim, sub));
    quiet(() => fs.unlinkSync(sub));
    quiet(() => fs.renameSync(aside, sub));
  }`;

for (const [shape, sub, before] of [
  ["a directory of its content", "sub", () => {}],
  ["a directory inside a forged .git", ".git/sub", (wt: string) => rmSync(join(wt, ".git"))],
] as const) {
  test(`removing a worktree never deletes through a link swapped in for ${shape}`, async () => {
    const repo = tempRepo();
    const base = revParse(repo, "HEAD");
    const root = temp();
    const victim = temp();
    // The same names on both sides, so a walk that listed the directory unlinks them through the link.
    const names = Array.from({ length: 200 }, (_, k) => `keep-${k}`);
    for (const n of names) writeFileSync(join(victim, n), "precious\n");
    for (let i = 0; i < 40; i++) {
      const wt = join(root, `w${i}`);
      plainAdd(repo, wt, `wip/w${i}`, base);
      before(wt);
      mkdirSync(join(wt, sub), { recursive: true });
      for (const n of names) writeFileSync(join(wt, sub, n), "x\n");
      const ready = join(root, `ready-${i}`);
      // cwd is the worktree and sub is relative, the survivor a left-behind process is: a rename cannot shake it off.
      const child = spawn(process.execPath, ["-e", swapper, sub, victim, ready], { cwd: wt, stdio: "ignore" });
      try {
        while (!existsSync(ready)) await sleep(1);
        await sleep(1);
        try {
          removeOwnedWorktree(repo, wt, null, root);
        } catch {} // a removal that fails closed is fine here
      } finally {
        child.kill("SIGKILL");
      }
      assert.equal(readdirSync(victim).length, names.length, `round ${i} deleted outside the worktree`);
      assert.ok(names.every((n) => read(join(victim, n)) === "precious\n"), `round ${i} changed a file outside the worktree`);
    }
  });
}

// A repo whose src/ holds committed files plus one uncommitted edit: the user's own checkout, the victim an escaping
// write would reach. Returns a snapshot function over it.
function victimCheckout(): { repo: string; base: string; names: string[]; snap: () => string[] } {
  const repo = tempRepo();
  const names = Array.from({ length: 100 }, (_, k) => `keep-${k}`);
  mkdirSync(join(repo, "src"));
  for (const n of names) writeFileSync(join(repo, "src", n), `${n}\n`);
  must(repo, "add", "src");
  must(repo, "commit", "-qm", "Add sources");
  const base = revParse(repo, "HEAD"); // the tree the worktrees check out and reset to, so a reset writes these files
  writeFileSync(join(repo, "src", "keep-0"), "uncommitted\n"); // nothing else holds this; a reset through a link loses it
  const snap = () => readdirSync(join(repo, "src")).sort().map((n) => `${n}:${read(join(repo, "src", n))}`);
  return { repo, base, names, snap };
}

test("resetTo never reaches the user's files through a link a survivor swaps in", async () => {
  const { repo, base, names, snap } = victimCheckout();
  const before = snap();
  for (let i = 0; i < 40; i++) {
    const wt = join(owned(), `w${i}`);
    addWorktree(repo, wt, `wip/w${i}`, base); // src/ is tracked here, checked out from base
    // Every tracked file dirtied, so reset --hard rewrites all of them, and one untracked file for clean to remove;
    // through the swapped link each write or delete would reach the victim.
    for (const n of names) writeFileSync(join(wt, "src", n), "dirty\n");
    writeFileSync(join(wt, "src", "untracked"), "u\n");
    const ready = join(home, `ready-reset-${i}`);
    const child = spawn(process.execPath, ["-e", swapper, "src", join(repo, "src"), ready], { cwd: wt, stdio: "ignore" });
    try {
      while (!existsSync(ready)) await sleep(1);
      await sleep(1);
      try { resetTo(repo, wt, base); } catch {} // a confined reset that fails closed is fine here
    } finally { child.kill("SIGKILL"); }
    assert.deepEqual(snap(), before, `round ${i} reached the user's checkout`);
  }
});

test("apply3way never reaches the user's files through a link a survivor swaps in", async () => {
  const { repo, base, names, snap } = victimCheckout();
  const before = snap();
  // A patch that adds a file under src/ for each name, built in a clean worktree. An add writes a fresh path, so a
  // swapped link makes the apply create it in the victim.
  const src = join(owned(), "patch-src");
  addWorktree(repo, src, "wip/patch-src", base); // src/ tracked, from base
  for (const n of names) writeFileSync(join(src, "src", `add-${n}`), "added\n");
  const patch = join(temp(), "edit.patch");
  writeFileSync(patch, diffSinceBaseBytes(repo, src, base));
  for (let i = 0; i < 40; i++) {
    const wt = join(owned(), `a${i}`);
    addWorktree(repo, wt, `wip/a${i}`, base);
    const ready = join(home, `ready-apply-${i}`);
    const child = spawn(process.execPath, ["-e", swapper, "src", join(repo, "src"), ready], { cwd: wt, stdio: "ignore" });
    try {
      while (!existsSync(ready)) await sleep(1);
      await sleep(1);
      try { apply3way(repo, wt, patch); } catch {} // a confined apply that fails closed is fine here
    } finally { child.kill("SIGKILL"); }
    assert.deepEqual(snap(), before, `round ${i} reached the user's checkout`);
  }
});

test("a confined apply keeps a planted link or a forged object out of the repository's store", () => {
  const { repo, wt, base } = withWorktree();
  const src = join(owned(), "patch-src");
  addWorktree(repo, src, "wip/patch-src", base);
  writeFileSync(join(src, "added.txt"), "added\n");
  const patch = join(temp(), "add.patch");
  writeFileSync(patch, diffSinceBaseBytes(repo, src, base));
  const victim = temp();
  writeFileSync(join(victim, "secret"), "precious\n");
  const forgedOid = "cd" + "0".repeat(38);
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = temp();
  // A git on PATH that, when the confined apply runs, plants in the quarantine a fanout dir that is a link to the
  // victim, and a forged object under a real dir, then runs the real git. Both run inside the sandbox, which lets the
  // quarantine be written. migrateObjects must then refuse the forged object and never follow the link.
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    'if [ -n "$GIT_OBJECT_DIRECTORY" ] && printf "%s\\n" "$@" | grep -qx apply; then',
    `  ln -s '${victim}' "$GIT_OBJECT_DIRECTORY/ab" 2>/dev/null`,
    `  mkdir -p "$GIT_OBJECT_DIRECTORY/cd" && printf forged > "$GIT_OBJECT_DIRECTORY/${forgedOid.slice(0, 2)}/${forgedOid.slice(2)}"`,
    "fi",
    `exec '${realGit}' "$@"`,
  ].join("\n") + "\n", { mode: 0o755 });
  withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => {
    assert.throws(() => applyToIndex(repo, wt, patch), /not the loose object it is named for/);
  });
  assert.equal(read(join(victim, "secret")), "precious\n");
  assert.equal(existsSync(join(repo, ".git", "objects", forgedOid.slice(0, 2), forgedOid.slice(2))), false);
});

test("a confined write fails closed, and changes nothing, when the sandbox cannot apply", () => {
  const { repo, wt, base } = withWorktree();
  writeFileSync(join(wt, "untracked.txt"), "u\n");
  const script = `
    const { resetTo } = await import(${JSON.stringify(join(import.meta.dirname, "..", "src", "git.ts"))});
    try { resetTo(process.env.R, process.env.W, process.env.B); console.log("RAN-UNCONFINED"); }
    catch (e) { console.log("THREW: " + e.message); }`;
  // An outer seatbelt sandbox the lead could be started under: the inner sandbox-exec then cannot apply.
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", process.execPath, "--input-type=module", "-e", script],
    { env: { ...process.env, R: repo, W: wt, B: base }, encoding: "utf8" });
  assert.match(r.stdout, /THREW: cannot confine git read-tree/);
  assert.doesNotMatch(r.stdout, /RAN-UNCONFINED/);
  assert.equal(read(join(wt, "untracked.txt")), "u\n"); // nothing was reset
});

test("a tree that cannot be removed leaves the worktree registered, and says so", () => {
  const repo = tempRepo();
  const base = revParse(repo, "HEAD");
  const root = temp();
  const wt = join(root, "stuck");
  plainAdd(repo, wt, "wip/stuck", base);
  mkdirSync(join(wt, "sealed"));
  // rm names the file it could not remove, and the worker chose that name: a C1 introducer here. An ACL that denies the
  // removal is what removeTree does not clear, as a mode or a flag it does.
  const stuck = join(wt, "sealed", "a\u009b2Jb.txt");
  writeFileSync(stuck, "a\n");
  spawnSync("/bin/chmod", ["+a", "everyone deny delete", stuck]);
  try {
    assert.throws(() => removeOwnedWorktree(repo, wt, "wip/stuck", root), (e: Error) => /could not remove .*stuck: .*a\?2Jb\.txt/.test(e.message) && !/[\x00-\x1f\x7f-\x9f]/.test(e.message));
    assert.ok(existsSync(join(repo, ".git", "worktrees", "stuck")), "the admin dir stays with the tree");
    assert.ok(branches(repo).includes("wip/stuck"), "and so does the branch");
  } finally {
    spawnSync("/bin/chmod", ["-N", stuck]);
  }
  removeOwnedWorktree(repo, wt, "wip/stuck", root);
  assert.deepEqual([existsSync(wt), existsSync(join(repo, ".git", "worktrees", "stuck")), branches(repo).includes("wip/stuck")], [false, false, false]);
});

test("removeOwnedWorktree clears a locked worktree, a registered one whose directory is gone, and a directory git does not know", () => {
  const repo = tempRepo();
  const base = revParse(repo, "HEAD");
  const root = temp();
  const admin = (name: string) => join(repo, ".git", "worktrees", name);

  const locked = join(root, "locked");
  plainAdd(repo, locked, "wip/locked", base);
  writeFileSync(join(admin("locked"), "locked"), "initializing");
  removeOwnedWorktree(repo, locked, "wip/locked", root);
  assert.deepEqual([existsSync(locked), existsSync(admin("locked"))], [false, false]);

  const gone = join(root, "gone");
  plainAdd(repo, gone, "wip/gone", base);
  writeFileSync(join(admin("gone"), "locked"), "initializing");
  rmSync(gone, { recursive: true });
  removeOwnedWorktree(repo, gone, null, root);
  assert.equal(existsSync(admin("gone")), false);

  const stray = join(root, "stray");
  mkdirSync(join(stray, "sub"), { recursive: true });
  writeFileSync(join(stray, "sub", "a.txt"), "a\n");
  removeOwnedWorktree(repo, stray, null, root);
  assert.equal(existsSync(stray), false);

  // A kill before the add wrote HEAD leaves an admin dir git will not accept as a repository.
  const early = join(root, "early");
  plainAdd(repo, early, "wip/early", base);
  rmSync(join(admin("early"), "HEAD"));
  writeFileSync(join(admin("early"), "locked"), "initializing");
  assert.throws(() => must(repo, "worktree", "remove", "--force", "--force", early));
  removeOwnedWorktree(repo, early, null, root);
  assert.deepEqual([existsSync(early), existsSync(admin("early"))], [false, false]);

  // Nothing there at all is nothing to do, and a link is removed rather than followed.
  removeOwnedWorktree(repo, join(root, "never"), null, root);
  const target = temp();
  writeFileSync(join(target, "keep.txt"), "k\n");
  symlinkSync(join(root, "missing"), join(root, "dangling"));
  removeOwnedWorktree(repo, join(root, "dangling"), null, root);
  assert.equal(lstatSync(join(root, "dangling"), { throwIfNoEntry: false }), undefined);

  // The refusals still come first, for a missing path too.
  assert.throws(() => removeOwnedWorktree(repo, join(target, "missing"), null, root), /not under/);
  assert.throws(() => removeOwnedWorktree(repo, join(root, "x"), "goal", root), /not a wip\/ branch/);
  assert.equal(must(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
});

test("deleteBranchAt deletes a branch only from the commit it was made at", () => {
  const repo = tempRepo();
  const base = revParse(repo, "HEAD");
  assert.equal(branchExists(repo, "wip/none"), false);
  deleteBranchAt(repo, "wip/none", base); // nothing there is nothing to do

  must(repo, "branch", "wip/still", base);
  assert.equal(branchExists(repo, "wip/still"), true);
  deleteBranchAt(repo, "wip/still", base);
  assert.equal(branchExists(repo, "wip/still"), false);

  const moved = must(repo, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "Work on it").trim();
  must(repo, "branch", "wip/moved", moved);
  assert.throws(() => deleteBranchAt(repo, "wip/moved", base), /wip\/moved/);
  assert.equal(revParse(repo, "refs/heads/wip/moved"), moved);

  // Outside wip/ it refuses before it looks, whatever the commit.
  must(repo, "branch", "goal", base);
  assert.throws(() => deleteBranchAt(repo, "goal", base), /not a wip\/ branch/);
  assert.equal(branchExists(repo, "goal"), true);
});

test("configuredDrivers lists what the config defines and fails closed on everything else", () => {
  const repo = tempRepo();
  withEnv({ GIT_CONFIG_GLOBAL: join(temp(), "none"), GIT_CONFIG_NOSYSTEM: "1" }, () => {
    assert.deepEqual(configuredDrivers(repo), []);
    must(repo, "config", "filter.lfs.smudge", "git-lfs smudge");
    must(repo, "config", "merge.ours.driver", "true");
    assert.deepEqual(configuredDrivers(repo).sort(), ["filter.lfs.smudge", "merge.ours.driver"]);
    must(repo, "config", "--unset", "filter.lfs.smudge");
    must(repo, "config", "--unset", "merge.ours.driver");

    // A git that cannot run, one killed by a signal, and an exit 1 that says something are not "no such key".
    assert.throws(() => withEnv({ PATH: temp() }, () => configuredDrivers(repo)), /cannot read the git config/);
    for (const script of ['kill -9 $$', 'echo "fatal: no" >&2; exit 1', "exit 7"]) {
      const dir = temp();
      writeFileSync(join(dir, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      assert.throws(() => withEnv({ PATH: `${dir}${delimiter}${process.env.PATH}` }, () => configuredDrivers(repo)), /cannot read the git config/, script);
    }
  });
});

test("indexLockPath names the lock of the worktree's own index", () => {
  const { repo, wt } = withWorktree();
  assert.equal(indexLockPath(repo, wt), join(must(wt, "rev-parse", "--absolute-git-dir").trim(), "index.lock"));
});

// A process the worker leaves behind is granted its own worktree root by the sandbox, so it can empty that root and put
// a symlink at its name pointing at a sibling task worktree or the integration worktree. The lead must name a worktree
// by its constructed path (the parent resolved, the final name taken as given) and never resolve through a swapped root.
for (const kind of ["sibling", "integration"] as const) {
  test(`a worktree root swapped for a link to ${kind === "sibling" ? "a sibling" : "the integration"} worktree is removed as the link only, and bound calls refuse`, () => {
    const repo = tempRepo();
    const base = revParse(repo, "HEAD");
    const root = owned(); // under the mandor home, as mandor places its worktrees
    const a = join(root, "a");
    const b = join(root, "b");
    const bBranch = kind === "integration" ? "goal" : "wip/b";
    addWorktree(repo, a, "wip/a", base);
    addWorktree(repo, b, bBranch, base);
    // B holds a committed file and a live uncommitted one: a removal or reset that followed the link would lose them.
    writeFileSync(join(b, "kept.txt"), "precious\n");
    must(b, "add", "kept.txt");
    must(b, "commit", "-qm", "B work");
    writeFileSync(join(b, "live.txt"), "live\n");
    const bHead = revParse(b, "HEAD");
    const bAdmin = must(b, "rev-parse", "--absolute-git-dir").trim();
    rmSync(a, { recursive: true });
    symlinkSync(b, a); // the swapped root
    // Every bound call refuses, naming the path, rather than acting on B through the link.
    for (const call of bound) assert.throws(() => call(repo, a, base), /its root .* is not a directory/);
    assert.equal(revParse(b, "HEAD"), bHead);
    assert.equal(must(b, "status", "--porcelain"), "?? live.txt\n");
    // Removal takes the link only: B's tree, its files and its admin dir survive; A's admin dir and branch go.
    removeOwnedWorktree(repo, a, "wip/a", root);
    assert.equal(lstatSync(a, { throwIfNoEntry: false }), undefined, "the link is gone");
    assert.equal(read(join(b, "kept.txt")), "precious\n");
    assert.equal(read(join(b, "live.txt")), "live\n");
    assert.equal(revParse(b, "HEAD"), bHead);
    assert.ok(existsSync(bAdmin), "B's admin dir stays");
    assert.equal(existsSync(join(repo, ".git", "worktrees", "a")), false, "A's admin dir is removed");
    assert.equal(branches(repo).includes("wip/a"), false);
    assert.ok(branches(repo).includes(bBranch));
  });
}

test("a worktree named in another case than its root entry is refused at the root, never resolved", (t) => {
  const { repo, wt, base } = withWorktree();
  const shouted = join(dirname(wt), basename(wt).toUpperCase());
  if (!existsSync(shouted)) return t.skip("the file system is case-sensitive");
  writeFileSync(join(wt, "task.txt"), "t\n");
  // lstat finds the entry under either spelling; only its real path shows it is not the path that was constructed.
  for (const call of bound) assert.throws(() => call(repo, shouted, base), /its root .* is not a directory at its own path/);
  assert.equal(must(wt, "status", "--porcelain", "--untracked-files=all"), "?? task.txt\n");
});

test("a root that goes away between its entry check and its realpath is refused like a replaced one", (t) => {
  const { wt } = withWorktree();
  const native = fs.realpathSync.native;
  // The entry is gone after lstat saw it and before its real path is read, as a process swapping the root can make it.
  t.mock.method(fs.realpathSync, "native", ((p: fs.PathLike) => {
    if (p === wt) rmSync(wt, { recursive: true });
    return native(p);
  }) as typeof native);
  assert.throws(() => worktreeRoot(wt), /^Error: refusing .*: its root .* is not a directory at its own path; it was replaced or removed: run mandor status, and tell the user$/);
});

// Swaps a worktree's own root for a link to the sibling B and back, so a confined reset or apply that computed its path
// before the swap writes through the link. Ends by itself after 30 s.
const rootSwapper = `
  const fs = require("fs");
  const [a, target, ready] = process.argv.slice(1);
  const aside = a + ".aside";
  const quiet = (f) => { try { f(); } catch {} };
  fs.writeFileSync(ready, "");
  for (const end = Date.now() + 30000; Date.now() < end;) {
    quiet(() => fs.renameSync(a, aside));
    quiet(() => fs.symlinkSync(target, a));
    quiet(() => fs.unlinkSync(a));
    quiet(() => fs.renameSync(aside, a));
  }`;

test("a root swapped for a link to a sibling during a confined reset or apply reaches no sibling", async () => {
  const repo = tempRepo();
  const base = revParse(repo, "HEAD");
  const root = owned(); // under the mandor home, as mandor places its worktrees
  const b = join(root, "b"); // the sibling victim: tracked files plus one uncommitted edit only it holds
  addWorktree(repo, b, "wip/b", base);
  const names = Array.from({ length: 50 }, (_, k) => `keep-${k}`);
  mkdirSync(join(b, "src"));
  for (const n of names) writeFileSync(join(b, "src", n), `${n}\n`);
  must(b, "add", "src");
  must(b, "commit", "-qm", "B sources");
  writeFileSync(join(b, "src", "keep-0"), "uncommitted\n");
  const snap = () => readdirSync(join(b, "src")).sort().map((n) => `${n}:${read(join(b, "src", n))}`);
  const before = snap();
  // A patch that adds a file under src/ for each name, for the apply arm.
  const patchSrc = join(root, "patch");
  addWorktree(repo, patchSrc, "wip/patch", base);
  mkdirSync(join(patchSrc, "src"), { recursive: true });
  for (const n of names) writeFileSync(join(patchSrc, "src", `add-${n}`), "added\n");
  const patch = join(temp(), "edit.patch");
  writeFileSync(patch, diffSinceBaseBytes(repo, patchSrc, base));
  for (let i = 0; i < 20; i++) {
    const a = join(root, `a${i}`);
    addWorktree(repo, a, `wip/a${i}`, base);
    writeFileSync(join(a, "untracked"), "u\n"); // something for a followed reset or apply to touch
    const ready = join(home, `ready-root-${i}`);
    const child = spawn(process.execPath, ["-e", rootSwapper, a, b, ready], { stdio: "ignore" });
    try {
      while (!existsSync(ready)) await sleep(1);
      await sleep(1);
      try {
        if (i % 2 === 0) resetTo(repo, a, base);
        else apply3way(repo, a, patch);
      } catch {} // a confined call that fails closed, or refuses the swapped root, is fine here
    } finally {
      child.kill("SIGKILL");
    }
    assert.deepEqual(snap(), before, `round ${i} reached the sibling`);
  }
});

// rerere would record a 3-way conflict's resolution by writing MERGE_RR in the admin dir, which the sandbox denies,
// so a real conflict reads as a patch that did not apply. A bare rr-cache dir enables it even with no config set.
test("apply3way reports a real conflict even when rerere is enabled by config or a bare rr-cache", () => {
  for (const trigger of ["config", "rr-cache"] as const) {
    const { repo, base, task, goal } = forked();
    if (trigger === "config") must(repo, "config", "rerere.enabled", "true");
    else mkdirSync(join(repo, ".git", "rr-cache"));
    writeFileSync(join(task, "f.txt"), tenWith({ 5: "task" }));
    const patch = patchOf(repo, task, base);
    writeFileSync(join(goal, "f.txt"), tenWith({ 5: "goal" }));
    must(goal, "commit", "-qam", "Edit goal");
    assert.deepEqual(apply3way(repo, goal, patch), { applied: true, conflicted: ["f.txt"] }, trigger);
    assert.match(read(join(goal, "f.txt")), /^<<<<<<< [^]*\ngoal\n[^]*\ntask\n>>>>>>> /m, trigger);
  }
});

// A real loose object: git deflates "blob <len>\0<content>" and names it by the hash of that.
function looseObject(content: string): { oid: string; raw: Buffer } {
  const r = temp();
  must(r, "init", "-q");
  const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: r, input: content, encoding: "utf8" }).trim();
  return { oid, raw: readFileSync(join(r, ".git", "objects", oid.slice(0, 2), oid.slice(2))) };
}

test("migrateObjects replaces a truncated object left in the store rather than trusting it", () => {
  const { oid, raw } = looseObject("payload for migrate\n");
  const from = temp();
  const to = temp();
  const [fan, rest] = [oid.slice(0, 2), oid.slice(2)];
  mkdirSync(join(from, fan), { recursive: true });
  writeFileSync(join(from, fan, rest), raw); // the good object in the quarantine
  mkdirSync(join(to, fan), { recursive: true });
  writeFileSync(join(to, fan, rest), raw.subarray(0, 3)); // a truncated leftover from a killed migration
  migrateObjects(from, to);
  assert.deepEqual(readFileSync(join(to, fan, rest)), raw, "the truncated object was replaced with the full one");
});

test("migrateObjects writes through a temp name, so a truncated object never sits under the final name", () => {
  const { oid, raw } = looseObject("another payload\n");
  const from = temp();
  const to = temp();
  const [fan, rest] = [oid.slice(0, 2), oid.slice(2)];
  mkdirSync(join(from, fan), { recursive: true });
  writeFileSync(join(from, fan, rest), raw);
  mkdirSync(join(to, fan), { recursive: true });
  const dst = join(to, fan, rest);
  writeFileSync(dst, raw.subarray(0, 5));
  chmodSync(dst, 0o444); // a read-only truncated final: only a temp-then-rename can replace it, never a write in place
  try {
    migrateObjects(from, to);
    assert.deepEqual(readFileSync(dst), raw);
    assert.deepEqual(readdirSync(join(to, fan)).sort(), [rest], "no temp file is left beside the final object");
  } finally {
    chmodSync(dst, 0o644);
  }
});

test("a failed object write leaves nothing under the final name, and no temp, which is named like git's own", (t) => {
  const { oid, raw } = looseObject("payload for a failed write\n");
  const from = temp();
  const to = temp();
  const [fan, rest] = [oid.slice(0, 2), oid.slice(2)];
  mkdirSync(join(from, fan), { recursive: true });
  writeFileSync(join(from, fan, rest), raw);
  const temps: string[] = [];
  // The rename into place fails, as an EIO or a full disk could make it, after the temp was written.
  const rename = t.mock.method(fs, "renameSync", (src: fs.PathLike) => {
    temps.push(basename(String(src)));
    throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
  });
  syncBuiltinESMExports(); // git.ts imports renameSync by name
  try {
    assert.throws(() => migrateObjects(from, to), /injected rename failure/);
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(temps.length, 1);
  // git's fsck passes over a tmp_obj_ file and its prune removes one once stale, so a temp a kill leaves is git's to clear.
  assert.match(temps[0], /^tmp_obj_/);
  assert.deepEqual(readdirSync(join(to, fan)), [], "neither an object under the final name nor a temp is left");
});
