import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { WORKER_TOOLS } from "./config.ts";
import type { ModelInfo, ToolName } from "./contracts.ts";
import { mandorHome } from "./home.ts";
import { readJson } from "./store.ts";

// problems: why a tool's models are the ones of an earlier refresh, or none. warnings: what each enabled tool had to say
// when they were read, kept so that what only reads the file (the session summary, a dispatch) need not run a tool.
export interface ModelCache {
  fetchedAt: string; codexVersion: string; versions: Partial<Record<ToolName, string>>; problems: Partial<Record<ToolName, string>>;
  warnings: Partial<Record<ToolName, string[]>>; models: ModelInfo[];
}

export const cacheFile = () => join(mandorHome(), "models.json");
const failureFile = () => join(mandorHome(), "models.failed");

// A refresh that no tool answered is kept for as long as a good list would be, so the commands that follow do not each wait
// for every tool again; a tool that hangs can take 30 seconds. It never throws: it only saves time.
export function noteRefreshFailure(): void {
  try {
    writeFileSync(failureFile(), new Date().toISOString(), { mode: 0o600 });
  } catch {}
}

export function clearRefreshFailure(): void {
  try {
    rmSync(failureFile(), { force: true });
  } catch {}
}

export function refreshFailedWithin(maxAgeMs: number): boolean {
  try {
    const age = Date.now() - Date.parse(readFileSync(failureFile(), "utf8"));
    return age >= 0 && age < maxAgeMs; // a failure dated ahead of the clock is no failure of the last few minutes
  } catch {
    return false;
  }
}

// A file from before a field existed reads as one without it.
export function readModelCache(): ModelCache | null {
  try {
    const c = readJson<ModelCache>(cacheFile());
    return Array.isArray(c?.models) && typeof c.fetchedAt === "string" ? { ...c, versions: c.versions ?? { codex: c.codexVersion }, problems: c.problems ?? {}, warnings: c.warnings ?? {} } : null;
  } catch {
    return null;
  }
}

// What the enabled tools said when their models were last read, with no tool run: a tool that is off says nothing.
export function cachedWarnings(cfg: Config, cache: ModelCache | null = readModelCache()): string[] {
  return cache === null ? [] : WORKER_TOOLS.filter((t) => cfg.tools[t].enabled).flatMap((t) => cache.warnings[t] ?? []);
}
