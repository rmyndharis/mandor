import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { renderConflictMessage, renderFixMessage } from "../src/brief.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Candidate, GoalRecord, JobRecord, LedgerEvent, ModelInfo, StallReason, TaskRecord, ToolName } from "../src/contracts.ts";
import { jobDir, processStart, projectDir, projectIdFor, scratchDir } from "../src/home.ts";
import { appendEvent, appendToolEvent, ledgerSize, loadState, loadToolState, now, readEvents } from "../src/ledger.ts";
import { cancelMarker, readJob } from "../src/runner.ts";
import { loadProjectConfig, saveProjectConfig } from "../src/provision.ts";
import { reviewPack } from "../src/review.ts";
import { showTask } from "../src/status.ts";
import { withProjectLock, writeFileAtomic, writeJsonAtomic } from "../src/store.ts";
import * as tasks from "../src/tasks.ts";
import { waitForNext } from "../src/wait.ts";
import { FAKE_ZCODE, temp, readFakeLog, tempHome, tempRepo, writeScenarios } from "./helpers.ts";

const LAUNCHER = join(import.meta.dirname, "..", "bin", "mandor");
const SKILL = join(import.meta.dirname, "..", "skills", "lead", "SKILL.md");
const CATALOG_FIXTURE = join(import.meta.dirname, "fixtures", "codex", "debug-models.json");
const GOAL = "feat/lifecycle";
const THREAD = "00000000-0000-7000-8000-000000000601";
const LUNA: Candidate = { tool: "codex", model: "gpt-6-luna", effort: "medium" };
const SOL_HIGH: Candidate = { tool: "codex", model: "gpt-6.1-sol", effort: "high" };
const SOL_MAX: Candidate = { tool: "codex", model: "gpt-6.1-sol", effort: "max" };
const DONE = { stdout: "generated:done" };
// Stays running until the test's cleanup kills it, so its slot stays taken.
const HOLD = { stdout: "generated:done", delayMs: 30_000 };
const NOTES = "Line 3 is wrong: it must say hello.\n";
const MESSAGE = "Add the change\n\nIt does what the task asks.\n";
const CONTINUE = "Continue the task from the current state of the files.";

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
// A pid of 0 or 1 would signal this process's own group or everything, so only real pids are used.
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

interface Lab { home: string; repo: string; id: string; file(name: string, body: string): string }

function lab(home: string): Lab {
  const repo = tempRepo();
  const id = projectIdFor(repo);
  const scratch = scratchDir(id, "t");
  return { home, repo, id, file: (name, body) => {
    const p = join(scratch, name);
    writeFileSync(p, body);
    return p;
  } };
}

function setup(t: TestContext): Lab {
  const home = tempHome({ config: true });
  t.after(() => reap(home));
  return lab(home);
}

const task = (s: Lab, slug: string) => loadState(s.id).tasks[slug];
const roundFile = (s: Lab, slug: string, seq: number, name: string) => join(projectDir(s.id), "tasks", slug, "rounds", String(seq), name);
const verdicts = (s: Lab) => readEvents(s.id).items.flatMap((e) => (e.t === "verdict" ? [`${e.taskId}:${e.verdict}`] : []));
const execs = () => readFakeLog().filter((e) => e.argv[0] === "exec");
const runnerLog = () => readFileSync(join(process.env.MANDOR_HOME!, "logs", "runner.log"), "utf8");
const ledgerText = (s: Lab) => readFileSync(join(projectDir(s.id), "ledger.jsonl"), "utf8");
const exhaust = (key: string) => appendToolEvent({ t: "tool.exhausted", at: now(), key, resetsAt: null, detail: "limit" });
const writeCatalog = (models: ModelInfo[]) => writeJsonAtomic(join(process.env.MANDOR_HOME!, "models.json"), { fetchedAt: new Date().toISOString(), codexVersion: "0.166.0", models });

type Updated = Extract<LedgerEvent, { t: "task.updated" }>;
const lastUpdate = (s: Lab, slug: string) => readEvents(s.id).items.findLast((e): e is Updated => e.t === "task.updated" && e.taskId === slug)!;
const setTask = (s: Lab, slug: string, patch: Partial<TaskRecord>) => appendEvent(s.id, { t: "task.updated", at: now(), taskId: slug, patch, reason: "test" });

const send = (s: Lab, slug: string, over: Partial<Parameters<typeof tasks.dispatch>[1]> = {}) =>
  tasks.dispatch(s.repo, { goal: GOAL, slug, tier: "light", briefFile: s.file(`${slug}.md`, `Do ${slug}.\n`), scope: [], use: null, after: null, ...over });

// Without a review first: accept commits only the tree the last review showed.
const unreviewedAccept = (s: Lab, slug: string, evidence = "node --test: 1 passed\n") =>
  tasks.verdictAccept(s.repo, slug, s.file("evidence.md", evidence), s.file("message.txt", MESSAGE), { allowTestIdentity: true });
const accept = (s: Lab, slug: string) => {
  reviewPack(s.repo, slug);
  return unreviewedAccept(s, slug);
};
const committed = (s: Lab, slug: string) => (accept(s, slug) as { commit: string }).commit;
const confirmed = (s: Lab, slug: string) => tasks.confirm(s.repo, slug, s.file("confirm.md", "node --test on the goal branch: 1 passed\n"));

function pump(s: Lab): void {
  const models = tasks.loadCatalog();
  withProjectLock(s.id, () => tasks.pumpLocked(s.id, models));
}

// The completion that set the state still holds the project lock for its pump; taking it once waits that out.
async function needsReview(s: Lab, slug: string): Promise<void> {
  assert.ok(await until(() => task(s, slug)?.status === "needs-review"), `${slug} reaches needs-review`);
  withProjectLock(s.id, () => {});
}

async function stalled(s: Lab, slug: string, reason: StallReason): Promise<void> {
  assert.ok(await until(() => task(s, slug)?.status === "stalled"), `${slug} stalls`);
  withProjectLock(s.id, () => {});
  assert.equal(task(s, slug).stallReason, reason);
}

// A started worker has a pid for the test's cleanup to kill.
async function workersRunning(ids: string[]): Promise<void> {
  assert.ok(await until(() => ids.every((id) => (readJob(id)?.workerPid ?? null) !== null)), "the workers run");
}

// Live jobs of another project, holding codex's slots until they are released.
function occupy(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `j-20261108100000-000${i}`;
    const job: JobRecord = {
      id, projectId: "other-000000000000", taskId: "x", seq: 1, kind: "start", candidate: LUNA, worktree: "/tmp", sessionId: null, promptPath: "/tmp/x", timeoutMs: 60_000,
      bin: "/usr/bin/false", env: {}, queuedAt: now(), status: "running", runnerPid: process.pid, runnerStart: processStart(process.pid), workerPid: null, startedAt: null, endedAt: null,
    };
    writeJsonAtomic(join(jobDir(id), "job.json"), job);
    return id;
  });
}

const release = (id: string) => rmSync(jobDir(id), { recursive: true });

// A task straight from the ledger, in a plain directory: enough for the fake.
function ledgerTask(s: Lab, slug: string, over: Partial<TaskRecord> = {}): void {
  const briefPath = join(projectDir(s.id), "tasks", slug, "brief.md");
  writeFileAtomic(briefPath, `Do ${slug}.\n`);
  appendEvent(s.id, {
    t: "task.created", at: now(), task: {
      id: slug, goalBranch: GOAL, tier: "light", after: null, status: "waiting", stallReason: null, pending: { kind: "start", message: null }, base: null,
      worktree: temp("mandor-wt-"), branch: `wip/${slug}`, scope: [], seq: 0, fixRounds: 0,
      candidate: null, sessionId: null, use: null, jobIds: [], integratedCommit: null, briefPath, ...over,
    },
  });
}

const tenWith = (edits: Record<number, string> = {}) => Array.from({ length: 10 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
const edit = (content: string) => ({ ...DONE, writeFile: [{ path: "f.txt", content }] });

// A goal over a repository that holds the ten-line file.
function tenLineGoal(s: Lab): GoalRecord {
  writeFileSync(join(s.repo, "f.txt"), tenWith());
  must(s.repo, "add", "f.txt");
  must(s.repo, "commit", "-qm", "Add the file");
  return tasks.goalStart(s.repo, GOAL, null).goal;
}

// Another task's work landing on the goal branch.
function moveGoal(goal: GoalRecord, write: (dir: string) => void): string {
  write(goal.integrationWorktree);
  must(goal.integrationWorktree, "add", "-A");
  must(goal.integrationWorktree, "commit", "-qm", "Move the tip");
  return must(goal.integrationWorktree, "rev-parse", "HEAD");
}

const rebaseFile = (s: Lab, name: "rebase.json" | "rebase.patch") => join(projectDir(s.id), "tasks", "hello", name);
const noEvidence = (s: Lab, slug: string, seq: number) => assert.equal(existsSync(roundFile(s, slug, seq, "evidence-accept.md")), false, "an accept that commits nothing saves no evidence");

const onGoal = (goal: GoalRecord, content: string) => moveGoal(goal, (dir) => writeFileSync(join(dir, "f.txt"), content));
const removedOnGoal = (goal: GoalRecord) => moveGoal(goal, (dir) => rmSync(join(dir, "f.txt")));

// A worker's first round leaves its edit of the ten-line file, and the goal then moves.
async function reviewed(s: Lab, content: string, slug = "hello"): Promise<TaskRecord> {
  writeScenarios([edit(content), DONE, DONE]);
  send(s, slug);
  await needsReview(s, slug);
  return task(s, slug);
}

// A git that fails or stops where the test says; the action can run the real one as "$real". PATH is read at each spawn,
// so this also reaches a child process.
function shimGit(t: TestContext, pattern: string, action: string): () => void {
  const real = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const dir = temp("mandor-shim-");
  writeFileSync(join(dir, "git"), `#!/bin/sh\nreal="${real}"\ncase " $* " in\n  ${pattern}) ${action};;\nesac\nexec "$real" "$@"\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  const restore = () => {
    process.env.PATH = saved;
  };
  t.after(restore);
  return restore;
}

// A shim action that stops git there, and a check that it has. A confined git's sandbox denies writing a marker outside
// the worktree, so the stop shows as a sleep with a command line of its own, read from outside. A stop whose test died
// before killing it fails closed: the shim exits 1 rather than going on to the real git.
function stopPoint(): { action: string; reached: () => boolean } {
  const sleeper = `sleep 30.${randomInt(1e9)}`;
  return { action: `${sleeper}; exit 1`, reached: () => execFileSync("/bin/ps", ["-axww", "-o", "command="], { encoding: "utf8" }).split("\n").some((l) => l.trim() === sleeper) };
}

const cli = (cwd: string, ...args: string[]) => {
  const r = spawnSync(LAUNCHER, args, { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : null };
};

// A held lock reports busy after 30 s of waiting; under this each of its 50 ms pauses moves the clock 10 s.
function skewClock(t: TestContext): () => void {
  const [realNow, realWait] = [Date.now, Atomics.wait];
  let skew = 0;
  const restore = () => {
    Date.now = realNow;
    Atomics.wait = realWait;
  };
  t.after(restore);
  Date.now = () => realNow() + skew;
  Atomics.wait = ((a: Int32Array, i: number, v: number, ms?: number) => {
    skew += 10_000;
    return realWait(a, i, v, ms);
  }) as typeof Atomics.wait;
  return restore;
}

// Fix rounds

test("fix resumes on task.sessionId and stores notes.md under a new seq", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, threadId: THREAD, writeFile: [{ path: "hello.txt", content: "hello\n" }] }, DONE]);
  const { worktree } = send(s, "hello").task;
  await needsReview(s, "hello");
  const before = ledgerSize(s.id);
  assert.deepEqual(tasks.verdictFix(s.repo, "hello", s.file("notes.md", NOTES)), { cursor: before });
  const fixed = task(s, "hello");
  assert.deepEqual([fixed.status, fixed.seq, fixed.fixRounds, fixed.pending, fixed.jobIds.length], ["working", 2, 1, null, 2]);
  const job = readJob(fixed.jobIds[1])!;
  assert.deepEqual([job.kind, job.sessionId, job.candidate], ["resume", THREAD, LUNA]);
  assert.equal(readFileSync(job.promptPath, "utf8"), renderFixMessage(NOTES));
  assert.equal(readFileSync(roundFile(s, "hello", 2, "notes.md"), "utf8"), renderFixMessage(NOTES));
  const verdict = readEvents(s.id).items.findLast((e) => e.t === "verdict");
  assert.deepEqual(verdict?.t === "verdict" && [verdict.verdict, verdict.seq, verdict.file?.path], ["fix", 2, roundFile(s, "hello", 2, "notes.md")]);
  await needsReview(s, "hello");
  const { argv } = execs().at(-1)!;
  assert.equal(argv[argv.indexOf("resume") + 1], THREAD);
  assert.equal(readFileSync(join(worktree!, "hello.txt"), "utf8"), "hello\n");
});

test("fix refuses a task that is not in needs-review, a task with an open job, empty notes and notes inside the repository", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  assert.throws(() => tasks.verdictFix(s.repo, "nope", s.file("notes.md", NOTES)), /no task nope/);
  ledgerTask(s, "early", { status: "stalled", stallReason: "failed" });
  assert.throws(() => tasks.verdictFix(s.repo, "early", s.file("notes.md", NOTES)), /task early is stalled, not needs-review/);
  ledgerTask(s, "busy", { status: "needs-review", pending: null, candidate: LUNA, sessionId: THREAD, seq: 1 });
  appendEvent(s.id, { t: "job.started", at: now(), job: { id: "j-20261108100000-abcd", taskId: "busy", seq: 2, kind: "resume", candidate: LUNA } });
  assert.throws(() => tasks.verdictFix(s.repo, "busy", s.file("notes.md", NOTES)), /task busy has a queued or running job/);
  writeScenarios([DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  assert.throws(() => tasks.verdictFix(s.repo, "hello", s.file("empty.md", "  \n")), /is empty/);
  const inside = join(s.repo, "inside.md");
  writeFileSync(inside, NOTES);
  assert.throws(() => tasks.verdictFix(s.repo, "hello", inside), /write it under mandor scratch/);
  assert.equal(task(s, "hello").status, "needs-review");
  assert.deepEqual(verdicts(s), []);
});

test("three counted fixes run and the fourth stalls with fix-rounds-exceeded", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([DONE, DONE, DONE, DONE, DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  for (let round = 1; round <= 3; round++) {
    tasks.verdictFix(s.repo, "hello", s.file("notes.md", NOTES));
    assert.equal(task(s, "hello").fixRounds, round);
    await needsReview(s, "hello");
  }
  const { cursor } = tasks.verdictFix(s.repo, "hello", s.file("notes.md", NOTES));
  const over = task(s, "hello");
  assert.deepEqual([over.status, over.stallReason, over.fixRounds, over.jobIds.length, over.seq], ["stalled", "fix-rounds-exceeded", 4, 4, 4]);
  assert.equal(existsSync(roundFile(s, "hello", 5, "notes.md")), false);
  assert.equal(verdicts(s).filter((v) => v === "hello:fix").length, 3);
  const woke = await waitForNext(s.repo, { since: cursor, timeoutMs: 30_000 });
  assert.deepEqual(woke.kind === "events" && woke.items.map((i) => [i.task, i.next]), [["hello", "fix-rounds-exceeded"]]);
});

test("a fix at the tool's limit waits, and the pump starts it when a slot frees", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, threadId: THREAD }, DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  const slots = occupy(2);
  tasks.verdictFix(s.repo, "hello", s.file("notes.md", NOTES));
  const held = task(s, "hello");
  assert.deepEqual([held.status, held.stallReason, held.pending?.kind, held.jobIds.length, held.seq], ["waiting", null, "resume", 1, 1]);
  slots.forEach(release);
  pump(s);
  const job = readJob(task(s, "hello").jobIds[1])!;
  assert.deepEqual([job.kind, job.sessionId, readFileSync(job.promptPath, "utf8")], ["resume", THREAD, renderFixMessage(NOTES)]);
  await needsReview(s, "hello");
});

test("a fix while codex is exhausted waits with a pending resume, and after ready codex the worker receives the fix notes", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, threadId: THREAD }, DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  exhaust("codex");
  tasks.verdictFix(s.repo, "hello", s.file("notes.md", NOTES));
  const held = task(s, "hello");
  assert.deepEqual([held.status, held.stallReason, held.pending?.kind, held.jobIds.length, held.fixRounds], ["stalled", "quota", "resume", 1, 1]);
  assert.equal(execs().length, 1, "no run on an exhausted tool");
  assert.deepEqual(tasks.ready("codex"), { resumed: ["hello"] });
  const resumed = task(s, "hello");
  assert.deepEqual([resumed.status, resumed.stallReason, resumed.pending, resumed.seq], ["working", null, null, 2]);
  const job = readJob(resumed.jobIds[1])!;
  assert.deepEqual([job.kind, job.sessionId, readFileSync(job.promptPath, "utf8")], ["resume", THREAD, renderFixMessage(NOTES)]);
  await needsReview(s, "hello");
});

test("a deferred fix with notes above the ledger's line limit succeeds, and its notes reach only the worker", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, threadId: THREAD }, DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  const sentinel = "NOTES-SENTINEL-771";
  const notes = `${sentinel}\n${"x".repeat(5000)}\n`;
  exhaust("codex");
  tasks.verdictFix(s.repo, "hello", s.file("notes.md", notes));
  assert.deepEqual([task(s, "hello").status, task(s, "hello").pending?.kind], ["stalled", "resume"]);
  assert.ok(!ledgerText(s).includes(sentinel), "the ledger never holds the notes");
  const status = cli(s.repo, "status", "--json");
  assert.equal(status.status, 0, status.stderr);
  assert.ok(!status.stdout.includes(sentinel), "status never prints the notes");
  tasks.ready("codex");
  assert.equal(readFileSync(readJob(task(s, "hello").jobIds[1])!.promptPath, "utf8"), renderFixMessage(notes));
  assert.ok(!ledgerText(s).includes(sentinel));
  await needsReview(s, "hello");
});

test("a review from before a fix round does not cover the round's result", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, threadId: THREAD, writeFile: [{ path: "hello.txt", content: "hello\n" }] }, { ...DONE, writeFile: [{ path: "hello.txt", content: "hello again\n" }] }]);
  send(s, "hello");
  await needsReview(s, "hello");
  reviewPack(s.repo, "hello");
  tasks.verdictFix(s.repo, "hello", s.file("notes.md", NOTES));
  await needsReview(s, "hello");
  assert.throws(() => unreviewedAccept(s, "hello"), /task hello changed since its last review; run mandor review hello again/);
  assert.deepEqual([task(s, "hello").status, verdicts(s)], ["needs-review", ["hello:fix"]]);
  const commit = committed(s, "hello");
  assert.equal(must(s.repo, "show", `${commit}:hello.txt`), "hello again");
});

test("a takeover's edits need a review of their own before accept", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }]);
  const { worktree } = send(s, "hello").task;
  await needsReview(s, "hello");
  reviewPack(s.repo, "hello");
  tasks.takeover(s.repo, "hello", false);
  writeFileSync(join(worktree!, "hello.txt"), "hello from the lead\n");
  assert.throws(() => unreviewedAccept(s, "hello"), /task hello changed since its last review; run mandor review hello again/);
  assert.deepEqual([task(s, "hello").status, verdicts(s)], ["takeover", ["hello:takeover"]]);
  const commit = committed(s, "hello");
  assert.equal(must(s.repo, "show", `${commit}:hello.txt`), "hello from the lead");
});

// Drop

test("drop removes the commit and counts", async (t) => {
  const s = setup(t);
  const { goal } = tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, threadId: THREAD, writeFile: [{ path: "hello.txt", content: "hello\n" }] }, DONE]);
  const base = must(s.repo, "rev-parse", GOAL);
  send(s, "hello");
  await needsReview(s, "hello");
  const commit = committed(s, "hello");
  assert.deepEqual([must(s.repo, "rev-parse", GOAL), task(s, "hello").integratedCommit], [commit, commit]);
  const before = ledgerSize(s.id);
  assert.deepEqual(tasks.drop(s.repo, "hello", s.file("notes.md", NOTES)), { cursor: before });
  assert.equal(must(s.repo, "rev-parse", GOAL), base);
  assert.equal(must(goal.integrationWorktree, "status", "--porcelain"), "");
  const dropped = task(s, "hello");
  assert.deepEqual([dropped.status, dropped.integratedCommit, dropped.fixRounds, dropped.seq], ["working", null, 1, 2]);
  assert.deepEqual(verdicts(s), ["hello:accept", "hello:drop"]);
  const job = readJob(dropped.jobIds[1])!;
  assert.deepEqual([job.kind, job.sessionId, readFileSync(job.promptPath, "utf8")], ["resume", THREAD, renderFixMessage(NOTES)]);
  await needsReview(s, "hello");
  const again = committed(s, "hello");
  assert.deepEqual([must(s.repo, "rev-parse", GOAL), must(s.repo, "rev-parse", `${again}^`), task(s, "hello").status], [again, base, "integrating"]);
});

test("drop refuses a task that is not integrating, empty notes and notes inside the repository", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }]);
  send(s, "hello");
  await needsReview(s, "hello");
  assert.throws(() => tasks.drop(s.repo, "hello", s.file("notes.md", NOTES)), /task hello is needs-review, not integrating/);
  const commit = committed(s, "hello");
  assert.throws(() => tasks.drop(s.repo, "hello", s.file("empty.md", "\n")), /is empty/);
  const inside = join(s.repo, "inside.md");
  writeFileSync(inside, NOTES);
  assert.throws(() => tasks.drop(s.repo, "hello", inside), /write it under mandor scratch/);
  assert.deepEqual([must(s.repo, "rev-parse", GOAL), task(s, "hello").status], [commit, "integrating"]);
});

test("a drop over the fix limit removes the commit and stalls with fix-rounds-exceeded", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }]);
  const base = must(s.repo, "rev-parse", GOAL);
  send(s, "hello");
  await needsReview(s, "hello");
  setTask(s, "hello", { fixRounds: 3 });
  committed(s, "hello");
  tasks.drop(s.repo, "hello", s.file("notes.md", NOTES));
  const over = task(s, "hello");
  assert.deepEqual([must(s.repo, "rev-parse", GOAL), over.status, over.stallReason, over.integratedCommit, over.fixRounds], [base, "stalled", "fix-rounds-exceeded", null, 4]);
  // The commit is gone for good, so the drop is on record, in a round of its own that the next accept's evidence joins.
  assert.deepEqual(verdicts(s), ["hello:accept", "hello:drop"]);
  const verdict = readEvents(s.id).items.findLast((e) => e.t === "verdict");
  assert.deepEqual(verdict?.t === "verdict" && [verdict.seq, verdict.file?.path], [2, roundFile(s, "hello", 2, "notes.md")]);
  assert.equal(readFileSync(roundFile(s, "hello", 2, "notes.md"), "utf8"), renderFixMessage(NOTES));
  assert.deepEqual([over.seq, over.jobIds.length], [2, 1]);
});

test("a drop of a task the lead took over returns it to takeover with no worker round, keeps the fix count, and never overwrites a round's record", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, threadId: THREAD, writeFile: [{ path: "hello.txt", content: "hello\n" }] }]);
  const base = must(s.repo, "rev-parse", GOAL);
  const { worktree } = send(s, "hello").task;
  await needsReview(s, "hello");
  // A fix that waits on a spent tool leaves notes for round 2, which no worker ever read.
  exhaust("codex");
  tasks.verdictFix(s.repo, "hello", s.file("notes.md", NOTES));
  assert.deepEqual([task(s, "hello").status, task(s, "hello").stallReason], ["stalled", "quota"]);
  const fixNotes = readFileSync(roundFile(s, "hello", 2, "notes.md"));
  tasks.takeover(s.repo, "hello", false);
  assert.equal(task(s, "hello").seq, 3, "the takeover's own round, past round 2's notes");
  writeFileSync(join(worktree!, "hello.txt"), "hello from the lead\n");
  committed(s, "hello");
  const [runs, before] = [execs().length, ledgerSize(s.id)];
  assert.deepEqual(tasks.drop(s.repo, "hello", s.file("lead.md", "The lead's proof failed.\n")), { cursor: before });
  const back = task(s, "hello");
  assert.deepEqual([back.status, back.stallReason, back.pending, back.integratedCommit, back.fixRounds, back.seq, back.jobIds.length], ["takeover", null, null, null, 1, 4, 1]);
  assert.equal(must(s.repo, "rev-parse", GOAL), base);
  assert.equal(execs().length, runs, "no worker round");
  assert.deepEqual(verdicts(s), ["hello:fix", "hello:takeover", "hello:accept", "hello:drop"]);
  assert.equal(readFileSync(roundFile(s, "hello", 4, "notes.md"), "utf8"), "The lead's proof failed.\n");
  assert.deepEqual(readFileSync(roundFile(s, "hello", 2, "notes.md")), fixNotes, "the fix's notes stay as they were");
  reviewPack(s.repo, "hello");
  const again = tasks.verdictAccept(s.repo, "hello", s.file("second.md", "the proofs pass now\n"), s.file("message.txt", MESSAGE), { allowTestIdentity: true }) as { commit: string };
  assert.equal(must(s.repo, "rev-parse", `${again.commit}^`), base);
  assert.equal(readFileSync(roundFile(s, "hello", 3, "evidence-accept.md"), "utf8"), "node --test: 1 passed\n", "the first accept's evidence stays");
  assert.equal(readFileSync(roundFile(s, "hello", 4, "evidence-accept.md"), "utf8"), "the proofs pass now\n");
  confirmed(s, "hello");
  assert.equal(task(s, "hello").status, "accepted");
});

test("after a drop whose fix round waits on a spent tool, a takeover and an accept leave the first accept's evidence as it was", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, threadId: THREAD, writeFile: [{ path: "hello.txt", content: "hello\n" }] }]);
  const { worktree } = send(s, "hello").task;
  await needsReview(s, "hello");
  reviewPack(s.repo, "hello");
  tasks.verdictAccept(s.repo, "hello", s.file("first.md", "the first accept's proofs\n"), s.file("message.txt", MESSAGE), { allowTestIdentity: true });
  const first = readFileSync(roundFile(s, "hello", 1, "evidence-accept.md"));
  exhaust("codex");
  tasks.drop(s.repo, "hello", s.file("notes.md", NOTES));
  assert.deepEqual([task(s, "hello").status, task(s, "hello").stallReason, task(s, "hello").seq], ["stalled", "quota", 1], "the fix round never ran");
  tasks.takeover(s.repo, "hello", false);
  writeFileSync(join(worktree!, "hello.txt"), "hello from the lead\n");
  reviewPack(s.repo, "hello");
  tasks.verdictAccept(s.repo, "hello", s.file("second.md", "the second accept's proofs\n"), s.file("message.txt", MESSAGE), { allowTestIdentity: true });
  assert.deepEqual(readFileSync(roundFile(s, "hello", 1, "evidence-accept.md")), first, "the first accept's evidence stays");
  // Round 2 holds the drop's notes, so the lead's round is the third.
  assert.equal(readFileSync(roundFile(s, "hello", 3, "evidence-accept.md"), "utf8"), "the second accept's proofs\n");
  const accepts = readEvents(s.id).items.flatMap((e) => (e.t === "verdict" && e.verdict === "accept" ? [[e.seq, e.file?.path]] : []));
  assert.deepEqual(accepts, [[1, roundFile(s, "hello", 1, "evidence-accept.md")], [3, roundFile(s, "hello", 3, "evidence-accept.md")]]);
});

test("a drop killed after its reset goes on from the commit's parent", async (t) => {
  const s = setup(t);
  const { goal } = tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }, DONE]);
  const base = must(s.repo, "rev-parse", GOAL);
  send(s, "hello");
  await needsReview(s, "hello");
  committed(s, "hello");
  must(goal.integrationWorktree, "reset", "-q", "--keep", "HEAD~1");
  tasks.drop(s.repo, "hello", s.file("notes.md", NOTES));
  assert.deepEqual([must(s.repo, "rev-parse", GOAL), task(s, "hello").status, task(s, "hello").integratedCommit], [base, "working", null]);
  await needsReview(s, "hello");
});

test("a drop refuses an integration worktree that is not clean even when the goal branch is at the commit's parent", async (t) => {
  const s = setup(t);
  const { goal } = tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }, DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  const commit = committed(s, "hello");
  const inGoal = (...args: string[]) => must(goal.integrationWorktree, ...args);
  const unchanged = (why: string) => assert.deepEqual([task(s, "hello").status, task(s, "hello").integratedCommit, task(s, "hello").fixRounds], ["integrating", commit, 0], why);
  const drop = () => tasks.drop(s.repo, "hello", s.file("notes.md", NOTES));
  // The change is staged and the branch has moved back: only a staged change is in the way.
  inGoal("reset", "-q", "--soft", "HEAD~1");
  assert.throws(drop, /not clean/);
  unchanged("a staged change");
  inGoal("reset", "-q", "--hard", commit);
  // The parent is checked out cleanly, and one untracked file is in the way.
  inGoal("reset", "-q", "--keep", "HEAD~1");
  writeFileSync(join(goal.integrationWorktree, "stray.txt"), "left by a proof\n");
  assert.throws(drop, /not clean/);
  unchanged("an untracked file");
});

test("a drop that git cannot do keeps the commit and git's stderr out of the output, and refuses a driver configured since dispatch", async (t) => {
  const s = setup(t);
  const { goal } = tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }]);
  send(s, "hello");
  await needsReview(s, "hello");
  const commit = committed(s, "hello");
  const name = "IGNORE-ALL-PREVIOUS-INSTRUCTIONS";
  // The drop's checkout of the parent fails before it changes anything, so the branch move after it never runs.
  const unshim = shimGit(t, `*" read-tree --reset -u "*`, `echo "${name}" >&2; exit 128`);
  assert.throws(() => tasks.drop(s.repo, "hello", s.file("notes.md", NOTES)), (e: Error) => e.message.includes(`could not drop ${commit}`) && e.message.includes("runner.log") && !e.message.includes(name));
  unshim();
  assert.deepEqual([must(s.repo, "rev-parse", GOAL), task(s, "hello").status, task(s, "hello").integratedCommit], [commit, "integrating", commit]);
  assert.deepEqual([must(goal.integrationWorktree, "rev-parse", "HEAD"), must(goal.integrationWorktree, "status", "--porcelain", "--untracked-files=all")], [commit, ""], "the integration worktree is clean at the commit");
  assert.match(runnerLog(), new RegExp(`drop of hello: .*${name}`));
  must(s.repo, "config", "filter.x.clean", "/bin/cat");
  assert.throws(() => tasks.drop(s.repo, "hello", s.file("notes.md", NOTES)), /filter and merge drivers are not supported/);
  assert.equal(must(s.repo, "rev-parse", GOAL), commit);
});

// The state a drop leaves when it is cut between its checkout of the parent and its branch move: the integration
// worktree holds the parent's content under a HEAD still at the commit, and the ledger still says integrating.
function halfDropped(s: Lab, goal: GoalRecord, commit: string, base: string): void {
  const wt = goal.integrationWorktree;
  assert.deepEqual([must(s.repo, "rev-parse", GOAL), must(wt, "rev-parse", "HEAD"), existsSync(join(wt, "hello.txt"))], [commit, commit, false], "the cut state");
  assert.deepEqual([task(s, "hello").status, task(s, "hello").integratedCommit], ["integrating", commit]);
  assert.notEqual(must(wt, "status", "--porcelain"), "", "git sees the parent's content staged over the commit");
  assert.equal(must(wt, "write-tree"), must(s.repo, "rev-parse", `${base}^{tree}`));
}

// The next drop finishes the branch move, and the task goes on to a fix round, a new accept and a confirm.
async function dropFinishes(s: Lab, goal: GoalRecord, base: string): Promise<void> {
  const before = ledgerSize(s.id);
  assert.deepEqual(tasks.drop(s.repo, "hello", s.file("notes.md", NOTES)), { cursor: before });
  assert.deepEqual([must(s.repo, "rev-parse", GOAL), must(goal.integrationWorktree, "rev-parse", "HEAD"), must(goal.integrationWorktree, "status", "--porcelain", "--untracked-files=all")], [base, base, ""]);
  assert.deepEqual([task(s, "hello").status, task(s, "hello").integratedCommit, task(s, "hello").fixRounds], ["working", null, 1]);
  await needsReview(s, "hello");
  const again = committed(s, "hello");
  assert.equal(must(s.repo, "rev-parse", `${again}^`), base);
  confirmed(s, "hello");
  assert.equal(task(s, "hello").status, "accepted");
}

test("a drop whose branch move fails after its checkout is finished by the next drop", async (t) => {
  const s = setup(t);
  const { goal } = tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }, DONE]);
  const base = must(s.repo, "rev-parse", GOAL);
  send(s, "hello");
  await needsReview(s, "hello");
  const commit = committed(s, "hello");
  // A held ref, say: the confined checkout has run, the branch move cannot.
  const unshim = shimGit(t, `*" update-ref HEAD "*`, "echo held >&2; exit 128");
  assert.throws(() => tasks.drop(s.repo, "hello", s.file("notes.md", NOTES)), new RegExp(`could not drop ${commit}`));
  unshim();
  halfDropped(s, goal, commit, base);
  // In this state nothing else may move the goal.
  assert.throws(() => tasks.confirm(s.repo, "hello", s.file("c.md", "ok\n")), /integration worktree not clean/);
  // Only that exact state resumes: an untracked file or an edit on top of it still refuses.
  const wt = goal.integrationWorktree;
  writeFileSync(join(wt, "stray.txt"), "x\n");
  assert.throws(() => tasks.drop(s.repo, "hello", s.file("notes.md", NOTES)), /refusing to drop the last commit: .* is not clean/);
  rmSync(join(wt, "stray.txt"));
  writeFileSync(join(wt, "README.md"), "edited\n");
  assert.throws(() => tasks.drop(s.repo, "hello", s.file("notes.md", NOTES)), /refusing to drop the last commit: .* is not clean/);
  writeFileSync(join(wt, "README.md"), must(s.repo, "show", `${base}:README.md`) + "\n");
  assert.deepEqual([must(s.repo, "rev-parse", GOAL), task(s, "hello").status], [commit, "integrating"]);
  await dropFinishes(s, goal, base);
});

test("a drop killed between its checkout and its branch move is finished by the next drop", async (t) => {
  const s = setup(t);
  const { goal } = tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }, DONE]);
  const base = must(s.repo, "rev-parse", GOAL);
  send(s, "hello");
  await needsReview(s, "hello");
  const commit = committed(s, "hello");
  const stop = stopPoint();
  const unshim = shimGit(t, `*" update-ref HEAD "*`, stop.action);
  const c = spawn(LAUNCHER, ["drop", "hello", "--notes", s.file("notes.md", NOTES)], { cwd: s.repo, stdio: "ignore", detached: true });
  t.after(() => kill(-c.pid!));
  assert.ok(await until(stop.reached), "the drop reaches its branch move");
  const ended = new Promise<void>((done) => c.once("exit", () => done()));
  kill(-c.pid!);
  await ended;
  unshim();
  halfDropped(s, goal, commit, base);
  await dropFinishes(s, goal, base);
});

test("drop refuses an integration worktree that is not on the goal branch, wherever its HEAD is", async (t) => {
  const s = setup(t);
  const { goal } = tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }]);
  send(s, "hello");
  await needsReview(s, "hello");
  const commit = committed(s, "hello");
  for (const [how, args] of [["detached at the commit's parent", ["checkout", "-q", "--detach", `${commit}^`]], ["on another branch at the commit", ["checkout", "-q", "-B", "side", commit]]] as const) {
    must(goal.integrationWorktree, ...args);
    assert.throws(() => tasks.drop(s.repo, "hello", s.file("notes.md", NOTES)), new RegExp(`refusing to drop ${commit}: .* is not on ${GOAL}`), how);
    assert.deepEqual([must(s.repo, "rev-parse", GOAL), task(s, "hello").status, task(s, "hello").integratedCommit], [commit, "integrating", commit], how);
  }
  assert.equal(must(s.repo, "rev-parse", "side"), commit, "the other branch is left alone");
  assert.deepEqual(verdicts(s), ["hello:accept"]);
});

test("drop still refuses when HEAD is neither the commit nor its parent", async (t) => {
  const s = setup(t);
  const { goal } = tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }]);
  send(s, "hello");
  await needsReview(s, "hello");
  const commit = committed(s, "hello");
  const later = moveGoal(goal, (dir) => writeFileSync(join(dir, "later.txt"), "later\n"));
  assert.throws(() => tasks.drop(s.repo, "hello", s.file("notes.md", NOTES)), /refusing to drop the last commit/);
  assert.deepEqual([must(s.repo, "rev-parse", GOAL), task(s, "hello").status, task(s, "hello").integratedCommit], [later, "integrating", commit]);
});

// Mechanical rebase

test("real conflict: second accept runs one uncounted conflict round, the worker fixes the markers via writeFile, then the accept commits", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([
    { ...DONE, threadId: THREAD, writeFile: [{ path: "README.md", content: "first\n" }] },
    { ...DONE, threadId: THREAD, writeFile: [{ path: "README.md", content: "second\n" }] },
    { ...DONE, writeFile: [{ path: "README.md", content: "merged\n" }] },
  ]);
  send(s, "first");
  await needsReview(s, "first");
  const { worktree } = send(s, "second").task;
  await needsReview(s, "second");
  const oldBase = task(s, "second").base;
  const first = committed(s, "first");
  confirmed(s, "first");

  // Slots held, so the worker's turn waits and the merge result can be read.
  const slots = occupy(2);
  const before = ledgerSize(s.id);
  assert.deepEqual(accept(s, "second"), { conflict: ["README.md"], cursor: before });
  noEvidence(s, "second", 1);
  const waiting = task(s, "second");
  assert.deepEqual([waiting.status, waiting.base, waiting.fixRounds, waiting.pending?.kind, waiting.seq], ["waiting", first, 0, "resume", 1]);
  assert.notEqual(oldBase, first);
  assert.match(readFileSync(join(worktree!, "README.md"), "utf8"), /^<<<<<<< [^]*\nfirst\n[^]*\nsecond\n>>>>>>> /m);
  assert.equal(must(worktree!, "rev-parse", "HEAD"), first);
  assert.ok(readFileSync(roundFile(s, "second", 1, "conflict.patch"), "utf8").includes("+second"));
  assert.deepEqual(verdicts(s), ["first:accept", "first:confirm", "second:fix"]);

  slots.forEach(release);
  pump(s);
  const round = task(s, "second");
  assert.deepEqual([round.status, round.seq, round.fixRounds], ["working", 2, 0]);
  const job = readJob(round.jobIds[1])!;
  assert.deepEqual([job.kind, job.sessionId, readFileSync(job.promptPath, "utf8")], ["resume", THREAD, renderConflictMessage(GOAL, ["README.md"])]);
  await needsReview(s, "second");

  const commit = committed(s, "second");
  assert.equal(must(s.repo, "rev-parse", `${commit}^`), first);
  assert.equal(must(s.repo, "show", `${commit}:README.md`), "merged");
  assert.deepEqual([task(s, "second").status, task(s, "second").fixRounds], ["integrating", 0]);
});

test("a conflict over the fix limit still runs its round: it does not count", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const before = await reviewed(s, tenWith({ 5: "task" }));
  setTask(s, "hello", { fixRounds: 4 });
  const tip = onGoal(goal, tenWith({ 5: "goal" }));
  const cursor = ledgerSize(s.id);
  assert.deepEqual(accept(s, "hello"), { conflict: ["f.txt"], cursor });
  assert.deepEqual([task(s, "hello").base, task(s, "hello").fixRounds, task(s, "hello").status], [tip, 4, "working"]);
  assert.notEqual(before.base, tip);
  await needsReview(s, "hello");
});

test("context-only overlap: clean merge returns to needs-review with no worker job", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const { worktree, base } = await reviewed(s, tenWith({ 3: "task" }));
  const tip = onGoal(goal, tenWith({ 5: "goal" }));
  const before = ledgerSize(s.id);
  const runs = execs().length;
  assert.deepEqual(accept(s, "hello"), { rebased: true, cursor: before });
  const moved = task(s, "hello");
  assert.deepEqual([moved.status, moved.base, moved.jobIds.length, moved.fixRounds, moved.seq], ["needs-review", tip, 1, 0, 1]);
  assert.notEqual(base, tip);
  assert.equal(execs().length, runs);
  assert.equal(must(worktree!, "rev-parse", "HEAD"), tip);
  assert.equal(readFileSync(join(worktree!, "f.txt"), "utf8"), tenWith({ 3: "task", 5: "goal" }));
  assert.equal(verdicts(s).length, 0, "no accept verdict for a merge the lead has not reviewed");
  assert.equal(existsSync(roundFile(s, "hello", 2, "notes.md")), false, "no phantom round");
  assert.deepEqual([existsSync(rebaseFile(s, "rebase.json")), existsSync(rebaseFile(s, "rebase.patch"))], [false, false]);
  noEvidence(s, "hello", 1);
  const woke = await waitForNext(s.repo, { since: before, timeoutMs: 30_000 });
  assert.deepEqual(woke.kind === "events" && woke.items.map((i) => [i.task, i.status, i.next]), [["hello", "needs-review", "review"]]);
  // The merge changed the worktree, so the review from before it no longer covers what accept would commit.
  assert.throws(() => unreviewedAccept(s, "hello"), /task hello changed since its last review; run mandor review hello again/);
  const commit = committed(s, "hello");
  assert.equal(must(s.repo, "rev-parse", `${commit}^`), tip);
  assert.equal(must(s.repo, "show", `${commit}:f.txt`), tenWith({ 3: "task", 5: "goal" }).trimEnd());
});

test("modify/delete: rebase-failed, worker changes restored, base unchanged", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const { worktree, base } = await reviewed(s, tenWith({ 3: "task" }));
  removedOnGoal(goal);
  const before = ledgerSize(s.id);
  assert.deepEqual(accept(s, "hello"), { stalled: "rebase-failed", cursor: before });
  noEvidence(s, "hello", 1);
  const held = task(s, "hello");
  assert.deepEqual([held.status, held.stallReason, held.base, held.jobIds.length], ["stalled", "rebase-failed", base, 1]);
  assert.equal(must(worktree!, "rev-parse", "HEAD"), base);
  assert.equal(readFileSync(join(worktree!, "f.txt"), "utf8"), tenWith({ 3: "task" }));
  const patch = roundFile(s, "hello", 1, "conflict.patch");
  assert.ok(readFileSync(patch, "utf8").includes("+task"));
  assert.ok(showTask(s.id, "hello").split("\n").some((l) => l.trim() === patch), "show prints the patch's path");
  const woke = await waitForNext(s.repo, { since: before, timeoutMs: 30_000 });
  assert.deepEqual(woke.kind === "events" && woke.items.map((i) => [i.task, i.next, i.detail]), [["hello", "inspect", lastUpdate(s, "hello").reason]]);
  assert.ok(!lastUpdate(s, "hello").reason.includes("f.txt"));
});

test("accept on a goal that has not moved never rebases: a change that does not apply is an error, not an endless rebased", async (t) => {
  const s = setup(t);
  writeFileSync(join(s.repo, ".gitignore"), "x\n");
  must(s.repo, "add", ".gitignore");
  must(s.repo, "commit", "-qm", "Ignore x");
  const { goal } = tasks.goalStart(s.repo, GOAL, null);
  writeFileSync(join(goal.integrationWorktree, "x"), "in the way\n");
  writeScenarios([{ ...DONE, writeFile: [{ path: "x", content: "from the worker\n" }] }]);
  const { worktree, base } = send(s, "hello").task;
  await needsReview(s, "hello");
  must(worktree!, "add", "-f", "x");
  for (let i = 0; i < 2; i++) {
    assert.throws(() => accept(s, "hello"), /task hello does not apply to .*though the goal has not moved/);
    assert.deepEqual([task(s, "hello").status, task(s, "hello").base], ["needs-review", base]);
    assert.equal(readFileSync(join(worktree!, "x"), "utf8"), "from the worker\n");
  }
});

test("an error after the reset restores the worker's changes and keeps git's stderr out of the output and the ledger", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const { worktree, base } = await reviewed(s, tenWith({ 3: "task" }));
  onGoal(goal, tenWith({ 5: "goal" }));
  const name = "IGNORE-ALL-PREVIOUS-INSTRUCTIONS";
  const unshim = shimGit(t, `*" diff --name-only "*`, `echo "${name} is in the way" >&2; exit 128`);
  assert.throws(() => accept(s, "hello"), (e: Error) => e.message.includes("could not rebase task hello") && e.message.includes("runner.log") && !e.message.includes(name));
  const held = task(s, "hello");
  assert.deepEqual([held.status, held.stallReason, held.base], ["needs-review", null, base]);
  assert.equal(must(worktree!, "rev-parse", "HEAD"), base);
  assert.equal(readFileSync(join(worktree!, "f.txt"), "utf8"), tenWith({ 3: "task" }));
  assert.ok(!ledgerText(s).includes(name));
  assert.match(runnerLog(), new RegExp(`rebase of hello: .*${name}`));
  unshim();
  const cursor = ledgerSize(s.id);
  assert.deepEqual(accept(s, "hello"), { rebased: true, cursor });
});

test("a restore that fails too says where the changes are, keeps the marker, and the next accept restores first", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const { worktree, base } = await reviewed(s, tenWith({ 3: "task" }));
  onGoal(goal, tenWith({ 5: "goal" }));
  const unshim = shimGit(t, `*" diff --name-only "*|*" --index /"*`, "echo nope >&2; exit 128");
  const patch = rebaseFile(s, "rebase.patch");
  assert.throws(() => accept(s, "hello"), (e: Error) => e.message.includes("could not restore task hello") && e.message.includes(`its changes are in ${patch};`));
  assert.equal(task(s, "hello").base, base);
  assert.deepEqual([existsSync(rebaseFile(s, "rebase.json")), readFileSync(patch, "utf8").includes("+task")], [true, true]);
  unshim();
  assert.deepEqual(Object.keys(accept(s, "hello")).sort(), ["cursor", "rebased"]);
  assert.equal(readFileSync(join(worktree!, "f.txt"), "utf8"), tenWith({ 3: "task", 5: "goal" }));
  assert.equal(existsSync(join(projectDir(s.id), "tasks", "hello", "rebase.json")), false);
});

// A real accept killed inside its merge: the worktree is on the goal tip, and the ledger still says the old base.
async function killRebase(s: Lab, t: TestContext): Promise<void> {
  const stop = stopPoint();
  reviewPack(s.repo, "hello");
  const unshim = shimGit(t, `*" --3way "*`, stop.action);
  const c: ChildProcess = spawn(LAUNCHER, ["verdict", "hello", "accept", "--evidence-file", s.file("e.md", "node --test: 1 passed\n"), "--message-file", s.file("m.txt", MESSAGE)], { cwd: s.repo, stdio: "ignore", detached: true });
  t.after(() => kill(-c.pid!));
  assert.ok(await until(stop.reached), "the accept reaches its merge");
  const ended = new Promise<void>((done) => c.once("exit", () => done()));
  kill(-c.pid!);
  await ended;
  unshim();
}

for (const [name, run, seen] of [
  ["accept", (s: Lab) => accept(s, "hello"), "needs-review"],
  ["fix", (s: Lab) => tasks.verdictFix(s.repo, "hello", s.file("notes.md", NOTES)), "working"],
  ["takeover", (s: Lab) => tasks.takeover(s.repo, "hello", false), "takeover"],
] as const) {
  test(`a rebase killed between the reset and its outcome is undone by the next ${name}`, async (t) => {
    const s = setup(t);
    must(s.repo, "config", "user.email", "dev@host.test");
    const goal = tenLineGoal(s);
    const { worktree, base } = await reviewed(s, tenWith({ 3: "task" }));
    const tip = onGoal(goal, tenWith({ 5: "goal" }));
    await killRebase(s, t);
    assert.deepEqual([must(worktree!, "rev-parse", "HEAD"), task(s, "hello").base], [tip, base], "the killed state");
    const patch = roundFile(s, "hello", 1, "conflict.patch");
    const bytes = readFileSync(patch);
    run(s);
    assert.equal(task(s, "hello").status, seen);
    assert.deepEqual(readFileSync(patch), bytes, "the worker's change was not overwritten");
    assert.equal(existsSync(join(projectDir(s.id), "tasks", "hello", "rebase.json")), false);
    if (name === "accept") assert.equal(readFileSync(join(worktree!, "f.txt"), "utf8"), tenWith({ 3: "task", 5: "goal" }));
    else assert.equal(must(worktree!, "rev-parse", "HEAD"), base);
    if (name === "takeover") assert.equal(readFileSync(join(worktree!, "f.txt"), "utf8"), tenWith({ 3: "task" }));
    if (name === "fix") await needsReview(s, "hello");
  });
}

test("a rebase killed and then cancelled leaves no marker for a worktree that is gone", async (t) => {
  const s = setup(t);
  must(s.repo, "config", "user.email", "dev@host.test");
  const goal = tenLineGoal(s);
  await reviewed(s, tenWith({ 3: "task" }));
  onGoal(goal, tenWith({ 5: "goal" }));
  await killRebase(s, t);
  const marker = join(projectDir(s.id), "tasks", "hello", "rebase.json");
  assert.equal(existsSync(marker), true);
  tasks.cancel(s.repo, "hello");
  assert.equal(existsSync(marker), false);
  assert.throws(() => tasks.takeover(s.repo, "hello", true), /task hello is cancelled, not needs-review or stalled/);
});

for (const variant of ["conflict", "not applied"] as const) {
  test(`after a rebase-failed takeover, a second rebase in the round that ends ${variant} keeps conflict.patch, the only copy of the worker's change`, async (t) => {
    const s = setup(t);
    const goal = tenLineGoal(s);
    const { worktree } = await reviewed(s, tenWith({ 3: "task" }));
    removedOnGoal(goal);
    accept(s, "hello");
    await stalled(s, "hello", "rebase-failed");
    const record = roundFile(s, "hello", 1, "conflict.patch");
    const original = readFileSync(record);
    assert.ok(original.toString().includes("+task"));
    tasks.takeover(s.repo, "hello", false);
    const taken = roundFile(s, "hello", 2, "conflict.patch");
    const takenBytes = readFileSync(taken);
    assert.ok(takenBytes.toString().includes("+task"), "the takeover kept the change in the round it moved the task to");
    // The lead starts to reapply the change by hand, and another task lands on the file the lead is editing.
    writeFileSync(join(worktree!, "README.md"), "temp repo\nfrom the lead\n");
    moveGoal(goal, (dir) => (variant === "conflict" ? writeFileSync(join(dir, "README.md"), "temp repo\nfrom the goal\n") : rmSync(join(dir, "README.md"))));
    const before = ledgerSize(s.id);
    assert.deepEqual(accept(s, "hello"), variant === "conflict" ? { conflict: ["README.md"], cursor: before } : { stalled: "rebase-failed", cursor: before });
    assert.deepEqual(readFileSync(record), original, "the worker's change is still on record");
    assert.deepEqual(readFileSync(taken), takenBytes, "and so is the takeover's record");
    assert.equal(task(s, "hello").status, "takeover");
    const readme = readFileSync(join(worktree!, "README.md"), "utf8");
    if (variant === "conflict") assert.match(readme, /^<<<<<<< [^]*\nfrom the goal\n[^]*\nfrom the lead\n>>>>>>> /m);
    else assert.equal(readme, "temp repo\nfrom the lead\n", "the lead's work is back");
    assert.deepEqual([existsSync(rebaseFile(s, "rebase.json")), existsSync(rebaseFile(s, "rebase.patch"))], [false, false]);
    noEvidence(s, "hello", 1);
    noEvidence(s, "hello", 2);
  });
}

test("a rebase killed in the second rebase of a round is restored from its own patch, with the lead's edits", async (t) => {
  const s = setup(t);
  must(s.repo, "config", "user.email", "dev@host.test");
  const goal = tenLineGoal(s);
  const { worktree } = await reviewed(s, tenWith({ 3: "task" }));
  onGoal(goal, tenWith({ 5: "goal" }));
  assert.deepEqual(Object.keys(accept(s, "hello")).sort(), ["cursor", "rebased"]);
  const record = readFileSync(roundFile(s, "hello", 1, "conflict.patch"));
  // The lead edits a shared file in the review, and the goal moves again.
  writeFileSync(join(worktree!, "CHANGES.md"), "- Say hello\n");
  // Inside the hunk's context, so only a merge can combine them.
  onGoal(goal, tenWith({ 5: "goal", 6: "again" }));
  await killRebase(s, t);
  assert.deepEqual(Object.keys(accept(s, "hello")).sort(), ["cursor", "rebased"]);
  assert.equal(readFileSync(join(worktree!, "f.txt"), "utf8"), tenWith({ 3: "task", 5: "goal", 6: "again" }));
  assert.equal(readFileSync(join(worktree!, "CHANGES.md"), "utf8"), "- Say hello\n");
  assert.deepEqual(readFileSync(roundFile(s, "hello", 1, "conflict.patch")), record, "the round's record is the first rebase's");
});

test("review undoes a rebase killed between its reset and its outcome before it reads the diff", async (t) => {
  const s = setup(t);
  must(s.repo, "config", "user.email", "dev@host.test");
  const goal = tenLineGoal(s);
  const { worktree } = await reviewed(s, tenWith({ 3: "task" }));
  moveGoal(goal, (dir) => {
    writeFileSync(join(dir, "f.txt"), tenWith({ 5: "goal" }));
    writeFileSync(join(dir, "other.txt"), "the goal's own\n");
  });
  await killRebase(s, t);
  const pack = reviewPack(s.repo, "hello");
  assert.deepEqual(pack.files, [{ path: "f.txt", status: "M" }], "only the task's change, not the goal's");
  assert.equal(readFileSync(join(worktree!, "f.txt"), "utf8"), tenWith({ 3: "task" }));
  assert.deepEqual([existsSync(rebaseFile(s, "rebase.json")), existsSync(join(worktree!, "other.txt"))], [false, false]);
});

test("a marker found after the outcome was recorded only goes away", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const { base, worktree } = await reviewed(s, tenWith({ 3: "task" }));
  const tip = onGoal(goal, tenWith({ 5: "goal" }));
  assert.deepEqual(Object.keys(accept(s, "hello")).sort(), ["cursor", "rebased"]);
  const marker = join(projectDir(s.id), "tasks", "hello", "rebase.json");
  writeJsonAtomic(marker, { oldBase: base });
  writeFileSync(rebaseFile(s, "rebase.patch"), "not applied again\n");
  committed(s, "hello");
  assert.deepEqual([existsSync(marker), existsSync(rebaseFile(s, "rebase.patch"))], [false, false]);
  assert.ok(readFileSync(roundFile(s, "hello", 1, "conflict.patch"), "utf8").includes("+task"), "the round's record stays");
  assert.equal(must(worktree!, "rev-parse", "HEAD"), tip);
});

test("in takeover, conflicted paths move the base, start no job and return the conflict for the lead", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const { worktree } = await reviewed(s, tenWith({ 5: "task" }));
  tasks.takeover(s.repo, "hello", false);
  const tip = onGoal(goal, tenWith({ 5: "goal" }));
  const before = ledgerSize(s.id);
  const runs = execs().length;
  assert.deepEqual(accept(s, "hello"), { conflict: ["f.txt"], cursor: before });
  const held = task(s, "hello");
  assert.deepEqual([held.status, held.base, held.jobIds.length, held.pending, held.fixRounds], ["takeover", tip, 1, null, 0]);
  assert.equal(execs().length, runs);
  assert.match(readFileSync(join(worktree!, "f.txt"), "utf8"), /^<<<<<<< /m);
  assert.deepEqual(verdicts(s), ["hello:takeover"]);
  writeFileSync(join(worktree!, "f.txt"), tenWith({ 5: "both" }));
  const commit = committed(s, "hello");
  assert.equal(must(s.repo, "rev-parse", `${commit}^`), tip);
});

test("in takeover, a clean merge moves the base and stays in takeover", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const { worktree } = await reviewed(s, tenWith({ 3: "task" }));
  tasks.takeover(s.repo, "hello", false);
  const tip = onGoal(goal, tenWith({ 5: "goal" }));
  const before = ledgerSize(s.id);
  assert.deepEqual(accept(s, "hello"), { rebased: true, cursor: before });
  assert.deepEqual([task(s, "hello").status, task(s, "hello").base], ["takeover", tip]);
  assert.equal(readFileSync(join(worktree!, "f.txt"), "utf8"), tenWith({ 3: "task", 5: "goal" }));
  committed(s, "hello");
});

test("in takeover, a change that does not apply is restored and stays in takeover", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const { worktree, base } = await reviewed(s, tenWith({ 3: "task" }));
  tasks.takeover(s.repo, "hello", false);
  removedOnGoal(goal);
  const before = ledgerSize(s.id);
  assert.deepEqual(accept(s, "hello"), { stalled: "rebase-failed", cursor: before });
  const held = task(s, "hello");
  assert.deepEqual([held.status, held.stallReason, held.base], ["takeover", null, base]);
  assert.equal(must(worktree!, "rev-parse", "HEAD"), base);
  assert.equal(readFileSync(join(worktree!, "f.txt"), "utf8"), tenWith({ 3: "task" }));
});

// Reassign

test("reassign after model-limit starts a fresh codex session on another model, keeps the first job's file, and puts the first report in the handoff", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  const report = JSON.stringify({ status: "done", summary: "FIRST-ROUND-SUMMARY", files_changed: ["hello.txt"], commands_run: [], tests: { ran: false, passed: 0, failed: 0, notes: "" }, open_issues: [], questions_for_lead: [] });
  writeScenarios([
    { ...DONE, threadId: THREAD, lastMessage: report, writeFile: [{ path: "hello.txt", content: "hello\n" }] },
    { stdout: "generated:model-limit" },
    DONE,
  ]);
  const { worktree } = send(s, "hello").task;
  await needsReview(s, "hello");
  tasks.verdictFix(s.repo, "hello", s.file("notes.md", NOTES));
  await stalled(s, "hello", "model-limit");
  const before = ledgerSize(s.id);
  const { task: moved, cursor } = tasks.reassign(s.repo, "hello");
  assert.equal(cursor, before);
  assert.deepEqual([moved.status, moved.stallReason, moved.candidate, moved.seq, moved.jobIds.length, moved.pending], ["working", null, SOL_HIGH, 3, 3, null]);
  const job = readJob(moved.jobIds[2])!;
  assert.deepEqual([job.kind, job.sessionId, job.candidate, job.worktree], ["start", null, SOL_HIGH, worktree]);
  const handoff = readFileSync(roundFile(s, "hello", 3, "handoff.md"), "utf8");
  assert.equal(readFileSync(job.promptPath, "utf8"), handoff);
  assert.ok(handoff.startsWith(readFileSync(moved.briefPath, "utf8")), handoff);
  for (const part of ["FIRST-ROUND-SUMMARY", "hello.txt", renderFixMessage(NOTES).trim()]) assert.ok(handoff.includes(part), part);
  await needsReview(s, "hello");
  const { argv } = execs().at(-1)!;
  assert.deepEqual([argv.includes("resume"), argv[argv.indexOf("-m") + 1]], [false, SOL_HIGH.model]);
  assert.equal(readFileSync(join(worktree!, "hello.txt"), "utf8"), "hello\n");
});

test("reassign prefers the tool only after a model-limit", async (t) => {
  const s = setup(t);
  // The tier lists another tool first, so only preferTool can pick codex.
  const config = structuredClone(DEFAULT_CONFIG);
  config.tools.codex.bin = process.env.MANDOR_CODEX_BIN!;
  config.tools.zcode = { ...config.tools.zcode, enabled: true, bin: FAKE_ZCODE };
  config.tiers.medium = ["zcode:GLM-5.3@high", "codex:gpt-6.1-sol@high"];
  writeJsonAtomic(join(s.home, "config.json"), config);
  const model = (tool: ToolName, name: string, efforts: string[]): ModelInfo => ({ tool, model: name, label: name, efforts, defaultEffort: efforts[0], hidden: false });
  writeCatalog([model("codex", "gpt-6-luna", ["medium"]), model("codex", "gpt-6.1-sol", ["high"]), model("zcode", "GLM-5.3", ["high"])]);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([DONE, HOLD]);
  send(s, "hello");
  await needsReview(s, "hello");
  exhaust("codex:gpt-6-luna");
  setTask(s, "hello", { status: "stalled", stallReason: "model-limit" });
  const moved = tasks.reassign(s.repo, "hello").task;
  assert.deepEqual([moved.status, moved.candidate], ["working", SOL_HIGH]);
  await workersRunning(moved.jobIds.slice(1));
  kill(-readJob(moved.jobIds[1])!.workerPid!);
  await stalled(s, "hello", "failed");
  // After anything else the tier's own order holds; the zcode job fails without the network, which is not the point.
  assert.deepEqual(tasks.reassign(s.repo, "hello").task.candidate, { tool: "zcode", model: "GLM-5.3", effort: "high" });
});

test("codex-only quota, then reassign (all-exhausted), then ready codex: the task resumes its old session", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ stdout: "generated:quota", threadId: THREAD, writeFile: [{ path: "hello.txt", content: "hello\n" }] }, DONE]);
  send(s, "hello");
  await stalled(s, "hello", "all-exhausted");
  const { task: still } = tasks.reassign(s.repo, "hello");
  assert.deepEqual([still.status, still.stallReason, still.jobIds.length, still.pending], ["stalled", "all-exhausted", 1, null]);
  assert.equal(execs().length, 1);
  assert.deepEqual(tasks.ready("codex"), { resumed: ["hello"] });
  assert.deepEqual(loadToolState(Math.floor(Date.now() / 1000)), {});
  const resumed = task(s, "hello");
  assert.deepEqual([resumed.status, resumed.stallReason, resumed.pending, resumed.seq, resumed.candidate], ["working", null, null, 2, LUNA]);
  const job = readJob(resumed.jobIds[1])!;
  assert.deepEqual([job.kind, job.sessionId, readFileSync(job.promptPath, "utf8")], ["resume", THREAD, CONTINUE]);
  await needsReview(s, "hello");
  const { argv } = execs().at(-1)!;
  assert.equal(argv[argv.indexOf("resume") + 1], THREAD);
});

test("reassign at the tool's limit waits with a pending handoff, and the pump starts it", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }, DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  setTask(s, "hello", { status: "stalled", stallReason: "timeout" });
  const slots = occupy(2);
  const { task: held } = tasks.reassign(s.repo, "hello");
  assert.deepEqual([held.status, held.stallReason, held.pending, held.jobIds.length], ["waiting", null, { kind: "handoff", message: null }, 1]);
  assert.equal(existsSync(roundFile(s, "hello", 2, "handoff.md")), false);
  slots.forEach(release);
  pump(s);
  assert.equal(task(s, "hello").status, "working");
  assert.equal(readFileSync(roundFile(s, "hello", 2, "handoff.md"), "utf8"), readFileSync(readJob(task(s, "hello").jobIds[1])!.promptPath, "utf8"));
  await needsReview(s, "hello");
});

test("reassign takes only a stall it can help, and no task whose dependency is not accepted", (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  const refused = (slug: string, reason: StallReason, pattern: RegExp) => {
    ledgerTask(s, slug, { status: "stalled", stallReason: reason, pending: null });
    assert.throws(() => tasks.reassign(s.repo, slug), pattern, reason);
    assert.deepEqual([task(s, slug).status, task(s, slug).stallReason], ["stalled", reason]);
  };
  refused("mechanical", "rebase-failed", /task mechanical is stalled with rebase-failed/);
  refused("rounds", "fix-rounds-exceeded", /task rounds is stalled with fix-rounds-exceeded/);
  ledgerTask(s, "early");
  assert.throws(() => tasks.reassign(s.repo, "early"), /task early is waiting/);
  ledgerTask(s, "blocked", { after: "early", status: "stalled", stallReason: "failed" });
  assert.throws(() => tasks.reassign(s.repo, "blocked"), /task blocked depends on early, which is waiting/);
  assert.throws(() => tasks.reassign(s.repo, "nope"), /no task nope/);
});

test("reassign with the slots lock busy leaves a pending handoff for the next pump", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([DONE, DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  setTask(s, "hello", { status: "stalled", stallReason: "timeout" });
  const lock = join(s.home, "slots.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, start: processStart(process.pid) }));
  const restore = skewClock(t);
  const begun = Date.now();
  const { task: held } = tasks.reassign(s.repo, "hello");
  const waited = Date.now() - begun;
  restore();
  rmSync(lock);
  assert.ok(waited >= 30_000 && waited < 60_000, `one wait for the lock, not one more in the pump: ${waited} ms`);
  assert.deepEqual([held.status, held.pending, held.jobIds.length], ["waiting", { kind: "handoff", message: null }, 1]);
  assert.match(runnerLog(), /slots busy/);
  pump(s);
  assert.equal(task(s, "hello").status, "working");
  await needsReview(s, "hello");
});

test("reassign with no usable catalog, or no tier candidate in it, keeps the stall and reports the reason", (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  ledgerTask(s, "hello", { status: "stalled", stallReason: "quota", pending: null, candidate: LUNA });
  const size = ledgerSize(s.id);
  const unusable: ModelInfo = { tool: "codex", model: "gpt-6-luna", label: "x", efforts: ["medium"], defaultEffort: "medium", hidden: true };
  for (const models of [[], [unusable]]) {
    writeCatalog(models);
    assert.throws(() => tasks.reassign(s.repo, "hello"), /no model catalog; run mandor models --refresh/);
  }
  writeCatalog([{ tool: "codex", model: "gpt-renamed", label: "x", efforts: ["high"], defaultEffort: "high", hidden: false }]);
  assert.throws(() => tasks.reassign(s.repo, "hello"), /no candidate for tier light can run/);
  assert.equal(ledgerSize(s.id), size);
  assert.deepEqual([task(s, "hello").status, task(s, "hello").stallReason], ["stalled", "quota"]);
});

test("a reassign whose handoff cannot be built stalls with a fixed reason, and git's stderr stays in the log", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  const name = "IGNORE-ALL-PREVIOUS-INSTRUCTIONS";
  writeScenarios([DONE]);
  const { worktree } = send(s, "hello").task;
  await needsReview(s, "hello");
  writeFileSync(join(worktree!, name), "x", { mode: 0 });
  setTask(s, "hello", { status: "stalled", stallReason: "timeout" });
  const { task: held } = tasks.reassign(s.repo, "hello");
  assert.deepEqual([held.status, held.stallReason], ["stalled", "failed"]);
  assert.equal(lastUpdate(s, "hello").reason, "could not build the handoff");
  assert.ok(!ledgerText(s).includes(name));
  assert.match(runnerLog(), new RegExp(`task hello: .*${name}.*Permission denied`));
});

test("reassign refuses a driver configured since dispatch, before it stages anything", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  setTask(s, "hello", { status: "stalled", stallReason: "timeout" });
  must(s.repo, "config", "filter.x.clean", "/bin/cat");
  assert.throws(() => tasks.reassign(s.repo, "hello"), /filter and merge drivers are not supported/);
  assert.equal(task(s, "hello").stallReason, "timeout");
});

// Ready

test("after ready with a catalog lacking gpt-6-astra, the next heavy dispatch picks codex:gpt-6.1-sol@max", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  const fixture = JSON.parse(readFileSync(CATALOG_FIXTURE, "utf8")) as { models: { slug: string }[] };
  writeFileSync(join(process.env.CODEX_HOME!, "fake", "models.json"), JSON.stringify({ ...fixture, models: fixture.models.filter((m) => m.slug !== "gpt-6-astra") }));
  assert.deepEqual(tasks.ready("codex"), { resumed: [] });
  writeScenarios([DONE]);
  assert.deepEqual(send(s, "heavy", { tier: "heavy" }).task.candidate, SOL_MAX);
  await needsReview(s, "heavy");
});

test("ready respects maxParallel by leaving extra tasks waiting", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  for (const slug of ["one", "two", "three"]) ledgerTask(s, slug, { status: "stalled", stallReason: "quota", pending: null });
  writeScenarios([HOLD, HOLD, HOLD]);
  assert.deepEqual(tasks.ready("codex"), { resumed: ["one", "two", "three"] });
  const seen = ["one", "two", "three"].map((slug) => [task(s, slug).status, task(s, slug).stallReason, task(s, slug).pending]);
  assert.deepEqual(seen, [["working", null, null], ["working", null, null], ["waiting", null, { kind: "start", message: null }]]);
  await workersRunning([...task(s, "one").jobIds, ...task(s, "two").jobIds]);
});

test("ready codex revives an all-exhausted task that never started", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  exhaust("codex");
  const { task: held } = send(s, "hello");
  assert.deepEqual([held.status, held.stallReason, held.pending, held.jobIds], ["stalled", "all-exhausted", { kind: "start", message: null }, []]);
  writeScenarios([DONE]);
  assert.deepEqual(tasks.ready("codex"), { resumed: ["hello"] });
  const started = task(s, "hello");
  assert.deepEqual([started.status, started.stallReason, started.candidate], ["working", null, LUNA]);
  const job = readJob(started.jobIds[0])!;
  assert.deepEqual([job.kind, readFileSync(job.promptPath, "utf8")], ["start", readFileSync(started.briefPath, "utf8")]);
  await needsReview(s, "hello");
});

test("account-mismatch on a ready resume starts one fresh handoff", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([
    { stdout: "generated:quota", threadId: THREAD, writeFile: [{ path: "a.txt", content: "a\n" }] },
    { stdout: "generated:account-mismatch" },
    { ...DONE, threadId: "00000000-0000-7000-8000-000000000602" },
  ]);
  send(s, "hello");
  await stalled(s, "hello", "all-exhausted");
  tasks.ready("codex");
  assert.equal(readJob(task(s, "hello").jobIds[1])!.kind, "resume");
  await needsReview(s, "hello");
  const done = task(s, "hello");
  assert.deepEqual([done.jobIds.map((id) => readJob(id)!.kind), done.seq, done.sessionId], [["start", "resume", "start"], 3, "00000000-0000-7000-8000-000000000602"]);
  assert.equal(loadState(s.id).jobs[done.jobIds[1]].outcome?.status, "account-mismatch");
  const handoff = readFileSync(roundFile(s, "hello", 3, "handoff.md"), "utf8");
  assert.equal(readFileSync(readJob(done.jobIds[2])!.promptPath, "utf8"), handoff);
  assert.ok(handoff.includes("a.txt"), handoff);
  assert.equal(execs().length, 3);
});

test("ready gives a task with a candidate and no session a handoff, and leaves other tools and reasons alone", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }, DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  setTask(s, "hello", { status: "stalled", stallReason: "model-limit", sessionId: null });
  const other: Candidate = { tool: "zcode", model: "GLM-5.3", effort: "high" };
  ledgerTask(s, "elsewhere", { status: "stalled", stallReason: "quota", pending: null, candidate: other });
  ledgerTask(s, "broken", { status: "stalled", stallReason: "failed", pending: null, candidate: LUNA });
  assert.deepEqual(tasks.ready("codex"), { resumed: ["hello"] });
  const job = readJob(task(s, "hello").jobIds[1])!;
  assert.deepEqual([job.kind, job.sessionId, readFileSync(job.promptPath, "utf8")], ["start", null, readFileSync(roundFile(s, "hello", 2, "handoff.md"), "utf8")]);
  assert.deepEqual([task(s, "elsewhere").status, task(s, "broken").status], ["stalled", "stalled"]);
  await needsReview(s, "hello");
});

test("ready runs from any directory over every project, and reports one it could not reach", async (t) => {
  const a = setup(t);
  const b = lab(a.home);
  const c = lab(a.home);
  for (const s of [a, b]) {
    tasks.goalStart(s.repo, GOAL, null);
    ledgerTask(s, `in-${s === a ? "a" : "b"}`, { status: "stalled", stallReason: "all-exhausted", pending: null, base: null });
  }
  tasks.goalStart(c.repo, GOAL, null);
  writeFileSync(join(projectDir(c.id), "ledger.jsonl"), "not json\n");
  writeScenarios([HOLD, HOLD]);
  const plain = temp("mandor-plain-");
  const r = cli(plain, "ready", "codex");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([[...r.json.resumed].sort(), r.json.failed], [["in-a", "in-b"], [c.id]]);
  assert.equal(task(a, "in-a").status, "working");
  assert.equal(task(b, "in-b").status, "working");
  assert.match(runnerLog(), new RegExp(`ready codex in ${c.id}: .*unparsable line`));
  await workersRunning([...task(a, "in-a").jobIds, ...task(b, "in-b").jobIds]);
});

test("ready refuses an unknown tool and a refresh that fails, and marks nothing ready", (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  ledgerTask(s, "hello", { status: "stalled", stallReason: "quota", pending: null });
  exhaust("codex");
  assert.throws(() => tasks.ready("nope" as ToolName), /unknown tool nope/);
  writeFileSync(join(process.env.CODEX_HOME!, "fake", "models.json"), "not json");
  assert.throws(() => tasks.ready("codex"), /printed a catalog that does not parse/);
  assert.deepEqual(Object.keys(loadToolState(Math.floor(Date.now() / 1000))), ["codex"]);
  assert.equal(task(s, "hello").status, "stalled");
});

// Cancel

test("cancel records cancelled and removes the worktree", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([HOLD]);
  const { task: sent } = send(s, "hello");
  await workersRunning(sent.jobIds);
  const before = ledgerSize(s.id);
  assert.deepEqual(tasks.cancel(s.repo, "hello"), { cursor: before });
  const gone = task(s, "hello");
  assert.deepEqual([gone.status, gone.stallReason, gone.pending], ["cancelled", null, null]);
  assert.equal(existsSync(sent.worktree!), false);
  assert.equal(must(s.repo, "branch", "--list", "wip/hello"), "");
  assert.equal(loadState(s.id).jobs[sent.jobIds[0]].outcome?.status, "cancelled", "the job was stopped, and its completion waited for");
  assert.deepEqual(verdicts(s), ["hello:cancel"]);
  assert.deepEqual(await waitForNext(s.repo, { since: before, timeoutMs: 10_000 }), { kind: "idle", cursor: ledgerSize(s.id) });
});

test("cancel takes waiting, needs-review, stalled and takeover, clears pending, and refuses integrating, accepted and cancelled", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "one.txt", content: "one\n" }] }, DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  send(s, "review-me");
  await needsReview(s, "review-me");
  exhaust("codex");
  const { task: held } = send(s, "held");
  assert.equal(held.status, "stalled");
  const { task: mine } = send(s, "mine");
  tasks.takeover(s.repo, "mine", true);
  assert.equal(task(s, "mine").status, "takeover");
  ledgerTask(s, "queued", { worktree: join(mine.worktree!, "..", "task-queued") });
  for (const slug of ["held", "mine", "queued", "review-me"]) {
    tasks.cancel(s.repo, slug);
    assert.deepEqual([task(s, slug).status, task(s, slug).stallReason, task(s, slug).pending], ["cancelled", null, null], slug);
  }
  assert.throws(() => tasks.cancel(s.repo, "held"), /task held is cancelled/);
  committed(s, "hello");
  assert.throws(() => tasks.cancel(s.repo, "hello"), /task hello is integrating; drop it first/);
  assert.equal(existsSync(cancelMarker(s.id, "hello")), false, "a refused cancel leaves no marker to stop a later job");
  confirmed(s, "hello");
  assert.throws(() => tasks.cancel(s.repo, "hello"), /task hello is accepted/);
  assert.throws(() => tasks.cancel(s.repo, "nope"), /no task nope/);
});

test("cancel waits for a job at most 20 s, and the marker stays for a job that outlives it", (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  ledgerTask(s, "hello", { status: "working", pending: null, candidate: LUNA, worktree: null });
  appendEvent(s.id, { t: "job.started", at: now(), job: { id: "j-20261108100000-abcd", taskId: "hello", seq: 1, kind: "start", candidate: LUNA } });
  const restore = skewClock(t);
  const begun = Date.now();
  tasks.cancel(s.repo, "hello");
  const waited = Date.now() - begun;
  restore();
  assert.ok(waited >= 20_000 && waited < 40_000, `${waited} ms`);
  assert.equal(task(s, "hello").status, "cancelled");
  assert.equal(existsSync(cancelMarker(s.id, "hello")), true);
});

test("a task that became integrating during the wait is refused, and its marker goes", (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  ledgerTask(s, "hello", { status: "working", pending: null, candidate: LUNA, worktree: null });
  appendEvent(s.id, { t: "job.started", at: now(), job: { id: "j-20261108100000-abcd", taskId: "hello", seq: 1, kind: "start", candidate: LUNA } });
  const realWait = Atomics.wait;
  t.after(() => {
    Atomics.wait = realWait;
  });
  Atomics.wait = ((a: Int32Array, i: number, v: number, ms?: number) => {
    appendEvent(s.id, { t: "job.finished", at: now(), jobId: "j-20261108100000-abcd", outcome: { status: "done", sessionId: null, detail: "", resetsAt: null, exitCode: 0 } });
    setTask(s, "hello", { status: "integrating" });
    Atomics.wait = realWait;
    return realWait(a, i, v, ms);
  }) as typeof Atomics.wait;
  assert.throws(() => tasks.cancel(s.repo, "hello"), /task hello is integrating; drop it first/);
  assert.equal(existsSync(cancelMarker(s.id, "hello")), false);
});

// An open job in the ledger, with no job file, keeps a cancel waiting between its two locks.
const GHOST = "j-20261108100000-abcd";
const openGhost = (s: Lab) => appendEvent(s.id, { t: "job.started", at: now(), job: { id: GHOST, taskId: "hello", seq: 1, kind: "start", candidate: LUNA } });
const closeGhost = (s: Lab) => appendEvent(s.id, { t: "job.finished", at: now(), jobId: GHOST, outcome: { status: "done", sessionId: null, detail: "", resetsAt: null, exitCode: 0 } });

async function cancelBetweenLocks(s: Lab, t: TestContext): Promise<ChildProcess> {
  openGhost(s);
  const c = spawn(LAUNCHER, ["cancel", "hello"], { cwd: s.repo, stdio: "ignore", detached: true });
  t.after(() => kill(-c.pid!));
  assert.ok(await until(() => existsSync(cancelMarker(s.id, "hello"))), "the cancel writes its marker");
  return c;
}

const exited = (c: ChildProcess) => new Promise<void>((done) => (c.exitCode !== null || c.signalCode !== null ? done() : c.once("exit", () => done())));

test("a cancel killed after its first lock does not make the next fix round end cancelled", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, threadId: THREAD }, DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  const c = await cancelBetweenLocks(s, t);
  kill(-c.pid!);
  await exited(c);
  closeGhost(s);
  assert.equal(task(s, "hello").status, "needs-review");
  tasks.verdictFix(s.repo, "hello", s.file("notes.md", NOTES));
  await needsReview(s, "hello");
  assert.equal(loadState(s.id).jobs[task(s, "hello").jobIds[1]].outcome?.status, "done");
  assert.equal(existsSync(cancelMarker(s.id, "hello")), false);
  assert.match(runnerLog(), /task hello: removed the marker of a cancel that did not finish/);
});

test("no job starts while a cancel is between its locks, and the cancel then records the task cancelled", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([DONE, DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  const c = await cancelBetweenLocks(s, t);
  setTask(s, "hello", { status: "waiting", pending: { kind: "resume", message: "Go on." } });
  pump(s);
  assert.deepEqual([task(s, "hello").status, task(s, "hello").jobIds.length, execs().length], ["waiting", 1, 1], "the start waits for the cancel");
  closeGhost(s);
  await exited(c);
  assert.deepEqual([c.exitCode, task(s, "hello").status, task(s, "hello").jobIds.length, execs().length], [0, "cancelled", 1, 1]);
  assert.equal(existsSync(cancelMarker(s.id, "hello")), true, "a cancel that finished keeps its marker for a job that outlived it");
});

test("a cancel killed while a job runs is half a cancel: the job ends with its own outcome, and a fresh cancel then cancels the task", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, delayMs: 4000 }]);
  const { task: sent } = send(s, "hello");
  await workersRunning(sent.jobIds);
  // Held still, so the runner never sees the marker while its cancel lives.
  const runner = readJob(sent.jobIds[0])!.runnerPid!;
  process.kill(runner, "SIGSTOP");
  const c = spawn(LAUNCHER, ["cancel", "hello"], { cwd: s.repo, stdio: "ignore", detached: true });
  t.after(() => kill(-c.pid!));
  assert.ok(await until(() => existsSync(cancelMarker(s.id, "hello"))), "the cancel writes its marker");
  kill(-c.pid!);
  await exited(c);
  process.kill(runner, "SIGCONT");
  await needsReview(s, "hello");
  assert.equal(loadState(s.id).jobs[sent.jobIds[0]].outcome?.status, "done");
  assert.equal(existsSync(cancelMarker(s.id, "hello")), false);
  assert.match(runnerLog(), /task hello: removed the marker of a cancel that did not finish/);
  tasks.cancel(s.repo, "hello");
  assert.equal(task(s, "hello").status, "cancelled");
});

test("cancelling a task stalls its chain of dependents, wait reports inspect, and then goes idle", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([DONE, DONE]);
  send(s, "root");
  await needsReview(s, "root");
  send(s, "mid", { after: "root" });
  send(s, "leaf", { after: "mid" });
  send(s, "apart");
  assert.deepEqual([task(s, "mid").status, task(s, "leaf").status], ["waiting", "waiting"]);
  const { cursor } = tasks.cancel(s.repo, "root");
  for (const slug of ["mid", "leaf"]) {
    const x = task(s, slug);
    assert.deepEqual([x.status, x.stallReason, x.pending, x.jobIds, lastUpdate(s, slug).reason], ["stalled", "failed", { kind: "start", message: null }, [], "dependency root was cancelled"], slug);
  }
  assert.notEqual(task(s, "apart").status, "stalled");
  await needsReview(s, "apart");
  const woke = await waitForNext(s.repo, { since: cursor, timeoutMs: 30_000 });
  assert.deepEqual(
    woke.kind === "events" && woke.items.filter((i) => i.task !== "apart").map((i) => [i.task, i.status, i.next, i.detail]),
    [["mid", "stalled", "inspect", "dependency root was cancelled"], ["leaf", "stalled", "inspect", "dependency root was cancelled"]],
  );
  assert.deepEqual(await waitForNext(s.repo, { since: woke.cursor, timeoutMs: 10_000 }), { kind: "idle", cursor: ledgerSize(s.id) });
  assert.throws(() => tasks.reassign(s.repo, "mid"), /task mid depends on root, which is cancelled/);
  assert.throws(() => send(s, "late", { after: "root" }), /--after root: that task is cancelled/);
  assert.equal(task(s, "late"), undefined);
  assert.equal(tasks.takeover(s.repo, "mid", false).cursor > 0, true);
  assert.equal(task(s, "mid").status, "takeover");
});

test("prose that puts the name before an ordinary word is refused with the way out, and accepted once the user allows it", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  const name = ["man", "dor"].join("");
  writeScenarios([{ ...DONE, writeFile: [{ path: "shift.md", content: `Update the ${name} status when the shift ends.\n` }] }]);
  send(s, "shift");
  await needsReview(s, "shift");
  assert.throws(() => accept(s, "shift"), new RegExp(`accept refused:\\n- attribution: shift\\.md: names the tool \\(${name} status\\)\\nIf this repository uses that name as a word of its own subject, the user allows it with project setup --name-is-a-word; do not run it yourself\\.$`));
  assert.equal(task(s, "shift").status, "needs-review");
  saveProjectConfig(s.id, { ...loadProjectConfig(s.id), nameIsWord: true });
  assert.deepEqual(reviewPack(s.repo, "shift").violations, []);
  assert.match(committed(s, "shift"), /^[0-9a-f]{40}$/);
  confirmed(s, "shift");
  // An invocation is a trace all the same, and its refusal names no way out.
  writeScenarios([{ ...DONE, writeFile: [{ path: "run.md", content: `Then run ${name} status --json.\n` }] }]);
  send(s, "run");
  await needsReview(s, "run");
  assert.throws(() => accept(s, "run"), new RegExp(`accept refused:\\n- attribution: run\\.md: names the tool \\(${name} status\\)$`));
});

// Takeover

test("a taken-over task is accepted through the guards and releases its dependent", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }, DONE]);
  const { worktree } = send(s, "first").task;
  await needsReview(s, "first");
  send(s, "second", { after: "first" });
  const before = ledgerSize(s.id);
  assert.deepEqual(tasks.takeover(s.repo, "first", false), { cursor: before });
  assert.deepEqual([task(s, "first").status, task(s, "first").stallReason, task(s, "first").pending], ["takeover", null, null]);
  assert.deepEqual(verdicts(s), ["first:takeover"]);
  writeFileSync(join(worktree!, "AGENTS.md"), "rules\n");
  assert.throws(() => accept(s, "first"), /accept refused/);
  assert.equal(task(s, "first").status, "takeover");
  rmSync(join(worktree!, "AGENTS.md"));
  writeFileSync(join(worktree!, "hello.txt"), "hello from the lead\n");
  const commit = committed(s, "first");
  assert.equal(must(s.repo, "show", `${commit}:hello.txt`), "hello from the lead");
  assert.deepEqual([task(s, "first").status, task(s, "second").status], ["integrating", "waiting"]);
  confirmed(s, "first");
  assert.equal(task(s, "first").status, "accepted");
  assert.deepEqual([task(s, "second").status, task(s, "second").base], ["working", commit]);
  await needsReview(s, "second");
});

test("takeover of an all-exhausted task without --approved is refused", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  exhaust("codex");
  const pending = { kind: "start" as const, message: null };
  const { task: held } = send(s, "hello");
  assert.deepEqual([held.status, held.stallReason, held.pending], ["stalled", "all-exhausted", pending]);
  assert.throws(() => tasks.takeover(s.repo, "hello", false), /task hello needs the user's approval/);
  assert.deepEqual([task(s, "hello").status, task(s, "hello").pending, verdicts(s)], ["stalled", pending, []]);
  ledgerTask(s, "rounds", { status: "stalled", stallReason: "fix-rounds-exceeded", pending: null });
  assert.throws(() => tasks.takeover(s.repo, "rounds", false), /task rounds needs the user's approval/);
  tasks.takeover(s.repo, "hello", true);
  tasks.takeover(s.repo, "rounds", true);
  assert.deepEqual([task(s, "hello").status, task(s, "hello").stallReason, task(s, "hello").pending], ["takeover", null, null]);
  assert.deepEqual([task(s, "rounds").status, verdicts(s)], ["takeover", ["hello:takeover", "rounds:takeover"]]);
});

test("takeover takes needs-review or a stall with no open job, and refuses anything else", (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  const refused = (slug: string, over: Partial<TaskRecord>, pattern: RegExp) => {
    ledgerTask(s, slug, over);
    assert.throws(() => tasks.takeover(s.repo, slug, true), pattern, slug);
  };
  refused("queued", {}, /task queued is waiting, not needs-review or stalled/);
  refused("run", { status: "working", pending: null }, /task run is working, not needs-review or stalled/);
  refused("wired", { status: "integrating", pending: null }, /task wired is integrating, not needs-review or stalled/);
  ledgerTask(s, "open", { status: "needs-review", pending: null, seq: 1 });
  appendEvent(s.id, { t: "job.started", at: now(), job: { id: "j-20261108100000-abcd", taskId: "open", seq: 2, kind: "resume", candidate: LUNA } });
  assert.throws(() => tasks.takeover(s.repo, "open", true), /task open has a queued or running job/);
  assert.throws(() => tasks.takeover(s.repo, "nope", true), /no task nope/);
  assert.deepEqual(verdicts(s), []);
});

test("taking over a rebase-failed task moves it to the goal tip with no approval, keeps its change in a new round's conflict.patch, and accept then applies", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const { worktree } = await reviewed(s, tenWith({ 3: "task" }));
  const tip = removedOnGoal(goal);
  accept(s, "hello");
  await stalled(s, "hello", "rebase-failed");
  const patch = readFileSync(roundFile(s, "hello", 1, "conflict.patch"), "utf8");
  assert.ok(patch.includes("+task"));
  tasks.takeover(s.repo, "hello", false);
  const taken = task(s, "hello");
  assert.deepEqual([taken.status, taken.stallReason, taken.base, taken.pending, taken.seq], ["takeover", null, tip, null, 2]);
  assert.equal(must(worktree!, "rev-parse", "HEAD"), tip);
  assert.equal(existsSync(join(worktree!, "f.txt")), false, "the worktree holds the goal tip");
  assert.equal(readFileSync(roundFile(s, "hello", 1, "conflict.patch"), "utf8"), patch);
  assert.equal(readFileSync(roundFile(s, "hello", 2, "conflict.patch"), "utf8"), patch, "the change as the worktree held it, in the round the task moved to");
  const verdict = readEvents(s.id).items.findLast((e) => e.t === "verdict");
  assert.deepEqual(verdict?.t === "verdict" && [verdict.verdict, verdict.seq], ["takeover", 2]);
  writeFileSync(join(worktree!, "g.txt"), "reapplied by hand\n");
  const commit = committed(s, "hello");
  assert.equal(must(s.repo, "rev-parse", `${commit}^`), tip);
  assert.equal(readFileSync(roundFile(s, "hello", 2, "conflict.patch"), "utf8"), patch, "an accept that applies leaves the patch alone");
  assert.equal(existsSync(roundFile(s, "hello", 2, "evidence-accept.md")), true, "the lead's accept is the new round's");
});

test("a rebase-failed takeover keeps the change as the lead left it, edits since a clean rebase included, in a new round's conflict.patch", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const { worktree } = await reviewed(s, tenWith({ 3: "task" }));
  writeFileSync(join(worktree!, "CHANGES.md"), "- first lead edit\n");
  onGoal(goal, tenWith({ 5: "goal" }));
  assert.deepEqual(Object.keys(accept(s, "hello")).sort(), ["cursor", "rebased"]);
  const first = readFileSync(roundFile(s, "hello", 1, "conflict.patch"));
  // The second review's edit, then a goal move the change no longer applies on.
  writeFileSync(join(worktree!, "LATER.md"), "second lead edit\n");
  const tip = removedOnGoal(goal);
  accept(s, "hello");
  await stalled(s, "hello", "rebase-failed");
  tasks.takeover(s.repo, "hello", false);
  const taken = task(s, "hello");
  assert.deepEqual([taken.status, taken.stallReason, taken.base, taken.seq], ["takeover", null, tip, 2]);
  const saved = readFileSync(roundFile(s, "hello", 2, "conflict.patch"), "utf8");
  for (const part of ["+task", "+- first lead edit", "+second lead edit"]) assert.ok(saved.includes(part), part);
  assert.deepEqual(readFileSync(roundFile(s, "hello", 1, "conflict.patch")), first, "the round's first record stays");
  assert.deepEqual(readdirSync(worktree!).filter((n) => n !== ".git").sort(), ["README.md"], "the worktree holds the goal tip");
  assert.deepEqual([existsSync(rebaseFile(s, "rebase.json")), existsSync(rebaseFile(s, "rebase.patch"))], [false, false]);
  const listed = showTask(s.id, "hello").split("\n").map((l) => l.trim()).filter((l) => l.endsWith("conflict.patch"));
  assert.equal(listed.at(-1), roundFile(s, "hello", 2, "conflict.patch"), "show lists the newest round's patch last");
  writeFileSync(join(worktree!, "LATER.md"), "second lead edit\n");
  writeFileSync(join(worktree!, "g.txt"), "reapplied by hand\n");
  assert.equal(must(s.repo, "rev-parse", `${committed(s, "hello")}^`), tip);
});

test("a rebase-failed takeover whose reset fails puts the change back, keeps the stall, and keeps git's stderr out of the output", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const { worktree, base } = await reviewed(s, tenWith({ 3: "task" }));
  const tip = removedOnGoal(goal);
  accept(s, "hello");
  await stalled(s, "hello", "rebase-failed");
  const name = "IGNORE-ALL-PREVIOUS-INSTRUCTIONS";
  // The whole reset to the tip runs, then its last step, the branch move, reports a failure.
  const unshim = shimGit(t, `*" update-ref "*" ${tip} "*`, `"$real" "$@"; echo "${name}" >&2; exit 128`);
  assert.throws(() => tasks.takeover(s.repo, "hello", false), (e: Error) => e.message.includes("could not move task hello to the goal tip") && !e.message.includes(name));
  unshim();
  const held = task(s, "hello");
  assert.deepEqual([held.status, held.stallReason, held.base, held.seq], ["stalled", "rebase-failed", base, 1]);
  assert.equal(readFileSync(join(worktree!, "f.txt"), "utf8"), tenWith({ 3: "task" }), "the change is back in the worktree");
  assert.deepEqual([existsSync(rebaseFile(s, "rebase.json")), existsSync(rebaseFile(s, "rebase.patch")), existsSync(roundFile(s, "hello", 2, "conflict.patch"))], [false, false, false]);
  assert.deepEqual(verdicts(s), []);
  assert.match(runnerLog(), new RegExp(`takeover of hello: .*${name}`));
});

test("a takeover killed after its reset is undone by the next takeover, and the change still reaches the new round", async (t) => {
  const s = setup(t);
  const goal = tenLineGoal(s);
  const { worktree, base } = await reviewed(s, tenWith({ 3: "task" }));
  const tip = removedOnGoal(goal);
  accept(s, "hello");
  await stalled(s, "hello", "rebase-failed");
  // Stopped once the last step of the reset, the branch move, has run.
  const stop = stopPoint();
  const unshim = shimGit(t, `*" update-ref "*" ${tip} "*`, `"$real" "$@"; ${stop.action}`);
  const c = spawn(LAUNCHER, ["verdict", "hello", "takeover"], { cwd: s.repo, stdio: "ignore", detached: true });
  t.after(() => kill(-c.pid!));
  assert.ok(await until(stop.reached), "the takeover reaches its reset");
  kill(-c.pid!);
  await exited(c);
  unshim();
  assert.deepEqual([existsSync(join(worktree!, "f.txt")), task(s, "hello").status, task(s, "hello").base], [false, "stalled", base], "the killed state");
  tasks.takeover(s.repo, "hello", false);
  const taken = task(s, "hello");
  assert.deepEqual([taken.status, taken.base, taken.seq], ["takeover", tip, 2]);
  assert.ok(readFileSync(roundFile(s, "hello", 2, "conflict.patch"), "utf8").includes("+task"));
  assert.deepEqual([existsSync(rebaseFile(s, "rebase.json")), existsSync(rebaseFile(s, "rebase.patch"))], [false, false]);
});

// What the lead reads

test("a pump stall reports its reason through wait and show, until a job reports something newer", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, threadId: THREAD }, { stdout: "generated:no-terminal", exitCode: 1 }]);
  send(s, "hello");
  await needsReview(s, "hello");
  exhaust("codex:gpt-6-luna");
  const { cursor } = tasks.verdictFix(s.repo, "hello", s.file("notes.md", NOTES));
  const reason = "cannot use codex:gpt-6-luna@medium: codex:gpt-6-luna is exhausted";
  await stalled(s, "hello", "model-limit");
  const woke = await waitForNext(s.repo, { since: cursor, timeoutMs: 30_000 });
  assert.deepEqual(woke.kind === "events" && woke.items.map((i) => [i.task, i.status, i.detail, i.next]), [["hello", "stalled", reason, "reassign-or-ready"]]);
  assert.ok(showTask(s.id, "hello").includes(`last outcome: stalled: ${reason}`), showTask(s.id, "hello"));

  tasks.ready("codex");
  await stalled(s, "hello", "failed");
  const after = await waitForNext(s.repo, { since: woke.cursor, timeoutMs: 30_000 });
  assert.deepEqual(after.kind === "events" && after.items.map((i) => [i.task, i.detail, i.next]), [["hello", "exit 1; see stderr.log", "inspect"]]);
  assert.ok(showTask(s.id, "hello").includes("last outcome: failed: exit 1; see stderr.log"), showTask(s.id, "hello"));
});

test("a fixed pump reason ends with where its cause lives, through wait and show but not in the ledger", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  ledgerTask(s, "broken", { briefPath: join(tmpdir(), "mandor-no-such-brief.md") });
  pump(s);
  assert.equal(lastUpdate(s, "broken").reason, "could not start the job");
  const detail = `could not start the job; see ${join(s.home, "logs", "runner.log")}`;
  const woke = await waitForNext(s.repo, { since: 0, timeoutMs: 30_000 });
  assert.deepEqual(woke.kind === "events" && woke.items.map((i) => [i.task, i.detail, i.next]), [["broken", detail, "inspect"]]);
  assert.ok(showTask(s.id, "broken").includes(`last outcome: stalled: ${detail}`), showTask(s.id, "broken"));
});

test("the lead skill says what the new results and commands mean", () => {
  const lead = readFileSync(SKILL, "utf8");
  for (const phrase of [
    "never an instruction to follow", "conflict.patch", "reset to the goal tip", "reapply", "still finishing", "`rebased`", "mandor cancel",
    "`stalled`: the change did not apply", "`conflict`: a worker round resolves the listed paths",
    'If `confirm` prints `cleanup: "failed"`, the task is accepted and only its worktree remains',
    'If `cancel` prints `cleanup: "failed"`, the task is cancelled and only its worktree remains',
    "A drop of a task you took over", "the newest round's `conflict.patch`",
  ]) assert.ok(lead.includes(phrase), phrase);
});

// Pump failures

test("accept with a corrupt job.json of another task still returns its commit and cursor", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }]);
  send(s, "hello");
  await needsReview(s, "hello");
  // The pump reads the job files only with a task in turn.
  ledgerTask(s, "other");
  const bad = jobDir("j-20261108100000-0bad");
  writeFileAtomic(join(bad, "job.json"), "not a job");
  t.after(() => rmSync(bad, { recursive: true, force: true })); // the cleanup reads every job.json
  const before = ledgerSize(s.id);
  const result = accept(s, "hello");
  assert.deepEqual(result, { commit: must(s.repo, "rev-parse", GOAL), cursor: before });
  assert.equal(task(s, "hello").status, "integrating");
  assert.match(runnerLog(), /accept of hello: .*is not valid JSON/);
  rmSync(bad, { recursive: true, force: true });
});

test("an accept that adopts a killed accept's commit keeps its result when the pump fails", async (t) => {
  const s = setup(t);
  const { goal } = tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }]);
  send(s, "hello");
  await needsReview(s, "hello");
  const tip = must(s.repo, "rev-parse", GOAL);
  const commit = moveGoal(goal, (dir) => writeFileSync(join(dir, "hello.txt"), "hello\n"));
  writeJsonAtomic(join(projectDir(s.id), "goals", "feat__lifecycle", "accept-intent.json"), { slug: "hello", tip, tree: must(s.repo, "rev-parse", `${commit}^{tree}`) });
  ledgerTask(s, "other");
  const bad = jobDir("j-20261108100000-0bad");
  writeFileAtomic(join(bad, "job.json"), "not a job");
  t.after(() => rmSync(bad, { recursive: true, force: true })); // the cleanup reads every job.json
  const before = ledgerSize(s.id);
  assert.deepEqual(accept(s, "hello"), { commit, cursor: before });
  assert.deepEqual([task(s, "hello").status, task(s, "hello").integratedCommit], ["integrating", commit]);
  rmSync(bad, { recursive: true, force: true });
});

test("a pump that cannot read a job file fails no command whose state is on record", async (t) => {
  const s = setup(t);
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([
    { ...DONE, threadId: THREAD, writeFile: [{ path: "a.txt", content: "a\n" }] },
    { ...DONE, threadId: THREAD, writeFile: [{ path: "b.txt", content: "b\n" }] },
    { ...DONE, writeFile: [{ path: "c.txt", content: "c\n" }] },
  ]);
  for (const slug of ["a", "b", "c"]) {
    send(s, slug);
    await needsReview(s, slug);
  }
  ledgerTask(s, "other");
  const bad = jobDir("j-20261108100000-0bad");
  writeFileAtomic(join(bad, "job.json"), "not a job");
  t.after(() => rmSync(bad, { recursive: true, force: true })); // the cleanup reads every job.json
  const logged = (what: string) => assert.match(runnerLog(), new RegExp(`${what}: .*is not valid JSON`), what);

  assert.equal(typeof tasks.planSet(s.repo, GOAL, s.file("plan.md", "1. Go.\n"), "Go").cursor, "number");
  logged(`plan set of ${GOAL}`);
  assert.equal(tasks.goalStart(s.repo, "feat/second", null).goal.branch, "feat/second");
  logged("goal start of feat/second");

  committed(s, "a");
  logged("accept of a");
  assert.equal(typeof confirmed(s, "a").cursor, "number");
  logged("confirm of a");
  assert.equal(task(s, "a").status, "accepted");

  committed(s, "b");
  assert.equal(typeof tasks.drop(s.repo, "b", s.file("notes.md", NOTES)).cursor, "number");
  logged("drop of b");
  assert.deepEqual([task(s, "b").status, task(s, "b").pending?.kind], ["waiting", "resume"]);

  assert.equal(typeof tasks.verdictFix(s.repo, "c", s.file("notes.md", NOTES)).cursor, "number");
  logged("fix of c");
  assert.deepEqual([task(s, "c").status, task(s, "c").pending?.kind], ["waiting", "resume"]);

  assert.equal(typeof tasks.cancel(s.repo, "c").cursor, "number");
  logged("cancel of c");
  assert.equal(task(s, "c").status, "cancelled");

  assert.deepEqual(tasks.ready("codex"), { resumed: [] });
  logged("ready codex");

  rmSync(bad, { recursive: true, force: true });
});

// The commands

test("the CLI runs fix, takeover, drop, reassign and cancel, and refuses bad usage with exit 2", async (t) => {
  const s = setup(t);
  must(s.repo, "config", "user.email", "dev@host.test");
  tasks.goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...DONE, writeFile: [{ path: "hello.txt", content: "hello\n" }] }, DONE, DONE, DONE]);
  send(s, "hello");
  await needsReview(s, "hello");
  const run = (...args: string[]) => cli(s.repo, ...args);

  for (const args of [
    ["verdict", "hello", "fix"],
    ["verdict", "hello", "fix", "--notes"],
    ["verdict", "hello", "takeover", "--bogus"],
    ["verdict", "hello", "takeover", "--approved", "--approved"],
    ["drop", "hello"],
    ["drop"],
    ["reassign"],
    ["reassign", "hello", "extra"],
    ["ready"],
    ["ready", "codex", "extra"],
    ["cancel"],
    ["cancel", "hello", "extra"],
  ]) assert.equal(run(...args).status, 2, args.join(" "));
  assert.deepEqual([run("ready", "nope").status, run("reassign", "hello").status], [1, 1]);

  const fix = run("verdict", "hello", "fix", "--notes", s.file("notes.md", NOTES));
  assert.equal(fix.status, 0, fix.stderr);
  assert.equal(typeof fix.json.cursor, "number");
  await needsReview(s, "hello");

  assert.equal(run("review", "hello").status, 0);
  const accepted = run("verdict", "hello", "accept", "--evidence-file", s.file("e.md", "node --test: 1 passed\n"), "--message-file", s.file("m.txt", MESSAGE));
  assert.equal(accepted.status, 0, accepted.stderr);
  const dropped = run("drop", "hello", "--notes", s.file("notes.md", NOTES));
  assert.equal(dropped.status, 0, dropped.stderr);
  await needsReview(s, "hello");

  setTask(s, "hello", { status: "stalled", stallReason: "timeout" });
  const moved = run("reassign", "hello");
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(moved.json.task.status, "working");
  await needsReview(s, "hello");

  setTask(s, "hello", { status: "stalled", stallReason: "all-exhausted" });
  assert.equal(run("verdict", "hello", "takeover").status, 1);
  const taken = run("verdict", "hello", "takeover", "--approved");
  assert.equal(taken.status, 0, taken.stderr);
  assert.equal(task(s, "hello").status, "takeover");

  const gone = run("cancel", "hello");
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(task(s, "hello").status, "cancelled");
});
