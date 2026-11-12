import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { JobRecord } from "../src/contracts.ts";
import { jobDir, processStart, projectDir, projectIdFor, roundDir, scratchDir } from "../src/home.ts";
import { appendEvent, loadState, now } from "../src/ledger.ts";
import { emptyProjectConfig, saveProjectConfig } from "../src/provision.ts";
import { withProjectLock } from "../src/store.ts";
import { indexLockPath } from "../src/git.ts";
import { dispatch, goalStart } from "../src/tasks.ts";
import { reviewPack, taskDiff } from "../src/review.ts";
import { tempHome, tempRepo, writeScenarios } from "./helpers.ts";

const LAUNCHER = join(import.meta.dirname, "..", "bin", "mandor");
const GOAL = "feat/review";
const SLUG = "work";

const must = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

async function until(ok: () => boolean, ms = 20_000): Promise<boolean> {
  for (const end = Date.now() + ms; !ok(); await sleep(50)) if (Date.now() > end) return false;
  return true;
}

const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};

// Whatever a test leaves running dies with it: runners other than this process, and every worker group.
function reap(home: string): void {
  const jobs = join(home, "jobs");
  for (const id of existsSync(jobs) ? readdirSync(jobs) : []) {
    const p = join(jobs, id, "job.json");
    if (!existsSync(p)) continue;
    const job = JSON.parse(readFileSync(p, "utf8")) as JobRecord;
    const runner = job.runnerPid ?? 0;
    if (runner > 1 && runner !== process.pid && processStart(runner) === job.runnerStart) kill(runner);
    if ((job.workerPid ?? 0) > 1) kill(-job.workerPid!);
  }
}

function put(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

interface Fixture { repo: string; id: string; wt: string; scratch: string }

// A goal on a repository holding `files`, and a task with no job, so the test edits its worktree directly.
function fixture(t: TestContext, files: Record<string, string> = {}, scope: string[] = []): Fixture {
  const home = tempHome({ config: true });
  t.after(() => reap(home));
  const repo = tempRepo();
  const id = projectIdFor(repo);
  const scratch = scratchDir(id, "t");
  for (const [path, body] of Object.entries(files)) put(repo, path, body);
  if (Object.keys(files).length > 0) {
    must(repo, "add", "--", ...Object.keys(files));
    must(repo, "commit", "-q", "-m", "Add files");
  }
  goalStart(repo, GOAL, null);
  const brief = join(scratch, "brief.md");
  writeFileSync(brief, "Do the work.\n");
  const { task } = dispatch(repo, { goal: GOAL, slug: SLUG, tier: "light", briefFile: brief, scope, use: null, after: null });
  return { repo, id, wt: task.worktree!, scratch };
}

const details = (p: ReturnType<typeof reviewPack>, kind: string) => p.redFlags.filter((f) => f.kind === kind).map((f) => f.detail);

// The fixture's task still has the job that dispatch queued, so a test that wants a task with no job in flight ends it.
function endJob(f: Fixture): void {
  for (const jobId of loadState(f.id).tasks[SLUG].jobIds) {
    appendEvent(f.id, { t: "job.finished", at: now(), jobId, outcome: { status: "done", sessionId: null, detail: "", resetsAt: null, exitCode: 0 } });
  }
}

test("a diff with nothing to flag gives an empty pack", (t) => {
  const f = fixture(t, { "src/a.ts": "export const a = 1;\n" });
  put(f.wt, "src/a.ts", "export const a = 2;\n");
  const p = reviewPack(f.repo, SLUG);
  assert.deepEqual(p.files, [{ path: "src/a.ts", status: "M" }]);
  assert.match(p.diffStat, /src\/a\.ts \| 2 \+-/);
  assert.deepEqual([p.redFlags, p.violations, p.worktree, p.reportPath], [[], [], f.wt, null]);
});

test("no change at all gives no files and an empty stat", (t) => {
  const f = fixture(t);
  assert.deepEqual(reviewPack(f.repo, SLUG), { diffStat: "", files: [], redFlags: [], violations: [], worktree: f.wt, reportPath: null });
});

test("a review works on a copy of the index, so a lock in the worktree's git directory does not stop it and is left alone", (t) => {
  const f = fixture(t, { "src/a.ts": "a\n" });
  put(f.wt, "src/a.ts", "b\n");
  const lock = indexLockPath(f.repo, f.wt);
  writeFileSync(lock, "");
  assert.deepEqual(reviewPack(f.repo, SLUG).files, [{ path: "src/a.ts", status: "M" }]);
  assert.equal(existsSync(lock), true, "the lock is not the review's to remove");
});

test("the pack names an accept that did not finish, whichever task of the goal it was", (t) => {
  const f = fixture(t, { "src/a.ts": "a\n" });
  put(f.wt, "src/a.ts", "b\n");
  const marker = join(projectDir(f.id), "goals", "feat__review", "accept-intent.json");
  assert.deepEqual(details(reviewPack(f.repo, SLUG), "accept-unfinished"), [], "no marker, no flag");
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ slug: SLUG, tip: "0".repeat(40) }));
  assert.deepEqual(details(reviewPack(f.repo, SLUG), "accept-unfinished"), ["an accept of work did not finish; run its accept again, which settles it"]);
  writeFileSync(marker, JSON.stringify({ slug: "other", tip: "0".repeat(40) }));
  assert.deepEqual(details(reviewPack(f.repo, SLUG), "accept-unfinished"), ["an accept of other did not finish; run its accept again, which settles it"]);
  writeFileSync(marker, "{");
  assert.deepEqual(details(reviewPack(f.repo, SLUG), "accept-unfinished"), ["an accept did not finish and its marker cannot be read: tell the user"]);
  // Advice, so the pack is whole, and the first thing the lead reads of it.
  const pack = reviewPack(f.repo, SLUG);
  assert.equal(pack.redFlags[0].kind, "accept-unfinished");
  assert.deepEqual(pack.files, [{ path: "src/a.ts", status: "M" }]);
  assert.equal(readFileSync(marker, "utf8"), "{", "a review settles nothing");
});

test("diff prints the task's change as text through the review's git layer, and records no review", (t) => {
  const f = fixture(t, { "src/a.ts": "a\n" });
  put(f.wt, "src/a.ts", "b\n");
  put(f.wt, "src/new.ts", "n\n");
  endJob(f);
  const text = taskDiff(f.repo, SLUG);
  assert.match(text, /^diff --git a\/src\/a\.ts b\/src\/a\.ts$/m);
  assert.match(text, /^-a\n\+b$/m);
  assert.match(text, /^diff --git a\/src\/new\.ts b\/src\/new\.ts$/m);
  assert.equal(existsSync(join(projectDir(f.id), "tasks", SLUG, "reviewed.json")), false, "accept still wants a review");
  assert.throws(() => taskDiff(f.repo, "nope"), /no task nope/);
  const bare = fixture(t);
  endJob(bare);
  assert.equal(taskDiff(bare.repo, SLUG), "", "no change gives no text");
});

test("diff writes the control bytes of a worker's file as visible escapes, and keeps tabs, line ends and CRLF", (t) => {
  const f = fixture(t, { "src/a.ts": "a\n" });
  put(f.wt, "src/new.ts", "x\x1b[2Ky\rz\0w\tv\r\nend\n");
  endJob(f);
  const text = taskDiff(f.repo, SLUG);
  assert.ok(text.includes("x\\x1b[2Ky\\x0dz\\x00w\tv\r\n"), JSON.stringify(text));
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text.replace(/\r\n/g, "\n")), "no control byte is left but a tab and a line end");
});

test("diff into a reader that stops early is no failure and prints no stack", (t) => {
  const f = fixture(t, { "src/a.ts": "a\n" });
  put(f.wt, "src/big.txt", "line\n".repeat(200_000));
  endJob(f);
  const err = join(f.scratch, "err.txt");
  const r = spawnSync("bash", ["-c", 'set -o pipefail; "$1" diff "$2" 2>"$3" | head -c 1 >/dev/null; echo $?', "x", LAUNCHER, SLUG, err], { cwd: f.repo, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "0");
  assert.equal(readFileSync(err, "utf8"), "");
});

test("diff refuses a task with a job in flight, whose worker is still changing the files", (t) => {
  const f = fixture(t, { "src/a.ts": "a\n" });
  put(f.wt, "src/a.ts", "b\n");
  const candidate = { tool: "codex", model: "gpt-6-luna", effort: "medium" } as const;
  appendEvent(f.id, { t: "job.started", at: now(), job: { id: "j-20261108100000-0001", taskId: SLUG, seq: 1, kind: "start", candidate } });
  assert.throws(() => taskDiff(f.repo, SLUG), /task work has a queued or running job/);
});

test("the diff command prints the text, exits 2 without a slug and 1 for a task that does not exist", (t) => {
  const f = fixture(t, { "src/a.ts": "a\n" });
  put(f.wt, "src/a.ts", "b\n");
  endJob(f);
  const run = (...args: string[]) => spawnSync(LAUNCHER, args, { cwd: f.repo, encoding: "utf8" });
  const shown = run("diff", SLUG);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /^-a\n\+b$/m);
  const bare = run("diff");
  assert.deepEqual([bare.status, bare.stderr], [2, "mandor: usage: diff <slug>\n"]);
  assert.equal(run("diff", "nope").status, 1);
});

// The task's first job is named by its id, which holds the time it was queued.
const firstJob = (f: Fixture, id: string) => appendEvent(f.id, { t: "task.updated", at: now(), taskId: SLUG, patch: { jobIds: [id] }, reason: "test" });

test("the pack flags what changed under ignored paths since the task's first job, which the staged tree does not hold", (t) => {
  const f = fixture(t, { ".gitignore": "build/\n", "src/a.ts": "a\n" });
  put(f.wt, "src/a.ts", "b\n");
  put(f.wt, "build/out.js", "worker-written\n");
  firstJob(f, "j-20200101000000-0000");
  const p = reviewPack(f.repo, SLUG);
  assert.deepEqual(details(p, "ignored-changed"), ["build/: 1 file changed since the first job began"]);
  assert.deepEqual(p.files, [{ path: "src/a.ts", status: "M" }], "the staged tree does not hold it");
  firstJob(f, "j-20990101000000-0000");
  assert.deepEqual(details(reviewPack(f.repo, SLUG), "ignored-changed"), [], "a first job in the future leaves nothing newer");
});

test("the pack names ten ignored paths at most and counts the rest", (t) => {
  const f = fixture(t, { ".gitignore": "d*/\n", "src/a.ts": "a\n" });
  for (let i = 0; i < 12; i++) put(f.wt, `d${String(i).padStart(2, "0")}/x.js`, "x\n");
  firstJob(f, "j-20200101000000-0000");
  const found = details(reviewPack(f.repo, SLUG), "ignored-changed");
  assert.equal(found.length, 11);
  assert.equal(found.at(-1), "and 2 more ignored paths changed");
});

test("a task whose first job id has no time is flagged for nothing under ignored paths", (t) => {
  const f = fixture(t, { ".gitignore": "build/\n", "src/a.ts": "a\n" });
  put(f.wt, "build/out.js", "x\n");
  firstJob(f, "j-not-a-time");
  assert.deepEqual(details(reviewPack(f.repo, SLUG), "ignored-changed"), []);
});

test("a task that does not exist is refused", (t) => {
  const f = fixture(t);
  assert.throws(() => reviewPack(f.repo, "nope"), /no task nope/);
});

test("the pack resolves its project from a cwd inside the task worktree", (t) => {
  const f = fixture(t, { "src/a.ts": "a\n" });
  put(f.wt, "src/a.ts", "b\n");
  assert.deepEqual(reviewPack(f.wt, SLUG).files, [{ path: "src/a.ts", status: "M" }]);
});

test("test-deleted flags a deleted test file by directory or by name, and no other deletion", (t) => {
  const tests = ["tests/a.py", "pkg/__tests__/b.js", "app/src/androidTest/C.kt", "x/y.test.ts", "x/y_test.go", "src/FooTest.kt", "src/BarTest.java", "mod/Tests/Swift.swift"];
  const others = ["src/latest.kt", "src/contest.py", "src/protest.ts", "src/main/Test.swift", "src/attest.kt"];
  const f = fixture(t, Object.fromEntries([...tests, ...others].map((p) => [p, "line\n"])));
  for (const p of [...tests, ...others]) rmSync(join(f.wt, p));
  const p = reviewPack(f.repo, SLUG);
  assert.deepEqual(details(p, "test-deleted").sort(), [...tests].sort());
  assert.equal(p.files.length, tests.length + others.length);
});

test("a test file that is only added or changed is not test-deleted", (t) => {
  const f = fixture(t, { "test/a.test.ts": "one\n" });
  put(f.wt, "test/a.test.ts", "two\n");
  put(f.wt, "test/b.test.ts", "new\n");
  assert.deepEqual(details(reviewPack(f.repo, SLUG), "test-deleted"), []);
});

test("test-skipped flags added skips and ignores, and not process.exit or removed skips", (t) => {
  const f = fixture(t, { "test/old.test.ts": "it.skip('old', () => {});\n", "src/run.ts": "run();\n" });
  put(f.wt, "test/old.test.ts", "it('old', () => {});\n"); // a skip removed
  put(f.wt, "test/a.test.ts", "it.skip('a', () => {});\nxit('b', () => {});\ndescribe.only('c', () => {});\n");
  put(f.wt, "src/K.kt", "@Ignore\nfun a() {}\n@Disabled(\"slow\")\nfun b() {}\n");
  put(f.wt, "src/run.ts", "process.exit(1);\nSystem.exit(2);\nsys.exit(3);\n// @IgnoreMe @Disabledness\n");
  const p = reviewPack(f.repo, SLUG);
  assert.deepEqual(details(p, "test-skipped").sort(), ["src/K.kt: @Disabled, @Ignore", "test/a.test.ts: .only(, .skip(, xit("]);
});

test("test-skipped flags a skip that depends on a condition: an assumption or a conditional JUnit annotation", (t) => {
  const f = fixture(t, { "src/run.ts": "run();\n" });
  put(f.wt, "src/ShiftTest.java", [
    "@DisabledOnOs(OS.MAC)", "void a() {}", "@EnabledIfEnvironmentVariable(named = \"CI\", matches = \".*\")", "void b() {}",
    "@DisabledIf(\"late\")", "void c() {}", "@EnabledForJreRange(min = JRE.JAVA_21)", "void d() {}", "@DisabledInNativeImage", "void e() {}", "@EnabledOnJre(JRE.JAVA_21)", "void g() {}",
    "void h() { Assumptions.assumeTrue(LocalTime.now().isBefore(NOON)); }", "void i() { assumeFalse(late()); }", "void j() { Assume.assumeNotNull(x); }",
    "void k() { assumeThat(x, is(1)); }", "void l() { assumeNoException(e); }", "",
  ].join("\n"));
  // Words that only begin like them are not skips.
  put(f.wt, "src/run.ts", "assumeTruthy();\n// @DisabledNot @EnabledNothing @DisabledOnlyOnce\nconst assumeTrueValue = 1;\nfunction assumeTrue2() {}\nreassumeTrue(1);\n");
  const p = reviewPack(f.repo, SLUG);
  assert.deepEqual(details(p, "test-skipped"), [
    "src/ShiftTest.java: @DisabledIf, @DisabledInNativeImage, @DisabledOnOs, @EnabledForJreRange, @EnabledIfEnvironmentVariable, @EnabledOnJre, assumeFalse(, assumeNoException(, assumeNotNull(, assumeThat(, assumeTrue(",
  ]);
});

test("assert-removed counts removed assertion lines per file next to the added ones", (t) => {
  const f = fixture(t, {
    "test/a.test.ts": "assert.equal(a, 1);\nexpect(b).toBe(2);\nassertThat(c);\nconst keep = 1;\n",
    "src/plain.ts": "const a = 1;\n",
  });
  put(f.wt, "test/a.test.ts", "assert.equal(a, 2);\nconst keep = 1;\n");
  put(f.wt, "src/plain.ts", "const a = 2;\n");
  const p = reviewPack(f.repo, SLUG);
  assert.deepEqual(details(p, "assert-removed"), ["test/a.test.ts: 3 removed, 1 added"]);
});

test("a path named assert or TODO is not read as a removed or added line", (t) => {
  const f = fixture(t, { "assert/expect(.txt": "x\n" });
  put(f.wt, "assert/expect(.txt", "y\n");
  put(f.wt, "TODO.md", "y\n");
  const p = reviewPack(f.repo, SLUG);
  assert.deepEqual([details(p, "assert-removed"), details(p, "todo-added")], [[], []]);
});

test("out-of-scope flags a changed path that matches no scope entry, and only for a task with a scope", (t) => {
  const f = fixture(t, {}, ["src/**", "docs/", "README.md"]);
  for (const p of ["src/a/b.ts", "docs/x.md", "README.md", "lib/c.ts", "srcx/d.ts"]) put(f.wt, p, "x\n");
  assert.deepEqual(details(reviewPack(f.repo, SLUG), "out-of-scope").sort(), ["lib/c.ts", "srcx/d.ts"]);
  const open = fixture(t);
  put(open.wt, "lib/c.ts", "x\n");
  assert.deepEqual(details(reviewPack(open.repo, SLUG), "out-of-scope"), []);
});

test("shared-path matches a trailing slash by prefix and other entries exactly or by glob", (t) => {
  const f = fixture(t);
  saveProjectConfig(f.id, { ...emptyProjectConfig(), shared: ["gradle/", "build.gradle", "config/*.json"] });
  for (const p of ["gradle/wrapper/w.properties", "build.gradle", "config/a.json", "config/sub/b.json", "gradlew", "app/build.gradle", "src/other.ts"]) put(f.wt, p, "x\n");
  assert.deepEqual(details(reviewPack(f.repo, SLUG), "shared-path").sort(), ["build.gradle", "config/a.json", "gradle/wrapper/w.properties"]);
});

test("todo-added counts added TODO and FIXME words per file, not removed or embedded ones", (t) => {
  const f = fixture(t, { "src/a.ts": "// TODO: old\n" });
  put(f.wt, "src/a.ts", "// TODO: one\n// FIXME later\nconst TODOS = 1; // not a marker\n");
  put(f.wt, "src/b.ts", "const x = 1;\n");
  assert.deepEqual(details(reviewPack(f.repo, SLUG), "todo-added"), ["src/a.ts: 2 added"]);
});

test("stale-input names the clone path to rebuild for a changed generator input", (t) => {
  const f = fixture(t);
  saveProjectConfig(f.id, { ...emptyProjectConfig(), generators: { "gen/out": ["tools/gen.sh", "schema/**"], "bin/cache": ["tools/gen.sh"] } });
  put(f.wt, "tools/gen.sh", "x\n");
  put(f.wt, "schema/a/b.json", "x\n");
  put(f.wt, "src/other.ts", "x\n");
  assert.deepEqual(details(reviewPack(f.repo, SLUG), "stale-input").sort(), [
    "schema/a/b.json: rebuild gen/out", "tools/gen.sh: rebuild bin/cache", "tools/gen.sh: rebuild gen/out",
  ]);
});

test("attribution-hint reports the advisory hints, which are not violations", (t) => {
  const f = fixture(t);
  put(f.wt, "src/meta.json", '{ "generatedByGpt": true }\n');
  const p = reviewPack(f.repo, SLUG);
  assert.deepEqual(p.violations, []);
  assert.deepEqual(details(p, "attribution-hint"), ["src/meta.json: generated by gpt"]);
});

test("violations are what accept refuses: agent files, default and project deny, and clone paths", (t) => {
  const f = fixture(t);
  saveProjectConfig(f.id, { ...emptyProjectConfig(), deny: ["secret/**"], clone: ["build-out"] });
  for (const p of ["CLAUDE.md", ".env", "secret/k.txt", "build-out/x.bin", "src/fine.ts"]) put(f.wt, p, "x\n");
  const p = reviewPack(f.repo, SLUG);
  assert.deepEqual(p.violations.map((v) => [v.kind, v.detail]).sort(), [
    ["agent-path", "CLAUDE.md"], ["denied-path", ".env"], ["denied-path", "build-out/x.bin"], ["denied-path", "secret/k.txt"],
  ]);
});

test("the ignored paths of a review count from five seconds after the first job began, by its UTC time, and not from the newest job", (t) => {
  const f = fixture(t, { "src/a.ts": "a\n" });
  endJob(f);
  writeFileSync(join(f.wt, ".gitignore"), "build/\n");
  mkdirSync(join(f.wt, "build"));
  writeFileSync(join(f.wt, "build", "x.js"), "x\n");
  // Job ids hold the time they were queued, in UTC, to the second.
  const ids = (...at: number[]) => at.map((ms, i) => `j-${new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14)}-aaa${i}`);
  const setJobs = (jobIds: string[]) => appendEvent(f.id, { t: "task.updated", at: now(), taskId: SLUG, patch: { jobIds }, reason: "test" });
  const flagged = () => details(reviewPack(f.repo, SLUG), "ignored-changed");
  const t0 = Date.now();
  setJobs(ids(t0 - 3_000));
  assert.deepEqual(flagged(), [], "the first seconds are the provisioning's");
  setJobs(ids(t0 - 30_000));
  assert.deepEqual(flagged(), ["build/: 1 file changed since the first job began"]);
  setJobs(ids(t0 - 30_000, t0 + 60_000));
  assert.deepEqual(flagged(), ["build/: 1 file changed since the first job began"], "the first job counts, not the newest");
  setJobs(ids(t0 + 60_000));
  assert.deepEqual(flagged(), [], "nothing changed after a job that has not begun");
});

test("a report that is blocked, partial or asks a question is flagged report-asks, for the round the task is in only, and its text stays out", (t) => {
  const f = fixture(t, { "src/a.ts": "a\n" });
  endJob(f);
  put(f.wt, "src/a.ts", "b\n");
  const seq = loadState(f.id).tasks[SLUG].seq;
  const write = (at: number, over: object) => {
    mkdirSync(roundDir(f.id, SLUG, at), { recursive: true });
    writeFileSync(join(roundDir(f.id, SLUG, at), "report.json"), JSON.stringify({
      status: "done", summary: "Done.", files_changed: [], commands_run: [], tests: { ran: false, passed: 0, failed: 0, notes: "" },
      open_issues: [], questions_for_lead: [], ...over,
    }));
  };
  const asked = () => details(reviewPack(f.repo, SLUG), "report-asks");
  assert.deepEqual(asked(), [], "no report");
  write(seq, {});
  assert.deepEqual(asked(), [], "a report that asks nothing");
  write(seq, { status: "partial" });
  assert.deepEqual(asked(), ["the report says partial"]);
  write(seq, { status: "blocked", questions_for_lead: ["SECRET-QUESTION?", "b?"] });
  assert.deepEqual(asked(), ["the report says blocked and asks 2 questions"]);
  assert.ok(!JSON.stringify(reviewPack(f.repo, SLUG)).includes("SECRET-QUESTION"), "the worker's own words stay out of the pack");
  write(seq, { questions_for_lead: ["a?"] });
  assert.deepEqual(asked(), ["the report asks 1 question"]);
  // A report of an earlier round, where the task has moved on to a round without one, is no ask of this round.
  appendEvent(f.id, { t: "task.updated", at: now(), taskId: SLUG, patch: { seq: seq + 1 }, reason: "test" });
  write(seq, { status: "blocked" });
  assert.deepEqual(asked(), [], "only the report of the task's own round counts");
});

// A job that ran `npm test` and reported two commands, one of which it never ran.
const REPORT = {
  status: "done", summary: "Done.", files_changed: [],
  commands_run: [
    { command: "npm test", exit_code: 0, summary: "all passed" },
    { command: "npm run lint", exit_code: 0, summary: "clean" },
  ],
  tests: { ran: true, passed: 1, failed: 0, notes: "" }, open_issues: [], questions_for_lead: [],
};

const unrun = (i: number) => `commands_run[${i}] has no command_execution item in the job's raw.log`;

test("unrun-claim flags each commands_run entry no command_execution item matches", async (t) => {
  const home = tempHome({ config: true });
  t.after(() => reap(home));
  const repo = tempRepo();
  const id = projectIdFor(repo);
  const scratch = scratchDir(id, "t");
  goalStart(repo, GOAL, null);
  writeScenarios([{ stdout: "generated:done", commands: ["npm   test\n"], lastMessage: JSON.stringify(REPORT), writeFile: [{ path: "a.txt", content: "a\n" }] }]);
  const brief = join(scratch, "brief.md");
  writeFileSync(brief, "Do the work.\n");
  dispatch(repo, { goal: GOAL, slug: SLUG, tier: "light", briefFile: brief, scope: [], use: { tool: "codex", model: "gpt-6-luna", effort: "medium" }, after: null });
  assert.ok(await until(() => loadState(id).tasks[SLUG]?.status === "needs-review"), "the task reaches needs-review");
  withProjectLock(id, () => {}); // the completion still holds the lock for its pump

  const p = reviewPack(repo, SLUG);
  const round = join(projectDir(id), "tasks", SLUG, "rounds", "1");
  assert.equal(p.reportPath, join(round, "report.json"));
  assert.deepEqual(details(p, "unrun-claim"), [unrun(1)]);
  assert.ok(!JSON.stringify(p).includes("npm run lint"), "the report text stays out of the pack");

  // Real Codex escapes a single quote the POSIX way inside the -lc argument.
  const job = loadState(id).tasks[SLUG].jobIds.at(-1)!;
  const item = (type: string, command: string, event = "item.completed") => `${JSON.stringify({ type: event, item: { type, command } })}\n`;
  const raw = join(jobDir(job), "raw.log");
  writeFileSync(raw, [
    "not json\n", item("command_execution", "/bin/zsh -lc 'echo '\\''hi'\\'''"), item("command_execution", "bash -lc 'npm run lint -- --fix'", "item.started"),
    item("agent_message", "npm run lint"), item("command_execution", "/bin/zsh -lc 'npm   test && echo done'"),
  ].join(""));
  writeFileSync(join(round, "report.json"), JSON.stringify({ ...REPORT, commands_run: ["echo 'hi'", "npm test", "npm run lint", "echo", ""].map((command) => ({ command, exit_code: 0, summary: "" })) }));
  assert.deepEqual(details(reviewPack(repo, SLUG), "unrun-claim"), [unrun(2), unrun(4)]);

  // A missing raw.log or report gives no flag and no error.
  rmSync(raw);
  assert.deepEqual(details(reviewPack(repo, SLUG), "unrun-claim"), []);
  writeFileSync(raw, item("command_execution", "npm test"));
  rmSync(join(round, "report.json"));
  const gone = reviewPack(repo, SLUG);
  assert.deepEqual([details(gone, "unrun-claim"), gone.reportPath], [[], null]);

  // A newer job that wrote no report is not held to the claims of an older round.
  writeFileSync(raw, "");
  writeFileSync(join(round, "report.json"), JSON.stringify(REPORT));
  assert.deepEqual(details(reviewPack(repo, SLUG), "unrun-claim"), [unrun(0), unrun(1)]);
  const next = "j-20260101000000-abcd";
  mkdirSync(jobDir(next), { recursive: true });
  writeFileSync(join(jobDir(next), "raw.log"), item("command_execution", "ls"));
  const candidate = { tool: "codex", model: "gpt-6-luna", effort: "medium" } as const;
  appendEvent(id, { t: "job.started", at: now(), job: { id: next, taskId: SLUG, seq: 2, kind: "resume", candidate } });
  appendEvent(id, { t: "task.updated", at: now(), taskId: SLUG, reason: "test", patch: { seq: 2, jobIds: [...loadState(id).tasks[SLUG].jobIds, next] } });
  const newer = reviewPack(repo, SLUG);
  assert.deepEqual([details(newer, "unrun-claim"), newer.reportPath], [[], join(round, "report.json")]);
});

// Commands as a real Codex run logged them: a script with single quotes goes in double quotes with \" escapes, a
// heredoc script runs as one -lc argument, and one holding ! is glued from double- and single-quoted pieces.
const DOUBLE_QUOTED = String.raw`/bin/zsh -lc "node -e 'import(\"./math.mjs\").then(m => console.log(\"sum=\" + m.add(2, 3)))'"`;
const HEREDOC = `/bin/zsh -lc "cat > math.mjs <<'EOF'
export function add(a, b) {
  return a + b;
}
EOF
cat > math.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './math.mjs';

test('adds two numbers', () => {
  assert.equal(add(2, 3), 5);
});
EOF
node --test"`;
const GLUED = `/bin/zsh -lc "cat > math.mjs <<'EOF'
export function add(a, b) {
  if ("'!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new TypeError('"'Both arguments must be finite numbers');
  }

  return a + b;
}
EOF
cat > math.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './math.mjs';

test('adds two numbers', () => {
  assert.equal(add(2, 3), 5);
});

test('adds negative numbers', () => {
  assert.equal(add(-2, 5), 3);
});

test('rejects non-numbers', () => {
  assert.throws(() => add('2', 3), TypeError);
});
EOF
node --test"`;

test("unrun-claim reads an executed command as the shell did, whichever way Codex quoted the script", (t) => {
  const f = fixture(t);
  const job = "j-20260101000000-ab12";
  mkdirSync(jobDir(job), { recursive: true });
  const candidate = { tool: "codex", model: "gpt-6-luna", effort: "medium" } as const;
  appendEvent(f.id, { t: "job.started", at: now(), job: { id: job, taskId: SLUG, seq: 1, kind: "start", candidate } });
  appendEvent(f.id, { t: "task.updated", at: now(), taskId: SLUG, reason: "test", patch: { seq: 1, jobIds: [job] } });
  const item = (command: string) => `${JSON.stringify({ type: "item.completed", item: { type: "command_execution", command } })}\n`;
  writeFileSync(join(jobDir(job), "raw.log"), [DOUBLE_QUOTED, HEREDOC, GLUED, 'bash -lc "echo \\$HOME \\\\ \\"a b\\""'].map(item).join(""));
  const claims = [
    `node -e 'import("./math.mjs").then(m => console.log("sum=" + m.add(2, 3)))'`,
    "node --test",
    "if (!Number.isFinite(a) || !Number.isFinite(b)) {",
    "throw new TypeError('Both arguments must be finite numbers');",
    'echo $HOME \\ "a b"',
    "npm test",
    `node -e 'import(\\"./math.mjs\\")`,
  ];
  const round = roundDir(f.id, SLUG, 1);
  mkdirSync(round, { recursive: true });
  writeFileSync(join(round, "report.json"), JSON.stringify({ ...REPORT, commands_run: claims.map((command) => ({ command, exit_code: 0, summary: "" })) }));
  assert.deepEqual(details(reviewPack(f.repo, SLUG), "unrun-claim"), [unrun(5), unrun(6)]);
});

test("the CLI prints the pack as JSON and refuses a missing slug", (t) => {
  const f = fixture(t, { "src/a.ts": "a\n" });
  put(f.wt, "src/a.ts", "b\n// TODO: later\n");
  const run = (...args: string[]) => spawnSync(LAUNCHER, args, { cwd: f.repo, encoding: "utf8" });
  const ok = run("review", SLUG);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), reviewPack(f.repo, SLUG));
  assert.equal(JSON.parse(ok.stdout).redFlags[0].kind, "todo-added");
  assert.equal(run("review").status, 2);
  assert.equal(run("review", SLUG, "extra").status, 2);
});
