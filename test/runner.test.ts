import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Candidate, JobKind, JobOutcome, JobRecord, JobResult, LedgerEvent, TaskRecord, TaskStatus, WorkerReport } from "../src/contracts.ts";
import { jobDir, processStart, projectDir, workerEnv } from "../src/home.ts";
import { appendEvent, loadState, now, readEvents } from "../src/ledger.ts";
import { countActiveJobs } from "../src/routing.ts";
import { cancelMarker, pruneJobs, reconcileLocked, runJob, spawnInRoot } from "../src/runner.ts";
import { withProjectLock, withSlotsLock, writeFileAtomic, writeJsonAtomic } from "../src/store.ts";
import { emptyProjectConfig, saveProjectConfig } from "../src/provision.ts";
import { startJobLocked } from "../src/tasks.ts";
import { temp, readAgyLog, readFakeLog, tempHome, tempRepo, writeAgyConfig, writeAgyScenarios, writeScenarios } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const LAUNCHER = join(ROOT, "bin", "mandor");
const FAKE = join(import.meta.dirname, "fake-bin", "fake-codex.mjs");
const FAKE_AGY = join(import.meta.dirname, "fake-bin", "fake-agy.mjs");
const PROJECT = "demo-000000000000";
const SLUG = "t1";
const CANDIDATE: Candidate = { tool: "codex", model: "gpt-6-luna", effort: "medium" };
const THREAD = "00000000-0000-7000-8000-000000000301";
const OLD_THREAD = "00000000-0000-7000-8000-000000000302";
const SECRET = "SECRET_TOKEN_123";
const BRIEF = "Brief: add a.txt.\n";
const REPORT: WorkerReport = {
  status: "done", summary: "Done.", files_changed: [], commands_run: [],
  tests: { ran: false, passed: 0, failed: 0, notes: "" }, open_issues: [], questions_for_lead: [],
};

const currentTask = () => loadState(PROJECT).tasks[SLUG];
const readJob = (id: string) => JSON.parse(readFileSync(join(jobDir(id), "job.json"), "utf8")) as JobRecord;
const readResult = (id: string) => JSON.parse(readFileSync(join(jobDir(id), "result.json"), "utf8")) as JobResult;
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const ledgerText = () => read(join(projectDir(PROJECT), "ledger.jsonl"));
const toolsText = () => read(join(process.env.MANDOR_HOME!, "tools.jsonl"));
const roundFile = (seq: number, name: string) => join(projectDir(PROJECT), "tasks", SLUG, "rounds", String(seq), name);
// Model detection runs the fake too, so only exec calls are worker runs.
const execs = () => readFakeLog().filter((e) => e.argv[0] === "exec");
const alive = (pid: number) => processStart(pid) !== null;
const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};
const reconcile = () => withProjectLock(PROJECT, () => reconcileLocked(PROJECT, []));
const old = () => new Date(Date.now() - 61_000).toISOString(); // past the 60 s queued grace

// An executable sh script, standing in for a worker or for codex. "$0.pid" is a file next to it.
function script(body: string): string {
  const p = join(temp("mandor-script-"), "run");
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

async function until(ok: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; !ok(); await sleep(50)) if (Date.now() > end) return false;
  return true;
}

type Finished = Extract<LedgerEvent, { t: "job.finished" }>;
const finishedEvents = (jobId: string) => readEvents(PROJECT).items.filter((e): e is Finished => e.t === "job.finished" && e.jobId === jobId);

// A runner appends job.finished before the task updates of the same completion, all under the
// project lock, so taking that lock once waits for the rest of it.
async function finished(jobId: string): Promise<JobOutcome> {
  assert.ok(await until(() => finishedEvents(jobId).length > 0, 20_000), `job ${jobId} finishes`);
  withProjectLock(PROJECT, () => {});
  return finishedEvents(jobId)[0].outcome;
}

async function workerRunning(jobId: string): Promise<JobRecord> {
  assert.ok(await until(() => readJob(jobId).workerPid !== null, 20_000), `job ${jobId} starts its worker`);
  return readJob(jobId);
}

// Whatever a test leaves running dies with it: runners other than this process, and every worker group.
// A pid of 0 or 1 would signal this process's own group or everything, so only real pids are used.
function reap(home: string): void {
  const jobs = join(home, "jobs");
  for (const id of existsSync(jobs) ? readdirSync(jobs) : []) {
    const p = join(jobs, id, "job.json");
    if (!existsSync(p)) continue;
    let job: JobRecord;
    try {
      job = JSON.parse(readFileSync(p, "utf8")) as JobRecord;
    } catch {
      continue; // a record a test made unreadable on purpose
    }
    const runner = job.runnerPid ?? 0;
    if (runner > 1 && runner !== process.pid && processStart(runner) === job.runnerStart) kill(runner);
    if ((job.workerPid ?? 0) > 1) kill(-job.workerPid!);
  }
}

function home(t: TestContext): string {
  const h = tempHome({ config: true });
  t.after(() => reap(h));
  return h;
}

function createTask(over: Partial<TaskRecord>): TaskRecord {
  const task: TaskRecord = {
    id: SLUG, goalBranch: "feat/x", tier: "light", after: null, status: "waiting", stallReason: null,
    pending: { kind: "start", message: null }, base: null, worktree: null, branch: `wip/${SLUG}`, scope: [], seq: 0, fixRounds: 0,
    candidate: null, sessionId: null, use: null, jobIds: [], integratedCommit: null, briefPath: join(projectDir(PROJECT), "tasks", SLUG, "brief.md"),
    ...over,
  };
  appendEvent(PROJECT, { t: "task.created", at: now(), task });
  return task;
}

// A task whose worktree is a plain directory: enough for the fake.
function setup(t: TestContext, over: Partial<TaskRecord> = {}): TaskRecord {
  home(t);
  return createTask({ worktree: temp("mandor-wt-"), ...over });
}

// A task with a real worktree under the mandor home and a recorded repository root, as a handoff needs.
function gitSetup(t: TestContext, over: Partial<TaskRecord> = {}): TaskRecord {
  const h = home(t);
  const repo = tempRepo();
  const worktree = join(h, "worktrees", PROJECT, `task-${SLUG}`);
  mkdirSync(dirname(worktree), { recursive: true });
  execFileSync("git", ["worktree", "add", "-q", "-b", `wip/${SLUG}`, worktree], { cwd: repo });
  writeFileAtomic(join(projectDir(PROJECT), "root"), `${repo}\n`);
  const briefPath = join(projectDir(PROJECT), "tasks", SLUG, "brief.md");
  writeFileAtomic(briefPath, BRIEF);
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  return createTask({ worktree, base, briefPath, ...over });
}

let serial = 0;

function jobRecord(over: Partial<JobRecord>): JobRecord {
  const id = over.id ?? `j-20261108100000-${(serial++).toString(16).padStart(4, "0")}`;
  return {
    id, projectId: PROJECT, taskId: SLUG, seq: 1, kind: "start", candidate: CANDIDATE, worktree: "/tmp", sessionId: null,
    promptPath: join(jobDir(id), "prompt.md"), timeoutMs: 60_000, bin: FAKE, env: workerEnv(id), queuedAt: now(),
    status: "queued", runnerPid: null, runnerStart: null, workerPid: null, startedAt: null, endedAt: null, ...over,
  };
}

// The records startJobLocked writes, without launching a runner, so the test can run the job itself.
function queueJob(over: Partial<JobRecord> = {}): JobRecord {
  const task = currentTask();
  const job = jobRecord({ seq: task.seq + 1, worktree: task.worktree!, ...over });
  writeFileAtomic(job.promptPath, "Do the task.");
  writeJsonAtomic(join(jobDir(job.id), "job.json"), job);
  appendEvent(PROJECT, { t: "job.started", at: now(), job: { id: job.id, taskId: SLUG, seq: job.seq, kind: job.kind, candidate: job.candidate } });
  appendEvent(PROJECT, {
    t: "task.updated", at: now(), taskId: SLUG, reason: "test",
    patch: { status: "working", stallReason: null, pending: null, seq: job.seq, candidate: job.candidate, sessionId: job.sessionId, jobIds: [...task.jobIds, job.id] },
  });
  return job;
}

const startJob = (kind: JobKind = "start", sessionId: string | null = null) =>
  withProjectLock(PROJECT, () => withSlotsLock(() => startJobLocked(PROJECT, currentTask(), kind, CANDIDATE, "Do the task.", sessionId)))!;

// runJob outcomes

test("done: result.json, raw.log 0600, small job.finished, task needs-review, task.sessionId set from thread.started", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done", threadId: THREAD }]);
  const job = queueJob();
  await runJob(job.id);
  const result = readResult(job.id);
  assert.deepEqual([result.status, result.sessionId, result.report], ["done", THREAD, REPORT]);
  for (const f of ["raw.log", "stderr.log", "result.json", "job.json", "last-message.json"]) assert.equal(statSync(join(jobDir(job.id), f)).mode & 0o777, 0o600, f);
  const line = ledgerText().split("\n").find((l) => l.includes('"job.finished"'))!;
  assert.ok(Buffer.byteLength(line) < 1024, line);
  assert.deepEqual(JSON.parse(line).outcome, { status: "done", sessionId: THREAD, detail: "", resetsAt: null, exitCode: 0 });
  assert.deepEqual(JSON.parse(readFileSync(roundFile(1, "report.json"), "utf8")), REPORT);
  const task = currentTask();
  assert.deepEqual([task.status, task.sessionId], ["needs-review", THREAD]);
  const done = readJob(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.runnerPid, process.pid);
  assert.ok(done.startedAt !== null && done.endedAt !== null && done.workerPid !== null);
  assert.equal(process.cwd(), process.env.MANDOR_HOME, "the runner enters the worktree only to start the worker");
});

test("quota: tool.exhausted codex and task stalled all-exhausted", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:quota" }]);
  const job = queueJob();
  await runJob(job.id);
  const tools = toolsText().trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(tools.map((e) => [e.t, e.key]), [["tool.exhausted", "codex"]]);
  const task = currentTask();
  assert.deepEqual([task.status, task.stallReason], ["stalled", "all-exhausted"]);
  assert.equal(readJob(job.id).status, "quota");
});

test("model-limit keys codex:<candidate model>", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:model-limit" }]);
  const job = queueJob();
  await runJob(job.id);
  const tools = toolsText().trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(tools.map((e) => e.key), [`codex:${CANDIDATE.model}`]);
  const task = currentTask();
  assert.deepEqual([task.status, task.stallReason], ["stalled", "model-limit"]);
});

test("20 KB report completes normally", async (t) => {
  setup(t);
  const report: WorkerReport = { ...REPORT, summary: "x".repeat(20_000) };
  writeScenarios([{ stdout: "generated:done", lastMessage: JSON.stringify(report) }]);
  const job = queueJob();
  await runJob(job.id);
  assert.deepEqual(readResult(job.id).report, report);
  assert.deepEqual(JSON.parse(readFileSync(roundFile(1, "report.json"), "utf8")), report);
  assert.ok(ledgerText().split("\n").every((l) => Buffer.byteLength(l) < 1024));
  assert.equal(currentTask().status, "needs-review");
});

test("a done job whose report says blocked or partial carries that in its outcome detail", async (t) => {
  setup(t);
  writeScenarios([
    { stdout: "generated:done", lastMessage: JSON.stringify({ ...REPORT, status: "blocked" }) },
    { stdout: "generated:done", lastMessage: JSON.stringify({ ...REPORT, status: "partial" }) },
    { stdout: "generated:done", lastMessage: JSON.stringify(REPORT) },
  ]);
  const details: string[] = [];
  for (let i = 0; i < 3; i++) {
    const job = queueJob();
    await runJob(job.id);
    const outcome = finishedEvents(job.id)[0].outcome;
    assert.equal(outcome.status, "done");
    details.push(outcome.detail);
  }
  assert.deepEqual(details, ["the report says blocked", "the report says partial", ""]);
  assert.equal(currentTask().status, "needs-review");
});

test("a job whose worktree root was replaced by a link starts no worker in what the link names", async (t) => {
  const task = setup(t);
  // A process an earlier round left behind emptied the root and put a link at its name, to a sibling's tree.
  const sibling = temp("mandor-sibling-");
  rmSync(task.worktree!, { recursive: true });
  symlinkSync(sibling, task.worktree!);
  writeScenarios([{ stdout: "generated:done", writeFile: [{ path: "a.txt", content: "a\n" }] }]);
  const job = queueJob();
  await runJob(job.id);
  assert.deepEqual(readdirSync(sibling), [], "nothing was written where the link points");
  assert.equal(execs().length, 0, "no worker started");
  assert.equal((await finished(job.id)).status, "failed");
  assert.match(read(join(process.env.MANDOR_HOME!, "logs", "runner.log")), /its root .* is not a directory at its own path/);
});

test("a root swapped for a link right after its check passes starts no worker in what the link names", async (t) => {
  const task = setup(t);
  const sibling = temp("mandor-sibling-");
  const native = fs.realpathSync.native;
  let swapped = false;
  // The check sees a real directory, and the swap lands before the start enters it, as a left-behind process can time it.
  t.mock.method(fs.realpathSync, "native", ((p: fs.PathLike) => {
    const real = native(p);
    if (p === task.worktree && !swapped) {
      swapped = true;
      rmSync(task.worktree!, { recursive: true });
      symlinkSync(sibling, task.worktree!);
    }
    return real;
  }) as typeof native);
  writeScenarios([{ stdout: "generated:done", writeFile: [{ path: "a.txt", content: "a\n" }] }]);
  const job = queueJob();
  await runJob(job.id);
  assert.ok(swapped, "the start checked the root");
  assert.deepEqual(readdirSync(sibling), [], "nothing was written where the link points");
  assert.equal(execs().length, 0, "no worker started");
  assert.equal((await finished(job.id)).status, "failed");
  assert.match(read(join(process.env.MANDOR_HOME!, "logs", "runner.log")), /its root .* is not a directory at its own path/);
});

test("a root that is a link only while the write boundary is built starts no worker that may write where the link points", async (t) => {
  const task = setup(t);
  writeAgyConfig(process.env.MANDOR_HOME!);
  saveProjectConfig(PROJECT, { ...emptyProjectConfig(), workerNetwork: true });
  writeAgyScenarios([{}]);
  const sibling = temp("mandor-sibling-");
  const parked = `${task.worktree}.parked`;
  const native = fs.realpathSync.native;
  let looks = 0;
  // A link for the first resolution of the root and a directory again after it, as a process an earlier round left
  // behind can time it: a boundary built from the path before any check would name the link's target, and the
  // start's own check would then pass.
  t.mock.method(fs.realpathSync, "native", ((p: fs.PathLike) => {
    if (p !== task.worktree || ++looks > 1) return native(p);
    fs.renameSync(task.worktree!, parked);
    symlinkSync(sibling, task.worktree!);
    try {
      return native(p);
    } finally {
      rmSync(task.worktree!);
      fs.renameSync(parked, task.worktree!);
    }
  }) as typeof native);
  const job = queueJob({ candidate: { tool: "agy", model: "gemini-3.8-flash-low", effort: "low" }, bin: FAKE_AGY });
  await runJob(job.id);
  const workers = readAgyLog().filter((e) => e.argv.includes("-p"));
  assert.deepEqual(workers.filter((e) => e.argv.join(" ").includes(sibling)), [], "no worker may write where the link points");
  assert.equal(workers.length, 0, "no worker started");
  assert.equal((await finished(job.id)).status, "failed");
});

// The physical cwd the start verifies is the constructed path, whose parent is resolved: a home reached through a link
// (/var for /private/var, say) still starts its workers.
test("a worktree named through a linked parent starts its worker in the real directory", async (t) => {
  home(t);
  const real = temp("mandor-wt-");
  const link = join(temp("mandor-parent-"), "wts");
  symlinkSync(dirname(real), link);
  const child = spawnInRoot(join(link, basename(real)), { command: "/bin/pwd", args: ["-P"], env: {} }, ["ignore", "pipe", "ignore"]);
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  await new Promise((done) => child.once("close", done));
  assert.equal(out.trim(), real);
});

test("a worktree named through a linked parent gets its write rules from the root the runner verified", async (t) => {
  const task = setup(t);
  writeAgyConfig(process.env.MANDOR_HOME!);
  saveProjectConfig(PROJECT, { ...emptyProjectConfig(), workerNetwork: true });
  writeAgyScenarios([{}]);
  // The same directory, named through a link to its parent, as a home under /var is.
  const link = join(temp("mandor-parent-"), "wts");
  symlinkSync(dirname(task.worktree!), link);
  const spelled = join(link, basename(task.worktree!));
  const job = queueJob({ worktree: spelled, candidate: { tool: "agy", model: "gemini-3.8-flash-low", effort: "low" }, bin: FAKE_AGY });
  await runJob(job.id);
  const [worker] = readAgyLog().filter((e) => e.argv.includes("-p"));
  assert.ok(worker !== undefined, "the worker started");
  const { permissions } = JSON.parse(worker.argv[worker.argv.indexOf("--settings") + 1]);
  assert.deepEqual(permissions.allow.slice(0, 2), [`write_file(${task.worktree})`, `read_file(${task.worktree})`]);
  assert.equal(worker.cwd, task.worktree);
});

// Swaps the root of task-a for a link to task-b and back, confined like a worker to that root: the sandbox grants the
// root entry itself, so a process a worker left behind can do the same. Ends by itself after 60 s.
const rootSwapper = `
  const fs = require("fs");
  const [a, b, ready] = process.argv.slice(1);
  const quiet = (f) => { try { f(); } catch {} };
  fs.writeFileSync(ready, "");
  for (const end = Date.now() + 60000; Date.now() < end;) {
    quiet(() => fs.rmdirSync(a));
    quiet(() => fs.symlinkSync(b, a));
    quiet(() => fs.unlinkSync(a));
    quiet(() => fs.mkdirSync(a));
  }`;
const WORKER_PROFILE = '(version 1)(allow default)(deny file-write*)(allow file-write* (subpath (param "ROOT")) (literal (param "READY")))';

test("a root swapped for a link to a sibling during the start never gives the worker the sibling as its cwd", async (t) => {
  const h = home(t);
  const a = join(h, "worktrees", PROJECT, "task-a");
  const b = join(h, "worktrees", PROJECT, "task-b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b);
  const ready = join(h, "ready");
  const swapper = spawn("/usr/bin/sandbox-exec", ["-D", `ROOT=${a}`, "-D", `READY=${ready}`, "-p", WORKER_PROFILE, process.execPath, "-e", rootSwapper, a, b, ready], { stdio: "ignore" });
  const seen = { own: 0, sibling: 0, gone: 0, refused: 0 };
  try {
    assert.ok(await until(() => existsSync(ready), 5_000), "the swapper runs");
    for (let i = 0; i < 1000; i++) {
      let child: ChildProcess;
      try {
        child = spawnInRoot(a, { command: "/bin/pwd", args: ["-P"], env: {} }, ["ignore", "pipe", "ignore"]);
      } catch {
        seen.refused++; // a link or no entry at the root, or a root gone before its check: all fail the job unstarted
        continue;
      }
      const cwd = await new Promise<string | null>((done) => {
        let s = "";
        child.stdout!.on("data", (d) => (s += d));
        child.once("error", () => done(null)); // a spawn that fails has started no worker: the job fails unstarted too
        child.once("close", () => done(s.trim()));
      });
      if (cwd === null) seen.refused++;
      else seen[cwd === a ? "own" : cwd === b ? "sibling" : "gone"]++; // gone: the root was removed under a started worker
    }
  } finally {
    swapper.kill("SIGKILL");
  }
  t.diagnostic(JSON.stringify(seen));
  assert.equal(seen.sibling, 0, `the worker's cwd was the sibling: ${JSON.stringify(seen)}`);
  assert.ok(seen.refused > 0 && seen.own + seen.gone > 0, `the swap was not seen by started workers: ${JSON.stringify(seen)}`);
});

test("timeout kills the sleeper grandchild", async (t) => {
  setup(t);
  const pidFile = join(temp("mandor-sleeper-"), "sleeper.pid");
  writeScenarios([{ stdout: "generated:done", sleeperPidFile: pidFile, delayMs: 30_000 }]);
  const job = queueJob({ timeoutMs: 1500 });
  await runJob(job.id);
  const sleeper = Number(readFileSync(pidFile, "utf8"));
  assert.ok(sleeper > 1);
  assert.ok(await until(() => !alive(sleeper), 5_000), "the stop reaches the worker's whole process group");
  assert.equal(readResult(job.id).status, "timeout");
  assert.equal(finishedEvents(job.id)[0].outcome.status, "timeout");
  const task = currentTask();
  assert.deepEqual([task.status, task.stallReason], ["stalled", "timeout"]);
});

test("cancel marker gives cancelled with the task unchanged", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done", delayMs: 30_000 }]);
  const job = queueJob();
  const before = currentTask();
  const run = runJob(job.id);
  assert.ok(await until(() => execs().length === 1, 10_000), "the worker starts");
  const marked = Date.now();
  // A cancel under way: this process stands in for it.
  writeJsonAtomic(cancelMarker(PROJECT, SLUG), { pid: process.pid, start: processStart(process.pid) });
  await run;
  assert.ok(Date.now() - marked < 10_000, "the stop does not wait out the worker's 30 s");
  assert.equal(readJob(job.id).status, "cancelled");
  assert.equal(finishedEvents(job.id)[0].outcome.status, "cancelled");
  assert.deepEqual(currentTask(), before);
});

// What a cancel killed between its locks leaves: a marker whose writer is gone.
const deadCancel = () => writeJsonAtomic(cancelMarker(PROJECT, SLUG), { pid: spawnSync("/usr/bin/true").pid!, start: "Thu Jan  1 00:00:00 1970" });

test("a marker whose cancel died stops nothing: the job ends with its own outcome and the marker goes", async (t) => {
  setup(t);
  // Past the first check of the marker, a second into the run.
  writeScenarios([{ stdout: "generated:done", threadId: THREAD, delayMs: 1500 }]);
  const job = queueJob();
  deadCancel();
  await runJob(job.id);
  assert.deepEqual([readJob(job.id).status, finishedEvents(job.id)[0].outcome.status, currentTask().status], ["done", "done", "needs-review"]);
  assert.equal(existsSync(cancelMarker(PROJECT, SLUG)), false);
  assert.match(read(join(process.env.MANDOR_HOME!, "logs", "runner.log")), /task t1: removed the marker of a cancel that did not finish/);
});

test("the marker of a cancel that finished still stops a job that outlived its wait", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done", delayMs: 30_000 }]);
  const job = queueJob();
  // A cancel that recorded the task: the ledger says cancelled, and its writer is gone.
  appendEvent(PROJECT, { t: "task.updated", at: now(), taskId: SLUG, patch: { status: "cancelled", stallReason: null, pending: null }, reason: "cancelled" });
  deadCancel();
  const begun = Date.now();
  await runJob(job.id);
  assert.ok(Date.now() - begun < 10_000, "the stop does not wait out the worker's 30 s");
  assert.deepEqual([readJob(job.id).status, finishedEvents(job.id)[0].outcome.status, currentTask().status], ["cancelled", "cancelled", "cancelled"]);
  assert.equal(existsSync(cancelMarker(PROJECT, SLUG)), true);
});

test("half a cancel beside a ledger the runner cannot read leaves it going: the check logs once and the job ends with its own outcome", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done", threadId: THREAD, delayMs: 8000 }]);
  const job = await workerRunning(startJob().id);
  const ledger = join(projectDir(PROJECT), "ledger.jsonl");
  const good = readFileSync(ledger);
  writeFileSync(ledger, Buffer.concat([good, Buffer.from("not json\n")]));
  deadCancel();
  const judged = () => read(join(process.env.MANDOR_HOME!, "logs", "runner.log")).split("\n").filter((l) => l.includes("could not judge the cancel marker"));
  assert.ok(await until(() => judged().length > 0, 10_000), "the runner says it could not judge the marker");
  await sleep(2500); // more checks pass with the ledger still unreadable
  writeFileSync(ledger, good);
  assert.deepEqual([(await finished(job.id)).status, currentTask().status], ["done", "needs-review"]);
  assert.equal(judged().length, 1, "said once");
});

test("half a cancel that stays as it is is judged once, not on every check of the marker", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done", threadId: THREAD, delayMs: 4500 }]);
  const job = queueJob();
  const ledger = join(projectDir(PROJECT), "ledger.jsonl");
  const realRead = fs.readFileSync;
  let [reads, counting] = [0, true];
  const spy = t.mock.method(fs, "readFileSync", ((...args: unknown[]) => {
    if (counting && String(args[0]) === ledger) reads++;
    return Reflect.apply(realRead, fs, args);
  }) as unknown as typeof fs.readFileSync);
  syncBuiltinESMExports(); // store.ts imports readFileSync by name
  try {
    const run = runJob(job.id);
    assert.ok(await until(() => readJob(job.id).workerPid !== null, 10_000), "the worker starts");
    deadCancel();
    await sleep(3200); // three checks of the marker, which judging reads the ledger for
    counting = false;
    await run;
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(reads, 1);
  assert.deepEqual([finishedEvents(job.id)[0].outcome.status, currentTask().status], ["done", "needs-review"]);
});

test("a fresh cancel after half a cancel is judged again, so the job stops within seconds", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done", delayMs: 30_000 }]);
  const job = queueJob();
  const run = runJob(job.id);
  assert.ok(await until(() => readJob(job.id).workerPid !== null, 10_000), "the worker starts");
  deadCancel();
  await sleep(2500); // judged as not standing, and cached
  const marked = Date.now();
  // A new cancel writes its own marker: a fresh file, so a new mtime. This process stands in for it.
  writeJsonAtomic(cancelMarker(PROJECT, SLUG), { pid: process.pid, start: processStart(process.pid) });
  await run;
  assert.ok(Date.now() - marked < 10_000, `the stop took ${Date.now() - marked} ms, not the worker's 30 s`);
  assert.deepEqual([readJob(job.id).status, finishedEvents(job.id)[0].outcome.status], ["cancelled", "cancelled"]);
});

test("a marker that cannot be checked counts as no cancel, and the runner says so once", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done", threadId: THREAD, delayMs: 4500 }]);
  const job = queueJob();
  deadCancel();
  const dir = dirname(cancelMarker(PROJECT, SLUG));
  t.after(() => fs.chmodSync(dir, 0o700));
  const run = runJob(job.id);
  assert.ok(await until(() => readJob(job.id).workerPid !== null, 10_000), "the worker starts");
  fs.chmodSync(dir, 0); // every check now fails
  await sleep(3200);
  fs.chmodSync(dir, 0o700); // the completion writes the round's report there
  await run;
  const told = read(join(process.env.MANDOR_HOME!, "logs", "runner.log")).split("\n").filter((l) => l.includes("could not judge the cancel marker"));
  assert.equal(told.length, 1, told.join("\n"));
  assert.deepEqual([finishedEvents(job.id)[0].outcome.status, currentTask().status], ["done", "needs-review"]);
});

test("SECRET_TOKEN_123 in fake stderr appears in neither ledger, tools.jsonl, nor result.json", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:quota", stderr: `token ${SECRET}\n` }]);
  const job = queueJob();
  await runJob(job.id);
  assert.ok(read(join(jobDir(job.id), "stderr.log")).includes(SECRET), "stderr goes to the job file");
  assert.notEqual(toolsText(), "");
  for (const text of [ledgerText(), toolsText(), read(join(jobDir(job.id), "result.json"))]) assert.ok(!text.includes(SECRET));
});

test("a done run paid by workspace credits exhausts codex until the plan window resets", async (t) => {
  setup(t);
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const limits = { credits: { has_credits: true }, primary: { used_percent: 100, resets_at: resetsAt }, secondary: { used_percent: 40, resets_at: resetsAt + 86_400 } };
  const event = { timestamp: new Date(Date.now() + 60_000).toISOString(), type: "event_msg", payload: { type: "token_count", rate_limits: limits } };
  const sessions = join(process.env.CODEX_HOME!, "sessions", "2026", "11", "08");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `rollout-2026-11-08T10-00-00-${THREAD}.jsonl`), `${JSON.stringify(event)}\n`);
  writeScenarios([{ stdout: "generated:done", threadId: THREAD }]);
  const job = queueJob();
  await runJob(job.id);
  assert.equal(readResult(job.id).creditFunded, true);
  assert.equal(currentTask().status, "needs-review");
  const tools = toolsText().trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(tools.map((e) => [e.key, e.resetsAt, e.detail]), [["codex", resetsAt, "plan limit reached while workspace credits are available"]]);
});

// Worker processes

test("a worker that ignores SIGINT is killed 10 s after the stop", async (t) => {
  setup(t);
  const worker = script(`trap '' INT\n/bin/sleep 30 &\necho $! > "$0.pid"\nwait`);
  const job = queueJob({ bin: worker, timeoutMs: 1_000 });
  const started = Date.now();
  await runJob(job.id);
  const took = Date.now() - started;
  assert.ok(took >= 10_000 && took < 25_000, `the run ended after ${took} ms`);
  assert.equal(readResult(job.id).status, "timeout");
  const child = Number(readFileSync(`${worker}.pid`, "utf8"));
  assert.ok(await until(() => !alive(child), 5_000), "the SIGKILL reaches the whole group");
});

test("a worker's background children die with its process group when it exits", async (t) => {
  setup(t);
  const worker = script(`/bin/sleep 300 &\necho $! > "$0.pid"\nexec ${JSON.stringify(FAKE)} "$@"`);
  writeScenarios([{ stdout: "generated:done" }]);
  const job = queueJob({ bin: worker });
  await runJob(job.id);
  assert.equal(readResult(job.id).status, "done");
  const child = Number(readFileSync(`${worker}.pid`, "utf8"));
  assert.ok(child > 1);
  assert.ok(await until(() => !alive(child), 5_000), "the background sleep dies with the group");
});

test("a runner error after the worker started kills the worker before the job completes", async (t) => {
  const task = setup(t);
  // The fake's argv names the task worktree, so pgrep finds it even when no workerPid was recorded.
  t.after(() => spawnSync("/usr/bin/pkill", ["-KILL", "-f", task.worktree!]));
  writeScenarios([{ stdout: "generated:done", delayMs: 30_000 }]);
  const job = queueJob();
  const jobJson = join(jobDir(job.id), "job.json");
  const realRename = fs.renameSync;
  let renames = 0;
  // The run's second job.json write records the worker pid, right after the worker started.
  const rename = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === jobJson && ++renames === 2) throw new Error("injected write error");
    realRename(from, to);
  });
  syncBuiltinESMExports(); // store.ts imports renameSync by name
  const started = Date.now();
  try {
    await runJob(job.id);
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(renames, 3, "claim, worker pid, completion");
  assert.ok(Date.now() - started < 10_000, "the run does not wait out the worker's 30 s");
  assert.equal(spawnSync("/usr/bin/pgrep", ["-f", task.worktree!]).status, 1, "no worker is left running");
  const outcome = finishedEvents(job.id)[0].outcome;
  assert.deepEqual([outcome.status, outcome.detail], ["failed", "runner error"]);
  assert.match(read(join(process.env.MANDOR_HOME!, "logs", "runner.log")), /injected write error/);
});

// Launch and the hidden _run command

test("worker env from the fake log equals the allowlist (no CODEX_API_KEY, SSH_AUTH_SOCK, GH_TOKEN; GIT_SSH_COMMAND=/usr/bin/false; GRADLE_OPTS set)", async (t) => {
  setup(t);
  const secrets = { CODEX_API_KEY: "sk-test", SSH_AUTH_SOCK: "/tmp/agent.sock", GH_TOKEN: "gh-test" };
  const saved = Object.keys(secrets).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, secrets);
  t.after(() => {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  writeScenarios([{ stdout: "generated:done" }]);
  const job = startJob();
  assert.deepEqual([job.bin, job.timeoutMs, job.status], [FAKE, 60 * 60_000, "queued"]);
  assert.equal((await finished(job.id)).status, "done");
  const runs = execs();
  assert.equal(runs.length, 1);
  const { __CF_USER_TEXT_ENCODING: _, ...env } = runs[0].env; // macOS adds it to every process
  assert.deepEqual(env, job.env);
  for (const k of Object.keys(secrets)) assert.equal(k in env, false, k);
  assert.equal(env.GIT_SSH_COMMAND, "/usr/bin/false");
  assert.equal(env.GRADLE_OPTS, "-Dorg.gradle.daemon=false");
  assert.equal(env.MANDOR_JOB, job.id);
});

test("a second _run of a finished job does not start the fake again", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done" }, { stdout: "generated:done" }]);
  const job = queueJob();
  await runJob(job.id);
  const ledger = ledgerText();
  const r = spawnSync(LAUNCHER, ["_run", job.id], { encoding: "utf8" });
  assert.deepEqual([r.status, r.stderr], [0, ""]);
  assert.equal(execs().length, 1);
  assert.equal(ledgerText(), ledger);
});

// node:sqlite warns on stderr when it loads; refine loads it for a failed run once the state database exists.
test("_run through bin/mandor keeps stderr empty while node:sqlite loads", (t) => {
  setup(t);
  writeFileSync(join(process.env.CODEX_HOME!, "thread_history_1.sqlite"), "");
  writeScenarios([{ stdout: "generated:no-terminal", exitCode: 1 }]);
  const job = queueJob();
  const r = spawnSync(LAUNCHER, ["_run", job.id], { encoding: "utf8" });
  assert.deepEqual([r.status, r.stderr], [0, ""]);
  const result = readResult(job.id);
  assert.deepEqual([result.status, result.detail], ["failed", "exit 1; see stderr.log"]);
});

test("spawnRunner called from a long-lived parent leaves the runner with parent pid 1", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done", delayMs: 3_000 }]);
  const job = queueJob();
  const code = [
    `import { spawnRunner } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "spawn.ts")).href)};`,
    "spawnRunner(process.argv[1]);",
    "process.stdout.write('spawned');",
    "setInterval(() => {}, 60_000);",
  ].join("\n");
  const parent = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code, job.id], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => kill(parent.pid!));
  let out = "";
  let err = "";
  parent.stdout.on("data", (d) => (out += d));
  parent.stderr.on("data", (d) => (err += d));
  assert.ok(await until(() => out === "spawned", 10_000), err);
  assert.ok(await until(() => readJob(job.id).runnerPid !== null, 10_000), "the runner claims the job");
  const runner = readJob(job.id).runnerPid!;
  assert.deepEqual([parent.exitCode, parent.signalCode], [null, null], "the parent is still alive");
  assert.equal(spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(runner)], { encoding: "utf8" }).stdout.trim(), "1");
  assert.equal((await finished(job.id)).status, "done");
});

test("a runner that cannot be launched fails the job and stalls the task", (t) => {
  setup(t);
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--no-such-option"; // node refuses to start, so the launcher exits non-zero
  let job: JobRecord;
  try {
    job = startJob();
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
  assert.equal(readJob(job.id).status, "failed");
  const outcome = finishedEvents(job.id)[0].outcome;
  assert.deepEqual([outcome.status, outcome.detail], ["failed", "runner did not start"]);
  const task = currentTask();
  assert.deepEqual([task.status, task.stallReason], ["stalled", "failed"]);
});

test("a runner never runs a job the queued grace has written off", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done" }]);
  const job = queueJob({ queuedAt: old() });
  await runJob(job.id);
  assert.equal(execs().length, 0);
  const outcome = finishedEvents(job.id)[0].outcome;
  assert.deepEqual([outcome.status, outcome.detail], ["failed", "runner did not start"]);
  const task = currentTask();
  assert.deepEqual([task.status, task.stallReason], ["stalled", "failed"]);
});

test("a slow model refresh cannot let the queued grace pass before the claim", async (t) => {
  setup(t);
  // Codex for model detection only: its model list takes 8 s.
  const slow = script(`[ "$1" = debug ] && /bin/sleep 8\nexec ${JSON.stringify(FAKE)} "$@"`);
  writeScenarios([{ stdout: "generated:done" }]);
  const job = queueJob({ queuedAt: new Date(Date.now() - 55_000).toISOString() });
  const runner = spawn(LAUNCHER, ["_run", job.id], { env: { ...process.env, MANDOR_CODEX_BIN: slow }, stdio: "ignore" });
  t.after(() => kill(runner.pid!));
  await sleep(6_000); // the grace is over while the refresh still runs
  assert.equal(readJob(job.id).status, "running");
  assert.equal(countActiveJobs().codex, 1);
  assert.equal((await finished(job.id)).status, "done");
});

test("_run records a failure before the claim in runner.log", (t) => {
  setup(t);
  const id = "j-20261108100000-dead";
  const r = spawnSync(LAUNCHER, ["_run", id], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(read(join(process.env.MANDOR_HOME!, "logs", "runner.log")), new RegExp(`job ${id}: ENOENT`));
});

test("a start whose codex binary cannot be found leaves no job behind", (t) => {
  const task = setup(t);
  const home = process.env.MANDOR_HOME!;
  const saved = process.env.MANDOR_CODEX_BIN;
  delete process.env.MANDOR_CODEX_BIN;
  t.after(() => {
    if (saved !== undefined) process.env.MANDOR_CODEX_BIN = saved;
  });
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tools.codex.bin = "mandor-test-no-such-codex";
  writeJsonAtomic(join(home, "config.json"), cfg);
  assert.throws(() => startJob(), /codex not found on PATH/);
  assert.deepEqual(existsSync(join(home, "jobs")) ? readdirSync(join(home, "jobs")) : [], []);
  assert.deepEqual(currentTask(), task);
});

// Liveness and reconciliation

test("countActiveJobs counts live runners and fresh queued jobs across projects", (t) => {
  setup(t);
  const me = { runnerPid: process.pid, runnerStart: processStart(process.pid) };
  const gone = spawnSync("/usr/bin/true").pid;
  const jobs: Partial<JobRecord>[] = [
    { status: "running", ...me },
    { status: "running", ...me, projectId: "other-000000000000" },
    { status: "running", ...me, candidate: { tool: "zcode", model: "GLM-5.3", effort: "high" } },
    { status: "running", runnerPid: process.pid, runnerStart: "Thu Jan  1 00:00:00 1970" },
    { status: "running", runnerPid: gone, runnerStart: "Thu Jan  1 00:00:00 1970" },
    { status: "queued" },
    { status: "queued", queuedAt: new Date(Date.now() - 61_000).toISOString() },
    { status: "done", ...me },
  ];
  for (const over of jobs) {
    const job = jobRecord(over);
    writeJsonAtomic(join(jobDir(job.id), "job.json"), job);
  }
  mkdirSync(jobDir("j-20261108100000-ffff")); // a job directory before its job.json is written
  assert.deepEqual(countActiveJobs(), { codex: 3, zcode: 1, agy: 0 });
});

test("the worker gets its prompt on stdin, so no process list shows it and the byte limit of an argument list does not cut it", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done" }, { stdout: "generated:done" }]);
  const small = queueJob();
  await runJob(small.id);
  const [first] = execs();
  assert.deepEqual([first.stdin, first.argv.at(-1), first.argv.includes("Do the task.")], ["Do the task.", "-", false]);
  // More bytes than a process can be given as arguments, about a megabyte on macOS, in fewer characters than Codex accepts,
  // which is a million: a long brief in a script of three bytes a character. As an argument it failed the start.
  const brief = `A long brief ${"漢".repeat(400_000)}\n`;
  assert.ok(Buffer.byteLength(brief) > 1_048_576 && brief.length < 1_048_576);
  const big = queueJob();
  writeFileSync(big.promptPath, brief);
  await runJob(big.id);
  assert.equal((await finished(big.id)).status, "done");
  assert.equal(execs().at(-1)!.stdin, brief);
});

// Pruning

const DAY = 24 * 60 * 60 * 1000;

// A job of the task that ended `ago` ms ago, as completeJobLocked leaves it: job.json terminal, and the end in the ledger.
function endedJob(ago: number, recordEnd = true): JobRecord {
  const endedAt = new Date(Date.now() - ago).toISOString();
  const job = queueJob();
  writeJsonAtomic(join(jobDir(job.id), "job.json"), { ...job, status: "done", endedAt });
  if (recordEnd) appendEvent(PROJECT, { t: "job.finished", at: endedAt, jobId: job.id, outcome: { status: "done", sessionId: null, detail: "", resetsAt: null, exitCode: 0 } });
  return job;
}

const setTaskStatus = (status: TaskStatus) => appendEvent(PROJECT, { t: "task.updated", at: now(), taskId: SLUG, patch: { status }, reason: "test" });
const kept = (jobs: JobRecord[]) => jobs.map((j) => existsSync(jobDir(j.id)));

test("a job directory goes 30 days after the job ended, once the ledger holds its end and nothing reads it any more", (t) => {
  setup(t);
  const longAgo = 31 * DAY;
  const superseded = endedJob(longAgo);
  const young = endedJob(DAY);
  const unrecorded = endedJob(longAgo, false); // a crash between job.json and job.finished: reconcile still needs it
  const running = queueJob({ status: "running", runnerPid: process.pid, runnerStart: processStart(process.pid), queuedAt: new Date(Date.now() - longAgo).toISOString() });
  const newest = endedJob(longAgo);
  const all = [superseded, young, unrecorded, running, newest];
  setTaskStatus("needs-review");
  pruneJobs();
  // The newest job of a task still open stays: the review reads its log.
  assert.deepEqual(kept(all), [false, true, true, true, true]);
  setTaskStatus("accepted");
  pruneJobs();
  assert.deepEqual(kept(all), [false, true, true, true, false]);
  assert.equal(readJob(young.id).status, "done");
});

test("a job of a cancelled task goes too, and a ledger that cannot be read keeps every job", (t) => {
  setup(t);
  const job = endedJob(31 * DAY);
  setTaskStatus("cancelled");
  writeFileSync(join(projectDir(PROJECT), "ledger.jsonl"), `${ledgerText()}not json\n`);
  pruneJobs();
  assert.deepEqual(kept([job]), [true]);
  writeFileSync(join(projectDir(PROJECT), "ledger.jsonl"), ledgerText().replace("not json\n", ""));
  pruneJobs();
  assert.deepEqual(kept([job]), [false]);
});

test("a job record that cannot be read stays and is logged, and does not keep the others from being pruned", (t) => {
  setup(t);
  // The listing is in name order, so this one is read before every job the helpers make.
  const unreadable = "j-20200101000000-0000";
  mkdirSync(jobDir(unreadable), { recursive: true });
  writeFileSync(join(jobDir(unreadable), "job.json"), "{");
  const job = endedJob(31 * DAY);
  setTaskStatus("accepted");
  pruneJobs();
  assert.deepEqual(kept([job]), [false]);
  assert.equal(existsSync(join(jobDir(unreadable), "job.json")), true);
  assert.match(read(join(process.env.MANDOR_HOME!, "logs", "runner.log")), new RegExp(`job ${unreadable} not pruned: .*is not valid JSON`));
});

test("a runner prunes long-finished jobs when its own job is done", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done" }]);
  const old = endedJob(31 * DAY);
  const job = queueJob();
  await runJob(job.id);
  assert.deepEqual(kept([old, job]), [false, true]);
});

test("reconcile handles a dead runner without result.json", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done", delayMs: 30_000 }]);
  const job = await workerRunning(startJob().id);
  assert.deepEqual(reconcile(), [], "a live runner is left alone");
  kill(job.runnerPid!);
  assert.ok(await until(() => !alive(job.runnerPid!), 5_000));
  kill(-job.workerPid!);
  assert.deepEqual(reconcile(), [job.id]);
  const outcome = finishedEvents(job.id)[0].outcome;
  assert.deepEqual([outcome.status, outcome.detail], ["failed", "runner died"]);
  const task = currentTask();
  assert.deepEqual([task.status, task.stallReason], ["stalled", "runner-died"]);
  assert.deepEqual(reconcile(), []);
  assert.equal(finishedEvents(job.id).length, 1);
});

test("reconcile handles a dead runner with result.json", async (t) => {
  setup(t);
  writeScenarios([{ stdout: "generated:done", delayMs: 30_000 }]);
  const job = await workerRunning(startJob().id);
  kill(job.runnerPid!);
  assert.ok(await until(() => !alive(job.runnerPid!), 5_000));
  kill(-job.workerPid!);
  const result: JobResult = { status: "done", sessionId: THREAD, report: REPORT, usageCumulative: null, detail: "", resetsAt: null, exitCode: 0, creditFunded: false };
  writeJsonAtomic(join(jobDir(job.id), "result.json"), result);
  assert.deepEqual(reconcile(), [job.id]);
  assert.equal(finishedEvents(job.id)[0].outcome.status, "done");
  const task = currentTask();
  assert.deepEqual([task.status, task.sessionId], ["needs-review", THREAD]);
  assert.deepEqual(JSON.parse(readFileSync(roundFile(1, "report.json"), "utf8")), REPORT);
});

test("reconcile handles a queued job that never started", (t) => {
  setup(t);
  const job = queueJob();
  assert.deepEqual(reconcile(), [], "a queued job gets 60 s for its runner");
  writeJsonAtomic(join(jobDir(job.id), "job.json"), { ...job, queuedAt: new Date(Date.now() - 61_000).toISOString() });
  assert.deepEqual(reconcile(), [job.id]);
  assert.equal(readJob(job.id).status, "failed");
  const outcome = finishedEvents(job.id)[0].outcome;
  assert.deepEqual([outcome.status, outcome.detail], ["failed", "runner did not start"]);
  const task = currentTask();
  assert.deepEqual([task.status, task.stallReason], ["stalled", "failed"]);
});

test("reconcile settles a task a crash left working after its job finished", (t) => {
  setup(t);
  const job = queueJob();
  const result: JobResult = { status: "done", sessionId: THREAD, report: REPORT, usageCumulative: null, detail: "", resetsAt: null, exitCode: 0, creditFunded: false };
  writeJsonAtomic(join(jobDir(job.id), "result.json"), result);
  writeJsonAtomic(join(jobDir(job.id), "job.json"), { ...job, status: "done", endedAt: now() });
  // The completion died right after job.finished, before any of the task's part ran.
  appendEvent(PROJECT, { t: "job.finished", at: now(), jobId: job.id, outcome: { status: "done", sessionId: THREAD, detail: "", resetsAt: null, exitCode: 0 } });
  assert.equal(currentTask().status, "working");
  assert.deepEqual(reconcile(), [job.id]);
  const task = currentTask();
  assert.deepEqual([task.status, task.sessionId], ["needs-review", THREAD]);
  assert.deepEqual(JSON.parse(readFileSync(roundFile(1, "report.json"), "utf8")), REPORT);
  const ledger = ledgerText();
  assert.deepEqual(reconcile(), []);
  assert.equal(ledgerText(), ledger);
});

test("reconcile leaves a task whose handoff had already started a job to that job", (t) => {
  setup(t, { sessionId: OLD_THREAD });
  const first = queueJob({ kind: "resume", sessionId: OLD_THREAD });
  writeJsonAtomic(join(jobDir(first.id), "job.json"), { ...first, status: "account-mismatch", endedAt: now() });
  appendEvent(PROJECT, { t: "job.finished", at: now(), jobId: first.id, outcome: { status: "account-mismatch", sessionId: OLD_THREAD, detail: "mismatch", resetsAt: null, exitCode: 1 } });
  // The handoff appended its job.started, then the crash came before the task listed the job.
  const handoff = jobRecord({ seq: 2 });
  writeJsonAtomic(join(jobDir(handoff.id), "job.json"), handoff);
  appendEvent(PROJECT, { t: "job.started", at: now(), job: { id: handoff.id, taskId: SLUG, seq: 2, kind: "start", candidate: CANDIDATE } });
  assert.deepEqual(reconcile(), []);
  assert.deepEqual(readdirSync(join(process.env.MANDOR_HOME!, "jobs")).sort(), [first.id, handoff.id].sort(), "no second handoff");
  assert.equal(currentTask().status, "working");
  // Past its 60 s grace the handoff job counts as never started, and that settles the task.
  writeJsonAtomic(join(jobDir(handoff.id), "job.json"), { ...handoff, queuedAt: new Date(Date.now() - 61_000).toISOString() });
  assert.deepEqual(reconcile(), [handoff.id]);
  const task = currentTask();
  assert.deepEqual([task.status, task.stallReason], ["stalled", "failed"]);
});

test("a late completion of a job the task has moved past leaves the task alone", (t) => {
  setup(t);
  // A start that died between its job.started and its task update, so the task never listed it.
  const orphan = jobRecord({ queuedAt: old() });
  writeJsonAtomic(join(jobDir(orphan.id), "job.json"), orphan);
  appendEvent(PROJECT, { t: "job.started", at: now(), job: { id: orphan.id, taskId: SLUG, seq: 1, kind: "start", candidate: CANDIDATE } });
  const current = queueJob();
  const before = currentTask();
  assert.deepEqual(before.jobIds, [current.id]);
  assert.deepEqual(reconcile(), [orphan.id]);
  assert.equal(finishedEvents(orphan.id)[0].outcome.detail, "runner did not start");
  assert.deepEqual(currentTask(), before);
});

// Account mismatch

test("a second account-mismatch on the same task stalls it with account-mismatch", async (t) => {
  gitSetup(t, { sessionId: OLD_THREAD });
  writeScenarios([
    { stdout: "generated:account-mismatch", writeFile: [{ path: "a.txt", content: "a\n" }] },
    { stdout: "generated:done", threadId: THREAD },
    { stdout: "generated:account-mismatch" },
  ]);
  const first = queueJob({ kind: "resume", sessionId: OLD_THREAD });
  await runJob(first.id);
  assert.equal(finishedEvents(first.id)[0].outcome.status, "account-mismatch");
  const handoff = currentTask().jobIds[1];
  assert.ok(handoff !== undefined, "the first mismatch starts a fresh session");
  assert.equal((await finished(handoff)).status, "done");
  const fresh = readJob(handoff);
  assert.deepEqual([fresh.kind, fresh.sessionId, fresh.seq, fresh.candidate], ["start", null, 2, CANDIDATE]);
  const text = readFileSync(roundFile(2, "handoff.md"), "utf8");
  assert.equal(readFileSync(fresh.promptPath, "utf8"), text);
  assert.ok(text.startsWith(BRIEF) && text.includes("a.txt"), text);
  assert.deepEqual([currentTask().status, currentTask().sessionId], ["needs-review", THREAD]);

  const second = queueJob({ kind: "resume", sessionId: THREAD });
  await runJob(second.id);
  const task = currentTask();
  assert.deepEqual([task.status, task.stallReason], ["stalled", "account-mismatch"]);
  assert.deepEqual(task.jobIds, [first.id, handoff, second.id]);
  assert.equal(execs().length, 3);
});

test("an account-mismatch handoff with no free slot waits with a pending handoff", async (t) => {
  gitSetup(t, { sessionId: OLD_THREAD });
  const me = { runnerPid: process.pid, runnerStart: processStart(process.pid) };
  for (let i = 0; i < 2; i++) {
    const busy = jobRecord({ status: "running", projectId: "other-000000000000", ...me });
    writeJsonAtomic(join(jobDir(busy.id), "job.json"), busy);
  }
  writeScenarios([{ stdout: "generated:account-mismatch" }]);
  const job = queueJob({ kind: "resume", sessionId: OLD_THREAD });
  await runJob(job.id);
  const task = currentTask();
  assert.deepEqual([task.status, task.pending, task.jobIds], ["waiting", { kind: "handoff", message: null }, [job.id]]);
  assert.equal(existsSync(roundFile(2, "handoff.md")), false);
});

test("a handoff that cannot stage the worker's files stalls with account-mismatch, and the log keeps git's error", async (t) => {
  const { worktree } = gitSetup(t, { sessionId: OLD_THREAD });
  writeFileSync(join(worktree!, "unreadable.txt"), "x", { mode: 0 });
  writeScenarios([{ stdout: "generated:account-mismatch" }]);
  const job = queueJob({ kind: "resume", sessionId: OLD_THREAD });
  await runJob(job.id);
  const task = currentTask();
  assert.deepEqual([task.status, task.stallReason], ["stalled", "account-mismatch"]);
  assert.match(read(join(process.env.MANDOR_HOME!, "logs", "runner.log")), /handoff after job .*unreadable\.txt.*Permission denied/);
});

test("an account-mismatch handoff that finds the slots lock busy waits with a pending handoff", async (t) => {
  gitSetup(t, { sessionId: OLD_THREAD });
  const home = process.env.MANDOR_HOME!;
  // A live holder by pid and start time, which this process never took through withSlotsLock.
  writeFileSync(join(home, "slots.lock"), JSON.stringify({ pid: process.pid, start: processStart(process.pid) }));
  writeScenarios([{ stdout: "generated:account-mismatch" }]);
  const job = queueJob({ kind: "resume", sessionId: OLD_THREAD });
  // The lock reports busy after 30 s of waiting; here each of its 50 ms pauses moves the clock 10 s.
  const realNow = Date.now;
  const realWait = Atomics.wait;
  let skew = 0;
  Date.now = () => realNow() + skew;
  Atomics.wait = ((a: Int32Array, i: number, v: number, ms?: number) => {
    skew += 10_000;
    return realWait(a, i, v, ms);
  }) as typeof Atomics.wait;
  try {
    await runJob(job.id);
  } finally {
    Date.now = realNow;
    Atomics.wait = realWait;
  }
  assert.ok(skew >= 30_000, "the handoff waited for the slots lock");
  const task = currentTask();
  assert.deepEqual([task.status, task.pending, task.jobIds], ["waiting", { kind: "handoff", message: null }, [job.id]]);
  assert.match(read(join(home, "logs", "runner.log")), /slots busy/);
});
