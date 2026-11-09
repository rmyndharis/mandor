import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LedgerEvent, ProjectState, ToolEvent, ToolState } from "./contracts.ts";
import { mandorHome, projectDir } from "./home.ts";
import { appendJsonl, clampDetail, readJsonl } from "./store.ts";

const ledgerPath = (projectId: string) => join(projectDir(projectId), "ledger.jsonl");
const toolsPath = () => join(mandorHome(), "tools.jsonl");

export function now(): string {
  return new Date().toISOString();
}

// The one place project events are written. Callers hold the project lock for any read-decide-append.
export function appendEvent(projectId: string, ev: LedgerEvent): void {
  if (ev.t === "job.finished") ev = { ...ev, outcome: { ...ev.outcome, detail: clampDetail(ev.outcome.detail) } };
  else if (ev.t === "task.updated") ev = { ...ev, reason: clampDetail(ev.reason) };
  appendJsonl(ledgerPath(projectId), ev);
}

// endByte is the cursor for the next read; it comes from the same read as the items, so it cannot race with appends.
export function readEvents(projectId: string, fromByte = 0): { items: LedgerEvent[]; endByte: number } {
  return readJsonl<LedgerEvent>(ledgerPath(projectId), fromByte);
}

// Whether a line of the ledger starts at the byte. The cursors the commands print always do; one made up may fall inside a
// line, and a read from there would call a sound ledger corrupt.
export function atLineStart(projectId: string, byte: number): boolean {
  if (byte === 0) return true;
  const fd = openSync(ledgerPath(projectId), "r");
  try {
    const before = Buffer.alloc(1);
    return readSync(fd, before, 0, 1, byte - 1) === 1 && before[0] === 10;
  } finally {
    closeSync(fd);
  }
}

export function ledgerSize(projectId: string): number {
  try {
    return statSync(ledgerPath(projectId)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
}

// Slugs, branches and job ids are arbitrary strings, so the records have no prototype: a key such as
// __proto__ or constructor must be an ordinary key, and an unknown one must read as undefined.
const records = <T>() => Object.create(null) as Record<string, T>;

// An event for a record the ledger never created changes nothing.
export function replay(events: LedgerEvent[]): ProjectState {
  const s: ProjectState = { goals: records(), tasks: records(), jobs: records() };
  for (const ev of events) {
    switch (ev.t) {
      case "goal.started":
        s.goals[ev.goal.branch] = { ...ev.goal, description: null, plan: null };
        break;
      case "plan.set": {
        const g = s.goals[ev.goal];
        if (g) {
          g.description = ev.description;
          g.plan = ev.plan;
        }
        break;
      }
      case "task.created":
        s.tasks[ev.task.id] = ev.task;
        break;
      case "task.updated": {
        const t = s.tasks[ev.taskId];
        if (t) s.tasks[ev.taskId] = { ...t, ...ev.patch };
        break;
      }
      case "job.started":
        s.jobs[ev.job.id] = { ...ev.job, outcome: null };
        break;
      case "job.finished": {
        const j = s.jobs[ev.jobId];
        if (j) j.outcome = ev.outcome;
        break;
      }
      case "verdict":
        break;
    }
  }
  return s;
}

// Full replay on every command; add a state.json snapshot if a ledger passes about 10k events.
export function loadState(projectId: string): ProjectState {
  return replay(readEvents(projectId).items);
}

export function appendToolEvent(ev: ToolEvent): void {
  appendJsonl(toolsPath(), ev.t === "tool.exhausted" ? { ...ev, detail: clampDetail(ev.detail) } : ev);
}

export function loadToolState(nowSec: number): ToolState {
  const s: ToolState = {};
  for (const ev of readJsonl<ToolEvent>(toolsPath()).items) {
    if (ev.t === "tool.exhausted") {
      s[ev.key] = { resetsAt: ev.resetsAt, detail: ev.detail };
    } else {
      for (const key of Object.keys(s)) if (key === ev.tool || key.startsWith(`${ev.tool}:`)) delete s[key];
    }
  }
  for (const [key, v] of Object.entries(s)) if (v.resetsAt !== null && v.resetsAt < nowSec) delete s[key];
  return s;
}

export function listProjects(): string[] {
  try {
    return readdirSync(dirname(projectDir("x")), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
