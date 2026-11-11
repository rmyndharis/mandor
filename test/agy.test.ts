import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { agyHome, createAgyAdapter, TESTED_AGY_VERSION } from "../src/adapters/agy.ts";
import { getAdapter, modelsReport, readModelCache, refreshModels } from "../src/adapters/index.ts";
import { cachedWarnings } from "../src/modelcache.ts";
import { DEFAULT_CONFIG, resolveBin } from "../src/config.ts";
import type { Candidate, JobRecord, RawRun } from "../src/contracts.ts";
import { processStart, projectIdFor, scratchDir } from "../src/home.ts";
import { appendEvent, loadState, loadToolState, now } from "../src/ledger.ts";
import { emptyProjectConfig, saveProjectConfig } from "../src/provision.ts";
import { reviewPack } from "../src/review.ts";
import { showTask } from "../src/status.ts";
import { withProjectLock } from "../src/store.ts";
import { dispatch, goalStart, loadCatalog, pumpLocked, reassign, verdictFix } from "../src/tasks.ts";
import { readAgyLog, temp, tempHome, tempRepo, writeAgyConfig, writeAgyScenarios } from "./helpers.ts";

const FAKE = join(import.meta.dirname, "fake-bin", "fake-agy.mjs");
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "agy", name), "utf8");
const CONVERSATION = "00000000-0000-7000-8000-000000000c00";
const SECRET = "SECRET_TOKEN_123";

function config() {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tools.agy = { ...cfg.tools.agy, enabled: true, bin: FAKE };
  return cfg;
}
const agy = () => createAgyAdapter(config());

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j-20261110100000-ab12", projectId: "demo-000000000000", taskId: "t1", seq: 1, kind: "start",
    candidate: { tool: "agy", model: "gemini-3.8-flash-low", effort: "low" }, worktree: "/tmp/wt", sessionId: null,
    promptPath: "/tmp/prompt.md", timeoutMs: 60_000, bin: FAKE, env: { PATH: "/usr/bin:/bin", HOME: "/home/user" }, queuedAt: "2026-11-10T10:00:00.000Z",
    status: "running", runnerPid: null, runnerStart: null, workerPid: null, startedAt: "2026-11-10T10:00:00.500Z", endedAt: null,
    ...over,
  };
}

const raw = (stdout: string, over: Partial<RawRun> = {}): RawRun => ({ stdout, stderr: "", exitCode: 0, signal: null, lastMessage: null, ...over });
const jsonl = (events: object[]) => events.map((e) => `${JSON.stringify(e)}\n`).join("");
const REPORT = {
  status: "done", summary: "Done.", files_changed: ["a.txt"], commands_run: [{ command: "ls", exit_code: 0, summary: "listed" }],
  tests: { ran: false, passed: 0, failed: 0, notes: "" }, open_issues: [], questions_for_lead: [],
};
const USAGE = { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 };
// A run as the CLI prints it, reduced to the events the adapter reads.
const stream = (result: object, model = "gemini-3.8-flash-low") => jsonl([
  { event: "init", conversation_id: CONVERSATION, init: { model, cwd: "/tmp/wt" } },
  { event: "result", result: { conversation_id: CONVERSATION, num_turns: 1, usage: USAGE, ...result } },
]);

test("classify reads a real finished run: its conversation, the report the schema enforced, the model and the conversation's usage", () => {
  const r = agy().classify(raw(fixture("start-ok.jsonl")));
  assert.equal(r.status, "done");
  assert.equal(r.sessionId, CONVERSATION);
  assert.deepEqual([r.report?.status, r.report?.files_changed, r.report?.commands_run.map((c) => c.command)], ["done", ["hello.txt"], ["ls -a"]]);
  assert.equal(r.model, "gemini-3.8-flash-low");
  assert.deepEqual(r.usageCumulative, { input_tokens: 24711, output_tokens: 186, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 24897 });
  assert.ok(!r.usagePerRun, "this tool sums a conversation's usage, as codex does");
  assert.deepEqual([r.detail, r.exitCode, r.creditFunded, r.resetsAt], ["", 0, false, null]);
  const resumed = agy().classify(raw(fixture("resume-ok.jsonl")));
  assert.deepEqual([resumed.status, resumed.sessionId, resumed.usageCumulative?.input_tokens], ["done", CONVERSATION, 42450]);
});

test("the report is the structured output, or the last JSON object of the answer without one, and anything else is a failure", () => {
  assert.deepEqual(agy().classify(raw(stream({ status: "SUCCESS", response: "", structured_output: REPORT }))).report, REPORT);
  assert.deepEqual(agy().classify(raw(stream({ status: "SUCCESS", response: `Here it is:\n${JSON.stringify(REPORT)}\n` }))).report, REPORT);
  for (const result of [{ response: "All done!" }, { response: "", structured_output: { status: "done" } }, { response: "" }]) {
    const r = agy().classify(raw(stream({ status: "SUCCESS", ...result })));
    assert.deepEqual([r.status, r.detail, r.sessionId], ["failed", "report not valid JSON", CONVERSATION], JSON.stringify(result));
  }
  const cut = agy().classify(raw(jsonl([{ event: "init", conversation_id: CONVERSATION, init: { model: "m" } }])));
  assert.deepEqual([cut.status, cut.detail, cut.sessionId], ["failed", "stream ended early", CONVERSATION]);
  const nonZero = agy().classify(raw(stream({ status: "SUCCESS", response: "", structured_output: REPORT }), { exitCode: 1 }));
  assert.deepEqual([nonZero.status, nonZero.detail], ["failed", "exit 1 after the run finished; see stderr.log"]);
});

test("a report in the answer followed by braces in prose, or by an object that is not a report, is still the report", () => {
  const body = JSON.stringify(REPORT);
  const sample = "if (a) {\n  if (b) {\n    x();\n  }\n}\n".repeat(6);
  const tails = ["\nSee `if (x) { return; }` above.", "\nAn empty object {} means nothing.", '\nA string such as "}" is fine.', '\n{"status":"nope"}', `\n${"}".repeat(20)}`, `\n${sample}`];
  for (const tail of tails) {
    const r = agy().classify(raw(stream({ status: "SUCCESS", response: body + tail })));
    assert.equal(r.status, "done", tail);
    assert.deepEqual(r.report, REPORT, tail);
  }
});

test("a tool the run had no permission for fails the job by name, though the CLI itself reports success", () => {
  const denied = [{ action: "write_file", display_name: "WriteFile" }, { action: "command", display_name: "RunCommand" }];
  const r = agy().classify(raw(stream({ status: "SUCCESS", response: "", denied_actions: denied })));
  assert.deepEqual([r.status, r.detail, r.exitCode], ["failed", "the run lacked a permission its tools needed: write_file, command", 0]);
  const early = agy().classify(raw(stream({ status: "SUCCESS", response: "", structured_output: REPORT, finished_reason: "MAX_TOKENS" })));
  assert.deepEqual([early.status, early.detail], ["failed", "the run stopped early: MAX_TOKENS"]);
});

test("any refused action fails the run, whatever it is called, and only a name that is safe to print is in the detail", () => {
  const run = (denied: unknown) => agy().classify(raw(stream({ status: "SUCCESS", response: "", structured_output: REPORT, denied_actions: denied })));
  for (const denied of [[{ action: "mcp_call:x" }], [{}], [{ action: 7 }], [{ action: "Write-File" }]]) {
    const r = run(denied);
    assert.deepEqual([r.status, r.detail], ["failed", "the run lacked a permission its tools needed"], JSON.stringify(denied));
  }
  assert.equal(run([{ action: "write_file" }, { action: "mcp_call:x" }]).detail, "the run lacked a permission its tools needed: write_file");
  assert.equal(run([]).status, "done");
});

test("a failed run is a quota stop, a model's own limit or a plain failure by fixed phrases on stderr, which is never copied", () => {
  const failed = (stderr: string, exitCode = 3) => agy().classify(raw(stream({ status: "ERROR", response: "" }), { exitCode, stderr: `${stderr}\n${SECRET}\n` }));
  for (const text of ['AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED"}', 'AGY_ERROR: {"reason":"QUOTA_EXHAUSTED"}', "Your AI credits balance is too low to continue."]) {
    assert.deepEqual([failed(text).status, failed(text).detail], ["quota", "the account's quota is used up"], text);
  }
  const model = failed('AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED","reason":"You have exhausted your quota on this model."}');
  assert.deepEqual([model.status, model.detail], ["model-limit", "the quota of this model is used up"]);
  const unknown = failed('error: invalid model selection (--model "x" --effort ""): model x is not recognized', 1);
  assert.deepEqual([unknown.status, unknown.detail], ["failed", "the account does not offer this model"]);
  const other = failed("something else");
  assert.deepEqual([other.status, other.detail], ["failed", "status ERROR; see stderr.log"]);
  const silent = agy().classify(raw("", { exitCode: 1, stderr: SECRET }));
  assert.deepEqual([silent.status, silent.detail, silent.sessionId], ["failed", "exit 1; see stderr.log", null]);
  for (const r of [failed("x"), model, unknown, other, silent]) assert.ok(!JSON.stringify(r).includes(SECRET));
});

test("refine turns a resume that landed in a new conversation into an account mismatch, and fails a run on another model", () => {
  const a = agy();
  const done = a.classify(raw(stream({ status: "SUCCESS", response: "", structured_output: REPORT })));
  assert.equal(a.refine(done, job()).status, "done");
  assert.equal(a.refine(done, job({ kind: "resume", sessionId: CONVERSATION })).status, "done");
  // The CLI warns and starts a new conversation when the one it is asked for is gone: the worker then knows only the last message.
  const lost = a.refine(done, job({ kind: "resume", sessionId: "00000000-0000-7000-8000-00000000ffff" }));
  assert.deepEqual([lost.status, lost.detail, lost.report], ["account-mismatch", "the conversation was not found, so the run started a new one", null]);
  const other = a.refine(a.classify(raw(stream({ status: "SUCCESS", response: "", structured_output: REPORT }, "gemini-4-argon-high"))), job());
  assert.deepEqual([other.status, other.detail], ["failed", "ran on gemini-4-argon-high, not on gemini-3.8-flash-low"]);
  const quota = a.classify(raw(stream({ status: "ERROR", response: "" }), { exitCode: 3, stderr: "QUOTA_EXHAUSTED" }));
  assert.equal(a.refine(quota, job({ kind: "resume", sessionId: "00000000-0000-7000-8000-00000000ffff" })).status, "quota", "a failure keeps its own reason");
});

function prepared(over: Partial<JobRecord> = {}, project = { network: true, addDirs: [] as string[] }) {
  const home = tempHome();
  const dir = temp("mandor-ajob-");
  const promptPath = join(dir, "prompt.md");
  writeFileSync(promptPath, "Do the task.\n");
  const worktree = temp("mandor-awt-");
  const run = agy().prepare(job({ promptPath, worktree, ...over }), { schemaPath: join(dir, "schema.json"), lastMessagePath: join(dir, "last-message.json") }, project);
  return { home, dir, run, worktree };
}

test("prepare names the root it is handed and never follows a link at it: the runner has verified the root", () => {
  const link = join(temp("mandor-alink-"), "wt");
  symlinkSync(temp("mandor-asib-"), link);
  const { run } = prepared({ worktree: link });
  const allow = JSON.parse(run.args.at(-1)!).permissions.allow as string[];
  assert.deepEqual(allow.slice(0, 2), [`write_file(${link})`, `read_file(${link})`]);
  assert.equal(allow.length, 3);
});

test("prepare refuses a project without worker network, as the sandbox's proxy, not the project, decides what a command reaches", () => {
  assert.throws(() => prepared({}, { network: false, addDirs: [] }), /^Error: agy workers .*proxy.*project setup --update --worker-network$/);
  assert.doesNotThrow(() => prepared({}, { network: true, addDirs: [] }));
});

test("prepare runs the CLI on the worker's own directory, in its sandbox, with paid credits off and permissions for the worktree only", () => {
  const { home, dir, run, worktree } = prepared();
  assert.equal(agyHome(), join(home, "agy", "home"));
  assert.ok(existsSync(agyHome()));
  assert.equal(run.command, FAKE);
  const settings = run.args[run.args.indexOf("--settings") + 1];
  assert.deepEqual(JSON.parse(settings), { useG1Credits: false, permissions: { allow: [`write_file(${worktree})`, `read_file(${worktree})`, "command(*)"] } });
  assert.deepEqual(run.args, [
    `--gemini_dir=${agyHome()}`, "-p", "Do the task.\n", "--output-format", "stream-json", "--model", "gemini-3.8-flash-low", "--sandbox",
    "--json-schema", join(dir, "schema.json"), "--settings", settings,
  ]);
  assert.ok(!run.args.includes("--effort") && !run.args.includes("--dangerously-skip-permissions"));
  assert.equal(run.stdinFile, undefined);
  assert.deepEqual(run.env, { PATH: "/usr/bin:/bin", HOME: "/home/user", AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
});

test("prepare resumes a conversation by its id, adds each cache directory, and refuses a bad id and a prompt too long for an argument", () => {
  const { run } = prepared({ kind: "resume", sessionId: CONVERSATION });
  assert.deepEqual(run.args.slice(1, 3), ["--conversation", CONVERSATION]);
  const cache = temp("mandor-acache-");
  const withDirs = prepared({}, { network: true, addDirs: [cache] });
  assert.deepEqual(withDirs.run.args.slice(1, 3), ["--add-dir", cache]);
  assert.deepEqual(JSON.parse(withDirs.run.args.at(-1)!).permissions.allow.slice(0, 4), [`write_file(${withDirs.worktree})`, `read_file(${withDirs.worktree})`, `write_file(${cache})`, `read_file(${cache})`]);
  assert.throws(() => prepared({ kind: "resume", sessionId: "sess_x" }), /agy resume needs a conversation id/);
  assert.throws(() => prepared({ kind: "resume", sessionId: null }), /agy resume needs a conversation id/);
  const dir = temp("mandor-along-");
  writeFileSync(join(dir, "prompt.md"), "x".repeat(200_001));
  assert.throws(() => prepared({ promptPath: join(dir, "prompt.md") }), /prompt of 200001 bytes is too long for agy/);
});

test("detectModels lists the account's models with the effort each id ends in, and version asks the CLI", () => {
  const home = tempHome();
  writeAgyConfig(home);
  const models = agy().detectModels();
  assert.deepEqual(models.map((m) => [m.tool, m.model, m.efforts.join("/"), m.defaultEffort, m.hidden]), [
    ["agy", "gemini-4-argon-high", "high", "high", false],
    ["agy", "gemini-4-argon-medium", "medium", "medium", false],
    ["agy", "gemini-3.8-flash-medium", "medium", "medium", false],
    ["agy", "gemini-3.8-flash-low", "low", "low", false],
    ["agy", "claude-sonnet-5-5-high", "high", "high", false],
    ["agy", "gpt-oss-120b", "default", "default", false],
  ]);
  assert.deepEqual(readAgyLog().at(-1)!.argv, [`--gemini_dir=${agyHome()}`, "--output-format", "json", "models"]);
  assert.equal(readAgyLog().at(-1)!.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
  assert.equal(agy().version(), TESTED_AGY_VERSION);
  assert.equal(resolveBin("agy", config()), FAKE);
  writeFileSync(join(agyHome(), "fake", "models.json"), "[]");
  assert.throws(() => agy().detectModels(), /agy models listed no model/);
});

// The core, with the tool next to codex

const FLASH: Candidate = { tool: "agy", model: "gemini-3.8-flash-low", effort: "low" };
const GOAL = "feat/third-tool";

async function until(ok: () => boolean, ms = 30_000): Promise<boolean> {
  for (const end = Date.now() + ms; !ok(); await sleep(50)) if (Date.now() > end) return false;
  return true;
}

// Whatever a test leaves running dies with it: the runners and every worker group.
function reap(home: string): void {
  const jobs = join(home, "jobs");
  for (const id of existsSync(jobs) ? readdirSync(jobs) : []) {
    const p = join(jobs, id, "job.json");
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, "utf8")) as JobRecord;
    const kill = (pid: number) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    };
    const runner = j.runnerPid ?? 0;
    if (runner > 1 && runner !== process.pid && processStart(runner) === j.runnerStart) kill(runner);
    if ((j.workerPid ?? 0) > 1 && j.status === "running") kill(-j.workerPid!);
  }
}

function project(t: TestContext, opts: { network?: boolean } = {}) {
  const home = tempHome();
  writeAgyConfig(home);
  t.after(() => reap(home));
  const repo = tempRepo();
  const id = projectIdFor(repo);
  saveProjectConfig(id, { ...emptyProjectConfig(), workerNetwork: opts.network ?? true });
  const briefFile = join(scratchDir(id, "t"), "brief.md");
  writeFileSync(briefFile, "Create the file.\n");
  goalStart(repo, GOAL, null);
  const send = (slug: string, use: Candidate | null = FLASH) => dispatch(repo, { goal: GOAL, slug, tier: "light", briefFile, scope: [], use, after: null });
  return { home, repo, id, send };
}

test("the pump and reassign read the project's worker network when they route", async (t) => {
  const p = project(t);
  writeAgyScenarios([{}, {}, {}]);
  const set = (slug: string, patch: object) => appendEvent(p.id, { t: "task.updated", at: now(), taskId: slug, patch, reason: "test" });
  const net = (workerNetwork: boolean) => saveProjectConfig(p.id, { ...emptyProjectConfig(), workerNetwork });
  p.send("first");
  assert.ok(await until(() => loadState(p.id).tasks.first.status === "needs-review"), showTask(p.id, "first"));
  // A task that waits for the first, pinned to agy; the project then stops allowing the network.
  dispatch(p.repo, { goal: GOAL, slug: "later", tier: "light", briefFile: join(scratchDir(p.id, "t"), "brief.md"), scope: [], use: FLASH, after: "first" });
  set("first", { status: "accepted" });
  net(false);
  withProjectLock(p.id, () => pumpLocked(p.id, loadCatalog()));
  const later = loadState(p.id).tasks.later;
  assert.deepEqual([later.status, later.stallReason], ["stalled", "failed"], "the pump did not start it");
  assert.match(readFileSync(join(p.home, "logs", "runner.log"), "utf8"), /agy needs worker network, which this project does not allow/);
  // Reassign routes by the same setting: a tier that only agy lists has no candidate without the network.
  const config = JSON.parse(readFileSync(join(p.home, "config.json"), "utf8"));
  config.tiers = { light: ["agy:gemini-3.8-flash-medium"], medium: ["agy:gemini-3.8-flash-medium"], heavy: ["agy:gemini-3.8-flash-medium"] };
  writeFileSync(join(p.home, "config.json"), JSON.stringify(config));
  set("first", { status: "stalled", stallReason: "failed" });
  assert.throws(() => reassign(p.repo, "first"), /^Error: no candidate for tier light can run in this project, which allows no worker network: allow it with mandor project setup --update --worker-network$/);
  net(true);
  assert.equal(reassign(p.repo, "first").task.status, "working");
});

test("dispatch refuses an agy candidate in a project without worker network, and no worker starts", (t) => {
  const p = project(t, { network: false });
  writeAgyScenarios([{}]);
  assert.throws(() => p.send("closed"), /^Error: cannot use agy:gemini-3\.8-flash-low.*: agy needs worker network, which this project does not allow$/);
  assert.equal(loadState(p.id).tasks.closed, undefined, "no task is left behind");
  // Reading the model list runs the CLI too, so only a run with a prompt is a worker.
  assert.equal(readAgyLog().filter((e) => e.argv.includes("-p")).length, 0, "the worker never started");
});

test("the catalog holds agy's models next to codex's, and the report says what using it means", () => {
  const home = tempHome();
  writeAgyConfig(home);
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(getAdapter("agy", cfg).tool, "agy");
  const models = refreshModels(cfg);
  assert.deepEqual([...new Set(models.map((m) => m.tool))], ["codex", "agy"]);
  assert.deepEqual(readModelCache()!.versions, { codex: "0.166.0", agy: TESTED_AGY_VERSION });
  const { warnings } = modelsReport(cfg, false);
  assert.ok(warnings.some((w) => /^agy is on: .*terms.*README/.test(w)), JSON.stringify(warnings));
  assert.ok(!warnings.some((w) => w.includes("tested version") && w.startsWith("agy")), JSON.stringify(warnings));
  writeFileSync(join(home, "agy", "home", "fake", "version"), "1.6.0\n");
  refreshModels(cfg);
  assert.ok(modelsReport(cfg, false).warnings.includes(`agy 1.6.0 is not the tested version ${TESTED_AGY_VERSION}`));
  cfg.tools.agy.enabled = false;
  assert.ok(!modelsReport(cfg, true).warnings.some((w) => w.startsWith("agy")), "a tool that is off has nothing to say");
});

test("what agy's version and models calls print on stderr goes to a private log and nowhere else", () => {
  const home = tempHome();
  writeAgyConfig(home);
  writeFileSync(join(home, "agy", "home", "fake", "stderr"), `refreshing auth ${SECRET}\n`);
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  refreshModels(cfg);
  const log = join(home, "logs", "vendor.stderr");
  const text = readFileSync(log, "utf8");
  assert.match(text, new RegExp(`^\\S+ agy .*--version\\nrefreshing auth ${SECRET}\\n`, "m"));
  assert.match(text, new RegExp(`^\\S+ agy .* models\\nrefreshing auth ${SECRET}\\n`, "m"));
  assert.equal(statSync(log).mode & 0o777, 0o600);
  for (const name of readdirSync(home, { recursive: true, encoding: "utf8" })) {
    const file = join(home, name);
    if (file === log || name.split("/").includes("fake") || !statSync(file).isFile()) continue;
    assert.ok(!readFileSync(file, "utf8").includes(SECRET), name);
  }
});

test("a refresh stores each enabled tool's warnings, and only an enabled tool has any to say", () => {
  const home = tempHome();
  writeAgyConfig(home);
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  refreshModels(cfg);
  const stored = readModelCache()!.warnings;
  assert.deepEqual(Object.keys(stored ?? {}).sort(), ["agy", "codex"]);
  assert.ok(stored!.agy!.some((w) => /^agy is on: /.test(w)), JSON.stringify(stored));
  assert.ok(stored!.codex!.includes("codex has no per-run switch to keep workers off workspace credits"), JSON.stringify(stored));
  assert.deepEqual(cachedWarnings(cfg), [...stored!.codex!, ...stored!.agy!]);
  assert.deepEqual(modelsReport(cfg, false).warnings.filter((w) => !w.includes("login shell")), cachedWarnings(cfg).filter((w) => !w.includes("login shell")));
  // A tool that is off says nothing, to the commands that print and to the ones that only read the stored text.
  cfg.tools.codex.enabled = false;
  for (const warnings of [modelsReport(cfg, false).warnings, cachedWarnings(cfg)]) assert.ok(!warnings.some((w) => w.startsWith("codex") || w.includes("login shell")), JSON.stringify(warnings));
  assert.deepEqual(cachedWarnings(cfg), stored!.agy);
  cfg.tools.agy.enabled = false;
  assert.deepEqual(cachedWarnings(cfg), []);
  // A tool switched on since the refresh has its warnings worked out, and a problem of one switched off is not printed.
  const later = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  later.tools.agy.enabled = false;
  refreshModels(later);
  later.tools.agy.enabled = true;
  assert.ok(modelsReport(later, false).warnings.some((w) => /^agy is on: /.test(w)), "agy was off at the refresh");
  const cache = JSON.parse(readFileSync(join(home, "models.json"), "utf8"));
  writeFileSync(join(home, "models.json"), JSON.stringify({ ...cache, problems: { agy: "agy models listed no model" } }));
  later.tools.agy.enabled = false;
  assert.ok(!modelsReport(later, false).warnings.some((w) => w.startsWith("agy")), "agy is off now");
  // A cache from before the warnings were stored has none to give, and is no error.
  writeFileSync(join(home, "models.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), codexVersion: "0.166.0", models: [] }));
  assert.deepEqual(cachedWarnings(config()), []);
});

test("a task sent to agy runs in its worktree, a fix resumes its conversation, and each run shows what it added to the conversation's usage", async (t) => {
  const p = project(t);
  const report = { ...REPORT, files_changed: ["hello.txt"], commands_run: [{ command: "ls -a", exit_code: 0, summary: "listed" }, { command: "npm test", exit_code: 0, summary: "passed" }] };
  writeAgyScenarios([{ writeFile: [{ path: "hello.txt", content: "hello\n" }], commands: ["ls -a"], report }, { writeFile: [{ path: "hello.txt", content: "hello\nworld\n" }] }]);
  const { task } = p.send("hello");
  assert.deepEqual([task.status, task.candidate], ["working", FLASH]);
  assert.ok(await until(() => loadState(p.id).tasks.hello.status === "needs-review"), showTask(p.id, "hello"));
  const done = loadState(p.id).tasks.hello;
  assert.equal(done.sessionId, "00000000-0000-7000-8000-000000000d01");
  assert.equal(readFileSync(join(done.worktree!, "hello.txt"), "utf8"), "hello\n");
  const run1 = readAgyLog().find((l) => l.argv.includes("-p"))!;
  assert.equal(run1.cwd, realpathSync.native(done.worktree!));
  assert.equal(run1.argv[run1.argv.indexOf("-p") + 1], readFileSync(done.briefPath, "utf8"), "the prompt is the rendered brief");
  assert.equal(run1.env.MANDOR_JOB, done.jobIds[0]);
  // Of the two commands the report claims, the log shows one.
  assert.deepEqual(reviewPack(p.repo, "hello").redFlags.filter((f) => f.kind === "unrun-claim"), [{ kind: "unrun-claim", detail: "commands_run[1] has no command_execution item in the job's raw.log" }]);

  const notes = join(scratchDir(p.id, "t"), "notes.md");
  writeFileSync(notes, "Add a second line.\n");
  verdictFix(p.repo, "hello", notes);
  assert.ok(await until(() => loadState(p.id).tasks.hello.status === "needs-review" && loadState(p.id).tasks.hello.seq === 2), showTask(p.id, "hello"));
  const run2 = readAgyLog().filter((l) => l.argv.includes("-p"))[1];
  assert.deepEqual(run2.argv.slice(1, 3), ["--conversation", "00000000-0000-7000-8000-000000000d01"]);
  assert.equal(readFileSync(join(done.worktree!, "hello.txt"), "utf8"), "hello\nworld\n");
  const jobs = showTask(p.id, "hello").split("\n").filter((l) => l.startsWith("  j-"));
  assert.match(jobs[0], / agy:gemini-3\.8-flash-low@low done: input_tokens 1000, output_tokens 50, /);
  assert.match(jobs[1], / agy:gemini-3\.8-flash-low@low done: input_tokens 1500, output_tokens 40, /);
});

test("a denied tool and a spent model stall the task, and a conversation that is gone starts over once from the work so far", async (t) => {
  const p = project(t);
  writeAgyScenarios([{ kind: "denied" }, { kind: "model-limit" }, {}, { forgetConversation: true }, {}]);
  p.send("denied");
  assert.ok(await until(() => loadState(p.id).tasks.denied.status === "stalled"), showTask(p.id, "denied"));
  assert.match(showTask(p.id, "denied"), /last outcome: failed: the run lacked a permission its tools needed: write_file, command/);
  p.send("spent");
  assert.ok(await until(() => loadState(p.id).tasks.spent.status === "stalled"), showTask(p.id, "spent"));
  assert.deepEqual(Object.keys(loadToolState(Date.now() / 1000)), ["agy:gemini-3.8-flash-low"]);
  // Another model of the tool still runs.
  const ARGON: Candidate = { tool: "agy", model: "gemini-4-argon-medium", effort: "medium" };
  p.send("lost", ARGON);
  assert.ok(await until(() => loadState(p.id).tasks.lost.status === "needs-review"), showTask(p.id, "lost"));
  const notes = join(scratchDir(p.id, "t"), "notes.md");
  writeFileSync(notes, "Again.\n");
  verdictFix(p.repo, "lost", notes);
  assert.ok(await until(() => loadState(p.id).tasks.lost.status === "needs-review" && loadState(p.id).tasks.lost.seq === 3), showTask(p.id, "lost"));
  const outcomes = Object.values(loadState(p.id).jobs).filter((j) => j.taskId === "lost").map((j) => [j.kind, j.outcome?.status]);
  assert.deepEqual(outcomes, [["start", "done"], ["resume", "account-mismatch"], ["start", "done"]]);
  const last = readAgyLog().filter((l) => l.argv.includes("-p")).at(-1)!;
  assert.ok(!last.argv.includes("--conversation"), "the handoff is a fresh conversation");
  assert.match(last.argv[last.argv.indexOf("-p") + 1], /An earlier worker session started this task and cannot be resumed/);
});
