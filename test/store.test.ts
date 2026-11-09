import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { assertOutsideRepos, mandorHome, processAlive, processStart, projectDir, scratchDir, workerEnv, worktreesDir } from "../src/home.ts";
import { appendJsonl, clampDetail, ensureDir, fileRef, readJson, readJsonl, withProjectLock, withSlotsLock, writeJsonAtomic } from "../src/store.ts";
import { temp, tempHome, tempRepo } from "./helpers.ts";

const procs = join(import.meta.dirname, "procs");
const [emDash, enDash, bar] = [0x2014, 0x2013, 0x2015].map((c) => String.fromCharCode(c));
const mode = (p: string) => statSync(p).mode & 0o777;
const lockOf = (id: string) => join(projectDir(id), "lock");
// A start time no live process has, for holders whose pid now belongs to someone else.
const OLD_START = "Thu Jan  1 00:00:00 1970";
const breakLines = (home: string) => readFileSync(join(home, "logs", "locks.log"), "utf8").trim().split("\n");

// spawnSync returns after the child has exited and been reaped, so this pid is dead.
function deadHolder(): { pid: number; start: string } {
  const h = JSON.parse(spawnSync(process.execPath, [join(procs, "start.ts")], { encoding: "utf8" }).stdout);
  assert.equal(typeof h.start, "string");
  return h;
}

// Runs test/procs/<script> under this Node; children inherit MANDOR_HOME from process.env.
function run(script: string, args: (string | number)[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [join(procs, script), ...args.map(String)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    c.stderr.on("data", (d) => (stderr += String(d)));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code, stderr }));
  });
}

function assertExitedZero(runs: { code: number | null; stderr: string }[]): void {
  assert.deepEqual(runs.map((r) => r.code), runs.map(() => 0), runs.map((r) => r.stderr).join("\n"));
}

// Sets (or, for undefined, deletes) environment variables until the test ends.
function setEnv(t: TestContext, vars: Record<string, string | undefined>): void {
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) delete process.env[k];
      else process.env[k] = x;
    }
  };
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  apply(vars);
  t.after(() => apply(old));
}

// Enter and exit markers must alternate per pid: two holders at once would interleave them.
function assertSerialized(markers: string, sections: number): void {
  const lines = readFileSync(markers, "utf8").trim().split("\n");
  assert.equal(lines.length, sections * 2);
  for (let k = 0; k < lines.length; k += 2) {
    const pid = lines[k].split(" ")[0];
    assert.deepEqual([lines[k], lines[k + 1]], [`${pid} enter`, `${pid} exit`]);
  }
  assert.equal(new Set(lines.map((l) => l.split(" ")[0])).size, 2);
}

test("writeJsonAtomic mode 0600", () => {
  const dir = join(tempHome(), "x");
  const p = join(dir, "a.json");
  writeJsonAtomic(p, { a: 1 });
  assert.equal(mode(p), 0o600);
  assert.equal(mode(dir), 0o700);
  writeJsonAtomic(p, { a: 2 });
  assert.deepEqual(readJson(p), { a: 2 });
  assert.deepEqual(readdirSync(dir), ["a.json"]);
});

test("ensureDir mode 0700", () => {
  const home = tempHome();
  ensureDir(join(home, "a", "b"));
  ensureDir(join(home, "a", "b"));
  assert.equal(mode(join(home, "a")), 0o700);
  assert.equal(mode(join(home, "a", "b")), 0o700);
  assert.equal(mode(scratchDir("p-1", "notes")), 0o700);
  assert.throws(() => scratchDir("p-1", "../escape"), /invalid scratch name/);
});

test("readJsonl partial line and endByte", () => {
  const home = tempHome();
  const p = join(home, "l.jsonl");
  const first = '{"s":"é"}\n';
  writeFileSync(p, `${first}{"n":2}\n{"n":`);
  const a = readJsonl(p);
  assert.deepEqual(a.items, [{ s: "é" }, { n: 2 }]);
  assert.equal(a.endByte, Buffer.byteLength(first) + 8);
  assert.deepEqual(readJsonl(p, a.endByte), { items: [], endByte: a.endByte });
  appendFileSync(p, "3}\n");
  assert.deepEqual(readJsonl(p, a.endByte), { items: [{ n: 3 }], endByte: statSync(p).size });
  assert.deepEqual(readJsonl(join(home, "missing.jsonl")), { items: [], endByte: 0 });
});

test("readJsonl throws on a complete unparsable line", () => {
  const p = join(tempHome(), "l.jsonl");
  writeFileSync(p, '{"n":1}\n{"n":\n{"n":3}\n');
  assert.throws(() => readJsonl(p), (e: Error) => e.message.includes(p) && e.message.includes("byte 8"));
});

test("appendJsonl throws above 4096 bytes", () => {
  const p = join(tempHome(), "l.jsonl");
  const overhead = Buffer.byteLength(`${JSON.stringify({ s: "" })}\n`);
  appendJsonl(p, { s: "x".repeat(4096 - overhead) });
  assert.throws(() => appendJsonl(p, { s: "x".repeat(4097 - overhead) }), /4096/);
  // The cap counts bytes: 2100 two-byte characters are over it.
  assert.throws(() => appendJsonl(p, { s: "é".repeat(2100) }), /4096/);
  assert.equal(statSync(p).size, 4096);
  assert.equal(readJsonl(p).items.length, 1);
  assert.equal(mode(p), 0o600);
});

test("clampDetail keeps one line of at most 300 chars", () => {
  assert.equal(clampDetail(`  a\n\tb\r\n${emDash}c${enDash}d${bar}  `), "a b -c-d-");
  const words = clampDetail("word ".repeat(200));
  assert.equal(words.length, 299);
  assert.ok(!words.endsWith(" "));
  // A surrogate pair straddling the cut is dropped whole.
  const smile = String.fromCodePoint(0x1f600);
  assert.equal(clampDetail(`a${smile.repeat(200)}`), `a${smile.repeat(149)}`);
  const f = join(tempHome(), "r.md");
  const body = `line one\nline ${emDash} two\n`;
  writeFileSync(f, body);
  assert.deepEqual(fileRef(f), { path: f, sha256: createHash("sha256").update(body).digest("hex"), excerpt: "line one line - two" });
});

test("assertOutsideRepos refuses inside a repo and inside worktreesDir", () => {
  tempHome();
  const repo = tempRepo();
  const repoRootOf = (dir: string) => {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "brief.md"), "x");
  assert.throws(() => assertOutsideRepos(join(repo, "docs", "brief.md"), repoRootOf), /git working tree/);
  assert.throws(() => assertOutsideRepos(join(repo, "new.md"), repoRootOf), /git working tree/);
  const wt = join(worktreesDir("p-1"), "task-x");
  mkdirSync(wt, { recursive: true });
  assert.throws(() => assertOutsideRepos(join(wt, "notes.md"), repoRootOf), /worktrees/);
  // A symlink from outside is resolved before the check.
  const link = join(temp("mandor-link-"), "wt");
  symlinkSync(wt, link);
  assert.throws(() => assertOutsideRepos(join(link, "notes.md"), repoRootOf), /worktrees/);
  assertOutsideRepos(join(scratchDir("p-1", "s"), "brief.md"), repoRootOf);
});

test("processStart output is identical under LC_ALL=en_NZ.UTF-8 and LC_ALL=C callers", () => {
  const pid = String(process.pid);
  const nz = { ...process.env, LC_ALL: "en_NZ.UTF-8", TZ: "Pacific/Auckland" };
  const c = { ...process.env, LC_ALL: "C", TZ: "UTC" };
  // The callers' own ps output differs, so equal results come from processStart's fixed environment.
  const raw = (env: NodeJS.ProcessEnv) => spawnSync("/bin/ps", ["-o", "lstart=", "-p", pid], { env, encoding: "utf8" }).stdout.trim();
  assert.notEqual(raw(nz), raw(c));
  const via = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [join(procs, "start.ts"), pid], { env, encoding: "utf8" }).stdout;
  const fromNz = via(nz);
  assert.equal(fromNz, via(c));
  const own = processStart(process.pid);
  assert.equal(JSON.parse(fromNz).start, own);
  assert.match(own ?? "", /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/);
  assert.equal(processStart(0), null);
  assert.equal(processStart(99_999_999), null);
});

test("processAlive: a pid that is gone, or now belongs to a process started at another time, is dead", () => {
  const own = processStart(process.pid);
  assert.equal(processAlive(process.pid, own), true);
  // A start that was never recorded cannot tell a reused pid from the original.
  assert.equal(processAlive(process.pid, null), true);
  assert.equal(processAlive(process.pid, "Thu Jan  1 00:00:00 1970"), false);
  const gone = spawnSync("/usr/bin/true").pid;
  assert.equal(processAlive(gone, own), false);
  assert.equal(processAlive(gone, null), false);
  // Signal 0 to pid 0 or -1 would reach a whole process group or every process, so these never get that far.
  for (const pid of [0, -1, 1.5, NaN, Infinity, 2 ** 53, "12", null, undefined, {}]) assert.equal(processAlive(pid, null), false, String(pid));
});

// The helpers' exit cleanup, run in a child process so that whatever it kills is never this test's own process. Each
// stand-in is a group leader of its own, as a worker is; the pids are what the job records hold.
test("the exit cleanup kills the live fake worker of an unfinished job, and neither an unrelated process at that pid nor a finished job's", async (t) => {
  const leader = (cmd: string) => {
    const c = spawn("/bin/sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    t.after(() => {
      try {
        process.kill(-c.pid!, "SIGKILL");
      } catch {}
    });
    return c;
  };
  const tag = () => `30.${randomInt(1e9)}`;
  const unrelated = leader(`exec sleep ${tag()}`); // a recycled pid, now a plain sleep
  const worker = leader(`sleep ${tag()}; : fake-codex`); // the fake Codex by its command line, as a worker shows
  const finished = leader(`sleep ${tag()}; : fake-codex`);
  const script = `import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";
    import { tempHome } from ${JSON.stringify(join(import.meta.dirname, "helpers.ts"))};
    const home = tempHome();
    const job = (id, workerPid, endedAt) => {
      mkdirSync(join(home, "jobs", id), { recursive: true });
      writeFileSync(join(home, "jobs", id, "job.json"), JSON.stringify({ id, runnerPid: null, runnerStart: null, workerPid, endedAt }));
    };
    job("j-1", ${unrelated.pid}, null);
    job("j-2", ${worker.pid}, null);
    job("j-3", ${finished.pid}, "2026-01-01T00:00:00.000Z");`;
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.deepEqual({ status: r.status, stderr: r.stderr }, { status: 0, stderr: "" });
  const gone = (c: ReturnType<typeof spawn>) => c.exitCode !== null || c.signalCode !== null;
  for (const end = Date.now() + 5000; !gone(worker) && Date.now() < end;) await new Promise((done) => setTimeout(done, 50));
  assert.equal(worker.signalCode, "SIGKILL", "the fake worker's group was killed");
  await new Promise((done) => setTimeout(done, 300));
  assert.deepEqual([gone(unrelated), gone(finished)], [false, false], "the unrelated process and the finished job's were left alone");
});

test("mandorHome takes an absolute MANDOR_HOME, defaults when it is unset or empty, and refuses a relative one", (t) => {
  setEnv(t, { MANDOR_HOME: "/abs/home" });
  assert.equal(mandorHome(), "/abs/home");
  setEnv(t, { MANDOR_HOME: undefined });
  assert.equal(mandorHome(), join(homedir(), ".mandor"));
  setEnv(t, { MANDOR_HOME: "" });
  assert.equal(mandorHome(), join(homedir(), ".mandor"));
  for (const rel of ["rel/home", "./home", "../home", "~/home"]) {
    setEnv(t, { MANDOR_HOME: rel });
    assert.throws(mandorHome, new RegExp(`^Error: MANDOR_HOME must be an absolute path, not ${JSON.stringify(rel).replace(/[./]/g, "\\$&")}$`), rel);
  }
});

test("workerEnv contains exactly the allowlist, creates empty-gh, omits MANDOR_JOB for null, and drops relative PATH entries", (t) => {
  const home = tempHome();
  const lead = {
    HOME: "/h", USER: "u", LOGNAME: "u", PATH: "/usr/bin:/bin", TMPDIR: "/tmp/w", LANG: "en_US.UTF-8",
    LC_ALL: "C", LC_CTYPE: "UTF-8", SHELL: "/bin/zsh", JAVA_HOME: "/j", ANDROID_HOME: "/a", CODEX_HOME: "/c",
  };
  setEnv(t, {
    // An empty entry and relative ones would resolve a bare command against the worker's cwd.
    ...lead, PATH: "/usr/bin::bin:./tools:/bin:", ANDROID_SDK_ROOT: undefined,
    CODEX_API_KEY: "s", OPENAI_API_KEY: "s", ANTHROPIC_API_KEY: "s", SSH_AUTH_SOCK: "/s", GH_TOKEN: "s", GITHUB_TOKEN: "s",
    NODE_OPTIONS: "--x",
  });
  const fixed = {
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GIT_SSH_COMMAND: "/usr/bin/false",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
    GH_CONFIG_DIR: join(home, "empty-gh"), GRADLE_OPTS: "-Dorg.gradle.daemon=false",
  };
  assert.deepEqual(workerEnv("j-1"), { ...lead, ...fixed, MANDOR_JOB: "j-1" });
  delete process.env.CODEX_HOME;
  assert.deepEqual(workerEnv(null), { ...lead, CODEX_HOME: "/h/.codex", ...fixed });
  assert.equal(mode(join(home, "empty-gh")), 0o700);
  assert.deepEqual(readdirSync(join(home, "empty-gh")), []);
});

test("8 processes x 200 appends yield 1600 parseable lines", async () => {
  const p = join(tempHome(), "projects", "p-append", "ledger.jsonl");
  const goAt = Date.now() + 500;
  assertExitedZero(await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((w) => run("append.ts", [p, w, 200, goAt]))));
  const { items, endByte } = readJsonl<{ w: number; i: number }>(p);
  assert.equal(items.length, 1600);
  assert.equal(endByte, statSync(p).size);
  assert.equal(new Set(items.map((x) => `${x.w}:${x.i}`)).size, 1600);
});

test("withProjectLock serializes two processes", async () => {
  const markers = join(tempHome(), "markers");
  const goAt = Date.now() + 500;
  assertExitedZero(await Promise.all([1, 2].map(() => run("lock.ts", ["p-ser", markers, 3, 100, goAt]))));
  assertSerialized(markers, 6);
  assert.deepEqual(readdirSync(projectDir("p-ser")), []);
});

test("a stale lock from a dead pid is broken exactly once when two processes contend", async () => {
  const home = tempHome();
  const dead = deadHolder();
  const lock = lockOf("p-stale");
  ensureDir(dirname(lock));
  writeFileSync(lock, JSON.stringify(dead));
  const markers = join(home, "markers");
  const goAt = Date.now() + 500;
  assertExitedZero(await Promise.all([1, 2].map(() => run("lock.ts", ["p-stale", markers, 1, 100, goAt]))));
  assertSerialized(markers, 2);
  const lines = breakLines(home);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(lock) && lines[0].includes(`pid ${dead.pid}`), lines[0]);
  assert.equal(mode(join(home, "logs", "locks.log")), 0o600);
  assert.deepEqual(readdirSync(projectDir("p-stale")), []);
});

test("a stale .break left by a dead breaker is broken too", () => {
  const home = tempHome();
  const lock = lockOf("p-break");
  ensureDir(dirname(lock));
  writeFileSync(lock, JSON.stringify(deadHolder()));
  writeFileSync(`${lock}.break`, JSON.stringify(deadHolder()));
  assert.equal(withProjectLock("p-break", () => 5, { tryOnce: true }), 5);
  assert.equal(breakLines(home).length, 2);
  assert.deepEqual(readdirSync(projectDir("p-break")), []);
});

test("an unparsable lock counts as held", () => {
  const home = tempHome();
  const lock = lockOf("p-bad");
  ensureDir(dirname(lock));
  for (const garbage of ["", "{not json", '{"pid":0,"start":"x"}']) {
    writeFileSync(lock, garbage);
    let ran = false;
    assert.equal(withProjectLock("p-bad", () => (ran = true), { tryOnce: true }), null);
    // The path in the error lets a user find a lock a crash left unparsable.
    assert.throws(() => withProjectLock("p-bad", () => (ran = true), { maxWaitMs: 120 }), { message: `project busy (${lock})` });
    assert.equal(ran, false);
    assert.equal(readFileSync(lock, "utf8"), garbage);
  }
  assert.ok(!existsSync(join(home, "logs", "locks.log")));
});

test("a lock whose pid is alive but started at another time is stale", () => {
  const home = tempHome();
  const lock = lockOf("p-reused");
  ensureDir(dirname(lock));
  // The test runner is alive, but under another start time its pid names a holder that is gone.
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, start: OLD_START }));
  assert.equal(withProjectLock("p-reused", () => 7, { tryOnce: true }), 7);
  const lines = breakLines(home);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(lock) && lines[0].includes(`pid ${process.ppid}`), lines[0]);
  assert.deepEqual(readdirSync(projectDir("p-reused")), []);
});

test("a temp name a killed holder left linked to the lock never changes it", () => {
  const home = tempHome();
  const lock = lockOf("p-leftover");
  ensureDir(dirname(lock));
  // An earlier process with this pid was killed between linking its temp file and removing
  // it, so that temp name and the lock still share one inode.
  const planted = JSON.stringify({ pid: process.pid, start: OLD_START });
  writeFileSync(lock, planted);
  const leftover = `${lock}.${process.pid}.tmp`;
  linkSync(lock, leftover);
  assert.equal(withProjectLock("p-leftover", () => 7, { tryOnce: true }), 7);
  assert.equal(readFileSync(leftover, "utf8"), planted);
  assert.deepEqual(readdirSync(projectDir("p-leftover")), [basename(leftover)]);
  assert.equal(breakLines(home).length, 1);
});

test("a dangling symlink at the lock path counts as held without spinning", () => {
  tempHome();
  const lock = lockOf("p-dangle");
  ensureDir(dirname(lock));
  symlinkSync(join(dirname(lock), "nowhere"), lock);
  // In a child with a timeout, so endless retries fail the test instead of hanging the run.
  const r = spawnSync(process.execPath, [join(procs, "try-lock.ts"), "p-dangle"], { encoding: "utf8", timeout: 5000 });
  assert.deepEqual([r.signal, r.status, r.stdout.trim()], [null, 0, "null"], r.stderr);
  assert.throws(() => withProjectLock("p-dangle", () => 1, { maxWaitMs: 120 }), { message: `project busy (${lock})` });
});

test("release tolerates a lock that vanished during fn", () => {
  tempHome();
  const lock = lockOf("p-gone");
  assert.equal(withProjectLock("p-gone", () => (unlinkSync(lock), 4)), 4);
  assert.throws(() => withProjectLock("p-gone", () => {
    unlinkSync(lock);
    throw new Error("boom");
  }), { message: "boom" });
});

test("withProjectLock refuses while this process holds the slots lock", () => {
  tempHome();
  assert.throws(() => withSlotsLock(() => withProjectLock("p-order", () => 1)), /lock order/);
  assert.throws(() => withSlotsLock(() => withProjectLock("p-order", () => 1, { tryOnce: true })), /lock order/);
  assert.ok(!existsSync(join(mandorHome(), "slots.lock")));
  assert.ok(!existsSync(lockOf("p-order")));
});

test("tryOnce returns null when held", () => {
  tempHome();
  const lock = lockOf("p-held");
  ensureDir(dirname(lock));
  // The test runner is a live process other than this one.
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, start: processStart(process.ppid) }));
  let ran = false;
  assert.equal(withProjectLock("p-held", () => (ran = true), { tryOnce: true }), null);
  assert.throws(() => withProjectLock("p-held", () => (ran = true), { maxWaitMs: 120 }), /project busy/);
  assert.equal(ran, false);
  unlinkSync(lock);
  assert.equal(withProjectLock("p-held", () => withProjectLock("p-held", () => 1, { tryOnce: true })), null);
  assert.equal(withProjectLock("p-held", () => 2, { tryOnce: true }), 2);
});

test("withProjectLock is not re-entrant", () => {
  tempHome();
  assert.throws(() => withProjectLock("p-re", () => withProjectLock("p-re", () => 1)), /not re-entrant/);
  // Project lock first, then slots lock, is the allowed nesting.
  assert.equal(withProjectLock("p-re", () => withSlotsLock(() => 3)), 3);
  assert.ok(!existsSync(lockOf("p-re")));
  assert.ok(!existsSync(join(mandorHome(), "slots.lock")));
});
