import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatCandidate, readConfig } from "./config.ts";
import { cachedWarnings } from "./modelcache.ts";
import type { TaskRecord } from "./contracts.ts";
import { processAlive, projectDir } from "./home.ts";
import { loadState, loadToolState, readEvents, replay } from "./ledger.ts";
import { isRunnerAlive, neverStarted, readJob } from "./runner.ts";
import { clampDetail, readJson } from "./store.ts";
import { resolveProject } from "./tasks.ts";
import { commandAt, commandIn, endsOpen, looseCommand, mayStart, replaceTraces } from "./toolname.ts";
import { nextFor } from "./wait.ts";

// With the other lines of the summary, the lists of these sizes stay under its limit of 9,000 characters.
const LIST_CHARS = 3400;
const MAX_TASKS = 30;
const WARNING_CHARS = 1400;
// Under clampDetail's limit even with "+N more" after it, so the clamp never cuts a key.
const KEY_CHARS = 280;
const STDIN_MS = 2000;
const CLI = join(import.meta.dirname, "cli.ts");
const LEAD_COMMANDS = ["dispatch", "verdict", "drop", "reassign", "ready", "confirm", "cancel"];

// Invisible characters dropped and compatibility forms unified, as the guards read text, so neither hides a form.
const readable = (s: string) => s.replace(/[\p{Default_Ignorable_Code_Point}\0]/gu, "").normalize("NFKC");

// A description is free text that enters the transcript of every session here, so it may carry none of the tool's
// forms (a command, its home path), which also leaves nothing the stop guard reads as a lead's command; the bare name
// stays.
const neutral = (description: string) => replaceTraces(clampDetail(readable(description)), "the tool");

// A JSON string's escapes, decoded in one pass from the left, so an escaped backslash never pairs with the letter after
// it. Any other escaped character stays as written.
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
const decodeJson = (line: string) =>
  line.replace(/\\(?:u([0-9a-fA-F]{4})|(.))/g, (m, hex?: string, c?: string) => (hex ? String.fromCharCode(parseInt(hex, 16)) : ESCAPES[c!] ?? m));
const LEAD_AT = commandAt(LEAD_COMMANDS);
const LEAD_IN = commandIn(LEAD_COMMANDS);
const LEAD_LOOSE = looseCommand(LEAD_COMMANDS);
// ASCII text is its own NFKC form and holds no invisible character, so only the rest pays for readable.
const ASCII = /^[\x01-\x7f]*$/;
const read = (s: string) => (ASCII.test(s) ? s : readable(s));

// A project's ledger exists only after its first goal: scratch, project setup and status make a project directory
// and no ledger, so they never arm the hooks. A directory that is gone or out of reach is no project either, and no
// reason to log into a home that may not exist; a cwd of another type is bad input, which resolveProject throws on.
function activeProject(cwd: string): string | null {
  if (typeof cwd === "string" && !existsSync(cwd)) return null;
  let id: string;
  try {
    ({ id } = resolveProject(cwd));
  } catch (e) {
    if ((e as Error).message.endsWith("is not inside a git repository")) return null;
    throw e;
  }
  return existsSync(join(projectDir(id), "ledger.jsonl")) ? id : null;
}

// Whole items while they fit, counting a separator of up to two characters after each, then how many did not.
function fit(items: string[], maxChars: number, maxItems = Infinity): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (const item of items) {
    chars += item.length + 2;
    if (kept.length === maxItems || chars > maxChars) break;
    kept.push(item);
  }
  return kept.length < items.length ? [...kept, `+${items.length - kept.length} more`] : kept;
}

const isSettled = (t: TaskRecord) => t.status === "accepted" || t.status === "cancelled";

// What the lead does next about a task. A wait reports the first two kinds; a session that starts meets the other two as
// well, which no wait would ever report.
const nextAction = (t: TaskRecord): string | null =>
  nextFor(t) ?? (t.status === "integrating" ? "confirm or drop" : t.status === "takeover" ? "finish the takeover, then accept" : null);

const list = (title: string, lines: string[]) => (lines.length > 0 ? [title, ...lines] : []);

// Empty outside a project. Hook output never carries a run's free text, so an exhausted tool shows its key only and a
// plan its path only.
export function sessionStartText(input: { cwd: string }): string {
  const id = activeProject(input.cwd);
  if (id === null) return "";
  // From one read, so the cursor is exactly where this state ends, whatever is appended meanwhile.
  const { items, endByte: cursor } = readEvents(id);
  const { goals, tasks } = replay(items);
  // Newest first, since a long-lived project's older goals are the ones to leave out.
  const goalLines = Object.values(goals).reverse().map((g) =>
    `- ${g.branch}: ${g.description === null ? "no description" : neutral(g.description)}; plan ${g.plan?.path ?? "none"}; worktree ${g.integrationWorktree}`);
  const taskLines = Object.values(tasks).toSorted((a, b) => Number(isSettled(a)) - Number(isSettled(b))).map((t) => {
    const next = nextAction(t);
    return `- ${t.id}: ${t.status}${t.stallReason === null ? "" : ` (${t.stallReason})`}, ${t.candidate === null ? "no candidate" : formatCandidate(t.candidate)}, seq ${t.seq}, fix rounds ${t.fixRounds}${next === null ? "" : `; next: ${next}`}`;
  });
  const exhausted = Object.keys(loadToolState(Date.now() / 1000));
  // Fixed phrases of mandor's, kept with the model list, so no tool runs here.
  const config = readConfig();
  const warningLines = config === null ? [] : cachedWarnings(config).map((w) => `- ${w}`);
  return [
    ...list("Goals:", fit(goalLines, LIST_CHARS)),
    ...list("Tasks:", fit(taskLines, LIST_CHARS, MAX_TASKS)),
    ...(exhausted.length > 0 ? [`Exhausted: ${clampDetail(fit(exhausted, KEY_CHARS).join(", "))}`] : []),
    ...list("Warnings:", fit(warningLines, WARNING_CHARS)),
    `Cursor: ${cursor}`,
    "mandor is active in this project. Run `mandor status` for details. If you are leading this work, load the `mandor:lead` skill, then handle every task above that gives a next action.",
    `After that, if a job is queued or running, or a task waits to start, run \`mandor wait --since ${cursor}\` in the background.`,
  ].join("\n");
}

function hasLiveJob(id: string): boolean {
  return Object.values(loadState(id).jobs).some((j) => {
    const job = j.outcome === null ? readJob(j.id) : null;
    if (job === null) return false;
    return job.status === "running" ? isRunnerAlive(job) : job.status === "queued" && !neverStarted(job);
  });
}

// A task whose turn has come: waiting with a pending entry and, if it follows another, that one accepted. The pump starts
// it as soon as a slot is free, so a lead that stops now leaves work that nobody waits for.
function hasPendingTurn(id: string): boolean {
  const { tasks } = loadState(id);
  return Object.values(tasks).some((t) => t.status === "waiting" && t.pending !== null && (t.after === null || tasks[t.after]?.status === "accepted"));
}

// A waiter is alive by a runner's rule, so a failed ps read counts it alive and never turns into a block.
function hasLiveWaiter(id: string): boolean {
  const dir = join(projectDir(id), "waiters");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => {
    try {
      const { pid, start } = readJson<{ pid: number; start: string | null }>(join(dir, name));
      return processAlive(pid, start);
    } catch {
      return false; // its wait ended after the listing, or died writing it
    }
  });
}

// end, moved past an escape it would cut: the character after a backslash that escapes, or the rest of a \uXXXX. A
// window that ended there would read a lone backslash where the line has whitespace.
function wholeEscapes(raw: string, end: number): number {
  for (let s = Math.max(0, end - 5); s < end; s++) {
    if (raw[s] !== "\\") continue;
    let run = s;
    while (run > 0 && raw[run - 1] === "\\") run--;
    if ((s - run) % 2 === 1) continue; // escaped by the backslash before it
    const length = raw[s + 1] === "u" ? 6 : 2;
    if (s + length > end) return Math.min(raw.length, s + length);
    s += length - 1;
  }
  return end;
}

// Whether a lead's command starts at the name at index i of the raw transcript, judged on the text around it decoded
// and read as a description is. Before the name: 16 characters, enough for two escaped characters, widened over a run
// of backslashes so its escapes pair as in the whole line, and doubled while what is left reads shorter than 8
// characters (invisible ones dropped). After it: never ending inside an escape, and doubled while the window ends
// inside the gap, the word or the space that decide. So the verdict is the one the whole line gives.
function leadAt(raw: string, i: number, looseEnd: number): boolean {
  let pre = "";
  for (let size = 16; ; size *= 2) {
    let start = Math.max(0, i - size);
    while (start > 0 && raw[start - 1] === "\\") start--;
    pre = read(decodeJson(raw.slice(start, i)));
    if (start === 0 || pre.length >= 8) break;
  }
  let post = "";
  for (let size = Math.max(64, 2 * (looseEnd - i)); ; size *= 2) {
    let end = wholeEscapes(raw, Math.min(raw.length, i + size));
    const last = raw.charCodeAt(end - 1);
    if (end < raw.length && last >= 0xd800 && last <= 0xdbff) end++;
    post = read(decodeJson(raw.slice(i, end)));
    if (end === raw.length || !endsOpen(post, 0)) break;
  }
  return LEAD_AT(pre + post, pre.length);
}

// A lead's command as a whole word, as the guards read a command, so an ordinary use of the name (a mandor
// confirmation step) is none. One native scan finds where a command may start, and only the text around each such
// place is decoded from JSON and read as a description is, so this check and the summary's replacement judge the same
// text with the same rule, a command on a later line of a Bash call still counts, and a long session costs one scan.
// Past PER_LINE such places on one line, the line is decoded once and judged whole, so content made of the name and an
// invisible character over and over costs one decode per line, not a window per place. raw is the transcript's JSON
// lines as written.
const PER_LINE = 8;
export function namesLeadCommand(raw: string): boolean {
  let lineEnd = -1, places = 0;
  LEAD_LOOSE.lastIndex = 0;
  for (let m = LEAD_LOOSE.exec(raw); m !== null; m = LEAD_LOOSE.exec(raw)) {
    const i = m.index;
    if (i > lineEnd) {
      lineEnd = raw.indexOf("\n", i);
      if (lineEnd < 0) lineEnd = raw.length;
      places = 0;
    }
    if (mayStart(m)) {
      if (++places > PER_LINE) {
        if (LEAD_IN(read(decodeJson(raw.slice(raw.lastIndexOf("\n", i) + 1, lineEnd))))) return true;
        LEAD_LOOSE.lastIndex = lineEnd;
        continue;
      }
      if (leadAt(raw, i, i + m[0].length)) return true;
    }
    LEAD_LOOSE.lastIndex = i + 1;
  }
  return false;
}

const isLeadTranscript = (path: string | undefined) => path !== undefined && namesLeadCommand(readFileSync(path, "utf8"));

// The transcript comes last: a long session's runs to many megabytes, and the stop hook fires after every turn.
export function stopDecision(input: { cwd: string; stop_hook_active?: boolean; transcript_path?: string }): { decision: "block"; reason: string } | null {
  if (input.stop_hook_active === true) return null;
  const id = activeProject(input.cwd);
  if (id === null || !(hasLiveJob(id) || hasPendingTurn(id)) || hasLiveWaiter(id) || !isLeadTranscript(input.transcript_path)) return null;
  return { decision: "block", reason: "Jobs are still running or waiting to start. Run mandor wait in the background before stopping." };
}

// Claude Code closes stdin after writing the input. One that never closes must not use up the hook's whole timeout.
// The deadline ends with the read: a file stdin stays open after it, and destroying that later would throw outside
// the caller's try.
async function readInput(): Promise<{ cwd: string; stop_hook_active?: boolean; transcript_path?: string }> {
  const deadline = setTimeout(() => process.stdin.destroy(new Error("hook input did not end")), STDIN_MS);
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    clearTimeout(deadline);
  }
}

// This process exits at once, so the refresh is left with parent pid 1 and outlives the session that started it. It
// runs away from the session's directory, which may be a task worktree holding files a worker wrote.
async function startModelRefresh(): Promise<void> {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "models", "--refresh"], { cwd: "/", detached: true, stdio: "ignore" });
  await once(child, "spawn"); // a failed start arrives as an error event, which this throws
  child.unref();
}

// Throws on any failure, for the caller's one try around the whole hook.
export async function runHook(args: string[]): Promise<void> {
  const [name] = args;
  if (args.length !== 1 || (name !== "session-start" && name !== "stop")) throw new Error(`unknown hook: ${args.join(" ")}`);
  const input = await readInput();
  if (name === "stop") {
    const decision = stopDecision(input);
    if (decision !== null) console.log(JSON.stringify(decision));
    return;
  }
  const text = sessionStartText(input);
  if (text === "") return;
  await startModelRefresh();
  console.log(text);
}
