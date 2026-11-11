#!/usr/bin/env node
// A stand-in for the Antigravity CLI in tests, steered by files in <dir>/fake/, where <dir> is its --gemini_dir:
//   scenarios.json  -p runs; each run claims one entry by creating claims/<index>
//   models.json     the ids `models` lists, instead of the default ones
//   version         the --version number, 1.5.2 without it
//   stderr          text that --version and `models` write to stderr
//   log.jsonl       appended: the argv, environment and working directory of every invocation
// A scenario: { kind?: "done" | "denied" | "quota" | "model-limit" | "no-result", report?, response?, model?, usage?,
// forgetConversation?, writeFile?: [{path, content}], commands?: [string], exitCode?, delayMs?, stderr? }.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const dir = args.find((a) => a.startsWith("--gemini_dir="))?.slice("--gemini_dir=".length) ?? "";
const control = join(dir, "fake");
const FIRST = "00000000-0000-7000-8000-000000000d01";
const REPORT = {
  status: "done", summary: "Done.", files_changed: [], commands_run: [],
  tests: { ran: false, passed: 0, failed: 0, notes: "" }, open_issues: [], questions_for_lead: [],
};
const MODELS = ["gemini-4-argon-high", "gemini-4-argon-medium", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "claude-sonnet-5-5-high", "gpt-oss-120b"];
const NO_USAGE = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };
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
  const asked = opt("--conversation");
  // The real CLI starts a new conversation, with a warning, when the one it is asked for is gone.
  const conversation_id = asked === undefined ? FIRST : s.forgetConversation ? "00000000-0000-7000-8000-000000000d02" : asked;
  if (asked !== undefined && s.forgetConversation) process.stderr.write(`warning: conversation "${asked}" not found\n`);
  const kind = s.kind ?? "done";
  const events = [{ event: "init", conversation_id, init: { model: s.model ?? opt("--model"), cwd: process.cwd(), permission_mode: "request-review" } }];
  for (const [i, CommandLine] of (s.commands ?? []).entries()) {
    events.push({ event: "step_update", step_update: { conversation_id, step_index: i + 1, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine }, output: "Command exited with code 0." } } });
  }
  const usage = s.usage ?? { ...NO_USAGE, input_tokens: asked === undefined ? 1000 : 2500, output_tokens: asked === undefined ? 50 : 90 };
  const result = (fields) => events.push({ event: "result", result: { conversation_id, duration_seconds: 1, num_turns: asked === undefined ? 1 : 2, usage, ...fields } });
  if (kind === "done") {
    const report = s.report ?? REPORT;
    result(s.response === undefined ? { status: "SUCCESS", response: `${JSON.stringify(report)}\n`, structured_output: report } : { status: "SUCCESS", response: s.response });
  } else if (kind === "denied") result({ status: "SUCCESS", response: "", denied_actions: [{ action: "write_file", display_name: "WriteFile" }, { action: "command", display_name: "RunCommand" }] });
  else if (kind === "quota" || kind === "model-limit") {
    process.stderr.write(`AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED","retryable":false,"reason":"${kind === "quota" ? "QUOTA_EXHAUSTED" : "You have exhausted your quota on this model."}"}\n`);
    result({ status: "ERROR", response: "", usage: NO_USAGE });
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
  return s.exitCode ?? (kind === "quota" || kind === "model-limit" ? 3 : 0);
}

async function main() {
  if (args.includes("--version")) {
    if (read("stderr") !== null) process.stderr.write(read("stderr"));
    process.stdout.write(`${read("version")?.trim() ?? "1.5.2"}\n`);
    return 0;
  }
  // Only a test home has this directory, so a stray run never writes into a real one.
  if (!existsSync(control)) {
    process.stderr.write("fake: <gemini_dir>/fake does not exist\n");
    return 1;
  }
  appendFileSync(join(control, "log.jsonl"), `${JSON.stringify({ argv: args, env: process.env, cwd: process.cwd() })}\n`);
  if (args.includes("models") && !args.includes("-p")) {
    if (read("stderr") !== null) process.stderr.write(read("stderr"));
    const ids = JSON.parse(read("models.json") ?? JSON.stringify(MODELS));
    process.stdout.write(`${JSON.stringify({ conversation_id: "", status: "SUCCESS", response: null, num_turns: 0, usage: NO_USAGE, command: { name: "models", data: { models: ids.map((id) => ({ id, label: id })) } } })}\n`);
    return 0;
  }
  if (args.includes("-p")) return run();
  process.stderr.write(`fake: unsupported arguments: ${args.join(" ")}\n`);
  return 2;
}

// exitCode, not exit(): stdout to a pipe is asynchronous on macOS and must drain first.
process.exitCode = await main();
