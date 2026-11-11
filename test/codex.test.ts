import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { zstdCompressSync } from "node:zlib";
import { codexWarnings, createCodexAdapter, TESTED_CODEX_VERSION } from "../src/adapters/codex.ts";
import { getAdapter, loadModels, refreshModels } from "../src/adapters/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { JobRecord, JobResult, RawRun } from "../src/contracts.ts";
import { workerEnv } from "../src/home.ts";
import type { Scenario } from "./helpers.ts";
import { temp as tempDir, readFakeLog, tempHome, writeScenarios } from "./helpers.ts";

// node:sqlite warns once per process that it is experimental. Loading it here first, with that
// warning muted, keeps it out of the test output whichever test touches a database first.
const { DatabaseSync } = (() => {
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return process.getBuiltinModule("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
})();

const launcher = join(import.meta.dirname, "..", "bin", "mandor");
const FAKE = join(import.meta.dirname, "fake-bin", "fake-codex.mjs");
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "codex", name), "utf8");
const temp = () => tempDir("mandor-codex-test-");
const codex = () => createCodexAdapter(DEFAULT_CONFIG);
const RSQUO = String.fromCharCode(0x2019);
const SECRET = "SECRET_TOKEN_123";

const STARTED = "2026-11-08T10:00:00.500Z";
const STARTED_S = Math.floor(Date.parse(STARTED) / 1000);
const T1 = "00000000-0000-7000-8000-000000000010";

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j-20261108100000-ab12", projectId: "demo-000000000000", taskId: "t1", seq: 1, kind: "start",
    candidate: { tool: "codex", model: "gpt-6-luna", effort: "low" }, worktree: "/tmp/wt", sessionId: null,
    promptPath: "/tmp/prompt.md", timeoutMs: 60_000, bin: "/opt/codex", env: {}, queuedAt: STARTED,
    status: "running", runnerPid: null, runnerStart: null, workerPid: null, startedAt: STARTED, endedAt: null,
    ...over,
  };
}

const raw = (stdout: string, over: Partial<RawRun> = {}): RawRun => ({ stdout, stderr: "", exitCode: 0, signal: null, lastMessage: null, ...over });
const jsonl = (events: object[]) => events.map((e) => `${JSON.stringify(e)}\n`).join("");
const failedStream = (message: string) => jsonl([{ type: "thread.started", thread_id: T1 }, { type: "turn.started" }, { type: "turn.failed", error: { message } }]);
const failedResult = (sessionId: string | null): JobResult => ({
  status: "failed", sessionId, report: null, usageCumulative: null, detail: "exit 1; see stderr.log", resetsAt: null, exitCode: 1, creditFunded: false,
});
const FILES = { schemaPath: "/tmp/run/schema.json", lastMessagePath: "/tmp/run/last.json" };
const NO_EXTRAS = { network: false, addDirs: [] };

// The fake's argv as the runner will build it, with the worker environment, in dir as the worktree the runner binds as the cwd.
function fakeRun(dir: string, model = "gpt-6-luna") {
  const files = { schemaPath: join(dir, "schema.json"), lastMessagePath: join(dir, "last.json") };
  const promptPath = join(dir, "prompt.md");
  writeFileSync(promptPath, "Do the task.");
  const p = codex().prepare(job({ bin: FAKE, env: workerEnv(null), worktree: dir, promptPath, candidate: { tool: "codex", model, effort: "low" } }), files, NO_EXTRAS);
  return { ...p, cwd: dir, last: files.lastMessagePath };
}

// One exec of the fake, with the -o file deleted first as the runner does.
function execFake(dir: string, model?: string): RawRun {
  const p = fakeRun(dir, model);
  rmSync(p.last, { force: true });
  const r = spawnSync(p.command, p.args, { cwd: p.cwd, env: p.env, encoding: "utf8", input: readFileSync(p.stdinFile!) });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status, signal: r.signal, lastMessage: existsSync(p.last) ? readFileSync(p.last, "utf8") : null };
}

// The same exec without waiting, so several fakes can run at once.
function execFakeAsync(dir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const p = fakeRun(dir);
  return new Promise((resolve, reject) => {
    const c = spawn(p.command, p.args, { cwd: p.cwd, env: p.env, stdio: ["pipe", "pipe", "pipe"] });
    c.stdin.end(readFileSync(p.stdinFile!));
    let stdout = "";
    let stderr = "";
    c.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    c.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runFake(scenario: Scenario, model?: string): RawRun {
  writeScenarios([scenario]);
  return execFake(temp(), model);
}

const events = (stdout: string) => stdout.trim().split("\n").map((l) => JSON.parse(l));
const alive = (pid: number) => spawnSync("/bin/ps", ["-o", "pid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim() !== "";
async function until(ok: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; !ok(); await sleep(50)) if (Date.now() > end) return false;
  return true;
}

// The launcher with a minimal environment; HOME is an empty directory unless given, so no real login file is read.
// `wrap` runs it under another command, such as an outer sandbox.
function cli(args: string[], home = temp(), wrap: string[] = []) {
  const [cmd, ...rest] = [...wrap, launcher, ...args];
  return spawnSync(cmd, rest, {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH!, HOME: home, SHELL: "/bin/zsh", TMPDIR: tmpdir(),
      MANDOR_HOME: process.env.MANDOR_HOME!, CODEX_HOME: process.env.CODEX_HOME!, MANDOR_CODEX_BIN: FAKE,
    },
  });
}

// Under any sandbox profile that denies something, a nested sandbox-exec cannot apply its own profile, as under
// Claude Code's Bash sandbox.
const OUTER_SANDBOX = ["/usr/bin/sandbox-exec", "-p", '(version 1)(allow default)(deny file-write* (subpath "/nonexistent"))'];

const filesUnder = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

// classify

test("start-ok fixture is done with its thread id", () => {
  const r = codex().classify(raw(fixture("start-ok.jsonl"), { lastMessage: fixture("schema-ok.last.json") }));
  assert.equal(r.status, "done");
  assert.equal(r.sessionId, "00000000-0000-7000-8000-000000000001");
  assert.deepEqual(r.report, JSON.parse(fixture("schema-ok.last.json")));
  assert.deepEqual(r.usageCumulative, { input_tokens: 27305, cached_input_tokens: 12800, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 });
  assert.equal(r.exitCode, 0);
});

test("resume-ok and schema-ok fixtures are done with their thread ids", () => {
  for (const [name, thread] of [["resume-ok.jsonl", "00000000-0000-7000-8000-000000000001"], ["schema-ok.jsonl", "00000000-0000-7000-8000-000000000002"]]) {
    const r = codex().classify(raw(fixture(name), { lastMessage: fixture("schema-ok.last.json") }));
    assert.deepEqual([r.status, r.sessionId], ["done", thread], name);
  }
});

test("retry-then-done is done", () => {
  tempHome();
  const run = runFake({ stdout: "generated:retry-then-done" });
  const stream = events(run.stdout);
  assert.ok(stream.some((e) => e.type === "error"), "a top-level error line");
  assert.ok(stream.some((e) => e.type === "item.completed" && e.item.type === "error"), "an error item");
  const r = codex().classify(run);
  assert.equal(r.status, "done");
  assert.equal(r.sessionId, "00000000-0000-7000-8000-000000000100");
  assert.equal(r.report?.status, "done");
});

test("no-terminal exit 0 is failed, stream ended early", () => {
  tempHome();
  const run = runFake({ stdout: "generated:no-terminal", exitCode: 0 });
  assert.equal(run.exitCode, 0);
  const r = codex().classify(run);
  assert.equal(r.status, "failed");
  assert.equal(r.detail, "stream ended early");
});

test("every template in quota-messages.json classifies as expected with U+2019 and with the ASCII apostrophe", () => {
  const templates: { template: string; expected: string }[] = JSON.parse(fixture("quota-messages.json"));
  assert.equal(templates.length, 18);
  for (const { template, expected } of templates) {
    const filled = template.replaceAll("{}", "gpt-6-astra");
    const curly = filled.replaceAll("{RSQUO}", RSQUO).replaceAll("'", RSQUO);
    const ascii = filled.replaceAll("{RSQUO}", "'");
    for (const message of [curly, ascii]) {
      assert.equal(codex().classify(raw(failedStream(message), { exitCode: 1 })).status, expected, message);
    }
  }
});

test("usage limit for gpt-6-astra is model-limit", () => {
  tempHome();
  const r = codex().classify(runFake({ stdout: "generated:model-limit" }, "gpt-6-astra"));
  assert.equal(r.status, "model-limit");
  assert.match(r.detail, /usage limit for gpt-6-astra/);
  assert.equal(codex().classify(runFake({ stdout: "generated:quota" })).status, "quota");
});

test("invalid_encrypted_content is account-mismatch", () => {
  tempHome();
  assert.equal(codex().classify(runFake({ stdout: "generated:account-mismatch" })).status, "account-mismatch");
  assert.equal(codex().classify(raw(failedStream("organization_id did not match the stored session"), { exitCode: 1 })).status, "account-mismatch");
});

test("a 10 KB turn.failed message yields a detail of at most 300 chars", () => {
  const r = codex().classify(raw(failedStream(`stream error: ${"x".repeat(10 * 1024)}`), { exitCode: 1 }));
  assert.equal(r.status, "failed");
  assert.ok(r.detail.length <= 300, `${r.detail.length} chars`);
});

test("failed-bad-model has no stderr text in detail", () => {
  const stderr = fixture("failed-bad-model.stderr");
  const r = codex().classify(raw(fixture("failed-bad-model.jsonl"), { stderr, exitCode: 1 }));
  assert.equal(r.status, "failed");
  assert.equal(r.sessionId, "00000000-0000-7000-8000-000000000003");
  assert.equal(r.detail, "The 'does-not-exist' model is not supported when using Codex with a ChatGPT account.");
  assert.ok(!r.detail.includes(stderr.trim()));
});

test("interrupted fixture is failed", () => {
  const r = codex().classify(raw(fixture("interrupted.jsonl"), { stderr: "Reading additional input from stdin...\n", exitCode: 1 }));
  assert.equal(r.status, "failed");
  assert.equal(r.sessionId, "00000000-0000-7000-8000-000000000004");
  assert.equal(r.detail, "exit 1; see stderr.log");
});

test("stderr reaches a detail only as one of the fixed phrases", () => {
  const detail = (stderr: string, exitCode: number | null = 1, signal: string | null = null) =>
    codex().classify(raw(fixture("interrupted.jsonl"), { stderr, exitCode, signal })).detail;
  assert.equal(detail(`thread already has an active writer ${SECRET}`), "session busy");
  assert.equal(detail(`Not inside a trusted directory and --skip-git-repo-check was not specified. ${SECRET}`), "not a git repository");
  assert.equal(detail(SECRET), "exit 1; see stderr.log");
  assert.equal(detail(SECRET, null, "SIGKILL"), "exit SIGKILL; see stderr.log");
});

test("turn.completed is done only with exit 0 and a valid report", () => {
  const stream = fixture("start-ok.jsonl");
  const report = fixture("schema-ok.last.json");
  const nonZero = codex().classify(raw(stream, { exitCode: 1, lastMessage: report }));
  assert.deepEqual([nonZero.status, nonZero.detail], ["failed", "exit 1 after turn.completed; see stderr.log"]);
  for (const lastMessage of ["OK", null]) {
    const r = codex().classify(raw(stream, { lastMessage }));
    assert.deepEqual([r.status, r.detail, r.report], ["failed", "report not valid JSON", null]);
  }
});

test("account and request ids in a turn.failed message are masked in the detail", () => {
  const message = `invalid_encrypted_content: org-${"A1".repeat(12)} user-${"b2".repeat(12)} req_${"c3".repeat(16)} thread 00000000-0000-7000-8000-0000000000aa`;
  const r = codex().classify(raw(failedStream(message), { exitCode: 1 }));
  assert.equal(r.status, "account-mismatch");
  assert.equal(r.detail, "invalid_encrypted_content: <id> <id> <id> thread <id>");
});

// the fake

test("the fake takes scenarios in order and honors each scenario field", () => {
  tempHome();
  const dir = temp();
  writeScenarios([
    { stdout: "generated:done", writeFile: [{ path: "sub/a.txt", content: "x" }], commands: ["npm test"], stderr: "warn\n", lastMessage: "custom message" },
    { stdout: "interrupted.jsonl", exitCode: 3 },
  ]);
  const first = execFake(dir);
  assert.equal(readFileSync(join(dir, "sub", "a.txt"), "utf8"), "x");
  const command = { id: "item_0", type: "command_execution", command: "/bin/zsh -lc 'npm test'", aggregated_output: "" };
  assert.deepEqual(events(first.stdout).filter((e) => e.item?.type === "command_execution"), [
    { type: "item.started", item: { ...command, exit_code: null, status: "in_progress" } },
    { type: "item.completed", item: { ...command, exit_code: 0, status: "completed" } },
  ]);
  assert.deepEqual([first.stderr, first.lastMessage, first.exitCode], ["warn\n", "custom message", 0]);
  const second = execFake(dir);
  assert.deepEqual(events(second.stdout), events(fixture("interrupted.jsonl")));
  assert.deepEqual([second.exitCode, second.lastMessage], [3, null]);
  const third = execFake(dir);
  assert.deepEqual([third.exitCode, third.stderr], [1, "fake: no scenario\n"]);
});

test("the fake's sleeper shares the fake's process group, so a group kill reaches it", async (t) => {
  tempHome();
  const dir = temp();
  const pidFile = join(dir, "sleeper.pid");
  writeScenarios([{ stdout: "generated:done", sleeperPidFile: pidFile, delayMs: 30_000 }]);
  const p = fakeRun(dir);
  const fake = spawn(p.command, p.args, { cwd: p.cwd, env: p.env, detached: true, stdio: "ignore" });
  let killed = false;
  t.after(() => {
    try {
      if (!killed) process.kill(-fake.pid!, "SIGKILL"); // a failed assertion must not leave the group running
    } catch {}
  });
  assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", 10_000), "the fake writes the sleeper pid");
  const sleeper = Number(readFileSync(pidFile, "utf8"));
  assert.ok(alive(sleeper));
  assert.equal(spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(sleeper)], { encoding: "utf8" }).stdout.trim(), String(fake.pid));
  process.kill(-fake.pid!, "SIGKILL");
  killed = true;
  assert.ok(await until(() => !alive(sleeper), 5_000), "the group kill reaches the sleeper");
});

test("concurrent fakes claim each scenario exactly once", async () => {
  tempHome();
  const threads = Array.from({ length: 8 }, (_, i) => `00000000-0000-7000-8000-0000000002${i}0`);
  writeScenarios(threads.map((threadId) => ({ stdout: "generated:done", threadId })));
  const runs = await Promise.all(Array.from({ length: 10 }, () => execFakeAsync(temp())));
  const claimed = runs.filter((r) => r.code === 0).map((r) => events(r.stdout)[0].thread_id);
  assert.deepEqual(claimed.sort(), threads);
  assert.deepEqual(runs.filter((r) => r.code !== 0).map((r) => [r.code, r.stderr]), [[1, "fake: no scenario\n"], [1, "fake: no scenario\n"]]);
});

// prepare

test("prepare start and resume argv match the S2-confirmed placement", () => {
  const project = { network: true, addDirs: ["/tmp/cache"] };
  const start = codex().prepare(job(), FILES, project);
  // No -C: the worktree is the cwd the runner binds, never a path Codex would resolve again.
  assert.deepEqual(start.args, [
    "exec", "--json", "-s", "workspace-write", "--ignore-user-config",
    "-c", "sandbox_workspace_write.network_access=true", "--add-dir", "/tmp/cache",
    "-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"',
    "--output-schema", "/tmp/run/schema.json", "-o", "/tmp/run/last.json", "-",
  ]);
  const resume = codex().prepare(job({ kind: "resume", sessionId: "00000000-0000-7000-8000-000000000002" }), FILES, project);
  assert.deepEqual(resume.args, [
    "exec", "-s", "workspace-write", "--ignore-user-config",
    "-c", "sandbox_workspace_write.network_access=true", "--add-dir", "/tmp/cache",
    "resume", "00000000-0000-7000-8000-000000000002", "--json",
    "-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"',
    "--output-schema", "/tmp/run/schema.json", "-o", "/tmp/run/last.json", "-",
  ]);
  // The prompt is the job's own file, which the runner makes the worker's stdin: as an argument it would show in every
  // process list and fail the start past the system's limit on arguments.
  assert.deepEqual([start.stdinFile, resume.stdinFile], ["/tmp/prompt.md", "/tmp/prompt.md"]);
});

test("prepare uses job.bin and job.env", () => {
  const env = { HOME: "/tmp/h", CODEX_HOME: "/tmp/h/.codex" };
  const p = codex().prepare(job({ bin: "/opt/bin/codex", env }), FILES, NO_EXTRAS);
  assert.equal(p.command, "/opt/bin/codex");
  assert.deepEqual(p.env, env);
});

test("prepare follows the config and project switches and refuses a run it cannot express", () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tools.codex.ignoreUserConfig = false;
  const args = createCodexAdapter(cfg).prepare(job(), FILES, NO_EXTRAS).args;
  assert.ok(!args.includes("--ignore-user-config"));
  assert.ok(!args.includes("--add-dir"));
  assert.ok(!args.includes("sandbox_workspace_write.network_access=true"));
  const noEffort = job({ candidate: { tool: "codex", model: "gpt-6-luna", effort: "" } });
  assert.throws(() => codex().prepare(noEffort, FILES, NO_EXTRAS), /codex candidate needs an effort/);
  assert.throws(() => codex().prepare(job({ kind: "resume" }), FILES, NO_EXTRAS), /session UUID/);
  assert.throws(() => codex().prepare(job({ kind: "resume", sessionId: "--help" }), FILES, NO_EXTRAS), /session UUID/);
});

// refine

function tokenCount(timestamp: string, set: { primary?: number; secondary?: number; hasCredits?: boolean } = {}): object {
  const e = JSON.parse(fixture("token-count.json"));
  const rl = e.payload.rate_limits;
  e.timestamp = timestamp;
  if (set.primary !== undefined) rl.primary.used_percent = set.primary;
  if (set.secondary !== undefined) rl.secondary.used_percent = set.secondary;
  if (set.hasCredits !== undefined) rl.credits.has_credits = set.hasCredits;
  return e;
}
const AFTER = "2026-11-08T10:00:05.000Z";
const BEFORE = "2026-11-08T10:00:00.499Z";
const PRIMARY_RESET = 1794065821;
const SECONDARY_RESET = 1794367489;

function writeRollout(codexHome: string, thread: string, lines: (object | string)[], zst = false): void {
  const dir = join(codexHome, "sessions", "2026", "11", "08");
  mkdirSync(dir, { recursive: true });
  const text = lines.map((l) => `${typeof l === "string" ? l : JSON.stringify(l)}\n`).join("");
  writeFileSync(join(dir, `rollout-2026-11-08T17-00-00-${thread}.jsonl${zst ? ".zst" : ""}`), zst ? zstdCompressSync(text) : text);
}

function writeStateDb(codexHome: string, rows: [thread: string, startedAt: number, error: unknown][]): void {
  const db = new DatabaseSync(join(codexHome, "thread_history_1.sqlite"));
  db.exec("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, error_json TEXT, started_at INTEGER, completed_at INTEGER)");
  const insert = db.prepare("INSERT INTO thread_turns (thread_id, turn_id, status, error_json, started_at) VALUES (?, ?, 'failed', ?, ?)");
  rows.forEach(([thread, startedAt, error], i) => insert.run(thread, `turn-${i}`, error === null ? null : JSON.stringify(error), startedAt));
  db.close();
}

test("reads resetsAt from a .zst rollout", () => {
  const home = temp();
  writeRollout(home, T1, [tokenCount(AFTER, { primary: 100 })], true);
  const r = codex().refine(failedResult(T1), job({ env: { CODEX_HOME: home } }));
  assert.equal(r.resetsAt, PRIMARY_RESET);
  assert.equal(r.creditFunded, false);
});

test("reads resetsAt from a plain .jsonl rollout", () => {
  const home = temp();
  writeRollout(home, T1, [
    { timestamp: STARTED, type: "session_meta", payload: { id: T1 } },
    tokenCount(AFTER, { primary: 20 }),
    "{ not json",
    tokenCount(AFTER, { primary: 100, secondary: 100 }),
  ]);
  // The result has no thread id of its own, so the job's is used.
  const r = codex().refine(failedResult(null), job({ sessionId: T1, env: { CODEX_HOME: home } }));
  assert.equal(r.resetsAt, SECONDARY_RESET);
});

test("a token_count event from before job.startedAt is ignored", () => {
  const home = temp();
  writeRollout(home, T1, [tokenCount(BEFORE, { primary: 100, secondary: 100, hasCredits: true })]);
  const before = failedResult(T1);
  const r = codex().refine(before, job({ env: { CODEX_HOME: home } }));
  assert.equal(r.resetsAt, null);
  assert.deepEqual(r, before);
});

test("creditFunded is true when has_credits is true and a window is at 100 percent, and false otherwise", () => {
  const home = temp();
  const cases: [string, { primary?: number; secondary?: number; hasCredits?: boolean }, boolean][] = [
    ["00000000-0000-7000-8000-000000000021", { secondary: 100, hasCredits: true }, true],
    ["00000000-0000-7000-8000-000000000022", { secondary: 100, hasCredits: false }, false],
    ["00000000-0000-7000-8000-000000000023", { hasCredits: true }, false],
  ];
  for (const [thread, set, funded] of cases) {
    writeRollout(home, thread, [tokenCount(AFTER, set)]);
    const r = codex().refine({ ...failedResult(thread), status: "done" }, job({ env: { CODEX_HOME: home } }));
    assert.equal(r.creditFunded, funded, JSON.stringify(set));
  }
});

test("turns failed into quota via a STATE_DB built at test time with node:sqlite", () => {
  const home = temp();
  const asString = "00000000-0000-7000-8000-000000000031";
  const asObject = "00000000-0000-7000-8000-000000000032";
  const otherError = "00000000-0000-7000-8000-000000000033";
  // started_at holds whole seconds: a turn that began in the job's own second counts.
  writeStateDb(home, [
    [asString, STARTED_S, { message: "limit", codexErrorInfo: "usageLimitExceeded" }],
    [asObject, STARTED_S, { codexErrorInfo: { usageLimitExceeded: { resetsAt: PRIMARY_RESET } } }],
    [otherError, STARTED_S, { codexErrorInfo: "modelNotFound" }],
    [otherError, STARTED_S + 1, null],
  ]);
  const refine = (r: JobResult) => codex().refine(r, job({ env: { CODEX_HOME: home } }));
  assert.equal(refine(failedResult(asString)).status, "quota");
  assert.equal(refine(failedResult(asObject)).status, "quota");
  assert.equal(refine(failedResult(otherError)).status, "failed");
  assert.equal(refine({ ...failedResult(asString), status: "done" }).status, "done");
});

test("ignores a usageLimitExceeded row that started before the job", () => {
  const home = temp();
  writeStateDb(home, [[T1, STARTED_S - 1, { codexErrorInfo: "usageLimitExceeded" }]]);
  assert.equal(codex().refine(failedResult(T1), job({ env: { CODEX_HOME: home } })).status, "failed");
});

test("a missing rollout leaves resetsAt null", () => {
  const home = temp();
  const before = failedResult(T1);
  const r = codex().refine(before, job({ env: { CODEX_HOME: home } }));
  assert.equal(r.resetsAt, null);
  assert.deepEqual(r, before);
  // Unchanged, not cleared: values refine did not find stay as they came in.
  const seeded = { ...before, resetsAt: PRIMARY_RESET, creditFunded: true };
  assert.deepEqual(codex().refine(seeded, job({ env: { CODEX_HOME: home } })), seeded);
});

test("refine leaves the result unchanged when a database or rollout cannot be read", () => {
  const before = failedResult(T1);
  const broken = temp();
  writeFileSync(join(broken, "thread_history_1.sqlite"), "not a database");
  mkdirSync(join(broken, "sessions", "2026", "11", "08"), { recursive: true });
  writeFileSync(join(broken, "sessions", "2026", "11", "08", `rollout-2026-11-08T17-00-00-${T1}.jsonl.zst`), "not a zstd stream");
  const noTable = temp();
  new DatabaseSync(join(noTable, "thread_history_1.sqlite")).close();
  for (const home of [broken, noTable]) assert.deepEqual(codex().refine(before, job({ env: { CODEX_HOME: home } })), before);
  assert.deepEqual(codex().refine(before, job({ env: {} })), before);
});

test("refine waits for another process's lock on the state database", async (t) => {
  const home = temp();
  writeStateDb(home, [[T1, STARTED_S, { codexErrorInfo: "usageLimitExceeded" }]]);
  const marker = join(home, "locked");
  // An exclusive transaction blocks every reader of a rollback-journal database until it ends, here after 1 s.
  const holder = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", `
    const [file, marker] = process.argv.slice(1);
    const db = new (require("node:sqlite").DatabaseSync)(file);
    db.exec("BEGIN EXCLUSIVE");
    require("node:fs").writeFileSync(marker, "");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    db.exec("COMMIT");
  `, join(home, "thread_history_1.sqlite"), marker], { stdio: "ignore" });
  t.after(() => holder.kill("SIGKILL"));
  assert.ok(await until(() => existsSync(marker), 10_000), "the other process holds the lock");
  assert.equal(codex().refine(failedResult(T1), job({ env: { CODEX_HOME: home } })).status, "quota");
});

// models

test("detectModels lists gpt-6-astra efforts and hides gpt-reserve", () => {
  tempHome();
  const models = codex().detectModels();
  assert.equal(models.length, 10);
  assert.deepEqual(models.find((m) => m.model === "gpt-6-astra"), {
    tool: "codex", model: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium", hidden: false,
  });
  assert.equal(models.find((m) => m.model === "gpt-reserve")?.hidden, true);
  assert.equal(codex().version(), TESTED_CODEX_VERSION);
});

test("vendor helper calls get the worker environment, and their errors carry no vendor output", (t) => {
  tempHome();
  process.env.OPENAI_API_KEY = "test-key";
  t.after(() => delete process.env.OPENAI_API_KEY);
  codex().version();
  const entry = readFakeLog().at(-1)!;
  assert.deepEqual(entry.argv, ["--version"]);
  const { __CF_USER_TEXT_ENCODING, ...env } = entry.env; // macOS sets this one in every process
  assert.deepEqual(env, workerEnv(null));
  const failing = createCodexAdapter(DEFAULT_CONFIG, () => ({ code: 1, stdout: SECRET }));
  const garbled = createCodexAdapter(DEFAULT_CONFIG, () => ({ code: 0, stdout: `${SECRET} {` }));
  for (const call of [() => failing.detectModels(), () => failing.version(), () => garbled.detectModels(), () => garbled.version()]) {
    assert.throws(call, (e: Error) => /^codex /.test(e.message) && !e.message.includes(SECRET));
  }
});

test("loadModels keeps the last good list when a refresh fails, and returns [] without one", () => {
  const home = tempHome();
  const control = join(process.env.CODEX_HOME!, "fake", "models.json");
  const cache = join(home, "models.json");
  writeFileSync(control, "not json");
  assert.deepEqual(loadModels(60_000, DEFAULT_CONFIG), []);
  assert.ok(!existsSync(cache));
  rmSync(control);
  const good = refreshModels(DEFAULT_CONFIG);
  const saved = readFileSync(cache, "utf8");
  assert.deepEqual(JSON.parse(saved).models, good);
  assert.equal(JSON.parse(saved).codexVersion, TESTED_CODEX_VERSION);
  writeFileSync(control, "not json");
  assert.throws(() => refreshModels(DEFAULT_CONFIG), /does not parse/);
  assert.equal(readFileSync(cache, "utf8"), saved);
  const calls = readFakeLog().length;
  assert.deepEqual(loadModels(60_000, DEFAULT_CONFIG), good);
  assert.equal(readFakeLog().length, calls, "a fresh cache is used without calling codex");
  assert.deepEqual(loadModels(0, DEFAULT_CONFIG), good);
  assert.equal(readFileSync(cache, "utf8"), saved);
  assert.equal(readFileSync(join(home, "logs", "models.log"), "utf8").trim().split("\n").length, 2);
});

test("detectModels skips a malformed entry and refuses a catalog with no usable model", () => {
  const usable = { slug: "gpt-ok", display_name: "GPT OK", supported_reasoning_levels: [{ effort: "low", description: "" }], default_reasoning_level: "low", visibility: "list" };
  const listing = (models: unknown[]) => createCodexAdapter(DEFAULT_CONFIG, () => ({ code: 0, stdout: JSON.stringify({ models }) }));
  assert.deepEqual(listing([usable, { slug: "gpt-no-levels" }, "not an entry"]).detectModels().map((m) => m.model), ["gpt-ok"]);
  for (const models of [[], [{ slug: "gpt-no-levels" }, { display_name: "No slug", supported_reasoning_levels: [] }]]) {
    assert.throws(() => listing(models).detectModels(), /^Error: codex debug models listed no usable model$/);
  }
});

test("an empty or wholly malformed catalog keeps the cached list", () => {
  const home = tempHome();
  const good = refreshModels(DEFAULT_CONFIG);
  const saved = readFileSync(join(home, "models.json"), "utf8");
  for (const models of [[], [{ slug: "gpt-no-levels" }]]) {
    writeFileSync(join(process.env.CODEX_HOME!, "fake", "models.json"), JSON.stringify({ models }));
    assert.throws(() => refreshModels(DEFAULT_CONFIG), /listed no usable model/);
    assert.deepEqual(loadModels(0, DEFAULT_CONFIG), good);
    assert.equal(readFileSync(join(home, "models.json"), "utf8"), saved);
  }
});

test("a worker login shell that cannot be read gives its own warning", (t) => {
  tempHome();
  const shell = process.env.SHELL;
  process.env.SHELL = "/usr/bin/false";
  t.after(() => {
    if (shell === undefined) delete process.env.SHELL;
    else process.env.SHELL = shell;
  });
  const warnings = codexWarnings(TESTED_CODEX_VERSION);
  assert.ok(warnings.includes("could not read the environment of the worker login shell"), JSON.stringify(warnings));
  assert.ok(!warnings.some((w) => w.includes("secret-like")), JSON.stringify(warnings));
});

test("models warns on version mismatch", () => {
  tempHome({ config: true });
  const models = () => {
    const r = cli(["models", "--refresh", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    return JSON.parse(r.stdout) as { codexVersion: string; models: unknown[]; warnings: string[] };
  };
  const tested = models();
  assert.equal(tested.codexVersion, TESTED_CODEX_VERSION);
  assert.equal(tested.models.length, 10);
  assert.ok(!tested.warnings.some((w) => w.includes("tested version")), JSON.stringify(tested.warnings));
  assert.ok(!tested.warnings.some((w) => w.includes("login shell")), JSON.stringify(tested.warnings));
  assert.ok(tested.warnings.some((w) => w.includes("workspace credits")), JSON.stringify(tested.warnings));
  writeFileSync(join(process.env.CODEX_HOME!, "fake", "version"), "0.167.0\n");
  const newer = models();
  assert.equal(newer.codexVersion, "0.167.0");
  assert.ok(newer.warnings.some((w) => w.includes("0.167.0") && w.includes(`tested version ${TESTED_CODEX_VERSION}`)), JSON.stringify(newer.warnings));
});

test("init and models warn about a tier candidate the catalog cannot run, and say nothing when every one can", () => {
  const home = tempHome({ config: true });
  const warned = (args: string[]): string[] => {
    const r = cli(args);
    assert.equal(r.status, 0, r.stderr);
    return args[0] === "init" || args.includes("--json") ? JSON.parse(r.stdout).warnings : r.stdout.split("\n").filter((l) => l.startsWith("warning: ")).map((l) => l.slice(9));
  };
  for (const args of [["init"], ["models", "--json"], ["models"]]) assert.ok(!warned(args).some((w) => w.startsWith("tier ")), args.join(" "));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tools.codex.bin = FAKE;
  cfg.tiers.light = ["codex:gpt-0-gone@medium", "codex:gpt-6-luna@medium"];
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
  for (const args of [["init"], ["models", "--json"], ["models"]]) {
    assert.deepEqual(warned(args).filter((w) => w.startsWith("tier ")), ["tier light: codex:gpt-0-gone is not in the model catalog"], args.join(" "));
  }
});

test("init names a secret-like variable exported by the worker login shell without printing its value", () => {
  const home = tempHome();
  const userHome = temp();
  writeFileSync(join(userHome, ".zprofile"), `export FAKE_TOKEN=${SECRET}\n`);
  const r = cli(["init"], userHome);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.home, home);
  assert.equal(out.config, join(home, "config.json"));
  assert.ok(existsSync(out.config));
  assert.equal(out.codexVersion, TESTED_CODEX_VERSION);
  assert.equal(out.models, 10);
  assert.ok(out.warnings.some((w: string) => w.includes("FAKE_TOKEN")), JSON.stringify(out.warnings));
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  for (const f of filesUnder(home)) assert.ok(!readFileSync(f, "utf8").includes(SECRET), f);
});

test("init and models read the worker login shell once per refresh, from a directory that is no worktree", () => {
  tempHome();
  const userHome = temp();
  const log = join(temp(), "login.log");
  writeFileSync(join(userHome, ".zprofile"), `pwd -P >> '${log}'\n`);
  assert.equal(cli(["init"], userHome).status, 0);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["/"], "one read, and not in the directory the command ran in");
  assert.equal(cli(["models", "--refresh"], userHome).status, 0);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2, "a refresh reads it once more");
  assert.equal(cli(["models"], userHome).status, 0);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2, "a fresh list needs no read");
});

test("init warns where sandbox-exec cannot apply a profile, and only there", () => {
  tempHome();
  const plain = cli(["init"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(!JSON.parse(plain.stdout).warnings.some((w: string) => w.includes("sandbox")), plain.stdout);
  const nested = cli(["init"], temp(), OUTER_SANDBOX);
  assert.equal(nested.status, 0, nested.stderr);
  const warnings: string[] = JSON.parse(nested.stdout).warnings;
  assert.ok(warnings.some((w) => /^cannot confine with sandbox-exec \(sandbox-exec: .+\): run mandor outside Claude Code's Bash sandbox, which sandbox-exec cannot nest in$/.test(w)), JSON.stringify(warnings));
});

test("mandor models never prints the fake's SECRET_TOKEN_123 stderr", () => {
  const home = tempHome({ config: true });
  const control = join(process.env.CODEX_HOME!, "fake");
  writeFileSync(join(control, "debug.stderr"), `refreshing auth ${SECRET}\n`);
  for (const args of [["models", "--refresh", "--json"], ["models", "--refresh"], ["models"]]) {
    const r = cli(args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.ok(!r.stdout.includes(SECRET), args.join(" "));
    if (!args.includes("--json")) {
      assert.match(r.stdout, /^gpt-6-astra .*ultra.* default medium$/m);
      assert.match(r.stdout, /^gpt-reserve .* hidden$/m);
      assert.match(r.stdout, /^warning: /m);
    }
  }
  writeFileSync(join(control, "models.json"), "not json");
  const failed = cli(["models", "--refresh"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^mandor: codex debug models /);
  assert.ok(!failed.stdout.includes(SECRET) && !failed.stderr.includes(SECRET));
  const log = join(home, "logs", "vendor.stderr");
  assert.match(readFileSync(log, "utf8"), new RegExp(SECRET));
  assert.equal(statSync(log).mode & 0o777, 0o600);
  for (const f of filesUnder(home).filter((f) => f !== log)) assert.ok(!readFileSync(f, "utf8").includes(SECRET), f);
});
