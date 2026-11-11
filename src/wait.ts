import { rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { askOf, roundReport } from "./brief.ts";
import { formatCandidate } from "./config.ts";
import type { ModelInfo, StallReason, TaskRecord, WaitItem, WaitSummary } from "./contracts.ts";
import { processStart, projectDir } from "./home.ts";
import { atLineStart, ledgerSize, loadState, readEvents } from "./ledger.ts";
import { reconcileLocked } from "./runner.ts";
import { withProjectLock, writeJsonAtomic } from "./store.ts";
import { loadCatalog, newerReason, pumpLocked, resolveProject } from "./tasks.ts";

const POLL_MS = 1000;
const SETTLE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const CATALOG_EVERY_MS = 5 * 60 * 1000;

const NEXT: Record<StallReason, WaitItem["next"]> = {
  "all-exhausted": "offer-takeover",
  "fix-rounds-exceeded": "fix-rounds-exceeded",
  quota: "reassign-or-ready",
  "model-limit": "reassign-or-ready",
  failed: "inspect",
  timeout: "inspect",
  "runner-died": "inspect",
  "account-mismatch": "inspect",
  "rebase-failed": "inspect",
};

// What the lead does next about a task in this state; null when it has nothing to do. A task whose newest report is
// blocked, partial or asks something (`asks`) is answered before it is reviewed.
export function nextFor(t: TaskRecord, asks = false): WaitItem["next"] | null {
  if (t.status === "needs-review") return asks ? "answer" : "review";
  return t.status === "stalled" && t.stallReason !== null ? NEXT[t.stallReason] : null;
}

interface Poll { lines: number; items: WaitItem[]; idle: boolean; endByte: number }

// One short hold of the project lock: finish what dead runners left, start what can start, then read what changed
// after the cursor. A busy lock is no answer yet, so it returns null at once and the caller polls again, which keeps a
// timeout or a signal prompt.
function poll(id: string, cursor: number, models: ModelInfo[]): Poll | null {
  try {
    return withProjectLock(id, () => {
      reconcileLocked(id, models);
      pumpLocked(id, models);
      const { items: events, endByte } = readEvents(id, cursor);
      const state = loadState(id);
      const changed = new Set<string>();
      for (const ev of events) {
        if (ev.t === "task.created") changed.add(ev.task.id);
        else if (ev.t === "task.updated") changed.add(ev.taskId);
      }
      const jobs = Object.values(state.jobs);
      const items: WaitItem[] = [];
      for (const slug of changed) {
        const t = state.tasks[slug];
        const ask = t !== undefined && t.status === "needs-review" ? askOf(roundReport(id, slug, t.seq)) : null;
        const next = t !== undefined && nextFor(t, ask !== null);
        if (!next) continue;
        const detail = ask ?? newerReason(id, slug) ?? jobs.findLast((j) => j.taskId === slug && j.outcome !== null)?.outcome?.detail ?? "";
        items.push({ task: slug, status: t.status, candidate: t.candidate && formatCandidate(t.candidate), detail, next });
      }
      const idle = !jobs.some((j) => j.outcome === null) && !Object.values(state.tasks).some((t) => t.status === "waiting" && t.pending !== null);
      return { lines: events.length, items, idle, endByte };
    }, { tryOnce: true });
  } catch (e) {
    if ((e as Error).message.startsWith("slots busy")) return null;
    throw e;
  }
}

let calls = 0;
const beats = new Set<string>();
const clearBeats = () => {
  for (const f of beats) rmSync(f, { force: true });
  beats.clear();
};
let handlers = false;

// Once per process, however many waits run in it. Re-raised once its handler is gone, the signal then ends the
// process as it would have without one.
function installHandlers(): void {
  if (handlers) return;
  handlers = true;
  process.on("exit", clearBeats);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      clearBeats();
      process.kill(process.pid, sig);
    });
  }
}

// The lead runs this in the background: it returns when a task needs the lead, when nothing is left in flight, or at
// the timeout. Its heartbeat file tells the Stop hook that a waiter is live.
export async function waitForNext(cwd: string, o: { since: number; timeoutMs: number | null }): Promise<WaitSummary> {
  const { id } = resolveProject(cwd);
  const size = ledgerSize(id);
  if (!Number.isSafeInteger(o.since) || o.since < 0 || o.since > size) throw new Error(`invalid cursor ${o.since}: the ledger holds ${size} bytes`);
  if (!atLineStart(id, o.since)) throw new Error(`invalid cursor ${o.since}: it is not the start of a line of the ledger; pass the cursor an earlier command printed`);
  const deadline = Date.now() + (o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  installHandlers();
  const beat = join(projectDir(id), "waiters", `${process.pid}-${++calls}.json`);
  beats.add(beat);
  writeJsonAtomic(beat, { pid: process.pid, start: processStart(process.pid) });
  try {
    let cursor = o.since;
    let models = loadCatalog();
    let loaded = Date.now();
    for (;;) {
      // Not each poll: with a broken codex every load runs it again.
      if (Date.now() - loaded >= CATALOG_EVERY_MS) {
        models = loadCatalog();
        loaded = Date.now();
      }
      let p = poll(id, cursor, models);
      if (p !== null && p.lines > 0) {
        // The events of one completion, or of tasks that end together, come back as one answer. A busy lock leaves the
        // items just read standing, but idle only ever comes from a poll that got through.
        await sleep(SETTLE_MS);
        p = poll(id, cursor, models) ?? { ...p, idle: false };
      }
      if (p !== null) {
        if (p.items.length > 0) return { kind: "events", items: p.items, cursor: p.endByte };
        if (p.idle) return { kind: "idle", cursor: p.endByte };
        cursor = p.endByte;
      }
      const left = deadline - Date.now();
      // An orphaned wait has no lead left to wake.
      if (left <= 0 || process.ppid === 1) return { kind: "timeout", cursor };
      await sleep(Math.min(POLL_MS, left));
    }
  } finally {
    rmSync(beat, { force: true });
    beats.delete(beat);
  }
}
