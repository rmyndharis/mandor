import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { getAdapter, loadModels, modelsReport, readModelCache, refreshModels } from "../src/adapters/index.ts";
import { createZcodeAdapter, lastJsonObject, REPORT_FORMAT, TESTED_ZCODE_VERSION, zcodeEnv, zcodeHome } from "../src/adapters/zcode.ts";
import { REPORT_SCHEMA } from "../src/brief.ts";
import { DEFAULT_CONFIG, resolveBin } from "../src/config.ts";
import type { Candidate, JobRecord, RawRun } from "../src/contracts.ts";
import { jobDir, jobTmpDir, processStart, projectIdFor, scratchDir } from "../src/home.ts";
import { loadState, loadToolState } from "../src/ledger.ts";
import { emptyProjectConfig, saveProjectConfig } from "../src/provision.ts";
import { reviewPack } from "../src/review.ts";
import { readJob } from "../src/runner.ts";
import { showTask } from "../src/status.ts";
import { dispatch, goalStart, verdictFix } from "../src/tasks.ts";
import { readZcodeLog, temp, tempHome, tempRepo, writeZcodeConfig, writeZcodeScenarios, zcodeSignIn } from "./helpers.ts";

const FAKE = join(import.meta.dirname, "fake-bin", "fake-zcode.mjs");
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "zcode", name), "utf8");
const SESSION = "sess_00000000-0000-7000-8000-000000000a01";
const PLAN = "account:zai-individual-coding-plan";

function config() {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tools.zcode = { ...cfg.tools.zcode, enabled: true, bin: FAKE };
  return cfg;
}
const zcode = () => createZcodeAdapter(config());

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j-20261110100000-ab12", projectId: "demo-000000000000", taskId: "t1", seq: 1, kind: "start",
    candidate: { tool: "zcode", model: "GLM-5.3-Flash", effort: "high" }, worktree: "/tmp/wt", sessionId: null,
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
// A finished run as the CLI prints it, reduced to the events the adapter reads.
const finished = (response: string, modelId = "GLM-5.3-Flash") => jsonl([
  { type: "turn.started", sessionId: SESSION, payload: {} },
  { type: "session.updated", sessionId: SESSION, payload: { messageCount: 6, providerId: PLAN, modelId, toolCount: 34 } },
  { type: "turn.completed", sessionId: SESSION, payload: { response, resultType: "success" } },
  { type: "result", sessionId: SESSION, response, usage: { inputTokens: 10, outputTokens: 2, source: "provider" } },
]);
const failed = (error: object) => jsonl([
  { type: "turn.started", sessionId: SESSION, payload: {} },
  { type: "turn.failed", sessionId: SESSION, payload: { error } },
]);

test("classify reads a real finished run: its session, its report, the model that ran and the usage of that run alone", () => {
  const r = zcode().classify(raw(fixture("start-ok.jsonl")));
  assert.equal(r.status, "done");
  assert.equal(r.sessionId, SESSION);
  assert.equal(r.report?.status, "done");
  assert.deepEqual(r.report?.files_changed, ["hello.txt"]);
  assert.equal(r.model, "GLM-5.3-Flash");
  assert.deepEqual(r.usageCumulative, { modelRequestCount: 3, inputTokens: 37782, outputTokens: 175, totalTokens: 37957, cacheReadTokens: 25024, cacheWriteTokens: 0, reasoningTokens: 0, webFetchRequests: 0, webSearchRequests: 0 });
  assert.equal(r.usagePerRun, true, "this tool counts a run's own usage, not the session's sum");
  assert.deepEqual([r.detail, r.exitCode, r.creditFunded, r.resetsAt], ["", 0, false, null]);
  const resumed = zcode().classify(raw(fixture("resume-ok.jsonl")));
  assert.deepEqual([resumed.status, resumed.sessionId, resumed.report?.status], ["done", SESSION, "done"]);
});

test("the report is the last JSON object of the answer, whatever prose or code fence surrounds it", () => {
  const body = JSON.stringify(REPORT, null, 2);
  for (const response of [body, `I skipped step 3.\n\n\`\`\`json\n${body}\n\`\`\`\n`, `First try: {"status":"nope"}\nFinal:\n${body}\nThanks.`]) {
    const r = zcode().classify(raw(finished(response)));
    assert.equal(r.status, "done", response);
    assert.deepEqual(r.report, REPORT);
  }
  assert.deepEqual(lastJsonObject('a {"x":{"y":1}} b {"z":[{"k":"}"}]} c'), { z: [{ k: "}" }] });
  assert.equal(lastJsonObject("no object here"), null);
  assert.equal(lastJsonObject("{ broken"), null);
});

test("a report followed by braces in prose, or by an object that is not a report, is still the report", () => {
  const body = JSON.stringify(REPORT);
  const sample = "if (a) {\n  if (b) {\n    x();\n  }\n}\n".repeat(6);
  const tails = ["\nSee `if (x) { return; }` above.", "\nAn empty object {} means nothing.", '\nA string such as "}" is fine.', '\n{"status":"nope"}', `\n${"}".repeat(20)}`, `\n${sample}`];
  for (const tail of tails) {
    const r = zcode().classify(raw(finished(body + tail)));
    assert.equal(r.status, "done", tail);
    assert.deepEqual(r.report, REPORT, tail);
  }
  // With no test for the report, the last object that parses is returned, a stray {} included.
  assert.deepEqual(lastJsonObject('{"a":1} tail {}'), {});
  assert.deepEqual(lastJsonObject('{"a":1} tail {}', (v) => "a" in v), { a: 1 });
});

test("the report is found whatever its own strings hold and whatever braces, quotes or objects come around it", () => {
  const tricky = { ...REPORT, summary: 'Closed the "}" and a {block}, a backslash \\ and a quote \\" inside' };
  const text = JSON.stringify(tricky);
  const answers = {
    "braces and quotes inside its strings": `${text}\nDone }.`,
    "a quote that never closes before it": `He said "hi and left. ${text}`,
    "an opening brace that never closes before it": `Format {a, b:\n${text}`,
    "an opening brace that closes after it": `{ see below\n${text}\n}`,
    "a wrapper object that is not a report": `{"report":${text}}`,
    "an object that opens with a key and is not JSON": `{"format" follows: ${text}}`,
  };
  for (const [name, answer] of Object.entries(answers)) {
    const r = zcode().classify(raw(finished(answer)));
    assert.equal(r.status, "done", name);
    assert.deepEqual(r.report, tricky, name);
  }
  const later = { ...REPORT, summary: "Second." };
  assert.deepEqual(zcode().classify(raw(finished(`${JSON.stringify(REPORT)}\n${JSON.stringify(later)}`))).report, later, "the later of two reports wins");
});

test("a long run of opening braces that cannot start an object does not slow the search for the report", () => {
  const started = Date.now();
  const r = zcode().classify(raw(finished(`${"{ ".repeat(50_000)}${JSON.stringify(REPORT)}`)));
  assert.equal(r.status, "done");
  assert.deepEqual(r.report, REPORT);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test("a finished run without a report that fits the schema is a failure, and so is a stream that ends early", () => {
  for (const response of ["All done!", '{"status":"done"}', ""]) {
    const r = zcode().classify(raw(finished(response)));
    assert.deepEqual([r.status, r.detail, r.sessionId], ["failed", "report not valid JSON", SESSION], response);
  }
  const cut = zcode().classify(raw(jsonl([{ type: "turn.started", sessionId: SESSION, payload: {} }])));
  assert.deepEqual([cut.status, cut.detail, cut.sessionId], ["failed", "stream ended early", SESSION]);
  const nonZero = zcode().classify(raw(finished(JSON.stringify(REPORT)), { exitCode: 1 }));
  assert.deepEqual([nonZero.status, nonZero.detail], ["failed", "exit 1 after the run finished; see stderr.log"]);
});

test("a failed turn is a quota stop for the provider's limit codes and a plain failure otherwise, with ids masked", () => {
  const withCode = (code: number | string, message = "limit reached") => failed({ message, attribution: { providerErrorCode: code } });
  for (const code of [1113, 1308, 1309, 1310, 1313, 1316, 1317, 1318, 1319, 1320, 1321, "1308"]) {
    const r = zcode().classify(raw(withCode(code), { exitCode: 1 }));
    assert.deepEqual([r.status, r.sessionId, r.exitCode], ["quota", SESSION, 1], String(code));
    assert.equal(r.detail, `provider code ${code}: limit reached`);
  }
  for (const code of [1311, 1302, 500]) assert.equal(zcode().classify(raw(withCode(code), { exitCode: 1 })).status, "failed", String(code));
  const masked = zcode().classify(raw(failed({ message: "bad request 00000000-0000-7000-8000-00000000beef for user-ABCDEFGHIJKLMNOPQRSTUV" }), { exitCode: 1 }));
  assert.deepEqual([masked.status, masked.detail], ["failed", "bad request <id> for <id>"]);
  assert.equal(zcode().classify(raw(failed({}), { exitCode: 1 })).detail, "turn failed");
});

const SIGN_IN = "the zcode worker's sign-in is no longer valid: run mandor login zcode, then mandor ready zcode";

test("a sign-in that stopped working sets the tool aside as a spent quota does, so its tasks can move to another tool", () => {
  // What the CLI reports about an hour after a sign-in: the turn fails while it prepares the request.
  const expired = zcode().classify(raw(failed({ type: "unknown_error", code: "model_request_failed", message: "project_token_login_failed", attribution: { errorPhase: "prepare" } }), { exitCode: 1 }));
  assert.deepEqual([expired.status, expired.detail, expired.sessionId], ["quota", SIGN_IN, SESSION]);
  // Another failure of the same phase is no sign-in problem.
  assert.equal(zcode().classify(raw(failed({ code: "model_request_failed", message: "socket hang up" }), { exitCode: 1 })).status, "failed");
});

test("a run that printed no event says only what fixed phrases on stderr mean, and never copies stderr", () => {
  const SECRET = "SECRET_TOKEN_123";
  const signedOut = zcode().classify(raw("", { exitCode: 1, stderr: `Error: Select a model before sending a message (traceId: x)\n${SECRET}\n` }));
  assert.deepEqual([signedOut.status, signedOut.detail, signedOut.sessionId], ["quota", SIGN_IN, null]);
  const other = zcode().classify(raw("", { exitCode: 1, stderr: `${SECRET}\n` }));
  assert.deepEqual([other.status, other.detail], ["failed", "exit 1; see stderr.log"]);
  const killed = zcode().classify(raw("", { exitCode: null, signal: "SIGKILL" }));
  assert.equal(killed.detail, "exit SIGKILL; see stderr.log");
});

test("refine fails a finished run that ran on another model than the job's, which the CLI does without a word", () => {
  const a = zcode();
  const done = a.classify(raw(finished(JSON.stringify(REPORT))));
  assert.equal(a.refine(done, job()).status, "done");
  const other = a.classify(raw(finished(JSON.stringify(REPORT), "GLM-5.3")));
  assert.deepEqual([other.status, other.model], ["done", "GLM-5.3"]);
  const refined = a.refine(other, job());
  assert.deepEqual([refined.status, refined.detail, refined.report], ["failed", "ran on GLM-5.3, not on GLM-5.3-Flash", null]);
  const unknown = a.refine({ ...done, model: null }, job());
  assert.deepEqual([unknown.status, unknown.detail], ["failed", "ran on an unnamed model, not on GLM-5.3-Flash"]);
  // A failure keeps its own reason.
  const quota = a.classify(raw(failed({ message: "x", attribution: { providerErrorCode: 1308 } }), { exitCode: 1 }));
  assert.equal(a.refine(quota, job()).status, "quota");
});

test("refine fails a resume that opened another session as an account mismatch, and leaves a start and an unnamed session alone", () => {
  const a = zcode();
  const done = a.classify(raw(finished(JSON.stringify(REPORT))));
  assert.equal(done.status, "done");
  const asked = "00000000-0000-7000-8000-0000000000aa";
  const resumed = (sessionId: string | null, kind: "start" | "resume" = "resume") => a.refine({ ...done, sessionId }, job({ kind, sessionId: asked }));
  assert.equal(resumed(asked).status, "done", "the session that was asked for");
  const lost = resumed("00000000-0000-7000-8000-0000000000bb");
  assert.deepEqual([lost.status, lost.report, lost.detail], ["account-mismatch", null, "the session was not resumed, so the run started a new one"]);
  assert.equal(resumed("00000000-0000-7000-8000-0000000000bb", "start").status, "done", "a start has no session to lose");
  assert.equal(resumed(null).status, "done", "a run that names no session proves nothing");
});

// inJobDir: the job's files are in the job's own directory, where the profile can read the temporary directory that lies in it.
// linked: the state home is reached through a link, as a MANDOR_HOME spelled with /tmp or /var is.
function prepared(over: Partial<JobRecord> = {}, project: { network: boolean; addDirs: string[]; sharedTemp?: boolean } = { network: true, addDirs: [] }, inJobDir = false, linked = false) {
  let home = tempHome();
  if (linked) {
    const link = join(temp("mandor-zlink-"), "home");
    symlinkSync(home, link);
    process.env.MANDOR_HOME = link;
    home = link;
  }
  zcodeSignIn();
  const dir = inJobDir ? join(home, "jobs", job(over).id) : temp("mandor-zjob-");
  mkdirSync(dir, { recursive: true });
  const promptPath = join(dir, "prompt.md");
  writeFileSync(promptPath, "Do the task.\nSecond line with a \"quote\".\n");
  const worktree = temp("mandor-zwt-");
  const j = job({ promptPath, worktree, ...over });
  const run = zcode().prepare(j, { schemaPath: join(dir, "schema.json"), lastMessagePath: join(dir, "last-message.json") }, project);
  return { home, dir, run, worktree, j };
}

test("prepare runs the CLI inside sandbox-exec, with the worker's own HOME, the prompt as its argument and the job's model in a file of its own", () => {
  const { home, dir, run, worktree, j } = prepared();
  const workerHome = join(home, "zcode", "home");
  assert.equal(zcodeHome(), workerHome);
  assert.equal(run.command, "/usr/bin/sandbox-exec");
  const at = run.args.indexOf(FAKE);
  assert.ok(at > 0, "the worker binary follows the sandbox's own arguments");
  assert.deepEqual(run.args.slice(at + 1), [
    "-p", `Do the task.\nSecond line with a "quote".\n${REPORT_FORMAT}`, "--output-format", "stream-json", "--mode", "yolo",
    "--disallowed-tools", "AskUserQuestion EnterPlanMode ExitPlanMode Skill",
  ]);
  assert.equal(run.stdinFile, undefined);
  // The CLI enforces no schema, so the prompt itself must say what the report holds: every key, at every level.
  const keys = (schema: { properties?: Record<string, unknown>; items?: unknown }): string[] =>
    [...Object.entries(schema.properties ?? {}).flatMap(([k, v]) => [k, ...keys(v as never)]), ...(schema.items ? keys(schema.items as never) : [])];
  for (const key of keys(REPORT_SCHEMA)) assert.ok(REPORT_FORMAT.includes(`"${key}"`), key);
  assert.ok(keys(REPORT_SCHEMA).length >= 14);
  // The sandbox: a profile, and the paths it may write as parameters, never spliced into the profile text.
  const sandbox = run.args.slice(0, at);
  assert.ok(sandbox.includes(`WT=${worktree}`) && sandbox.includes(`WH=${workerHome}`), sandbox.join(" "));
  const profile = sandbox[sandbox.indexOf("-p") + 1];
  assert.match(profile, /^\(version 1\)\(allow default\)\(deny file-write\*\)/);
  assert.ok(!profile.includes(worktree) && !profile.includes(home), "paths are parameters");
  // The shared temporary directories are closed: the job's own is the one a command may write besides the worktree.
  assert.ok(sandbox.includes(`JT=${jobTmpDir(j.id)}`), sandbox.join(" "));
  assert.doesNotMatch(profile, /\/private\/tmp|\/private\/var\/folders/);
  assert.deepEqual([run.env.TMPDIR, run.env.TMPPREFIX, run.env.CLANG_MODULE_CACHE_PATH, run.env.JAVA_TOOL_OPTIONS], [jobTmpDir(j.id), `${jobTmpDir(j.id)}/zsh`, `${jobTmpDir(j.id)}/clang-modules`, `-Djava.io.tmpdir=${jobTmpDir(j.id)}`]);
  // Contents only: a path's own metadata stays readable, as opening a database resolves every directory above it.
  assert.match(profile, /\(deny file-read-data /);
  assert.doesNotMatch(profile, /deny file-read\*/);
  // The environment: the job's, with HOME moved and the two provider files.
  assert.equal(run.env.HOME, workerHome);
  assert.equal(run.env.PATH, "/usr/bin:/bin");
  assert.equal(run.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, join(workerHome, "zcode-builtin.json"));
  assert.ok(existsSync(run.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE), "the catalog is copied to where the worker may lock it");
  const personal = run.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  assert.equal(dirname(personal), dir);
  assert.deepEqual(JSON.parse(readFileSync(personal, "utf8")).config.defaultModelSelection, { providerId: PLAN, modelId: "GLM-5.3-Flash", options: { reasoningLevel: "high" } });
  assert.equal(run.env.ELECTRON_RUN_AS_NODE, undefined, "only an app bundle is started as Node");
});

// What a command writes under the profile of a prepared run, each place by its own file, which is then removed.
function writes(run: { args: string[]; env: Record<string, string> }, places: Record<string, string>): string[] {
  const at = run.args.indexOf(FAKE);
  const mark = `mandor-zprobe-${process.pid}`;
  const probe = Object.entries(places).map(([name, dir]) => `echo x > "${dir}/${mark}" 2>/dev/null && echo ${name}-ok || echo ${name}-denied`).join("; ");
  const r = spawnSync("/usr/bin/sandbox-exec", [...run.args.slice(0, at), "/bin/sh", "-c", probe], { env: run.env, encoding: "utf8" });
  for (const dir of Object.values(places)) rmSync(join(dir, mark), { force: true });
  return r.stdout.trim().split("\n");
}

const SHARED = () => ({ tmp: "/tmp", shared: realpathSync(tmpdir()), cache: realpathSync(spawnSync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { encoding: "utf8" }).stdout.trim()) });

test("under the profile a command writes the worktree and the job's own temporary directory, and none of /tmp, the shared temporary directory and the per-user cache directory", () => {
  const { run, worktree, j } = prepared();
  const own = jobTmpDir(j.id);
  mkdirSync(own, { recursive: true });
  assert.deepEqual(writes(run, { wt: worktree, own, ...SHARED() }), ["wt-ok", "own-ok", "tmp-denied", "shared-denied", "cache-denied"]);
});

test("the profile names the paths under the state home as they really are, so a home reached through a link keeps the worker's home and temporary directory writable and the rest unreadable", () => {
  const { run, worktree, j, home } = prepared({}, { network: true, addDirs: [] }, true, true);
  const own = jobTmpDir(j.id);
  mkdirSync(own, { recursive: true });
  assert.deepEqual(writes(run, { wt: worktree, own, home: zcodeHome() }), ["wt-ok", "own-ok", "home-ok"]);
  const secret = join(realpathSync(home), "secret.txt");
  writeFileSync(secret, "state\n");
  const at = run.args.indexOf(FAKE);
  const read = spawnSync("/usr/bin/sandbox-exec", [...run.args.slice(0, at), "/bin/cat", join(home, "secret.txt")], { env: run.env, encoding: "utf8" });
  assert.deepEqual([read.status === 0, read.stdout], [false, ""], "the state home is closed to reads, whichever way it is spelled");
});

test("a here-document of zsh works under the profile with the environment prepare gives, and fails without TMPPREFIX", () => {
  const { run, worktree, j } = prepared({}, { network: true, addDirs: [] }, true);
  mkdirSync(jobTmpDir(j.id), { recursive: true });
  const at = run.args.indexOf(FAKE);
  const heredoc = `cd "${worktree}" && cat > h.txt <<'EOT'\nzsh here-document\nEOT\necho rc=$?`;
  const under = (env: Record<string, string>) => spawnSync("/usr/bin/sandbox-exec", [...run.args.slice(0, at), "/bin/zsh", "-c", heredoc], { env, encoding: "utf8" });
  const { TMPPREFIX: _, ...without } = run.env;
  assert.match(under(run.env).stdout, /rc=0/);
  assert.match(under(without).stderr, /can't create temp file for here document/);
});

test("a project that keeps the shared temporary directories open gets the profile and the environment it had", () => {
  const { run, worktree, home } = prepared({}, { network: true, addDirs: [], sharedTemp: true });
  assert.deepEqual(writes(run, { wt: worktree, ...SHARED() }), ["wt-ok", "tmp-ok", "shared-ok", "cache-ok"]);
  assert.equal(run.env.TMPPREFIX, undefined);
  assert.ok(!run.args.some((a) => a.startsWith("JT=")), "no directory of its own");
  assert.ok(home.length > 0);
});

test("prepare names the root it is handed and never follows a link at it: the runner has verified the root", () => {
  const link = join(temp("mandor-zlink-"), "wt");
  symlinkSync(temp("mandor-zsib-"), link);
  const { run } = prepared({ worktree: link });
  assert.ok(run.args.includes(`WT=${link}`), run.args.join(" "));
});

test("prepare resumes a session by its id, and refuses an id of another shape, a missing effort, a closed network and a prompt too long for an argument", () => {
  const { run } = prepared({ kind: "resume", sessionId: SESSION });
  const at = run.args.indexOf(FAKE);
  assert.deepEqual(run.args.slice(at + 1, at + 3), ["--resume", SESSION]);
  assert.throws(() => prepared({ kind: "resume", sessionId: "00000000-0000-7000-8000-000000000a01" }), /zcode resume needs a session id/);
  assert.throws(() => prepared({ kind: "resume", sessionId: null }), /zcode resume needs a session id/);
  assert.throws(() => prepared({ candidate: { tool: "zcode", model: "GLM-5.3", effort: "" } }), /zcode candidate needs an effort/);
  assert.throws(() => prepared({}, { network: false, addDirs: [] }), /zcode workers need the network.*project setup --update --worker-network/);
  const dir = temp("mandor-zlong-");
  // The limit is on the argument as sent, the report format included.
  writeFileSync(join(dir, "prompt.md"), "x".repeat(200_001 - Buffer.byteLength(REPORT_FORMAT)));
  assert.throws(() => prepared({ promptPath: join(dir, "prompt.md") }), /prompt of 200001 bytes is too long for zcode/);
});

test("an app bundle is started as Node with its script, and its catalog is the bundle's", () => {
  const home = tempHome();
  zcodeSignIn();
  const app = join(temp("mandor-zapp-"), "ZCode.app", "Contents");
  mkdirSync(join(app, "MacOS"), { recursive: true });
  mkdirSync(join(app, "Resources", "config", "provider"), { recursive: true });
  writeFileSync(join(app, "MacOS", "ZCode"), "");
  writeFileSync(join(app, "Resources", "config", "provider", "zcode-builtin.json"), readFileSync(join(dirname(FAKE), "provider", "zcode-builtin.json")));
  const cfg = config();
  cfg.tools.zcode.bin = join(app, "MacOS", "ZCode");
  const dir = temp("mandor-zjob-");
  writeFileSync(join(dir, "prompt.md"), "hi");
  const j = job({ bin: cfg.tools.zcode.bin, promptPath: join(dir, "prompt.md"), worktree: temp("mandor-zwt-") });
  const run = createZcodeAdapter(cfg).prepare(j, { schemaPath: join(dir, "schema.json"), lastMessagePath: join(dir, "l.json") }, { network: true, addDirs: [] });
  const at = run.args.indexOf(j.bin);
  assert.deepEqual(run.args.slice(at, at + 3), [j.bin, join(app, "Resources", "glm", "zcode.cjs"), "-p"]);
  assert.equal(run.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(readFileSync(join(home, "zcode", "home", "zcode-builtin.json"), "utf8"), readFileSync(join(app, "Resources", "config", "provider", "zcode-builtin.json"), "utf8"));
});

test("the catalog copy in the worker home is readable by the user only, and stays so when it is copied again", () => {
  tempHome();
  const dir = temp("mandor-zcatalog-");
  mkdirSync(join(dir, "provider"));
  const catalog = join(dir, "provider", "zcode-builtin.json");
  writeFileSync(catalog, "{}");
  chmodSync(catalog, 0o644);
  for (const call of ["first", "second"]) {
    zcodeEnv(join(dir, "bin"), {});
    assert.equal(statSync(join(zcodeHome(), "zcode-builtin.json")).mode & 0o777, 0o600, `after the ${call} copy`);
  }
});

test("detectModels lists the signed-in plan's enabled models with the levels the catalog's last matching rule gives", () => {
  tempHome();
  assert.throws(() => zcode().detectModels(), /zcode worker is not signed in: run mandor login zcode/);
  zcodeSignIn();
  const models = zcode().detectModels();
  assert.deepEqual(models.map((m) => [m.tool, m.model, m.efforts.join("/"), m.defaultEffort, m.hidden]), [
    ["zcode", "GLM-5.3", "low/high/max", null, false],
    ["zcode", "GLM-5.3-Flash", "low/high/max", null, false],
    ["zcode", "GLM-5.2", "disabled/high/max", null, false],
    ["zcode", "GLM-5-Turbo", "disabled/enabled", null, false],
  ]);
  zcodeSignIn("account:zai-start-plan");
  assert.deepEqual(zcode().detectModels().map((m) => m.model), ["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"]);
  zcodeSignIn("account:no-such-plan");
  assert.throws(() => zcode().detectModels(), /the zcode catalog lists no model for account:no-such-plan/);
});

test("what zcode's version call prints on stderr goes to a private log and nowhere else", () => {
  const home = tempHome();
  mkdirSync(join(home, "zcode", "home", "fake"), { recursive: true });
  writeFileSync(join(home, "zcode", "home", "fake", "stderr"), "refreshing auth SECRET_TOKEN_123\n");
  assert.equal(zcode().version(), TESTED_ZCODE_VERSION);
  const log = join(home, "logs", "vendor.stderr");
  assert.match(readFileSync(log, "utf8"), /^\S+ zcode .*--version\nrefreshing auth SECRET_TOKEN_123\n/m);
  assert.equal(statSync(log).mode & 0o777, 0o600);
});

test("version asks the CLI, and resolveBin gives each tool its own binary", () => {
  tempHome();
  assert.equal(zcode().version(), TESTED_ZCODE_VERSION);
  assert.equal(resolveBin("zcode", config()), FAKE);
  assert.equal(resolveBin("zcode", DEFAULT_CONFIG), "/Applications/ZCode.app/Contents/MacOS/ZCode", "a bare name means the app");
  assert.equal(resolveBin("codex", config()), process.env.MANDOR_CODEX_BIN);
});

// The core, with the tool next to codex

const LAUNCHER = join(import.meta.dirname, "..", "bin", "mandor");
const FLASH: Candidate = { tool: "zcode", model: "GLM-5.3-Flash", effort: "high" };
const GOAL = "feat/second-tool";

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

// A project whose workers may use the network, with a goal, and zcode signed in and switched on.
function project(t: TestContext, opts: { network?: boolean; signedIn?: boolean } = {}) {
  const home = tempHome();
  writeZcodeConfig(home);
  if (opts.signedIn ?? true) zcodeSignIn();
  t.after(() => reap(home));
  const repo = tempRepo();
  const id = projectIdFor(repo);
  saveProjectConfig(id, { ...emptyProjectConfig(), workerNetwork: opts.network ?? true });
  const briefFile = join(scratchDir(id, "t"), "brief.md");
  writeFileSync(briefFile, "Create the file.\n");
  goalStart(repo, GOAL, null);
  const send = (slug: string, use: Candidate | null = FLASH) => dispatch(repo, { goal: GOAL, slug, tier: "light", briefFile, scope: [], use, after: null });
  return { home, repo, id, send, briefFile };
}

test("the catalog holds every enabled tool's models, and a tool that cannot list its own keeps the others and its last list", () => {
  const home = tempHome();
  writeZcodeConfig(home);
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(getAdapter("zcode", cfg).tool, "zcode");
  // Not signed in yet: codex is listed, and the report says what zcode lacks.
  const first = refreshModels(cfg);
  assert.deepEqual([...new Set(first.map((m) => m.tool))], ["codex"]);
  assert.ok(modelsReport(cfg, true).warnings.includes("zcode: zcode worker is not signed in: run mandor login zcode"), JSON.stringify(modelsReport(cfg, true).warnings));
  zcodeSignIn();
  const both = refreshModels(cfg);
  assert.deepEqual([...new Set(both.map((m) => m.tool))], ["codex", "zcode"]);
  assert.deepEqual(both.filter((m) => m.tool === "zcode").map((m) => m.model), ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"]);
  const cache = readModelCache()!;
  assert.deepEqual(cache.versions, { codex: "0.166.0", zcode: TESTED_ZCODE_VERSION });
  assert.equal(cache.codexVersion, "0.166.0");
  assert.ok(!modelsReport(cfg, true).warnings.some((w) => w.startsWith("zcode")), "nothing to say about a tool that works at its tested version");
  // The sign-in goes away: the zcode models listed last stay, as a routed task may hold one.
  zcodeSignIn("account:no-such-plan");
  const kept = refreshModels(cfg);
  assert.deepEqual(kept.filter((m) => m.tool === "zcode").map((m) => m.model), ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"]);
  assert.deepEqual(loadModels(60_000, cfg), kept);
  // A tool that is off is never asked.
  cfg.tools.zcode.enabled = false;
  assert.deepEqual([...new Set(refreshModels(cfg).map((m) => m.tool))], ["codex"]);
});

test("a task sent to zcode runs in its worktree under the worker's own HOME, and a fix resumes its session", async (t) => {
  const p = project(t);
  writeZcodeScenarios([
    { writeFile: [{ path: "hello.txt", content: "hello\n" }], commands: ["ls -a"] },
    { writeFile: [{ path: "hello.txt", content: "hello\nworld\n" }] },
  ]);
  const { task } = p.send("hello");
  assert.deepEqual([task.status, task.candidate], ["working", FLASH]);
  assert.ok(await until(() => loadState(p.id).tasks.hello.status === "needs-review"), showTask(p.id, "hello"));
  const done = loadState(p.id).tasks.hello;
  assert.equal(done.sessionId, "sess_00000000-0000-7000-8000-000000000b01");
  assert.equal(readFileSync(join(done.worktree!, "hello.txt"), "utf8"), "hello\n");
  const job1 = readJob(done.jobIds[0])!;
  assert.equal(job1.bin, join(import.meta.dirname, "fake-bin", "fake-zcode.mjs"));
  const [run1] = readZcodeLog();
  assert.equal(run1.env.HOME, join(p.home, "zcode", "home"));
  assert.equal(run1.cwd, realpathSync.native(done.worktree!));
  assert.equal(run1.env.MANDOR_JOB, job1.id);
  assert.equal(run1.argv[run1.argv.indexOf("-p") + 1], readFileSync(done.briefPath, "utf8") + REPORT_FORMAT, "the prompt is the rendered brief and the report's format");
  assert.deepEqual(JSON.parse(readFileSync(join(jobDir(job1.id), "zcode-provider.json"), "utf8")).config.defaultModelSelection.modelId, "GLM-5.3-Flash");

  const notes = join(scratchDir(p.id, "t"), "notes.md");
  writeFileSync(notes, "Add a second line.\n");
  verdictFix(p.repo, "hello", notes);
  assert.ok(await until(() => loadState(p.id).tasks.hello.status === "needs-review" && loadState(p.id).tasks.hello.seq === 2), showTask(p.id, "hello"));
  const run2 = readZcodeLog()[1];
  assert.deepEqual(run2.argv.slice(0, 2), ["--resume", "sess_00000000-0000-7000-8000-000000000b01"]);
  assert.equal(readFileSync(join(done.worktree!, "hello.txt"), "utf8"), "hello\nworld\n");
  // Each run's usage is its own: the second is not reduced by the first.
  const jobs = showTask(p.id, "hello").split("\n").filter((l) => l.startsWith("  j-"));
  assert.equal(jobs.length, 2);
  for (const line of jobs) assert.match(line, / zcode:GLM-5\.3-Flash@high done: modelRequestCount 1, inputTokens 1200, outputTokens 80$/);
  // The commands the report claims are checked against the ones the log shows.
  assert.deepEqual(reviewPack(p.repo, "hello").redFlags.filter((f) => f.kind === "unrun-claim"), []);
});

test("a zcode run on another model than the job's stalls the task, and a quota stop marks the tool exhausted", async (t) => {
  const p = project(t);
  writeZcodeScenarios([{ model: "GLM-5.3" }, { kind: "quota" }]);
  p.send("wrong");
  assert.ok(await until(() => loadState(p.id).tasks.wrong.status === "stalled"), showTask(p.id, "wrong"));
  assert.match(showTask(p.id, "wrong"), /last outcome: failed: ran on GLM-5\.3, not on GLM-5\.3-Flash/);
  p.send("spent");
  assert.ok(await until(() => loadState(p.id).tasks.spent.status === "stalled"), showTask(p.id, "spent"));
  assert.match(showTask(p.id, "spent"), /last outcome: quota: provider code 1308: usage limit reached/);
  assert.deepEqual(Object.keys(loadToolState(Date.now() / 1000)), ["zcode"]);
});

test("a claimed command the zcode log does not show is flagged", async (t) => {
  const p = project(t);
  const report = { status: "done", summary: "Done.", files_changed: ["a.txt"], commands_run: [{ command: "npm test", exit_code: 0, summary: "passed" }, { command: "ls -a", exit_code: 0, summary: "listed" }],
    tests: { ran: true, passed: 3, failed: 0, notes: "" }, open_issues: [], questions_for_lead: [] };
  writeZcodeScenarios([{ writeFile: [{ path: "a.txt", content: "a\n" }], commands: ["ls -a"], response: JSON.stringify(report) }]);
  p.send("claim");
  assert.ok(await until(() => loadState(p.id).tasks.claim.status === "needs-review"), showTask(p.id, "claim"));
  assert.deepEqual(reviewPack(p.repo, "claim").redFlags.filter((f) => f.kind === "unrun-claim"), [{ kind: "unrun-claim", detail: "commands_run[0] has no command_execution item in the job's raw.log" }]);
});

test("dispatch refuses while an enabled tool's binary is missing, and a zcode candidate in a project without the network", (t) => {
  const p = project(t, { network: false });
  writeZcodeScenarios([{}]);
  assert.throws(() => p.send("closed"), /^Error: cannot use zcode:GLM-5.3-Flash@high: zcode needs worker network, which this project does not allow; pass another candidate to --use, or dispatch without it$/);
  assert.equal(loadState(p.id).tasks.closed, undefined, "no task is left behind");
  assert.equal(readZcodeLog().length, 0, "the worker never started");
  const cfg = JSON.parse(readFileSync(join(p.home, "config.json"), "utf8"));
  cfg.tools.zcode.bin = "/nonexistent/zcode";
  writeFileSync(join(p.home, "config.json"), JSON.stringify(cfg));
  assert.throws(() => p.send("gone"), /zcode not found at \/nonexistent\/zcode/);
  assert.throws(() => p.send("gone", null), /zcode not found at \/nonexistent\/zcode/);
});

test("login zcode signs the worker in under its own HOME and says which plan, and any other tool is refused", () => {
  const home = tempHome();
  writeZcodeConfig(home);
  mkdirSync(join(home, "zcode", "home", "fake"), { recursive: true });
  const cli = (...args: string[]) => spawnSync(LAUNCHER, args, { encoding: "utf8", env: { PATH: process.env.PATH!, HOME: temp("mandor-zuser-"), MANDOR_HOME: home, MANDOR_CODEX_BIN: process.env.MANDOR_CODEX_BIN!, CODEX_HOME: process.env.CODEX_HOME! } });
  const r = cli("login", "zcode");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { tool: "zcode", home: join(home, "zcode", "home"), provider: "account:zai-individual-coding-plan" });
  const [call] = readZcodeLog();
  assert.deepEqual(call.argv, ["login", "zai"]);
  assert.equal(call.env.HOME, join(home, "zcode", "home"));
  assert.ok(existsSync(call.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE));
  assert.deepEqual(readZcodeLog()[1], undefined);
  assert.deepEqual(cli("login", "zcode", "bigmodel").status, 0);
  assert.deepEqual(readZcodeLog()[1].argv, ["login", "bigmodel"]);
  for (const bad of [["login"], ["login", "codex"], ["login", "zcode", "other"], ["login", "zcode", "zai", "x"]]) {
    const b = cli(...bad);
    assert.deepEqual([b.status, b.stdout], [2, ""], bad.join(" "));
  }
});

test("login zcode --api-key stores a key piped in, as the CLI reads one, without starting the CLI or printing the key", () => {
  const home = tempHome();
  writeZcodeConfig(home);
  const workerHome = join(home, "zcode", "home");
  mkdirSync(join(workerHome, "fake"), { recursive: true });
  const KEY = "test-key.0123456789abcdef";
  const cli = (input: string, ...args: string[]) => spawnSync(LAUNCHER, args, { encoding: "utf8", input, env: { PATH: process.env.PATH!, HOME: temp("mandor-zuser-"), MANDOR_HOME: home, MANDOR_CODEX_BIN: process.env.MANDOR_CODEX_BIN!, CODEX_HOME: process.env.CODEX_HOME! } });
  // An earlier browser sign-in, which the key replaces.
  zcodeSignIn();
  writeFileSync(join(workerHome, ".zcode", "v2", "credentials.json"), JSON.stringify({ "oauth:zai:access_token": "old" }));

  const r = cli(`${KEY}\n`, "login", "zcode", "--api-key");
  assert.equal(r.status, 0, r.stderr);
  const provider = "account:zai-individual-coding-plan";
  assert.deepEqual(JSON.parse(r.stdout), { tool: "zcode", home: workerHome, provider });
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  assert.deepEqual(readZcodeLog(), [], "the CLI is not started");
  const file = join(workerHome, ".zcode", "v2", "credentials.json");
  const identity = `key-${createHash("sha256").update(KEY).digest("hex").slice(0, 24)}`;
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    [`account-provider:${provider}:identity`]: identity,
    [`account-provider:${provider}:auth-source`]: "manual",
    [`account-provider:coding-plan:${provider}:account:${identity}:api-key`]: KEY,
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // The adapter finds the plan as after a browser sign-in.
  assert.deepEqual(zcode().detectModels().map((m) => m.model), ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"]);

  const big = cli(KEY, "login", "zcode", "bigmodel", "--api-key");
  assert.equal(JSON.parse(big.stdout).provider, "account:bigmodel-individual-coding-plan");
  // What is wrong is said, and never what was given: a clipboard that holds a copied command or a page is not a key.
  const EMPTY = "mandor: no API key on stdin: copy the key, then run `pbpaste | mandor login zcode --api-key`\n";
  const NOT_A_KEY = "mandor: the text on stdin is not an API key: it holds spaces or line breaks. Copy the key alone, as the last thing copied, then run `pbpaste | mandor login zcode --api-key`\n";
  for (const [input, message] of [["", EMPTY], ["  \n", EMPTY], ["two words", NOT_A_KEY], ["pbpaste | mandor login zcode --api-key", NOT_A_KEY], ["first\nsecond\n", NOT_A_KEY]]) {
    const bad = cli(input, "login", "zcode", "--api-key");
    assert.deepEqual([bad.status, bad.stdout, bad.stderr], [1, "", message], JSON.stringify(input));
  }
  assert.equal(cli(KEY, "login", "zcode", "--api-key", "--api-key").status, 2);
});
