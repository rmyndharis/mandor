import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { JobRecord, JobResult } from "../contracts.ts";
import { mandorHome } from "../home.ts";
import { ensureDir } from "../store.ts";

// Vendor CLIs have printed OAuth tokens on stderr, so it goes only to a private log, never to output.
export function keepVendorStderr(tool: string, args: string[], r: { stderr?: string | null; error?: Error }): void {
  if (!r.stderr && !r.error) return;
  const logs = join(mandorHome(), "logs");
  ensureDir(logs);
  const head = `${new Date().toISOString()} ${tool} ${args.join(" ")}${r.error ? `: ${r.error.message}` : ""}`;
  appendFileSync(join(logs, "vendor.stderr"), `${head}\n${(r.stderr ?? "").replace(/\n?$/, "\n")}`, { mode: 0o600 });
}

// A session that is gone does not fail a resume without a word: the tool opens a new one, whose worker knows only the last
// message. A finished resume that names another session is an account mismatch, so the task starts over once, from the work
// so far. A run that names no session proves nothing.
export function lostSession(result: JobResult, job: JobRecord): JobResult | null {
  if (result.status !== "done" || job.kind !== "resume" || job.sessionId === null || result.sessionId === null || result.sessionId === job.sessionId) return null;
  return { ...result, status: "account-mismatch", report: null, detail: "the session was not resumed, so the run started a new one" };
}
