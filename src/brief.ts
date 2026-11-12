import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { FileRef, WorkerReport } from "./contracts.ts";
import { mandorHome, projectDir, roundDir } from "./home.ts";
import { fileRef, writeFileAtomic } from "./store.ts";

// Every rule the worker must follow, ahead of the task body. {scope} and {shared} are filled by renderBrief.
export const BRIEF_HEADER_LINES: readonly string[] = [
  "You are a worker running non-interactively for a lead engineer. No human can answer questions.",
  "1. Do not ask questions. Do not start brainstorming, planning, or question-asking skills or modes.",
  "2. Work only inside the current directory, and only on files within this scope: {scope}.",
  "3. Do not commit, push, create branches, or change git configuration. Do not run git commands that write.",
  "4. Do not create or modify AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules, .windsurfrules, .clinerules, copilot-instructions.md, .claude/, .codex/, .gemini/, .agents/, .agent/, .zcode/, .cursor/, .github/instructions/, or zcode.json.",
  "5. Do not add AI attribution anywhere, such as Co-Authored-By lines or \"Generated with\" lines.",
  "6. Never write the characters U+2014, U+2013, or U+2015.",
  "7. Do not modify these shared files unless the task says so: {shared}.",
  "8. If you cannot finish, stop and report status \"blocked\" with the reason.",
  "9. End with a final message that is only the JSON report described by the output schema.",
];

interface Schema { type: string; enum?: string[]; items?: Schema; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean }

const str = { type: "string" };
const strings = { type: "array", items: str };

// OpenAI strict rules: every object closes additionalProperties and requires all of its properties.
export const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "files_changed", "commands_run", "tests", "open_issues", "questions_for_lead"],
  properties: {
    status: { type: "string", enum: ["done", "blocked", "partial"] },
    summary: str,
    files_changed: strings,
    commands_run: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "exit_code", "summary"],
        properties: { command: str, exit_code: { type: "integer" }, summary: str },
      },
    },
    tests: {
      type: "object",
      additionalProperties: false,
      required: ["ran", "passed", "failed", "notes"],
      properties: { ran: { type: "boolean" }, passed: { type: "integer" }, failed: { type: "integer" }, notes: str },
    },
    open_issues: strings,
    questions_for_lead: strings,
  },
};

export function renderBrief(input: { shared: string[]; scope: string[]; taskBody: string }): string {
  const list = (a: string[]) => (a.length ? a.join(", ") : "none");
  const values: Record<string, string> = { scope: list(input.scope), shared: list(input.shared) };
  // One pass with a function, so a value holding "$&" or "{shared}" stays literal.
  const header = BRIEF_HEADER_LINES.join("\n").replace(/\{(scope|shared)\}/g, (_, k: string) => values[k]);
  return `${header}\n\n${input.taskBody}`;
}

const REPORT_REMINDER = "End with a final message that is only the JSON report described by the output schema.";

export function renderFixMessage(notes: string): string {
  return `The lead reviewed your work and found problems to fix. The lead's notes:\n\n${notes}\n\nFix these in the current files. ${REPORT_REMINDER}`;
}

// The lead's answer to a report that is blocked, partial or asks something: the worker resumes with it, and it is no fix.
export function renderAnswerMessage(notes: string): string {
  return `The lead read your report and answers it. The lead's notes:\n\n${notes}\n\nContinue the task from the current files with this answer. ${REPORT_REMINDER}`;
}

// What a report asks of the lead, as a short phrase, or null when it asks nothing: it says blocked or partial, or it holds
// a question. Only counts and the status are named, as the questions are the worker's own text.
export function askOf(report: WorkerReport | null): string | null {
  if (report === null) return null;
  // A question of nothing but blanks and invisible characters is none.
  const questions = report.questions_for_lead.filter((q) => q.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, "") !== "").length;
  const says = report.status === "done" ? null : `the report says ${report.status}`;
  const asks = questions === 0 ? null : `${says === null ? "the report asks" : "asks"} ${questions} question${questions === 1 ? "" : "s"}`;
  return [says, asks].filter((p) => p !== null).join(" and ") || null;
}

export function renderConflictMessage(goalBranch: string, files: string[]): string {
  return `Combining your work with ${goalBranch} left conflicts in these files:\n${files.map((f) => `- ${f}`).join("\n")}\n\n`
    + `Resolve the conflict markers in these files by editing them. Do not run git. ${REPORT_REMINDER}`;
}

function renderRound(r: { seq: number; report: WorkerReport | null; notes: string | null }): string {
  const list = (a: string[]) => (a.length ? a.join(", ") : "none");
  const parts = [`## Round ${r.seq}`];
  if (r.notes !== null) parts.push(`Lead notes:\n${r.notes}`);
  const w = r.report;
  if (w === null) {
    parts.push("No worker report was recorded for this round.");
  } else {
    parts.push(
      `Worker report (${w.status}): ${w.summary}`,
      `Files changed: ${list(w.files_changed)}`,
      `Commands run:\n${w.commands_run.length ? w.commands_run.map((c) => `- ${c.command} (exit ${c.exit_code}): ${c.summary}`).join("\n") : "none"}`,
      `Tests: ${w.tests.ran ? `ran, ${w.tests.passed} passed, ${w.tests.failed} failed` : "not run"}.${w.tests.notes ? ` ${w.tests.notes}` : ""}`,
      `Open issues: ${list(w.open_issues)}`,
    );
  }
  return parts.join("\n");
}

// originalBrief is the rendered brief with its header, so the fresh session gets the rules too.
export function renderHandoff(input: { originalBrief: string; rounds: { seq: number; report: WorkerReport | null; notes: string | null }[]; diffStat: string }): string {
  const rounds = [...input.rounds].sort((a, b) => a.seq - b.seq).map(renderRound);
  return [
    input.originalBrief,
    "An earlier worker session started this task and cannot be resumed. What it and the lead did so far:",
    ...rounds,
    `## Changes in the files now\n${input.diffStat.trimEnd() || "no changes"}`,
    "Continue the task from the current state of the files.",
  ].join("\n\n");
}

function conforms(v: unknown, s: Schema): boolean {
  switch (s.type) {
    case "string": return typeof v === "string" && (s.enum === undefined || s.enum.includes(v));
    case "boolean": return typeof v === "boolean";
    case "integer": return Number.isInteger(v);
    case "array": return Array.isArray(v) && v.every((x) => conforms(x, s.items!));
    case "object": return typeof v === "object" && v !== null && !Array.isArray(v)
      && Object.entries(s.properties!).every(([k, p]) => conforms((v as Record<string, unknown>)[k], p));
    default: return false;
  }
}

// Checks the schema's fields and types and ignores extra keys, so a report with an added field is still usable. Never throws.
export function parseReport(text: string): WorkerReport | null {
  try {
    const v: unknown = JSON.parse(text);
    return conforms(v, REPORT_SCHEMA) ? (v as WorkerReport) : null;
  } catch {
    return null;
  }
}

export const ROUND_FILES = ["notes.md", "report.json", "handoff.md", "conflict.patch", "cancelled.patch", "evidence-accept.md", "evidence-confirm.md"] as const;
export type RoundFileName = (typeof ROUND_FILES)[number];

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// A project id or slug shaped like a path must not take round files out of the task's directory,
// and a round number that is not a plain count would write a directory loadRounds never lists.
function checkedRoundDir(projectId: string, slug: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error(`invalid round number: ${seq}; the project's records are damaged: tell the user`);
  const dir = roundDir(projectId, slug, seq);
  if (!inside(join(mandorHome(), "projects"), projectDir(projectId)) || !inside(join(projectDir(projectId), "tasks"), dir)) {
    throw new Error(`round directory is outside the task directory: ${dir}; the project's records are damaged: tell the user`);
  }
  return dir;
}

// Reports, notes and evidence live in files; ledger events carry only the returned FileRef.
export function saveRoundFile(projectId: string, slug: string, seq: number, name: RoundFileName, content: string): FileRef {
  if (!ROUND_FILES.includes(name)) throw new Error(`not a round file name: ${name}; this is a bug in mandor: tell the user`);
  const p = join(checkedRoundDir(projectId, slug, seq), name);
  writeFileAtomic(p, content);
  return fileRef(p);
}

function readIfPresent(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// The report of one round, or null when the round holds none or it does not parse.
export function roundReport(projectId: string, slug: string, seq: number): WorkerReport | null {
  const text = readIfPresent(join(checkedRoundDir(projectId, slug, seq), "report.json"));
  return text === null ? null : parseReport(text);
}

// Directory names sort as text ("10" before "9"), so the order is made numeric here.
export function loadRounds(projectId: string, slug: string): { seq: number; dir: string; report: WorkerReport | null; notes: string | null }[] {
  let names: string[];
  try {
    names = readdirSync(dirname(checkedRoundDir(projectId, slug, 0)), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return names
    .filter((n) => /^(0|[1-9]\d*)$/.test(n) && Number.isSafeInteger(Number(n))) // the form saveRoundFile writes
    .map(Number)
    .sort((a, b) => a - b)
    .map((seq) => {
      const dir = checkedRoundDir(projectId, slug, seq);
      const report = readIfPresent(join(dir, "report.json"));
      return { seq, dir, report: report === null ? null : parseReport(report), notes: readIfPresent(join(dir, "notes.md")) };
    });
}
