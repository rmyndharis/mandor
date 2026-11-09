#!/usr/bin/env node
// A stand-in for the Codex CLI in tests, steered by files in $CODEX_HOME/fake/:
//   scenarios.json  exec runs; each exec claims one entry by creating claims/<index>
//   models.json     printed by `debug models` instead of the catalog fixture
//   debug.stderr    printed by `debug models` on stderr
//   version         the `--version` number when FAKE_CODEX_VERSION is unset, which it always is
//                   behind the worker environment allowlist
//   log.jsonl       appended: the argv and full environment of every invocation, and the prompt when it came on stdin
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const control = join(process.env.CODEX_HOME ?? "", "fake");
const fixtures = new URL("../fixtures/codex/", import.meta.url);
const DEFAULT_THREAD = "00000000-0000-7000-8000-000000000100";
const DEFAULT_REPORT = JSON.stringify({
  status: "done", summary: "Done.", files_changed: [], commands_run: [],
  tests: { ran: false, passed: 0, failed: 0, notes: "" }, open_issues: [], questions_for_lead: [],
});
const LATER = "or try again at 3:00 PM.";

const read = (name) => (existsSync(join(control, name)) ? readFileSync(join(control, name), "utf8") : null);
const opt = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// The lowest entry whose claim file this process creates; exclusive create makes concurrent claims safe.
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

function fromFixture(name, threadId) {
  const text = readFileSync(new URL(name.endsWith(".jsonl") ? name : `${name}.jsonl`, fixtures), "utf8");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .map((e) => (threadId !== undefined && e.type === "thread.started" ? { ...e, thread_id: threadId } : e));
}

function generated(kind, threadId, model, last, item) {
  const events = [{ type: "thread.started", thread_id: threadId }, { type: "turn.started" }];
  // Codex prints a top-level error just before the turn.failed that carries the same message.
  const fail = (message) => events.push({ type: "error", message }, { type: "turn.failed", error: { message } });
  const done = () => events.push(
    { type: "item.completed", item: item({ type: "agent_message", text: last }) },
    { type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 80, reasoning_output_tokens: 0 } },
  );
  if (kind === "done") done();
  else if (kind === "retry-then-done") {
    const message = "Reconnecting... 1/5 (stream disconnected before completion)";
    events.push({ type: "item.completed", item: item({ type: "error", message }) }, { type: "error", message });
    done();
  } else if (kind === "quota") fail(`You\u2019ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), ${LATER}`);
  else if (kind === "model-limit") fail(`You\u2019ve hit your usage limit for ${model}. Switch to another model now, ${LATER}`);
  else if (kind === "account-mismatch") {
    fail(JSON.stringify({ error: { message: "The encrypted content could not be verified.", type: "invalid_request_error", param: null, code: "invalid_encrypted_content" } }));
  } else if (kind !== "no-terminal") throw new Error(`fake: unknown generated kind: ${kind}`);
  return events;
}

async function exec() {
  const s = claim();
  if (s === null) {
    process.stderr.write("fake: no scenario\n");
    return 1;
  }
  let ids = 0;
  const item = (fields) => ({ id: `item_${ids++}`, ...fields });
  const commands = (s.commands ?? []).flatMap((c) => {
    const base = item({ type: "command_execution", command: `/bin/zsh -lc '${c}'`, aggregated_output: "" });
    return [
      { type: "item.started", item: { ...base, exit_code: null, status: "in_progress" } },
      { type: "item.completed", item: { ...base, exit_code: 0, status: "completed" } },
    ];
  });
  const kind = s.stdout.startsWith("generated:") ? s.stdout.slice("generated:".length) : null;
  const last = s.lastMessage ?? (kind === "done" || kind === "retry-then-done" ? DEFAULT_REPORT : undefined);
  const resumed = args.includes("resume") ? args[args.indexOf("resume") + 1] : undefined;
  const events = kind === null
    ? fromFixture(s.stdout, s.threadId)
    : generated(kind, s.threadId ?? resumed ?? DEFAULT_THREAD, opt("-m"), last, item);
  const started = events.findIndex((e) => e.type === "turn.started");
  events.splice(started < 0 ? events.length : started + 1, 0, ...commands);
  const lines = events.map((e) => `${JSON.stringify(e)}\n`);

  if (s.stderr) process.stderr.write(s.stderr);
  process.stdout.write(lines.slice(0, 1).join(""));
  for (const f of s.writeFile ?? []) {
    const p = resolve(f.path); // against the cwd: the runner binds it to the worktree and passes no -C
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }
  if (s.sleeperPidFile) {
    // Not detached: it shares this process group, which a timeout kill must reach.
    const sleeper = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
    sleeper.unref();
    process.on("exit", () => sleeper.kill("SIGKILL")); // a normal end leaves no sleeper; death by a signal skips this
    writeFileSync(s.sleeperPidFile, String(sleeper.pid));
  }
  if (s.delayMs) await sleep(s.delayMs);
  process.stdout.write(lines.slice(1).join(""));
  const out = opt("-o");
  if (out !== undefined && last !== undefined) writeFileSync(out, last);
  return s.exitCode ?? (events.some((e) => e.type === "turn.failed") ? 1 : 0);
}

async function main() {
  // Only a test home has this directory, so a stray run never writes into a real Codex home.
  if (!process.env.CODEX_HOME || !existsSync(control)) {
    process.stderr.write("fake: $CODEX_HOME/fake does not exist\n");
    return 1;
  }
  // A last argument of "-" says the prompt is on stdin, as the runner passes it.
  const stdin = args[0] === "exec" && args.at(-1) === "-" ? readFileSync(0, "utf8") : undefined;
  appendFileSync(join(control, "log.jsonl"), `${JSON.stringify({ argv: args, env: process.env, stdin })}\n`);
  if (args[0] === "--version") {
    process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? read("version")?.trim() ?? "0.166.0"}\n`);
    return 0;
  }
  if (args[0] === "debug" && args[1] === "models") {
    process.stdout.write(read("models.json") ?? readFileSync(new URL("debug-models.json", fixtures), "utf8"));
    process.stderr.write(read("debug.stderr") ?? "");
    return 0;
  }
  if (args[0] === "exec") return exec();
  process.stderr.write(`fake: unsupported arguments: ${args.join(" ")}\n`);
  return 2;
}

// exitCode, not exit(): stdout to a pipe is asynchronous on macOS and must drain first.
process.exitCode = await main();
