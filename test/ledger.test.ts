import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Candidate, FileRef, GoalRecord, JobOutcome, LedgerEvent, ProjectState, TaskRecord, ToolEvent } from "../src/contracts.ts";
import { projectDir } from "../src/home.ts";
import { appendEvent, appendToolEvent, ledgerSize, listProjects, loadState, loadToolState, now, readEvents, replay } from "../src/ledger.ts";
import { readJsonl } from "../src/store.ts";
import { tempHome } from "./helpers.ts";

const AT = "2026-11-07T00:00:00.000Z";
const cand: Candidate = { tool: "codex", model: "m", effort: "" };
const goal: GoalRecord = { branch: "feat/x", from: "main", integrationWorktree: "/w/int", createdAt: AT };
const ref: FileRef = { path: "/p/plan.md", sha256: "ab", excerpt: "plan" };
const task = (id: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
  id, goalBranch: "feat/x", tier: "medium", after: null, status: "waiting", stallReason: null, pending: null,
  base: null, worktree: null, branch: `feat/x-${id}`, scope: [], seq: 0, fixRounds: 0, candidate: null,
  sessionId: null, use: null, jobIds: [], integratedCommit: null, briefPath: "/b.md", ...over,
});
const outcome: JobOutcome = { status: "done", sessionId: "s1", detail: "ok", resetsAt: null, exitCode: 0 };
const started = (id: string): LedgerEvent => ({ t: "job.started", at: AT, job: { id, taskId: "a", seq: 1, kind: "start", candidate: cand } });
const exhausted = (key: string, resetsAt: number | null, detail = "d"): ToolEvent => ({ t: "tool.exhausted", at: AT, key, resetsAt, detail });
// Spread copies, so a deep comparison does not depend on the records' null prototype.
const plain = (s: ProjectState) => ({ goals: { ...s.goals }, tasks: { ...s.tasks }, jobs: { ...s.jobs } });
const ledgerPath = (id: string) => join(projectDir(id), "ledger.jsonl");

test("empty ledger gives empty state", () => {
  tempHome();
  assert.deepEqual(plain(replay([])), { goals: {}, tasks: {}, jobs: {} });
  assert.deepEqual(plain(loadState("p")), { goals: {}, tasks: {}, jobs: {} });
  assert.deepEqual(readEvents("p"), { items: [], endByte: 0 });
  assert.equal(ledgerSize("p"), 0);
});

test("goal.started inserts the goal with no plan yet", () => {
  const s = replay([{ t: "goal.started", at: AT, goal }]);
  assert.deepEqual({ ...s.goals }, { "feat/x": { ...goal, description: null, plan: null } });
});

test("plan.set sets the goal's description and plan", () => {
  const s = replay([{ t: "goal.started", at: AT, goal }, { t: "plan.set", at: AT, goal: "feat/x", description: "do x", plan: ref }]);
  assert.equal(s.goals["feat/x"].description, "do x");
  assert.deepEqual(s.goals["feat/x"].plan, ref);
  assert.equal(s.goals["feat/x"].from, "main");
});

test("a task recorded under the Indonesian alias of its tier replays as that tier", () => {
  const s = replay([
    { t: "task.created", at: AT, task: { ...task("a"), tier: "berat" as never } },
    { t: "task.created", at: AT, task: task("b", { tier: "light" }) },
  ]);
  assert.deepEqual([s.tasks.a.tier, s.tasks.b.tier], ["heavy", "light"]);
});

test("task.created inserts the task by id", () => {
  const s = replay([{ t: "task.created", at: AT, task: task("a") }, { t: "task.created", at: AT, task: task("b") }]);
  assert.deepEqual(Object.keys(s.tasks), ["a", "b"]);
  assert.deepEqual(s.tasks.a, task("a"));
});

test("task.updated shallow-merges its patch into the task", () => {
  const s = replay([
    { t: "task.created", at: AT, task: task("a", { scope: ["x", "y"], seq: 2 }) },
    { t: "task.updated", at: AT, taskId: "a", patch: { status: "working", scope: ["z"], pending: { kind: "start", message: null } }, reason: "r" },
    { t: "task.updated", at: AT, taskId: "a", patch: { fixRounds: 1 }, reason: "r" },
  ]);
  assert.deepEqual(s.tasks.a, task("a", { status: "working", scope: ["z"], seq: 2, fixRounds: 1, pending: { kind: "start", message: null } }));
});

test("job.started inserts the job without an outcome", () => {
  const s = replay([started("j1")]);
  assert.deepEqual({ ...s.jobs }, { j1: { id: "j1", taskId: "a", seq: 1, kind: "start", candidate: cand, outcome: null } });
});

test("job.finished sets the outcome", () => {
  const s = replay([started("j1"), started("j2"), { t: "job.finished", at: AT, jobId: "j1", outcome }]);
  assert.deepEqual(s.jobs.j1.outcome, outcome);
  assert.equal(s.jobs.j2.outcome, null);
});

test("verdict changes no state", () => {
  const base: LedgerEvent[] = [{ t: "goal.started", at: AT, goal }, { t: "task.created", at: AT, task: task("a") }, started("j1")];
  const verdict: LedgerEvent = { t: "verdict", at: AT, taskId: "a", verdict: "accept", seq: 1, file: ref };
  assert.deepEqual(replay([...base, verdict]), replay(base));
});

test("events for an unknown record change nothing", () => {
  const s = replay([
    { t: "task.updated", at: AT, taskId: "ghost", patch: { status: "working" }, reason: "r" },
    { t: "job.finished", at: AT, jobId: "ghost", outcome },
    { t: "plan.set", at: AT, goal: "ghost", description: "d", plan: ref },
  ]);
  assert.deepEqual(plain(s), { goals: {}, tasks: {}, jobs: {} });
});

test("task.updated with pending null clears pending", () => {
  const s = replay([
    { t: "task.created", at: AT, task: task("a", { pending: { kind: "resume", message: "m" } }) },
    { t: "task.updated", at: AT, taskId: "a", patch: { pending: null }, reason: "r" },
  ]);
  assert.equal(s.tasks.a.pending, null);
});

for (const name of ["__proto__", "constructor"]) {
  test(`${name} works as a task slug, a goal branch and a job id`, () => {
    const s = replay([
      { t: "goal.started", at: AT, goal: { ...goal, branch: name } },
      { t: "plan.set", at: AT, goal: name, description: "d", plan: ref },
      { t: "task.created", at: AT, task: task(name) },
      { t: "task.updated", at: AT, taskId: name, patch: { status: "working" }, reason: "r" },
      started(name),
      { t: "job.finished", at: AT, jobId: name, outcome },
    ]);
    assert.deepEqual(Object.keys(s.goals), [name]);
    assert.deepEqual(Object.keys(s.tasks), [name]);
    assert.deepEqual(Object.keys(s.jobs), [name]);
    assert.equal(s.goals[name].description, "d");
    assert.equal(s.tasks[name].status, "working");
    assert.deepEqual(s.jobs[name].outcome, outcome);
    assert.equal(replay([{ t: "task.created", at: AT, task: task(name) }]).tasks.toString, undefined);
  });
}

test("a stray event naming an Object member changes nothing", () => {
  for (const name of ["constructor", "toString"]) {
    const s = replay([
      { t: "task.updated", at: AT, taskId: name, patch: { status: "working" }, reason: "r" },
      { t: "plan.set", at: AT, goal: name, description: "d", plan: ref },
      { t: "job.finished", at: AT, jobId: name, outcome },
    ]);
    assert.deepEqual(plain(s), { goals: {}, tasks: {}, jobs: {} });
  }
  for (const k of ["description", "plan", "outcome", "status"]) assert.equal(Object.hasOwn(Object, k), false, k);
});

test("appendEvent writes a mode 0600 line that loadState replays", () => {
  tempHome();
  appendEvent("p", { t: "goal.started", at: AT, goal });
  appendEvent("p", { t: "task.created", at: AT, task: task("a") });
  assert.equal(statSync(ledgerPath("p")).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(loadState("p").tasks), ["a"]);
  assert.equal(loadState("p").goals["feat/x"].branch, "feat/x");
});

test("appendEvent clamps outcome detail and reason to one line of 300 characters", () => {
  tempHome();
  const long = `line one\n${"x".repeat(500)}`;
  appendEvent("p", { t: "job.finished", at: AT, jobId: "j1", outcome: { ...outcome, detail: long } });
  appendEvent("p", { t: "task.updated", at: AT, taskId: "a", patch: {}, reason: long });
  const [fin, upd] = readEvents("p").items;
  const detail = (fin as Extract<LedgerEvent, { t: "job.finished" }>).outcome.detail;
  const reason = (upd as Extract<LedgerEvent, { t: "task.updated" }>).reason;
  for (const s of [detail, reason]) {
    assert.equal(s.length, 300);
    assert.ok(s.startsWith("line one xxx"));
  }
});

test("appendEvent refuses a line over 4096 bytes and writes nothing", () => {
  tempHome();
  const big = task("a", { scope: Array.from({ length: 200 }, (_, i) => `src/some/long/path/${i}.ts`) });
  assert.throws(() => appendEvent("p", { t: "task.created", at: AT, task: big }), /exceeds 4096/);
  assert.equal(ledgerSize("p"), 0);
});

test("readEvents returns items after the cursor and the end byte", () => {
  tempHome();
  appendEvent("p", { t: "goal.started", at: AT, goal });
  const first = readEvents("p");
  assert.equal(first.items.length, 1);
  assert.equal(first.endByte, ledgerSize("p"));
  appendEvent("p", { t: "task.created", at: AT, task: task("a") });
  const next = readEvents("p", first.endByte);
  assert.deepEqual(next.items.map((e) => e.t), ["task.created"]);
  assert.equal(next.endByte, ledgerSize("p"));
  assert.deepEqual(readEvents("p", next.endByte), { items: [], endByte: next.endByte });
});

test("readEvents leaves a partial last line for the next read", () => {
  tempHome();
  appendEvent("p", { t: "goal.started", at: AT, goal });
  const whole = ledgerSize("p");
  appendFileSync(ledgerPath("p"), '{"t":"task.cre');
  const r = readEvents("p");
  assert.equal(r.items.length, 1);
  assert.equal(r.endByte, whole);
});

test("ledgerSize is the byte length of the ledger", () => {
  tempHome();
  appendEvent("p", { t: "goal.started", at: AT, goal });
  assert.equal(ledgerSize("p"), statSync(ledgerPath("p")).size);
  assert.equal(ledgerSize("other"), 0);
});

test("now is an ISO timestamp", () => {
  assert.match(now(), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test("tool.exhausted sets its key", () => {
  assert.deepEqual(replayTools([exhausted("codex", 2000, "quota")]), { codex: { resetsAt: 2000, detail: "quota" } });
  assert.deepEqual(replayTools([exhausted("codex", 2000, "a"), exhausted("codex", 3000, "b")]), { codex: { resetsAt: 3000, detail: "b" } });
  assert.deepEqual(Object.keys(replayTools([exhausted("codex:m1", 2000), exhausted("codex", 2000)])), ["codex:m1", "codex"]);
});

test("tool.ready deletes the tool key and every <tool>: key", () => {
  const s = replayTools([
    exhausted("codex", 2000), exhausted("codex:m1", 2000), exhausted("zcode", 2000), exhausted("zcode:m2", 2000), exhausted("codexx", 2000),
    { t: "tool.ready", at: AT, tool: "codex" },
  ]);
  assert.deepEqual(Object.keys(s).sort(), ["codexx", "zcode", "zcode:m2"]);
});

test("loadToolState leaves out keys that reset before nowSec", () => {
  const evs = [exhausted("codex", 999), exhausted("zcode", 1000), exhausted("agy", 1001), exhausted("codex:m", null)];
  assert.deepEqual(Object.keys(replayTools(evs, 1000)).sort(), ["agy", "codex:m", "zcode"]);
});

test("a null resetsAt never expires", () => {
  assert.deepEqual(replayTools([exhausted("codex", null, "unknown")], 9e12), { codex: { resetsAt: null, detail: "unknown" } });
});

test("appendToolEvent clamps detail and writes to tools.jsonl under the home", () => {
  const home = tempHome();
  appendToolEvent(exhausted("codex", 2000, `a\n${"y".repeat(500)}`));
  appendToolEvent({ t: "tool.ready", at: AT, tool: "zcode" });
  const path = join(home, "tools.jsonl");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const [ex] = readJsonl<ToolEvent>(path).items as Extract<ToolEvent, { t: "tool.exhausted" }>[];
  assert.equal(ex.detail.length, 300);
  assert.ok(ex.detail.startsWith("a yyy"));
  assert.deepEqual(loadToolState(0), { codex: { resetsAt: 2000, detail: ex.detail } });
});

test("loadToolState with no tools ledger is empty", () => {
  tempHome();
  assert.deepEqual(loadToolState(0), {});
});

test("listProjects lists project dirs", () => {
  const home = tempHome();
  assert.deepEqual(listProjects(), []);
  mkdirSync(projectDir("b-1"), { recursive: true });
  mkdirSync(projectDir("a-1"), { recursive: true });
  writeFileSync(join(home, "projects", "stray.txt"), "");
  assert.deepEqual(listProjects(), ["a-1", "b-1"]);
});

function replayTools(events: ToolEvent[], nowSec = 0) {
  tempHome();
  for (const e of events) appendToolEvent(e);
  return loadToolState(nowSec);
}
