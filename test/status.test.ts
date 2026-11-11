import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { saveRoundFile } from "../src/brief.ts";
import type { Candidate, JobRecord, JobResult, JobStatus, ProjectState, TaskRecord } from "../src/contracts.ts";
import { jobDir, processStart, projectDir, projectIdFor, scratchDir } from "../src/home.ts";
import { appendEvent, ledgerSize, loadState, now } from "../src/ledger.ts";
import { readJob } from "../src/runner.ts";
import { logPaths, showTask, statusTable } from "../src/status.ts";
import { dispatch, goalStart } from "../src/tasks.ts";
import { waitForNext } from "../src/wait.ts";
import { temp, tempHome, tempRepo, writeScenarios } from "./helpers.ts";

const LAUNCHER = join(import.meta.dirname, "..", "bin", "mandor");
const LUNA: Candidate = { tool: "codex", model: "gpt-6-luna", effort: "medium" };
const GOAL = "feat/status";
const SECRET = "SECRET_TOKEN_123";

async function until(ok: () => boolean, ms = 20_000): Promise<boolean> {
  for (const end = Date.now() + ms; !ok(); await sleep(50)) if (Date.now() > end) return false;
  return true;
}

const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Whatever a test leaves running dies with it: the runners and every worker group.
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

function setup(t: TestContext) {
  const home = tempHome({ config: true });
  t.after(() => reap(home));
  const repo = tempRepo();
  const id = projectIdFor(repo);
  const briefFile = join(scratchDir(id, "t"), "brief.md");
  writeFileSync(briefFile, "Create the file.\n");
  goalStart(repo, GOAL, null);
  const send = (slug: string) => dispatch(repo, { goal: GOAL, slug, tier: "light", briefFile, scope: [], use: LUNA, after: null });
  return { home, repo, id, send };
}

// The CLI as the user runs it, in the given directory.
const cli = (cwd: string, ...args: string[]) => {
  const r = spawnSync(LAUNCHER, args, { cwd, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, code: r.status };
};

const HELLO = { stdout: "generated:done", writeFile: [{ path: "hello.txt", content: "hello\n" }] };

test("status lists tasks", async (t) => {
  const s = setup(t);
  writeScenarios([HELLO]);
  s.send("hello");
  assert.ok(await until(() => loadState(s.id).tasks.hello.status === "needs-review"));

  const plain = cli(s.repo, "status");
  assert.equal(plain.code, 0, plain.err);
  const lines = plain.out.trimEnd().split("\n");
  assert.match(lines[0], /^task\s+status\s+candidate\s+seq\s+fix rounds\s+elapsed$/);
  assert.match(lines[1], /^hello\s+needs-review\s+codex:gpt-6-luna@medium\s+1\s+0\s+\d+s$/);
  assert.equal(lines.length, 3);
  assert.equal(lines[2], `cursor: ${ledgerSize(s.id)}`);

  const json = cli(s.repo, "status", "--json");
  assert.equal(json.code, 0, json.err);
  const data = JSON.parse(json.out);
  assert.deepEqual(Object.keys(data), ["project", "cursor", "tasks", "jobs", "tools", "unrecorded"]);
  assert.deepEqual([data.project, data.cursor, data.tools, data.unrecorded], [s.id, ledgerSize(s.id), {}, {}]);
  assert.deepEqual(data.tasks.map((x: TaskRecord) => [x.id, x.status]), [["hello", "needs-review"]]);
  assert.equal(data.jobs.length, 1);
  assert.deepEqual([data.jobs[0].taskId, data.jobs[0].status], ["hello", "done"]);
  // The job env holds the worker's allowlisted environment, and none of it is output.
  assert.ok(readJob(data.jobs[0].id)!.env.GIT_ASKPASS, "the job record has an env to withhold");
  assert.equal("env" in data.jobs[0], false);
  assert.doesNotMatch(json.out, /GIT_ASKPASS/);
});

test("statusTable shows stall reasons, elapsed times and exhausted tools", () => {
  const task = (id: string, over: Partial<TaskRecord>): TaskRecord => ({
    id, goalBranch: GOAL, tier: "light", after: null, status: "waiting", stallReason: null, pending: null, base: null, worktree: null,
    branch: `wip/${id}`, scope: [], seq: 0, fixRounds: 0, candidate: null, sessionId: null, use: null, jobIds: [], integratedCommit: null, briefPath: "", ...over,
  });
  const job = (id: string, taskId: string, seq: number, over: Partial<JobRecord>): JobRecord => ({
    id, projectId: "p", taskId, seq, kind: "start", candidate: LUNA, worktree: "/w", sessionId: null, promptPath: "/p", timeoutMs: 1, bin: "b",
    env: {}, queuedAt: "2026-11-08T10:00:00.000Z", status: "done", runnerPid: null, runnerStart: null, workerPid: null, startedAt: "2026-11-08T10:00:00.000Z", endedAt: null, ...over,
  });
  const state: ProjectState = {
    goals: {}, jobs: {},
    tasks: {
      a: task("a", { status: "working", candidate: LUNA, seq: 2, fixRounds: 1 }),
      b: task("b", { status: "stalled", stallReason: "quota", candidate: LUNA, seq: 1 }),
      c: task("c", {}),
    },
  };
  const jobs = [
    job("j1", "a", 1, { endedAt: "2026-11-08T10:01:00.000Z" }),
    job("j2", "a", 2, { status: "running", startedAt: "2026-11-08T10:05:00.000Z" }),
    job("j3", "b", 1, { endedAt: "2026-11-08T11:02:03.000Z" }),
  ];
  const nowMs = Date.parse("2026-11-08T10:05:42.000Z");
  const resetsAt = Date.parse("2026-11-08T15:00:00.000Z") / 1000;
  const table = statusTable(state, jobs, { codex: { resetsAt, detail: "x" }, "codex:gpt-6-luna": { resetsAt: null, detail: "y" } }, nowMs);
  const rows = table.split("\n").map((l) => l.split(/\s{2,}/));
  assert.deepEqual(rows[1], ["a", "working", "codex:gpt-6-luna@medium", "2", "1", "42s"]);
  assert.deepEqual(rows[2], ["b", "stalled (quota)", "codex:gpt-6-luna@medium", "1", "0", "1h02m"]);
  assert.deepEqual(rows[3], ["c", "waiting", "-", "0", "0", "-"]);
  // The reason of a mark, the paid-credit one included, is on the line: the lead reads this table, not status --json.
  assert.deepEqual(rows.slice(4), [["exhausted: codex until 2026-11-08T15:00:00Z: x"], ["exhausted: codex:gpt-6-luna until unknown: y"]]);
  const credits = "plan limit reached while workspace credits are available";
  assert.equal(statusTable(state, jobs, { codex: { resetsAt, detail: credits } }, nowMs).split("\n").at(-1), `exhausted: codex until 2026-11-08T15:00:00Z: ${credits}`);
  assert.equal(statusTable(state, jobs, { codex: { resetsAt, detail: "" } }, nowMs).split("\n").at(-1), "exhausted: codex until 2026-11-08T15:00:00Z", "no reason, no colon");
  assert.equal(statusTable({ goals: {}, tasks: {}, jobs: {} }, [], {}, nowMs), "no tasks");
});

test("status reconciles a dead runner, and wait --since its printed cursor reports the task with next inspect", async (t) => {
  const s = setup(t);
  writeScenarios([{ ...HELLO, delayMs: 30_000 }]);
  const { task } = s.send("hello");
  const jobId = task.jobIds[0];
  assert.ok(await until(() => readJob(jobId)?.workerPid != null), "the worker runs");
  const job = readJob(jobId)!;
  kill(job.runnerPid!);
  assert.ok(await until(() => !alive(job.runnerPid!), 5_000));
  kill(-job.workerPid!);
  assert.equal(loadState(s.id).tasks.hello.status, "working");
  const before = ledgerSize(s.id);

  const r = cli(s.repo, "status");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^hello\s+stalled \(runner-died\)\s+codex:gpt-6-luna@medium\s+1\s+0\s+\d+s$/m);
  const cursor = Number(/^cursor: (\d+)$/m.exec(r.out)![1]);
  assert.equal(cursor, before, "the cursor is the ledger length before reconcile appended");
  assert.ok(ledgerSize(s.id) > cursor);

  const woke = await waitForNext(s.repo, { since: cursor, timeoutMs: 30_000 });
  assert.deepEqual(woke, {
    kind: "events", cursor: ledgerSize(s.id),
    items: [{ task: "hello", status: "stalled", candidate: "codex:gpt-6-luna@medium", detail: "runner died", next: "inspect" }],
  });
});

test("show and logs never print stderr.log content", async (t) => {
  const s = setup(t);
  writeScenarios([{ stdout: "generated:no-terminal", exitCode: 1, stderr: `${SECRET}\n` }]);
  const { task } = s.send("hello");
  assert.ok(await until(() => loadState(s.id).tasks.hello.status === "stalled"));
  const dir = jobDir(task.jobIds[0]);
  assert.match(readFileSync(join(dir, "stderr.log"), "utf8"), new RegExp(SECRET), "the secret reached stderr.log");
  const conflict = join(projectDir(s.id), "tasks", "hello", "rounds", "1", "conflict.patch");
  assert.equal(saveRoundFile(s.id, "hello", 1, "conflict.patch", `${SECRET}\n`).path, conflict);

  const show = cli(s.repo, "show", "hello");
  assert.equal(show.code, 0, show.err);
  const t0 = loadState(s.id).tasks.hello;
  for (const line of [
    "task: hello", "status: stalled (failed)", `brief: ${t0.briefPath}`, `worktree: ${t0.worktree}`, "branch: wip/hello", `base: ${t0.base}`,
    `session: ${t0.sessionId ?? "none"}`, "fix rounds: 0", "last outcome: failed: exit 1; see stderr.log", conflict,
  ]) {
    assert.ok(show.out.split("\n").some((l) => l.trim() === line), `${line}\n${show.out}`);
  }

  const logs = cli(s.repo, "logs", "hello");
  assert.equal(logs.code, 0, logs.err);
  assert.equal(logs.out, `${join(dir, "raw.log")}\n${join(dir, "stderr.log")}\n`);
  assert.deepEqual(logPaths(s.id, "hello"), [join(dir, "raw.log"), join(dir, "stderr.log")]);

  for (const out of [show, logs, cli(s.repo, "status"), cli(s.repo, "status", "--json")]) assert.doesNotMatch(out.out + out.err, new RegExp(SECRET));
  assert.doesNotMatch(showTask(s.id, "hello"), new RegExp(SECRET));
});

test("show says when the worktree of an accepted or cancelled task is gone, and prints any other path as it is", (t) => {
  const s = setup(t);
  const gone = join(s.home, "worktrees", s.id, "task-gone");
  const record = (id: string, over: Partial<TaskRecord>): TaskRecord => ({
    id, goalBranch: GOAL, tier: "light", after: null, status: "waiting", stallReason: null, pending: null, base: null, worktree: gone,
    branch: `wip/${id}`, scope: [], seq: 1, fixRounds: 0, candidate: LUNA, sessionId: null, use: null, jobIds: [], integratedCommit: null, briefPath: "", ...over,
  });
  for (const task of [record("done", { status: "accepted" }), record("stopped", { status: "cancelled" }), record("busy", { status: "working" }),
    record("kept", { status: "accepted", worktree: s.repo }), record("bare", { status: "cancelled", worktree: null })]) {
    appendEvent(s.id, { t: "task.created", at: now(), task });
  }
  const worktreeLine = (slug: string) => showTask(s.id, slug).split("\n").find((l) => l.startsWith("worktree: "));
  assert.equal(worktreeLine("done"), `worktree: ${gone} (removed)`);
  assert.equal(worktreeLine("stopped"), `worktree: ${gone} (removed)`);
  assert.equal(worktreeLine("busy"), `worktree: ${gone}`, "a missing worktree of a live task is a fault to see, not a removal");
  assert.equal(worktreeLine("kept"), `worktree: ${s.repo}`);
  assert.equal(worktreeLine("bare"), "worktree: none");
});

test("show lists each job with the usage its own run added to its session", (t) => {
  const s = setup(t);
  const task: TaskRecord = {
    id: "used", goalBranch: GOAL, tier: "light", after: null, status: "needs-review", stallReason: null, pending: null, base: null, worktree: null,
    branch: "wip/used", scope: [], seq: 4, fixRounds: 1, candidate: LUNA, sessionId: null, use: null, jobIds: [], integratedCommit: null, briefPath: "",
  };
  appendEvent(s.id, { t: "task.created", at: now(), task });
  const [first, second] = ["00000000-0000-7000-8000-000000000a01", "00000000-0000-7000-8000-000000000a02"];
  // Codex reports a session's usage summed over its runs: the resume holds the start's count, and a fresh session starts over.
  const runs: [string, JobStatus, string | null, Record<string, number> | null][] = [
    ["j-20261108100000-0001", "done", first, { input_tokens: 100, output_tokens: 10 }],
    ["j-20261108100100-0002", "done", first, { input_tokens: 250, output_tokens: 30 }],
    ["j-20261108100200-0003", "quota", first, null],
    ["j-20261108100300-0004", "done", second, { input_tokens: 40, output_tokens: 4 }],
  ];
  runs.forEach(([id, status, sessionId, usageCumulative], i) => {
    appendEvent(s.id, { t: "job.started", at: now(), job: { id, taskId: "used", seq: i + 1, kind: i === 0 || i === 3 ? "start" : "resume", candidate: LUNA } });
    appendEvent(s.id, { t: "job.finished", at: now(), jobId: id, outcome: { status, sessionId, detail: "", resetsAt: null, exitCode: 0 } });
    const result: JobResult = { status, sessionId, report: null, usageCumulative, detail: "", resetsAt: null, exitCode: 0, creditFunded: false };
    mkdirSync(jobDir(id), { recursive: true });
    writeFileSync(join(jobDir(id), "result.json"), JSON.stringify(result));
  });
  // One with no end on record, whether it is queued, running or was never claimed.
  appendEvent(s.id, { t: "job.started", at: now(), job: { id: "j-20261108100400-0005", taskId: "used", seq: 5, kind: "resume", candidate: LUNA } });
  const lines = showTask(s.id, "used").split("\n");
  assert.deepEqual(lines.slice(lines.indexOf("jobs:")), [
    "jobs:",
    "  j-20261108100000-0001 codex:gpt-6-luna@medium done: input_tokens 100, output_tokens 10",
    "  j-20261108100100-0002 codex:gpt-6-luna@medium done: input_tokens 150, output_tokens 20",
    "  j-20261108100200-0003 codex:gpt-6-luna@medium quota: no usage recorded",
    "  j-20261108100300-0004 codex:gpt-6-luna@medium done: input_tokens 40, output_tokens 4",
    "  j-20261108100400-0005 codex:gpt-6-luna@medium unfinished: no usage recorded",
  ]);
  assert.ok(!showTask(s.id, "used").includes("round files:"), "the job list is the last section when no round file exists");
});

test("show and logs refuse an unknown task and a missing slug", (t) => {
  const s = setup(t);
  for (const cmd of ["show", "logs"]) {
    const r = cli(s.repo, cmd, "nope");
    assert.deepEqual([r.code, r.out, r.err], [1, "", "mandor: no task nope\n"]);
    assert.equal(cli(s.repo, cmd).code, 2);
  }
  assert.equal(cli(s.repo, "status", "--bogus").code, 2);
  assert.equal(cli(s.repo, "status", "--json", "--json").code, 2);
});

test("status outside a project prints no project here and creates nothing", (t) => {
  const home = tempHome({ config: true });
  t.after(() => reap(home));
  const plain = temp("mandor-plain-");
  const repo = tempRepo();
  for (const cwd of [plain, repo]) {
    for (const args of [["status"], ["status", "--json"]]) {
      const r = cli(cwd, ...args);
      assert.deepEqual([r.code, r.out, r.err], [0, "mandor: no project here\n", ""]);
    }
  }
  assert.equal(existsSync(join(home, "projects")), false);
  assert.equal(existsSync(projectDir(projectIdFor(repo))), false);
});
