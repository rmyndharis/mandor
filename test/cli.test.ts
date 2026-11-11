import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { TOOL_COMMANDS } from "../src/toolname.ts";
import { temp } from "./helpers.ts";

const root = join(import.meta.dirname, "..");
const launcher = join(root, "bin", "mandor");
const manifest = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8"));
const packageVersion: string = manifest("package.json").version;

// A release has one version: package.json is what --version prints, and the plugin manifest is what Claude Code reads.
test("the plugin manifest and the lock file carry the version of package.json", () => {
  assert.match(packageVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest(".claude-plugin/plugin.json").version, packageVersion);
  assert.equal(manifest("package-lock.json").version, packageVersion);
});

test("verdict answer is listed in the help, and wants its notes file", () => {
  const help = spawnSync(launcher, ["--help"], { encoding: "utf8" });
  assert.match(help.stdout, /^  verdict <slug> answer --notes <file>/m);
  const bare = spawnSync(launcher, ["verdict", "hello", "answer"], { encoding: "utf8", cwd: temp("mandor-help-") });
  assert.deepEqual([bare.status, bare.stdout, bare.stderr], [2, "", "mandor: --notes is required\n"]);
});

test("--version prints the version of package.json", () => {
  const r = spawnSync(launcher, ["--version"], { encoding: "utf8" });
  assert.equal(r.stdout, `${packageVersion}\n`);
  assert.equal(r.status, 0);
});

test("--help and a bare call print every command a person or the lead runs, and an unknown command points at it", () => {
  const help = spawnSync(launcher, ["--help"], { encoding: "utf8" });
  assert.deepEqual([help.status, help.stderr], [0, ""]);
  // The two the tool runs itself stay out: the detached runner and the hooks.
  const shown = TOOL_COMMANDS.filter((c) => c !== "_run" && c !== "hook");
  for (const c of shown) assert.match(help.stdout, new RegExp(`^  ${c}(?: |$)`, "m"), c);
  for (const c of ["_run", "hook"]) assert.doesNotMatch(help.stdout, new RegExp(`^  ${c}(?: |$)`, "m"), c);
  const bare = spawnSync(launcher, [], { encoding: "utf8" });
  assert.deepEqual([bare.status, bare.stdout, bare.stderr], [0, help.stdout, ""]);
  // After a command too, where a lead looks for that command's options.
  const after = spawnSync(launcher, ["dispatch", "--help"], { encoding: "utf8", cwd: temp("mandor-help-") });
  assert.deepEqual([after.status, after.stdout, after.stderr], [0, help.stdout, ""]);
  const unknown = spawnSync(launcher, ["frobnicate"], { encoding: "utf8", cwd: temp("mandor-help-") });
  assert.deepEqual([unknown.status, unknown.stdout, unknown.stderr], [2, "", "mandor: unknown command: frobnicate; see mandor --help\n"]);
});

test("launcher works through a symlink", () => {
  const link = join(temp("mandor-link-"), "launcher");
  symlinkSync(launcher, link);
  const r = spawnSync(link, ["--version"], { encoding: "utf8" });
  assert.equal(r.stdout, `${packageVersion}\n`);
  assert.equal(r.status, 0);
});

// A PATH of node and readlink alone: the launcher must lean on nothing else, realpath included, which not every system has.
function sparsePath(): string {
  const dir = temp("mandor-bin-");
  symlinkSync(process.execPath, join(dir, "node"));
  symlinkSync("/usr/bin/readlink", join(dir, "readlink"));
  return dir;
}

test("launcher finds its root through any symlink, with nothing on PATH but node and readlink", () => {
  const dir = temp("mandor-links-");
  symlinkSync(launcher, join(dir, "absolute"));
  symlinkSync(relative(dir, launcher), join(dir, "relative"));
  symlinkSync("absolute", join(dir, "chain")); // a link to a link, named from its own directory
  symlinkSync(join(root, "bin"), join(dir, "bindir")); // a link to the directory that holds it: a .. after it must not be read first
  const env = { PATH: sparsePath() };
  const version = (command: string, args: string[], cwd?: string) => spawnSync(command, [...args, "--version"], { encoding: "utf8", env, cwd });
  // The last one runs the script by a bare name, so $0 holds no slash.
  for (const r of [version(launcher, []), version(join(dir, "absolute"), []), version(join(dir, "relative"), []), version(join(dir, "chain"), []),
    version(join(dir, "bindir", "mandor"), []), version("/bin/sh", ["mandor"], join(root, "bin"))]) {
    assert.deepEqual([r.stdout, r.stderr, r.status], [`${packageVersion}\n`, "", 0]);
  }
});

// Node lives under /opt/homebrew here, so this PATH reaches the node-missing branch.
test('launcher exits 0 silently for "hook stop" with PATH=/usr/bin:/bin', () => {
  const r = spawnSync(launcher, ["hook", "stop"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

// A PATH holding a stand-in for node that only reports a version, or none: the launcher needs nothing else on the way.
function hookPath(nodeVersion: string | null): string {
  const dir = temp("mandor-hookbin-");
  if (nodeVersion !== null) writeFileSync(join(dir, "node"), `#!/bin/sh\necho v${nodeVersion}\n`, { mode: 0o755 });
  return dir;
}

// A home with a project in it, which has a goal once its ledger exists: scratch and status make the directory alone.
function homeWith(ledger: boolean): string {
  const home = temp("mandor-hookhome-");
  mkdirSync(join(home, "projects", "demo", "scratch"), { recursive: true });
  if (ledger) writeFileSync(join(home, "projects", "demo", "ledger.jsonl"), "");
  return home;
}

const tree = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort();

test("a hook with no usable node does nothing and succeeds, and the one that opens a session says why to whoever has used mandor", () => {
  const cases: [string | null, string][] = [
    [null, "node is not on their PATH"],
    ["20.11.0", "node 20.11.0 is not 22.18 or newer"],
    ["22.17.9", "node 22.17.9 is not 22.18 or newer"],
  ];
  for (const [version, why] of cases) {
    for (const [ledger, said] of [[true, `mandor hooks are off: ${why}\n`], [false, ""]] as const) {
      const home = homeWith(ledger);
      const before = tree(home);
      // The stop hook runs after every turn, so only the one that opens a session speaks.
      for (const [hook, out] of [["stop", ""], ["session-start", said]]) {
        const r = spawnSync(launcher, ["hook", hook], { encoding: "utf8", input: "{}", env: { PATH: hookPath(version), MANDOR_HOME: home } });
        assert.deepEqual([r.status, r.stdout, r.stderr], [0, out, ""], `${why}: ${hook}, ledger ${ledger}`);
      }
      assert.deepEqual(tree(home), before, "nothing is written");
    }
  }
});

test("that note finds the home as node does: ~/.mandor without MANDOR_HOME, and none when MANDOR_HOME is not absolute", () => {
  const user = temp("mandor-hookuser-");
  mkdirSync(join(user, ".mandor", "projects", "demo"), { recursive: true });
  writeFileSync(join(user, ".mandor", "projects", "demo", "ledger.jsonl"), "");
  // A ledger where a relative MANDOR_HOME would point from here, so a launcher that accepted it would speak.
  const cwd = temp("mandor-hookcwd-");
  mkdirSync(join(cwd, "relative", "home", "projects", "demo"), { recursive: true });
  writeFileSync(join(cwd, "relative", "home", "projects", "demo", "ledger.jsonl"), "");
  const start = (extra: Record<string, string>) => spawnSync(launcher, ["hook", "session-start"], { cwd, encoding: "utf8", env: { PATH: hookPath(null), ...extra } });
  assert.equal(start({ HOME: user }).stdout, "mandor hooks are off: node is not on their PATH\n");
  // A relative MANDOR_HOME is refused as mandorHome refuses it, and with no HOME there is no default.
  const silent: Record<string, string>[] = [{ MANDOR_HOME: "relative/home", HOME: user }, {}, { HOME: "" }];
  for (const extra of silent) assert.equal(start(extra).stdout, "", JSON.stringify(extra));
});

test("launcher runs under every common shell that is installed, not only /bin/sh", () => {
  const link = join(temp("mandor-shells-"), "link");
  symlinkSync(launcher, link);
  const shells = ["/bin/sh", "/bin/bash", "/bin/dash", "/bin/ksh", "/bin/zsh"].filter((shell) => existsSync(shell));
  assert.ok(shells.includes("/bin/sh"));
  for (const shell of shells) {
    // zsh is run as it would be as /bin/sh: by its own name it fails a glob that matches nothing, which the script is not for.
    const as = shell === "/bin/zsh" ? { argv0: "sh" } : {};
    for (const script of [launcher, link]) {
      const r = spawnSync(shell, [script, "--version"], { encoding: "utf8", ...as, env: { PATH: sparsePath() } });
      assert.deepEqual([r.stdout, r.stderr, r.status], [`${packageVersion}\n`, "", 0], `${shell} ${script}`);
    }
    // The hook that cannot run, with a home that holds a ledger to speak about, and with one that does not.
    for (const [ledger, said] of [[true, "mandor hooks are off: node is not on their PATH\n"], [false, ""]] as const) {
      const r = spawnSync(shell, [launcher, "hook", "session-start"], { encoding: "utf8", input: "{}", ...as, env: { PATH: hookPath(null), MANDOR_HOME: homeWith(ledger) } });
      assert.deepEqual([r.stdout, r.stderr, r.status], [said, "", 0], `${shell}, ledger ${ledger}`);
    }
  }
});

test("bin/mandor is committed with mode 100755", (t) => {
  const r = spawnSync("git", ["ls-files", "-s", "bin/mandor"], { cwd: root, encoding: "utf8" });
  if (r.stdout.trim() === "") return t.skip("bin/mandor is not tracked yet");
  assert.match(r.stdout, /^100755 /);
});
