#!/usr/bin/env node
// A stand-in for the ZCode CLI in tests, steered by files in $HOME/fake/, where HOME is the worker's own:
//   scenarios.json  -p runs; each run claims one entry by creating claims/<index>
//   version         the --version number, 0.17.1 without it
//   log.jsonl       appended: the argv and full environment of every invocation
// A scenario: { model?, response?, kind?: "done" | "quota" | "failed" | "no-result", code?, writeFile?: [{path, content}],
// commands?: [string], exitCode?, delayMs?, stderr? }. A done run answers with a report unless response says otherwise,
// and names the model its provider file asks for unless model says otherwise.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const home = process.env.HOME ?? "";
const control = join(home, "fake");
const SESSION = "sess_00000000-0000-7000-8000-000000000b01";
const REPORT = JSON.stringify({
  status: "done", summary: "Done.", files_changed: [], commands_run: [],
  tests: { ran: false, passed: 0, failed: 0, notes: "" }, open_issues: [], questions_for_lead: [],
});
const read = (name) => (existsSync(join(control, name)) ? readFileSync(join(control, name), "utf8") : null);
const opt = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function claim() {
  const scenarios = JSON.parse(read("scenarios.json") ?? "[]");
  mkdirSync(join(control, "claims"), { recursive: true });
  for (let i = 0; i < scenarios.length; i++) {
    try {
      writeFileSync(join(control, "claims", String(i)), "", { flag: "wx" });
      return scenarios[i];
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  return null;
}

async function run() {
  const s = claim();
  if (s === null) {
    process.stderr.write("fake: no scenario\n");
    return 1;
  }
  // The real CLI starts a session on the default of its personal provider file.
  const asked = JSON.parse(readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "utf8")).config.defaultModelSelection;
  const sessionId = opt("--resume") ?? s.sessionId ?? SESSION;
  const ev = (type, payload) => ({ type, sessionId, payload });
  const events = [ev("turn.started", { intent: { modelSelection: asked } }), ev("session.updated", { messageCount: 1, providerId: asked.providerId, modelId: s.model ?? asked.modelId, toolCount: 3 })];
  for (const command of s.commands ?? []) {
    events.push(ev("tool.updated", { toolCallId: "call_1", toolName: "Bash", input: { command }, kind: "scheduled" }), ev("tool.updated", { toolCallId: "call_1", result: { success: true }, kind: "result" }));
  }
  const kind = s.kind ?? "done";
  if (kind === "quota" || kind === "failed") {
    events.push(ev("turn.failed", { error: { message: kind === "quota" ? "usage limit reached" : "the model call failed", ...(s.code === undefined && kind !== "quota" ? {} : { attribution: { providerErrorCode: s.code ?? 1308 } }) } }));
  } else if (kind === "done") {
    const response = s.response ?? REPORT;
    const usage = { source: "provider", modelRequestCount: 1, inputTokens: 1200, outputTokens: 80 };
    events.push(ev("turn.completed", { response, resultType: "success", usage }), { type: "result", sessionId, response, usage });
  } else if (kind !== "no-result") throw new Error(`fake: unknown kind: ${kind}`);
  const lines = events.map((e) => `${JSON.stringify(e)}\n`);
  if (s.stderr) process.stderr.write(s.stderr);
  process.stdout.write(lines.slice(0, 1).join(""));
  for (const f of s.writeFile ?? []) {
    const p = resolve(f.path); // against the cwd, which the runner binds to the worktree
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }
  if (s.delayMs) await sleep(s.delayMs);
  process.stdout.write(lines.slice(1).join(""));
  return s.exitCode ?? (kind === "quota" || kind === "failed" ? 1 : 0);
}

async function main() {
  if (args[0] === "--version") {
    process.stdout.write(`${read("version")?.trim() ?? "0.17.1"}\n`);
    return 0;
  }
  // Only a test home has this directory, so a stray run never writes into a real home.
  if (!existsSync(control)) {
    process.stderr.write("fake: $HOME/fake does not exist\n");
    return 1;
  }
  appendFileSync(join(control, "log.jsonl"), `${JSON.stringify({ argv: args, env: process.env, cwd: process.cwd() })}\n`);
  if (args[0] === "login") {
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(join(home, ".zcode", "v2", "provider_config.json"), JSON.stringify({ schemaVersion: 1, config: { defaultModelSelection: { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" } } }));
    return 0;
  }
  if (args.includes("-p")) return run();
  process.stderr.write(`fake: unsupported arguments: ${args.join(" ")}\n`);
  return 2;
}

// exitCode, not exit(): stdout to a pipe is asynchronous on macOS and must drain first.
process.exitCode = await main();
