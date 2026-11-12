import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ZCODE_BILLING } from "../src/adapters/zcode.ts";
import { saveRoundFile } from "../src/brief.ts";
import type { Candidate, JobRecord, TaskRecord, TaskStatus } from "../src/contracts.ts";
import { foldPath } from "../src/guards.ts";
import { jobDir, processStart, projectDir, projectIdFor, worktreesDir } from "../src/home.ts";
import { namesLeadCommand, sessionStartText, stopDecision } from "../src/hooks.ts";
import { appendEvent, appendToolEvent, ledgerSize, now } from "../src/ledger.ts";
import { writeJsonAtomic } from "../src/store.ts";
import { commandAt, commandIn, toolTrace } from "../src/toolname.ts";
import { temp, readFakeLog, tempHome, tempRepo, writeZcodeConfig } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const LAUNCHER = join(ROOT, "bin", "mandor");
const CLI = join(ROOT, "src", "cli.ts");
const NODE_ARGS = ["--disable-warning=ExperimentalWarning"];
const HOOKS = ["session-start", "stop"];
const GOAL = "feat/hooks";
const LUNA: Candidate = { tool: "codex", model: "gpt-6-luna", effort: "medium" };
const BLOCK = { decision: "block", reason: "Jobs are still running or waiting to start. Run mandor wait in the background before stopping." };
const LONG_AGO = "Thu Jan  1 00:00:00 1970";

interface Run { status: number | null; stdout: string; stderr: string; ms: number }

function run(command: string, args: string[], input: string, env: NodeJS.ProcessEnv = process.env): Run {
  const started = performance.now();
  const r = spawnSync(command, args, { input, encoding: "utf8", env, timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - started };
}

// Through the launcher, as hooks.json runs it. The test's own cwd is another directory, so a hook that used its
// process cwd rather than the input's would not find the project.
const hook = (name: string, input: unknown, env?: NodeJS.ProcessEnv) => run(LAUNCHER, ["hook", name], JSON.stringify(input), env);
// The CLI without the launcher's node gate, as it runs when a usable node is on the PATH.
const direct = (name: string, input: unknown, env?: NodeJS.ProcessEnv) => run(process.execPath, [...NODE_ARGS, CLI, "hook", name], JSON.stringify(input), env);

function silent(r: Run, what?: string): void {
  assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: "", stderr: "" }, what);
}

function blocks(r: Run, what?: string): void {
  assert.deepEqual({ status: r.status, stderr: r.stderr }, { status: 0, stderr: "" }, what);
  assert.deepEqual(JSON.parse(r.stdout), BLOCK, what);
}

const logPath = (home: string) => join(home, "logs", "hooks.log");
const hookLog = (home: string) => (existsSync(logPath(home)) ? readFileSync(logPath(home), "utf8").split("\n").filter(Boolean) : []);

const plainDir = () => temp("mandor-plain-");

// The directory and everything under it with sizes and modification times, to show that nothing was written there.
// A directory's time also shows a file made and removed in it, such as a lock taken and released.
const snapshot = (dir: string) => ["", ...readdirSync(dir, { recursive: true, encoding: "utf8" }).sort()].map((f) => {
  const s = statSync(join(dir, f));
  return `${f} ${s.size} ${s.mtimeMs}`;
});

// The ledger's bytes and every job.json: what a reconcile, a completion or a pump would change.
function records(s: { home: string; id: string }) {
  const jobs = join(s.home, "jobs");
  return {
    ledger: readFileSync(join(projectDir(s.id), "ledger.jsonl"), "utf8"),
    jobs: (existsSync(jobs) ? readdirSync(jobs) : []).map((id) => readFileSync(join(jobs, id, "job.json"), "utf8")),
  };
}

async function until(ok: () => boolean, ms = 20_000): Promise<boolean> {
  for (const end = Date.now() + ms; !ok(); await sleep(50)) if (Date.now() > end) return false;
  return true;
}

// The fastest of a few runs: other test files load the machine meanwhile, and only the hook's own cost counts.
function fastest(once: () => Run, limit: number): Run {
  let best = once();
  for (let tries = 1; tries < 10 && best.ms >= limit; tries++) {
    const r = once();
    if (r.ms < best.ms) best = r;
  }
  return best;
}

function project() {
  const home = tempHome({ config: true });
  const repo = tempRepo();
  const id = projectIdFor(repo);
  appendEvent(id, { t: "goal.started", at: now(), goal: { branch: GOAL, from: "0".repeat(40), integrationWorktree: "/nowhere", createdAt: now() } });
  return { home, repo, id };
}

let jobs = 0;

// A job the ledger started and never finished; the running pid is this test process, which is alive.
function addJob(id: string, over: Partial<JobRecord> = {}): string {
  const jobId = `j-20261108000000-${(jobs++).toString(16).padStart(4, "0")}`;
  appendEvent(id, { t: "job.started", at: now(), job: { id: jobId, taskId: "t", seq: 1, kind: "start", candidate: LUNA } });
  writeJsonAtomic(join(jobDir(jobId), "job.json"), {
    id: jobId, projectId: id, taskId: "t", seq: 1, kind: "start", candidate: LUNA, worktree: "/nowhere", sessionId: null, promptPath: "/nowhere",
    timeoutMs: 60_000, bin: "/usr/bin/false", env: {}, queuedAt: now(), status: "running", runnerPid: process.pid, runnerStart: processStart(process.pid),
    workerPid: null, startedAt: null, endedAt: null, ...over,
  } satisfies JobRecord);
  return jobId;
}

// The file Claude Code keeps for a session: the lead's commands appear in it as Bash tool calls.
function transcript(command: string): string {
  const p = join(plainDir(), "session.jsonl");
  writeFileSync(p, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } })}\n`);
  return p;
}

// A running job, no waiter, a lead's transcript, no stop_hook_active: the one case that blocks. Each "allows" test
// starts here and changes one condition, so it proves that condition.
function armed() {
  const s = project();
  addJob(s.id);
  const input = { cwd: s.repo, session_id: "s", hook_event_name: "Stop", transcript_path: transcript("mandor dispatch --goal feat/hooks --task a --tier light --brief b.md") };
  blocks(hook("stop", input), "armed");
  return { ...s, input };
}

// Armed, with a job beside the live one whose runner died. A hook that reconciled would finish it.
function armedWithDeadRunner() {
  const s = armed();
  addJob(s.id, { runnerPid: spawnSync("/usr/bin/true").pid, runnerStart: LONG_AGO });
  return s;
}

function taskRecord(slug: string, status: TaskStatus, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: slug, goalBranch: GOAL, tier: "light", after: null, status, stallReason: null, pending: null, base: null, worktree: null, branch: `wip/${slug}`,
    scope: [], seq: 1, fixRounds: 0, candidate: LUNA, sessionId: null, use: null, jobIds: [], integratedCommit: null, briefPath: "/nowhere", ...over,
  };
}

const finalLines = (cursor: number) => [
  "mandor is active in this project. Run `mandor status` for details. If you are leading this work, load the `mandor:lead` skill, then handle every task above that gives a next action.",
  `After that, if a job is queued or running, or a task waits to start, run \`mandor wait --since ${cursor}\` in the background.`,
];

// Outside a project a hook costs the session nothing, whatever the environment.

test("outside a git repo, in little more than the launcher's own start", () => {
  const home = tempHome();
  const cwd = plainDir();
  const input = { cwd, session_id: "s", source: "startup", transcript_path: transcript("mandor dispatch") };
  // The budget follows the machine through the launcher itself: --version loads the CLI the same way (the shell
  // launcher, node, the module graph) and does no hook work, and under load that cost grows at the same rate as the
  // hook's, where a bare node start grows far less. Measured: the hook costs 1.2 to 1.3 of --version, unloaded and
  // loaded alike. Real work outside a project (a catalog load that runs codex, a reconcile) costs a process or more.
  for (const name of HOOKS) {
    // The two are timed in turn, so the fastest run of each comes from the same stretch of time: a budget taken in a
    // quiet moment would fail a hook timed while other test files load the machine. Five rounds at least, so the
    // budget never rests on one slow start of the launcher.
    let base = Infinity;
    let budget = Infinity;
    let best = hook(name, input);
    for (let rounds = 0; rounds < 20 && (rounds < 5 || best.ms >= budget); rounds++) {
      base = Math.min(base, run(LAUNCHER, ["--version"], "").ms);
      budget = 1.5 * base + 40;
      const r = hook(name, input);
      if (r.ms < best.ms) best = r;
    }
    silent(best, name);
    assert.ok(best.ms < budget, `${name} took ${Math.round(best.ms)} ms at best, over the budget of ${Math.round(budget)} ms (--version: ${Math.round(base)} ms)`);
  }
  assert.deepEqual(readdirSync(home), [], "it creates nothing and logs nothing");
});

test("in a repo without a project", async () => {
  const home = tempHome({ config: true });
  const repo = tempRepo();
  const id = projectIdFor(repo);
  // What a session runs first. They make a project directory, and no ledger.
  for (const args of [["scratch"], ["status"]]) spawnSync(LAUNCHER, args, { cwd: repo });
  assert.ok(existsSync(projectDir(id)));
  assert.equal(existsSync(join(projectDir(id), "ledger.jsonl")), false);
  const before = snapshot(home);
  const calls = readFakeLog().length;
  for (const name of HOOKS) silent(hook(name, { cwd: repo, transcript_path: transcript("mandor dispatch") }), name);
  await sleep(1000); // a refresh started by mistake would have reached the fake by now
  assert.equal(readFakeLog().length, calls);
  assert.deepEqual(snapshot(home), before, "it creates nothing and logs nothing");
});

test("with PATH=/usr/bin:/bin", () => {
  const home = tempHome();
  const repo = tempRepo();
  const env = { ...process.env, PATH: "/usr/bin:/bin" };
  for (const cwd of [plainDir(), repo]) {
    for (const name of HOOKS) {
      silent(hook(name, { cwd }, env), `launcher ${name} in ${cwd}`);
      silent(direct(name, { cwd }, env), `cli ${name} in ${cwd}`);
      // No git to find: nothing says this is a repository.
      silent(direct(name, { cwd }, { ...process.env, PATH: "/nonexistent" }), `cli ${name} in ${cwd} without git`);
    }
  }
  assert.deepEqual(readdirSync(home), [], "it creates nothing and logs nothing");
});

test("with a corrupt ledger line", () => {
  const s = project();
  addJob(s.id); // a blocking stop, but for the corruption
  const input = { cwd: s.repo, transcript_path: transcript("mandor dispatch") };
  appendFileSync(join(projectDir(s.id), "ledger.jsonl"), "{not json\n");
  for (const name of HOOKS) silent(hook(name, input), name);
  const log = hookLog(s.home);
  assert.equal(log.length, 2, log.join("\n"));
  assert.match(log[0], /hook session-start: .*unparsable line at byte/);
  assert.match(log[1], /hook stop: .*unparsable line at byte/);
  assert.equal(statSync(logPath(s.home)).mode & 0o777, 0o600);
  assert.equal(statSync(join(s.home, "logs")).mode & 0o777, 0o700);
});

test("a last line still being written is no corruption, and the cursor stops before it", () => {
  const s = project();
  const complete = ledgerSize(s.id);
  appendFileSync(join(projectDir(s.id), "ledger.jsonl"), '{"t":"task.created"');
  const r = hook("session-start", { cwd: s.repo });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split("\n").slice(-2), finalLines(complete));
  assert.deepEqual(hookLog(s.home), []);
});

test("any bad argument or input exits 0 silently and is logged", () => {
  const home = tempHome();
  const cases: [string[], string][] = [
    [[], "{}"],
    [["nope"], "{}"],
    [["stop", "extra"], "{}"],
    [["__proto__"], "{}"],
    ...HOOKS.flatMap((name): [string[], string][] => ["not json", "", "null", "[]", "{}", '{"cwd":5}'].map((input) => [[name], input])),
  ];
  for (const [args, input] of cases) {
    const before = hookLog(home).length;
    silent(run(LAUNCHER, ["hook", ...args], input), `hook ${args.join(" ")} < ${input}`);
    assert.equal(hookLog(home).length, before + 1, `hook ${args.join(" ")} < ${input} is logged`);
  }
});

test("a home that cannot be written stays silent too", () => {
  const home = join(plainDir(), "a-file");
  writeFileSync(home, "");
  const env = { ...process.env, MANDOR_HOME: home };
  for (const name of HOOKS) silent(run(LAUNCHER, ["hook", name], "not json", env), name);
});

test("a cwd that cannot be reached is outside a project: silent, nothing logged, no home made", (t) => {
  const home = join(plainDir(), "absent");
  const env = { ...process.env, MANDOR_HOME: home };
  const locked = plainDir();
  mkdirSync(join(locked, "inner"));
  chmodSync(locked, 0o000);
  t.after(() => chmodSync(locked, 0o700));
  for (const cwd of ["/nonexistent/dir", join(plainDir(), "deleted"), join(locked, "inner"), plainDir()]) {
    for (const name of HOOKS) {
      silent(hook(name, { cwd, transcript_path: transcript("mandor dispatch") }, env), `${name} in ${cwd}`);
      assert.equal(existsSync(home), false, `${name} in ${cwd} makes no home`);
    }
  }
});

test("a handler slower than the stdin deadline exits 0 silently when stdin is a regular file", () => {
  const home = tempHome();
  const dir = plainDir();
  // Node leaves a file stdin open after its last read, so a deadline still running would destroy it there, with no
  // one left to catch the error. A pipe closes at its end, so only a file shows this.
  writeFileSync(join(dir, "git"), "#!/bin/sh\n/bin/sleep 2.5\nexit 128\n", { mode: 0o755 });
  writeFileSync(join(dir, "input.json"), JSON.stringify({ cwd: plainDir() }));
  const stdin = openSync(join(dir, "input.json"), "r");
  const r = spawnSync(LAUNCHER, ["hook", "stop"], { stdio: [stdin, "pipe", "pipe"], encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 30_000 });
  closeSync(stdin);
  silent({ ...r, ms: 0 });
  assert.deepEqual(readdirSync(home), [], "nothing to log");
});

test("a stdin that never closes ends the hook well inside its timeout", { timeout: 15_000 }, async (t) => {
  const home = tempHome();
  const started = performance.now();
  const child = spawn(LAUNCHER, ["hook", "stop"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const code = await new Promise((done) => child.once("close", done));
  assert.equal(code, 0);
  assert.equal(output, "");
  assert.ok(performance.now() - started < 4000, "well inside the 5 s of hooks.json");
  assert.equal(hookLog(home).length, 1);
});

test("the hook path loads no adapter and no sqlite", () => {
  const s = armed();
  const watch = `data:text/javascript,${encodeURIComponent(`
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) { process.stderr.write(specifier + "\\n"); return next(specifier, context); } });
  `)}`;
  for (const name of HOOKS) {
    const r = run(process.execPath, [...NODE_ARGS, "--import", watch, CLI, "hook", name], JSON.stringify(s.input));
    assert.match(r.stderr, /hooks\.ts/, "the watcher sees the hook path");
    assert.doesNotMatch(r.stderr, /adapters|sqlite/);
  }
});

test("hooks.json runs both hooks fail-open, with a 5 s timeout", () => {
  const command = (name: string) => `"\${CLAUDE_PLUGIN_ROOT}/bin/mandor" hook ${name} 2>/dev/null || true`;
  const entry = (name: string) => ({ type: "command", command: command(name), timeout: 5 });
  assert.deepEqual(JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")), {
    hooks: {
      SessionStart: [{ matcher: "startup|resume|clear|compact|fork", hooks: [entry("session-start")] }],
      Stop: [{ hooks: [entry("stop")] }],
    },
  });
  const home = tempHome();
  for (const name of HOOKS) {
    for (const pluginRoot of [ROOT, "/nonexistent"]) {
      silent(run("/bin/sh", ["-c", command(name)], "not json", { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot }), `${name} from ${pluginRoot}`);
    }
  }
  assert.equal(hookLog(home).length, 2, "the working plugin root reached the CLI");
});

// The session-start summary

test("summary under 9000 chars with 200 tasks, including descriptions and the cursor", () => {
  const s = project();
  appendEvent(s.id, { t: "plan.set", at: now(), goal: GOAL, description: "Make the\nhooks quiet", plan: { path: "/plans/hooks.md", sha256: "0".repeat(64), excerpt: "PLAN-EXCERPT" } });
  const active: TaskStatus[] = ["working", "needs-review", "stalled", "waiting", "integrating", "takeover"];
  // The settled tasks come first in the ledger, so listing in ledger order would hide the active ones.
  for (let i = 0; i < 185; i++) appendEvent(s.id, { t: "task.created", at: now(), task: taskRecord(`done-${i}`, i % 2 === 0 ? "accepted" : "cancelled") });
  for (let i = 0; i < 15; i++) appendEvent(s.id, { t: "task.created", at: now(), task: taskRecord(`active-${i}`, active[i % active.length], { seq: 4, fixRounds: 2 }) });
  const cursor = ledgerSize(s.id);
  const r = hook("session-start", { cwd: s.repo });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length < 9000, `${r.stdout.length} chars`);
  const lines = r.stdout.trimEnd().split("\n");
  assert.ok(lines.includes(`- ${GOAL}: Make the hooks quiet; plan /plans/hooks.md; worktree /nowhere`), r.stdout);
  const tasks = lines.filter((l) => /^- (done|active)-/.test(l));
  assert.equal(tasks.length, 30);
  assert.deepEqual(tasks.slice(0, 15).map((l) => l.split(":")[0]), Array.from({ length: 15 }, (_, i) => `- active-${i}`));
  assert.ok(tasks.slice(15).every((l) => l.startsWith("- done-")));
  assert.equal(tasks[0], "- active-0: working, codex:gpt-6-luna@medium, seq 4, fix rounds 2");
  assert.equal(lines[lines.indexOf(tasks[29]) + 1], "+170 more");
  assert.ok(lines.includes(`Cursor: ${cursor}`));
  assert.deepEqual(lines.slice(-2), finalLines(cursor));
  assert.deepEqual(hookLog(s.home), []);
});

test("the summary stays under 9000 chars however long the goals and tasks, and keeps what matters most", () => {
  const s = project();
  // Each line at the ledger's own limits: a description near 4096 bytes, a slug at the file name limit.
  for (let i = 0; i < 40; i++) {
    const branch = `feat/long-${i}`;
    appendEvent(s.id, { t: "goal.started", at: now(), goal: { branch, from: "0".repeat(40), integrationWorktree: "/nowhere", createdAt: now() } });
    appendEvent(s.id, { t: "plan.set", at: now(), goal: branch, description: "d".repeat(3500), plan: { path: `/plans/${"p".repeat(200)}.md`, sha256: "0".repeat(64), excerpt: "" } });
  }
  for (let i = 0; i < 200; i++) appendEvent(s.id, { t: "task.created", at: now(), task: taskRecord(`${i}-${"s".repeat(240)}`, "working") });
  const keys = Array.from({ length: 100 }, (_, i) => `codex:${"m".repeat(40)}-${i}`);
  for (const key of keys) appendToolEvent({ t: "tool.exhausted", at: now(), key, resetsAt: null, detail: "x" });
  // A model list that holds more warnings than fit: the login shell's secret-like names alone can be that many.
  const warned = Array.from({ length: 60 }, (_, i) => `the worker login shell exports secret-like variables that worker commands can read: ${"V".repeat(60)}_${i}`);
  writeJsonAtomic(join(s.home, "models.json"), { fetchedAt: now(), codexVersion: "0.1.0", versions: { codex: "0.1.0" }, problems: {}, warnings: { codex: warned }, models: [] });
  const cursor = ledgerSize(s.id);
  const r = hook("session-start", { cwd: s.repo });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length <= 9000, `${r.stdout.length} chars`);
  const lines = r.stdout.trimEnd().split("\n");
  assert.deepEqual(lines.slice(-2), finalLines(cursor));
  assert.ok(lines.includes(`Cursor: ${cursor}`));
  assert.ok(lines.some((l) => l.startsWith("- feat/long-39: ")), "the newest goal is listed");
  assert.ok(lines.some((l) => l.startsWith("- 0-")), "tasks still have room");
  const exhausted = lines.find((l) => l.startsWith("Exhausted: codex:")) ?? "";
  const listed = exhausted.slice("Exhausted: ".length).split(", ");
  const unlisted = listed.pop() ?? "";
  assert.match(unlisted, /^\+\d+ more$/, "exhausted keys still have room, and say what they leave out");
  assert.ok(listed.every((key) => keys.includes(key)), `whole keys only: ${exhausted}`);
  assert.equal(listed.length + parseInt(unlisted.slice(1)), 100);
  assert.ok(exhausted.length <= "Exhausted: ".length + 300, `${exhausted.length} chars`);
  const more = lines.filter((l) => /^\+\d+ more$/.test(l)).map((l) => Number(l.slice(1, l.indexOf(" "))));
  assert.equal(more.length, 3, "all three cut lists say so");
  assert.ok(lines.includes("Warnings:") && lines.some((l) => l.startsWith("- the worker login shell exports")), "the warnings have room too");
  assert.equal(lines.filter((l) => l.startsWith("- feat/long-")).length + more[0], 41, "the 40 long goals and the project's first");
  assert.equal(lines.filter((l) => /^- \d+-/.test(l)).length + more[1], 200);
  assert.equal(lines.filter((l) => l.startsWith("- the worker login shell exports")).length + more[2], 60);
});

test("the summary lists exhausted keys, and no detail, excerpt or reason", () => {
  const s = project();
  appendEvent(s.id, { t: "plan.set", at: now(), goal: GOAL, description: "A goal", plan: { path: "/plans/a.md", sha256: "0".repeat(64), excerpt: "SECRET-EXCERPT" } });
  appendEvent(s.id, { t: "task.created", at: now(), task: taskRecord("a", "stalled", { candidate: null }) });
  appendEvent(s.id, { t: "task.updated", at: now(), taskId: "a", patch: {}, reason: "SECRET-REASON" });
  const job = addJob(s.id, { env: { TOKEN: "SECRET-ENV" } });
  appendEvent(s.id, { t: "job.finished", at: now(), jobId: job, outcome: { status: "quota", sessionId: null, detail: "SECRET-OUTCOME", resetsAt: null, exitCode: 1 } });
  writeFileSync(join(jobDir(job), "stderr.log"), "SECRET-STDERR\n");
  appendToolEvent({ t: "tool.exhausted", at: now(), key: "codex", resetsAt: null, detail: "SECRET-TOOL" });
  appendToolEvent({ t: "tool.exhausted", at: now(), key: "codex:gpt-6-luna", resetsAt: null, detail: "SECRET-TOOL" });
  appendToolEvent({ t: "tool.exhausted", at: now(), key: "codex:gpt-past", resetsAt: 1, detail: "SECRET-TOOL" });
  const r = hook("session-start", { cwd: s.repo });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /SECRET|gpt-past/);
  const lines = r.stdout.trimEnd().split("\n");
  assert.ok(lines.includes("Exhausted: codex, codex:gpt-6-luna"), r.stdout);
  assert.ok(lines.includes("- a: stalled, no candidate, seq 1, fix rounds 0"), r.stdout);
});

test("the summary says what a ZCode run may cost whenever ZCode is on, whatever the stored warnings say", () => {
  const s = project();
  writeZcodeConfig(s.home);
  const billing = () => hook("session-start", { cwd: s.repo }).stdout.trimEnd().split("\n").filter((l) => l === `- ${ZCODE_BILLING}`).length;
  assert.equal(billing(), 1, "no model list yet");
  for (const warnings of [{}, { zcode: [] }, { codex: [], zcode: [] }, { zcode: [ZCODE_BILLING] }]) {
    writeJsonAtomic(join(s.home, "models.json"), { fetchedAt: now(), codexVersion: "0.166.0", versions: { codex: "0.166.0" }, problems: {}, models: [], warnings });
    assert.equal(billing(), 1, JSON.stringify(warnings));
  }
  const config = JSON.parse(readFileSync(join(s.home, "config.json"), "utf8"));
  config.tools.zcode.enabled = false;
  writeJsonAtomic(join(s.home, "config.json"), config);
  assert.equal(billing(), 0, "a tool that is off says nothing");
});

test("the summary lists what the enabled tools warned of when their models were last read, and reads nothing else for it", () => {
  const s = project();
  const text = () => hook("session-start", { cwd: s.repo }).stdout;
  assert.doesNotMatch(text(), /Warnings:/, "no model list, nothing to say");
  const codex = ["codex has no per-run switch to keep workers off workspace credits", "codex 0.1.0 is not the tested version 0.166.0"];
  writeJsonAtomic(join(s.home, "models.json"), {
    fetchedAt: now(), codexVersion: "0.1.0", versions: { codex: "0.1.0" }, problems: { codex: "codex debug models failed: LEAKED-TEXT" }, models: [],
    warnings: { codex, agy: ["agy is on: Google's terms for consumer plans do not cover driving the Antigravity CLI from another tool"] },
  });
  const lines = text().trimEnd().split("\n");
  const at = lines.indexOf("Warnings:");
  assert.deepEqual(lines.slice(at, at + 3), ["Warnings:", `- ${codex[0]}`, `- ${codex[1]}`], "only codex is enabled, so agy has none to say");
  assert.equal(lines[at + 3], `Cursor: ${ledgerSize(s.id)}`);
  assert.doesNotMatch(text(), /LEAKED-TEXT/, "the text of a failed listing is for models to print, not for a summary");
  assert.deepEqual(hookLog(s.home), []);
});

test("the summary gives a task that needs the lead its stall reason and next action, integrating and takeover included", () => {
  const s = project();
  const add = (slug: string, status: TaskStatus, over: Partial<TaskRecord> = {}) => appendEvent(s.id, { t: "task.created", at: now(), task: taskRecord(slug, status, over) });
  add("busy", "working");
  add("reviewing", "needs-review");
  add("asking", "needs-review");
  saveRoundFile(s.id, "asking", 1, "report.json", JSON.stringify({
    status: "blocked", summary: "Stuck.", files_changed: [], commands_run: [], tests: { ran: false, passed: 0, failed: 0, notes: "" },
    open_issues: [], questions_for_lead: ["Which port?"],
  }));
  add("limit", "stalled", { stallReason: "quota" });
  add("spent", "stalled", { stallReason: "all-exhausted" });
  add("rounds", "stalled", { stallReason: "fix-rounds-exceeded" });
  add("broken", "stalled", { stallReason: "rebase-failed" });
  add("merging", "integrating");
  add("hands-on", "takeover");
  add("done", "accepted");
  const r = hook("session-start", { cwd: s.repo });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  const line = (slug: string) => lines.find((l) => l.startsWith(`- ${slug}:`));
  const tail = ", codex:gpt-6-luna@medium, seq 1, fix rounds 0";
  assert.equal(line("busy"), `- busy: working${tail}`);
  assert.equal(line("reviewing"), `- reviewing: needs-review${tail}; next: review`);
  assert.equal(line("asking"), `- asking: needs-review${tail}; next: answer`);
  assert.equal(line("limit"), `- limit: stalled (quota)${tail}; next: reassign-or-ready`);
  assert.equal(line("spent"), `- spent: stalled (all-exhausted)${tail}; next: offer-takeover`);
  assert.equal(line("rounds"), `- rounds: stalled (fix-rounds-exceeded)${tail}; next: fix-rounds-exceeded`);
  assert.equal(line("broken"), `- broken: stalled (rebase-failed)${tail}; next: inspect`);
  assert.equal(line("merging"), `- merging: integrating${tail}; next: confirm or drop`);
  assert.equal(line("hands-on"), `- hands-on: takeover${tail}; next: finish the takeover, then accept`);
  assert.equal(line("done"), `- done: accepted${tail}`);
  assert.deepEqual(lines.slice(-2), finalLines(ledgerSize(s.id)));
});

test("a goal with no plan yet is listed, and a cut description never splits a character", () => {
  const s = project();
  const r = hook("session-start", { cwd: s.repo });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trimEnd().split("\n").includes(`- ${GOAL}: no description; plan none; worktree /nowhere`), r.stdout);
  const emoji = String.fromCodePoint(0x1f600);
  appendEvent(s.id, { t: "plan.set", at: now(), goal: GOAL, description: `${"x".repeat(299)}${emoji}`, plan: { path: "/p.md", sha256: "0".repeat(64), excerpt: "" } });
  const cut = hook("session-start", { cwd: s.repo });
  assert.ok(cut.stdout.includes(`- ${GOAL}: ${"x".repeat(299)}; plan /p.md`), cut.stdout);
});

test("a real goal start arms the hooks, in the checkout and in its worktree", () => {
  const home = tempHome({ config: true });
  const repo = tempRepo();
  const id = projectIdFor(repo);
  for (const name of HOOKS) silent(hook(name, { cwd: repo }), `${name} before the goal`);
  const cli = (...args: string[]) => {
    const r = spawnSync(LAUNCHER, args, { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const { goal } = cli("goal", "start", GOAL);
  const plan = join(cli("scratch").dir, "plan.md");
  writeFileSync(plan, "1. Hook.\n");
  cli("plan", "set", "--goal", GOAL, "--file", plan, "--description", "Make the hooks quiet");
  for (const cwd of [repo, goal.integrationWorktree]) {
    const r = hook("session-start", { cwd });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`- ${GOAL}: Make the hooks quiet; plan ${join(projectDir(id), "goals", "feat__hooks", "plan.md")}; worktree ${goal.integrationWorktree}\n`), r.stdout);
    assert.deepEqual(r.stdout.trimEnd().split("\n").slice(-2), finalLines(ledgerSize(id)));
  }
  assert.deepEqual(hookLog(home), []);
});

test("a cwd in the mandor worktrees resolves through the recorded root, never its .git", () => {
  const s = project();
  writeFileSync(join(projectDir(s.id), "root"), `${s.repo}\n`);
  const cwd = join(worktreesDir(s.id), "task-a");
  mkdirSync(cwd, { recursive: true });
  // A worker can rewrite this. Discovery through it would find the other repository, which has no project.
  writeFileSync(join(cwd, ".git"), `gitdir: ${join(tempRepo(), ".git")}\n`);
  const r = hook("session-start", { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`- ${GOAL}: `), r.stdout);
});

test("inside a project, session-start returns within 500 ms and models.json refreshes within 5 s", async () => {
  const s = project();
  const cache = join(s.home, "models.json");
  writeJsonAtomic(cache, { fetchedAt: "2020-01-01T00:00:00.000Z", codexVersion: "0.0.0", models: [] });
  // A refresh longer than the limit, so a hook that waited for it, or shared its stdout, could not pass. Its parent
  // is the refresh, whose directory and process group it records.
  const dir = plainDir();
  const slow = join(dir, "slow-codex");
  writeFileSync(slow, `#!/bin/sh\n/bin/pwd > "${dir}/cwd"\n/bin/ps -o pid=,pgid= -p $PPID > "${dir}/group"\n/bin/sleep 0.6\nexec "${process.env.MANDOR_CODEX_BIN}" "$@"\n`, { mode: 0o755 });
  process.env.MANDOR_CODEX_BIN = slow;
  const best = fastest(() => hook("session-start", { cwd: s.repo }), 500);
  assert.equal(best.status, 0, best.stderr);
  assert.ok(best.stdout.includes(`- ${GOAL}: `), best.stdout);
  assert.deepEqual(best.stdout.trimEnd().split("\n").slice(-2), finalLines(ledgerSize(s.id)));
  assert.ok(best.ms < 500, `session-start took ${Math.round(best.ms)} ms at best`);
  assert.ok(await until(() => JSON.parse(readFileSync(cache, "utf8")).models.length > 0, 5000), "the refresh outlives the hook");
  assert.equal(readFileSync(join(dir, "cwd"), "utf8"), "/\n", "away from the session's directory");
  const [pid, group] = readFileSync(join(dir, "group"), "utf8").trim().split(/\s+/);
  assert.equal(pid, group, "detached, in a process group of its own");
  assert.deepEqual(hookLog(s.home), []);
});

// The Stop guard

test("stop blocks the lead with a running job and no waiter", () => {
  const s = armed();
  const r = hook("stop", s.input);
  assert.equal(r.stdout, `${JSON.stringify(BLOCK)}\n`);
  blocks(hook("stop", { ...s.input, stop_hook_active: false }), "stop_hook_active false is not set");
  assert.deepEqual(hookLog(s.home), []);
});

test("stop blocks the lead with a queued job younger than 60 s", () => {
  const s = project();
  addJob(s.id, { status: "queued", runnerPid: null, runnerStart: null, queuedAt: new Date(Date.now() - 50_000).toISOString() });
  blocks(hook("stop", { cwd: s.repo, transcript_path: transcript("mandor verdict a accept") }));
});

test("stop allows when a live waiter exists", async (t) => {
  const s = armed();
  // A real wait, so this reads the heartbeat wait really writes.
  const waiter = spawn(LAUNCHER, ["wait", "--since", String(ledgerSize(s.id))], { cwd: s.repo, stdio: "ignore" });
  t.after(() => waiter.kill("SIGKILL"));
  const waiters = join(projectDir(s.id), "waiters");
  assert.ok(await until(() => existsSync(join(waiters, `${waiter.pid}-1.json`))), "the wait writes its heartbeat");
  silent(hook("stop", s.input));
  const ended = new Promise((done) => waiter.once("exit", done));
  waiter.kill("SIGTERM");
  await ended;
  blocks(hook("stop", s.input), "the waiter is gone");
});

test("a heartbeat of a dead or recycled waiter, or one that does not parse, is no live waiter", () => {
  const s = armed();
  const dead = spawnSync("/usr/bin/true").pid;
  const beats: [string, string][] = [
    [`${dead}-1.json`, JSON.stringify({ pid: dead, start: LONG_AGO })],
    [`${dead}-2.json`, JSON.stringify({ pid: dead, start: null })],
    [`${process.pid}-1.json`, JSON.stringify({ pid: process.pid, start: LONG_AGO })],
    ["garbled-1.json", "{not json"],
    ["garbled-2.json", "null"],
    ["garbled-3.json", JSON.stringify({ pid: String(process.pid), start: null })],
    ["garbled-4.json", JSON.stringify({ pid: 0, start: null })],
    ["garbled-5.json", JSON.stringify({ pid: -1, start: null })],
    [`${dead}-3.json.${dead}.tmp`, '{"pid":'],
  ];
  mkdirSync(join(projectDir(s.id), "waiters"));
  for (const [name, body] of beats) writeFileSync(join(projectDir(s.id), "waiters", name), body);
  blocks(hook("stop", s.input));
  assert.deepEqual(hookLog(s.home), [], "stale heartbeats are no error");
  writeJsonAtomic(join(projectDir(s.id), "waiters", `${process.pid}-2.json`), { pid: process.pid, start: processStart(process.pid) });
  silent(hook("stop", s.input), "one live heartbeat among them");
});

test("stop allows a non-lead transcript", () => {
  const s = armed();
  silent(hook("stop", { ...s.input, transcript_path: transcript("git status") }));
  silent(hook("stop", { cwd: s.repo }), "no transcript at all");
  // What the hooks themselves put into every session of this project must not make it a lead's. A description is free
  // text, and its whitespace collapses on the way into the summary. The bare name is an ordinary word and stays, also
  // before a word that only starts like a lead's command.
  const description = "Run mandor\n  dispatch now, then MANDOR verdict; a mandor confirmation step and commandor dispatch";
  appendEvent(s.id, { t: "plan.set", at: now(), goal: GOAL, description, plan: { path: "/plans/a.md", sha256: "0".repeat(64), excerpt: "" } });
  const summary = hook("session-start", { cwd: s.repo }).stdout;
  assert.ok(summary.includes("mandor wait"));
  const own = join(plainDir(), "session.jsonl");
  writeFileSync(own, `${JSON.stringify({ context: summary, reason: BLOCK.reason })}\n`);
  silent(hook("stop", { ...s.input, transcript_path: own }));
  assert.ok(summary.includes(`- ${GOAL}: Run the tool now, then the tool; a mandor confirmation step and commandor dispatch; plan /plans/a.md; worktree /nowhere\n`), summary);
  assert.deepEqual(hookLog(s.home), []);
});

// What the stop guard reads as a lead's command is the command form of a trace, so a description, once its traces
// are replaced, never reads as one; and only the true commands are replaced.
test("no goal description makes the summary read as a lead's transcript, and its bare name stays", () => {
  const s = armed();
  const [nbsp, zw] = [0xa0, 0x200b].map((c) => String.fromCharCode(c));
  const shapes: [string, string][] = [
    ["mandor dispatch", "the tool"], ["Mandor Dispatch", "the tool"], ["mandor\n  verdict", "the tool"], [`mandor${nbsp}drop`, "the tool"],
    [`man${zw}dor reassign`, "the tool"], ["bin/mandor cancel x", "bin/the tool x"],
    ...["pre-mandor dispatch", "commandor dispatch", "a mandor confirmation step", "mandor dropdown", "mandor cancelled", "mandor_ready"]
      .map((d): [string, string] => [d, d]),
    // Key-value and list data: a command word before a separator, on one line or on two lines joined by the summary.
    ...["  jabatan: mandor\n  status: aktif", "foreman: Mandor\nreview: Tinjau", 'jabatan = "mandor"\nstatus = "aktif"', 'ROLE="mandor"\nstatus="ok"',
      '3,"Budi","mandor"\n"project","Alpha"', 'const s = "Jabatan: mandor\\nStatus: aktif";', "Mandor Status: aktif", '"Mandor Status": "Status Mandor",']
      .map((d): [string, string] => [d, d.replace(/\s+/g, " ").trim()]),
    // Commands as they are mentioned, before a comma or after a backtick; the summary joins two lines into one text,
    // where a bare comma no longer ends a command word.
    ["Run `mandor status`, then read the output.", "Run `the tool`, then read the output."], ["First run `mandor init`: it creates the home.", "First run `the tool`: it creates the home."],
    ["- `mandor wait`: returns when a task needs the lead", "- `the tool`: returns when a task needs the lead"],
    ['subprocess.run("mandor wait", shell=True)', 'subprocess.run("the tool", shell=True)'], ['execSync("mandor status", { stdio: "inherit" })', 'execSync("the tool", { stdio: "inherit" })'],
    ['"lead:status": "mandor status",', '"lead:status": "the tool",'], ['{"cmd": "mandor dispatch", "args": []}', '{"cmd": "the tool", "args": []}'],
    ["mandor drop, x", "the tool, x"], ["3,Budi,mandor\nproject,Alpha,x", "3,Budi,the tool,Alpha,x"],
    // The tool's variables in upper case only, as the guards read them.
    ["set mandor_home = x and MANDOR_HOME", "set mandor_home = x and the tool"],
  ];
  for (const [description, shown] of shapes) {
    appendEvent(s.id, { t: "plan.set", at: now(), goal: GOAL, description, plan: { path: "/plans/a.md", sha256: "0".repeat(64), excerpt: "" } });
    const summary = sessionStartText({ cwd: s.repo });
    assert.ok(summary.includes(`- ${GOAL}: ${shown}; plan /plans/a.md; worktree /nowhere\n`), JSON.stringify(description));
    const own = join(plainDir(), "session.jsonl");
    writeFileSync(own, `${JSON.stringify({ type: "attachment", content: summary })}\n`);
    assert.equal(stopDecision({ cwd: s.repo, transcript_path: own }), null, JSON.stringify(description));
  }
});

test("a lead's command marks a transcript only as a whole word, on any line of a command", () => {
  const s = armed();
  const decide = (command: string) => stopDecision({ cwd: s.repo, transcript_path: transcript(command) });
  // A line break inside a command is written into the transcript as the two characters \n.
  for (const command of ["mandor dispatch --goal x", "mandor verdict add accept", "./bin/mandor cancel add", "mandor confirm add",
    "cd /repo\nmandor dispatch --goal x", "Mandor Ready codex"]) {
    assert.deepEqual(decide(command), BLOCK, command);
  }
  for (const command of ["a mandor confirmation step", "commandor dispatch", "mandor dropdown", "mandor cancelled", "pre-mandor drop x",
    "./bin/mandor wait --since 5"]) {
    assert.equal(decide(command), null, command);
  }
});

// The stop guard reads the transcript decoded from JSON with the rule the guards use for a command, so on these shapes
// it finds a lead's command where the trace rule does. Not on every shape: the guards' fold also turns a Unicode
// hyphen into an ASCII one and the stop guard's reading does not, so after a command word one ends the word for the
// stop guard and not for the trace rule. That only makes the stop guard arm more, and a summary, whose descriptions
// have every trace replaced by the stop guard's own reading, never holds a command.
test("the stop guard and the trace rule agree on these shapes, and no description makes the summary read as a lead's", () => {
  const s = armed();
  const lead = ["dispatch", "verdict", "drop", "reassign", "ready", "confirm", "cancel"];
  const leadTrace = (d: string) => {
    const t = toolTrace(foldPath(d));
    return t !== null && lead.some((c) => t.endsWith(c));
  };
  const shapes: [string, boolean][] = [
    // A literal backslash escape before the name, as written in a description, with a fullwidth backslash too.
    ["Parse C:\\nmandor dispatch flags", true], ["fix \\tmandor ready", true], ["a \\rmandor cancel b", true],
    ["fix \uff3cnmandor confirm", true],
    // A Bash call over several lines, a heredoc, and quoted, escaped or control-character forms.
    ["cd /repo\nmandor dispatch --goal x", true], ["cat > run.sh <<'EOF'\nmandor dispatch --goal x\nEOF", true],
    ['echo \\"mandor dispatch\\"', true], ["C:\\\\mandor dispatch", true], ["\\nmandor cancel a", true],
    ['"/opt/x/bin/mandor" dispatch --goal x', true], ["`mandor` drop a", false], ["say \u0007mandor dispatch", true],
    ['mandor "dispatch" --goal x', true], ['mandor "status": 1', false],
    // An escaped closing quote, which the transcript writes as an escaped backslash and an escaped quote.
    ['sh -c "/opt/x/bin/mandor\\" dispatch --goal x"', true], ['sh -c "mandor\\" dispatch --goal x"', false],
    ['"${CLAUDE_PLUGIN_ROOT}/bin/mandor" hook session-start', false],
    // The bare name next to a word that only starts like a command, or glued to another word.
    ["a mandor confirmation step", false], ["mandor dropdown", false], ["commandor dispatch", false], ["pre-mandor dispatch", false],
    ["mandor cancelled", false],
  ];
  for (const [d, isLead] of shapes) {
    const what = JSON.stringify(d);
    assert.equal(leadTrace(d), isLead, `trace rule: ${what}`);
    assert.deepEqual(stopDecision({ cwd: s.repo, transcript_path: transcript(d) }), isLead ? BLOCK : null, `stop guard: ${what}`);
    appendEvent(s.id, { t: "plan.set", at: now(), goal: GOAL, description: d, plan: { path: "/plans/a.md", sha256: "0".repeat(64), excerpt: "" } });
    const own = join(plainDir(), "session.jsonl");
    writeFileSync(own, `${JSON.stringify({ type: "attachment", content: sessionStartText({ cwd: s.repo }) })}\n`);
    assert.equal(stopDecision({ cwd: s.repo, transcript_path: own }), null, `summary: ${what}`);
  }
});

// The check decodes only the text around a place where a command may start. An oracle decodes each line whole and
// reads it as a description is; the shapes put escapes, runs of backslashes, invisible characters and long whitespace
// where a window would end, on either side of the name.
test("judging only around the name gives the verdict of the whole decoded line", () => {
  const at = commandAt(["dispatch", "verdict", "drop", "reassign", "ready", "confirm", "cancel"]);
  const readable = (t: string) => t.replace(/[\p{Default_Ignorable_Code_Point}\0]/gu, "").normalize("NFKC");
  const oracle = (line: string) => {
    const text = readable(JSON.parse(line).message.content[0].text);
    return [...text.matchAll(/mandor/gi)].some((m) => at(text, m.index));
  };
  // Raw JSON string content, escapes as written in the transcript.
  const zw = "\u200b";
  const before = ["", "x", " ", "\\n", "\\\\n", "\\\\", '\\"', '\\\\\\"', "\u00e9", "\\u00e9", "\\u0020", "\\u200b", zw, "\\u005c\\u006e",
    ...Array.from({ length: 41 }, (_, r) => `${"\\".repeat(r)}u0020`), ...Array.from({ length: 41 }, (_, r) => `x${"\\".repeat(r)}n`),
    ...[0, 7, 8, 9, 15, 16, 17, 40, 80].flatMap((k) => [`x${zw.repeat(k)}`, `\\\\n${zw.repeat(k)}`, `x${"\\u200b".repeat(k)}`])];
  const after = [" dispatch", "\\ndispatch", " dispatch:", '\\" dispatch', `${zw}dispatch`, ` d${zw}ispatch`, " \uff44ispatch", " dispatch\u0301",
    " confirmation", " dispatch\u2713", "\u00a0dispatch", " \\u0064ispatch", '\\\\\\" dispatch', " dispatch\\u0301",
    // A backslash escape written as text between the name and the command (echo -e "mandor\tdispatch").
    "\\\\ndispatch", "\\\\tdispatch", " \\\\r\\\\n dispatch", "\\\\\\\\ndispatch",
    ...[50, 63, 64, 65, 128, 200].flatMap((k) => [`${" ".repeat(k)}dispatch`, ` dispatch${" ".repeat(k)}:`, ` dispatch${" ".repeat(k)}x`, ` dispatch\\"${" ".repeat(k)}=`]),
    // Runs of escaped whitespace after the command, so a window would end inside an escape before the separator.
    ...[23, 24, 25, 31, 32, 33, 60].flatMap((k) => [` dispatch${"\\n".repeat(k)}:`, ` dispatch${"\\t".repeat(k)}=`, ` dispatch${"\\n".repeat(k)},`,
      ` dispatch${"\\u0020".repeat(k)}:`])];
  let shapes = 0, armed = 0;
  for (let fill = 0; fill <= 20; fill++) {
    for (const b of before) {
      for (const a of after) {
        const line = `{"type":"assistant","message":{"content":[{"type":"text","text":"${"z".repeat(fill)}${b}mandor${a}"}]}}`;
        const expected = oracle(line);
        assert.equal(namesLeadCommand(`${line}\n`), expected, line);
        [shapes, armed] = [shapes + 1, armed + Number(expected)];
      }
    }
  }
  assert.ok(armed > 0 && armed < shapes, `${armed} of ${shapes} arm`);
});

// One native scan finds where a command may start; lines full of escapes and characters beyond Latin-1 are not decoded
// as a whole, so the check stays near a substring scan of the same file. Decoding every line that names the tool, or
// the whole line around each place, takes several times as long.
test("the transcript check costs about what a substring scan of the same file does", () => {
  const wide = (t: string) => [...t].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
  const text = `${wide("a")}\n`.repeat(1000) + "a mandor\u200b confirmation step, " + `${wide("c")}\t`.repeat(1000) + "mandor\u0301 x";
  const line = `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: text }] } })}\n`;
  const path = join(plainDir(), "long.jsonl");
  writeFileSync(path, line.repeat(Math.ceil(8 * 2 ** 20 / line.length)));
  const lead = ["dispatch", "verdict", "drop", "reassign", "ready", "confirm", "cancel"];
  const substring = () => {
    const bytes = readFileSync(path);
    return lead.some((c) => bytes.includes(`mandor ${c}`));
  };
  const time = (f: () => boolean) => {
    const start = performance.now();
    assert.equal(f(), false);
    return performance.now() - start;
  };
  let [old, now] = [Infinity, Infinity];
  for (let k = 0; k < 5; k++) [old, now] = [Math.min(old, time(substring)), Math.min(now, time(() => namesLeadCommand(readFileSync(path, "utf8"))))];
  assert.ok(now < 3 * old, `${now.toFixed(1)} ms against ${old.toFixed(1)} ms`);
});

// Past a few places to judge on one line the check decodes that line once and judges it whole, so a line made of the
// name and an invisible character over and over gives the whole line's verdict at about the cost of one decode.
const craftedLine = (places: number, last: string) =>
  `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "mandor\u200b ".repeat(places - 1) + last }] } })}\n`;

test("a line with a thousand places to judge gives the whole line's verdict", () => {
  const lead = ["dispatch", "verdict", "drop", "reassign", "ready", "confirm", "cancel"];
  const whole = commandIn(lead);
  const readable = (t: string) => t.replace(/[\p{Default_Ignorable_Code_Point}\0]/gu, "").normalize("NFKC");
  for (const [last, arms] of [["mandor dispatch --goal x", true], ["mandor\u200b dispatch --goal x", true], ["mandor dispatch: x", false],
    ["mandor\u200b done", false], ["commandor dispatch", false]] as [string, boolean][]) {
    const line = craftedLine(1000, last);
    assert.equal(whole(readable(JSON.parse(line).message.content[0].content)), arms, last);
    assert.equal(namesLeadCommand(line), arms, last);
  }
});

test("a crafted line costs about one decode of the line, not a window per place", () => {
  const whole = commandIn(["dispatch", "verdict", "drop", "reassign", "ready", "confirm", "cancel"]);
  const readable = (t: string) => t.replace(/[\p{Default_Ignorable_Code_Point}\0]/gu, "").normalize("NFKC");
  const time = (f: () => boolean) => {
    const start = performance.now();
    assert.equal(f(), false);
    return performance.now() - start;
  };
  const best = (line: string) => {
    let [once, check] = [Infinity, Infinity];
    for (let k = 0; k < 5; k++) {
      once = Math.min(once, time(() => whole(readable(JSON.parse(line).message.content[0].content))));
      check = Math.min(check, time(() => namesLeadCommand(line)));
    }
    return [once, check];
  };
  const [once, check] = best(craftedLine(50_000, "done"));
  assert.ok(check < 3 * once, `${check.toFixed(1)} ms against ${once.toFixed(1)} ms for one decode`);
  // Four times the line takes about four times as long.
  const [, longer] = best(craftedLine(200_000, "done"));
  assert.ok(longer < 8 * check, `${longer.toFixed(1)} ms for four times the line against ${check.toFixed(1)} ms`);
});

test("a goal description reaches the summary with each of the tool's forms replaced and the bare name kept", () => {
  const s = project();
  const zw = String.fromCharCode(0x200b);
  const description = `Read ~/.mandor/logs, set MANDOR_HOME, MANDOR_CODEX_BIN and MANDOR_JOB, run bin/mandor wait and man${zw}dor review a, `
    + "open /mandor:status and mandor:lead. Keep foo.mandor, commandor wait, mandor_id, MANDOR_ID, mandor:other and mandor memeriksa laporan.";
  appendEvent(s.id, { t: "plan.set", at: now(), goal: GOAL, description, plan: { path: "/plans/a.md", sha256: "0".repeat(64), excerpt: "" } });
  const summary = sessionStartText({ cwd: s.repo });
  assert.ok(summary.includes(`- ${GOAL}: Read ~/the tool/logs, set the tool, the tool and the tool, run bin/the tool and the tool a, open the tool and the tool. `
    + "Keep foo.mandor, commandor wait, mandor_id, MANDOR_ID, mandor:other and mandor memeriksa laporan.; plan /plans/a.md; worktree /nowhere\n"), summary);
  // Fullwidth forms are unified first, so they are replaced as the forms they stand for.
  const wide = (t: string) => [...t].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
  appendEvent(s.id, { t: "plan.set", at: now(), goal: GOAL, description: `run ${wide("mandor")} ${wide("wait")} and ${wide("~/.mandor")}/x, keep ${wide("mandor")}`, plan: { path: "/plans/a.md", sha256: "0".repeat(64), excerpt: "" } });
  assert.ok(sessionStartText({ cwd: s.repo }).includes(`- ${GOAL}: run the tool and ~/the tool/x, keep mandor; plan /plans/a.md; worktree /nowhere\n`));
});

test("every command that can start or change a job marks a lead's transcript", () => {
  const s = armed();
  for (const command of ["dispatch", "verdict", "drop", "reassign", "ready", "confirm", "cancel"]) {
    blocks(hook("stop", { ...s.input, transcript_path: transcript(`mandor ${command} a`) }), command);
  }
  for (const command of ["status", "show", "logs", "scratch", "wait", "models"]) {
    silent(hook("stop", { ...s.input, transcript_path: transcript(`mandor ${command}`) }), command);
  }
});

test("stop blocks the lead while a task waits with a pending entry and its dependency, if any, is accepted, and not otherwise", () => {
  const s = project();
  const input = { cwd: s.repo, transcript_path: transcript("mandor dispatch --goal feat/hooks --task a --tier light --brief b.md") };
  const add = (slug: string, status: TaskStatus, over: Partial<TaskRecord> = {}) => appendEvent(s.id, { t: "task.created", at: now(), task: taskRecord(slug, status, over) });
  const set = (slug: string, patch: Partial<TaskRecord>) => appendEvent(s.id, { t: "task.updated", at: now(), taskId: slug, patch, reason: "test" });
  const turn = { kind: "start", message: null } as const;
  silent(hook("stop", input), "no task");
  add("held", "waiting", { pending: null });
  silent(hook("stop", input), "a waiting task with no pending entry");
  add("dep", "working");
  add("later", "waiting", { pending: turn, after: "dep" });
  silent(hook("stop", input), "a pending task whose dependency is still open");
  set("dep", { status: "accepted" });
  blocks(hook("stop", input), "its dependency is accepted: the pump starts it");
  set("later", { status: "cancelled", pending: null });
  silent(hook("stop", input), "cancelled");
  add("free", "waiting", { pending: turn });
  blocks(hook("stop", input), "a pending task with no dependency");
  assert.deepEqual(hookLog(s.home), []);
});

test("stop allows when stop_hook_active is set", () => {
  const s = armed();
  silent(hook("stop", { ...s.input, stop_hook_active: true }));
});

test("stop allows when no job is live", () => {
  const dead = spawnSync("/usr/bin/true").pid;
  const notLive: [string, Partial<JobRecord>][] = [
    ["a dead runner", { runnerPid: dead, runnerStart: LONG_AGO }],
    ["a recycled runner pid", { runnerStart: LONG_AGO }],
    ["a queued job past the grace", { status: "queued", runnerPid: null, runnerStart: null, queuedAt: new Date(Date.now() - 61_000).toISOString() }],
    ["a job.json that finished before its ledger event", { status: "done", endedAt: now() }],
  ];
  for (const [what, over] of notLive) {
    const s = project();
    addJob(s.id, over);
    const recorded = records(s);
    silent(hook("stop", { cwd: s.repo, transcript_path: transcript("mandor dispatch") }), what);
    assert.deepEqual(records(s), recorded, `${what} stays for wait and status to reconcile`);
  }
  const s = project();
  const transcriptPath = transcript("mandor dispatch");
  silent(hook("stop", { cwd: s.repo, transcript_path: transcriptPath }), "no job");
  // job.json still says running: the ledger's outcome decides.
  const finished = addJob(s.id);
  appendEvent(s.id, { t: "job.finished", at: now(), jobId: finished, outcome: { status: "done", sessionId: null, detail: "", resetsAt: null, exitCode: 0 } });
  silent(hook("stop", { cwd: s.repo, transcript_path: transcriptPath }), "a finished job");
  // The claim wrote nothing yet: the ledger names a job whose file is not there.
  appendEvent(s.id, { t: "job.started", at: now(), job: { id: "j-20261108000000-ffff", taskId: "t", seq: 2, kind: "start", candidate: LUNA } });
  silent(hook("stop", { cwd: s.repo, transcript_path: transcriptPath }), "no job.json");
  assert.deepEqual(hookLog(s.home), []);
});

test("an unreadable transcript or job.json fails open and is logged", () => {
  const s = armed();
  silent(hook("stop", { ...s.input, transcript_path: join(plainDir(), "gone.jsonl") }), "no such transcript");
  assert.equal(hookLog(s.home).length, 1);
  const other = project();
  const job = addJob(other.id);
  writeFileSync(join(jobDir(job), "job.json"), "{not json");
  silent(hook("stop", { cwd: other.repo, transcript_path: transcript("mandor dispatch") }), "a job.json that does not parse");
  assert.equal(hookLog(other.home).length, 1);
});

// Read-only

test("stop writes nothing anywhere in the home and starts no refresh", async () => {
  const s = armedWithDeadRunner();
  const home = snapshot(s.home);
  const recorded = records(s);
  const calls = readFakeLog().length;
  blocks(hook("stop", s.input));
  await sleep(1000); // a refresh started by mistake would have reached the fake by now
  assert.equal(readFakeLog().length, calls, "no refresh");
  assert.deepEqual(snapshot(s.home), home, "no lock, no event, no other write");
  assert.deepEqual(records(s), recorded);
});

test("session-start writes nothing in the project, and its refresh writes only in the home", async () => {
  const s = armedWithDeadRunner();
  const dir = snapshot(projectDir(s.id));
  const recorded = records(s);
  assert.ok(hook("session-start", { cwd: s.repo }).stdout.includes(`- ${GOAL}: `));
  assert.deepEqual(snapshot(projectDir(s.id)), dir, "no lock, no event, no other write");
  assert.ok(await until(() => existsSync(join(s.home, "models.json")), 5000), "the refresh lands");
  assert.deepEqual(snapshot(projectDir(s.id)), dir);
  assert.deepEqual(records(s), recorded);
});

test("hooks finish quickly while another process holds the project lock, and write nothing to the ledger", async (t) => {
  const s = armedWithDeadRunner();
  const markers = join(plainDir(), "markers");
  const holder = spawn(process.execPath, [...NODE_ARGS, join(ROOT, "test", "procs", "lock.ts"), s.id, markers, "1", "120000", String(Date.now())], { stdio: "ignore" });
  t.after(() => holder.kill("SIGKILL"));
  assert.ok(await until(() => existsSync(markers)), "the other process holds the project lock");
  // Held by this process, which is alive: a hook that wanted the slots lock would wait out its whole deadline.
  writeFileSync(join(s.home, "slots.lock"), JSON.stringify({ pid: process.pid, start: processStart(process.pid) }));
  const recorded = records(s);

  // Stop first: the refresh session-start leaves behind may write in the home at any time.
  const home = snapshot(s.home);
  const stop = hook("stop", s.input);
  blocks(stop);
  assert.ok(stop.ms < 2000, `stop took ${Math.round(stop.ms)} ms`);
  assert.deepEqual(snapshot(s.home), home);

  const dir = snapshot(projectDir(s.id));
  const start = hook("session-start", { cwd: s.repo });
  assert.ok(start.stdout.includes(`- ${GOAL}: `), start.stdout);
  assert.ok(start.ms < 2000, `session-start took ${Math.round(start.ms)} ms`);
  assert.deepEqual(snapshot(projectDir(s.id)), dir);
  assert.deepEqual(records(s), recorded);
  assert.deepEqual(hookLog(s.home), []);
  // The refresh the hook left behind outlives it; this is the file's last test, so wait for it, or it writes its
  // log into a home the exit cleanup has already removed and leaves that home behind.
  assert.ok(await until(() => existsSync(join(s.home, "models.json"))), "the refresh lands before the file ends");
});
