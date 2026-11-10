import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { WORKER_TOOLS } from "../config.ts";
import type { Adapter, ModelInfo, ToolName } from "../contracts.ts";
import { mandorHome } from "../home.ts";
import { clampDetail, ensureDir, readJson, writeJsonAtomic } from "../store.ts";
import { codexWarnings, createCodexAdapter } from "./codex.ts";
import { createZcodeAdapter, zcodeWarnings } from "./zcode.ts";

export const MODELS_MAX_AGE_MS = 5 * 60 * 1000;

// problems: why a tool's models are the ones of an earlier refresh, or none.
export interface ModelCache { fetchedAt: string; codexVersion: string; versions: Partial<Record<ToolName, string>>; problems: Partial<Record<ToolName, string>>; models: ModelInfo[] }

const cacheFile = () => join(mandorHome(), "models.json");

export function getAdapter(tool: ToolName, cfg: Config): Adapter {
  if (tool === "codex") return createCodexAdapter(cfg);
  if (tool === "zcode") return createZcodeAdapter(cfg);
  throw new Error(`adapter for ${tool} is not available`);
}

// Asks every enabled tool for its models. A tool that cannot list them keeps the ones it listed last, as a task may
// hold one, and the reason goes on record. When no tool could, this throws before anything is written, so the last
// good file stays in place.
export function refreshModels(cfg: Config): ModelInfo[] {
  const last = readModelCache();
  const versions: ModelCache["versions"] = {};
  const problems: ModelCache["problems"] = {};
  const models: ModelInfo[] = [];
  let failure: unknown;
  let listed = 0;
  for (const tool of WORKER_TOOLS.filter((t) => cfg.tools[t].enabled)) {
    try {
      const adapter = getAdapter(tool, cfg);
      versions[tool] = adapter.version();
      models.push(...adapter.detectModels());
      listed++;
    } catch (e) {
      failure ??= e;
      problems[tool] = clampDetail((e as Error).message);
      if (versions[tool] === undefined && last?.versions[tool] !== undefined) versions[tool] = last.versions[tool];
      models.push(...(last?.models ?? []).filter((m) => m.tool === tool));
    }
  }
  if (listed === 0 && failure !== undefined) throw failure;
  writeJsonAtomic(cacheFile(), { fetchedAt: new Date().toISOString(), codexVersion: versions.codex ?? "", versions, problems, models });
  return models;
}

// A file from before a field existed reads as one without it.
export function readModelCache(): ModelCache | null {
  try {
    const c = readJson<ModelCache>(cacheFile());
    return Array.isArray(c?.models) && typeof c.fetchedAt === "string" ? { ...c, versions: c.versions ?? { codex: c.codexVersion }, problems: c.problems ?? {} } : null;
  } catch {
    return null;
  }
}

// Never throws: routing keeps the last good list while codex is broken, and an empty one
// only when no list was ever fetched.
export function loadModels(maxAgeMs: number, cfg: Config): ModelInfo[] {
  const cache = readModelCache();
  if (cache !== null && Date.now() - Date.parse(cache.fetchedAt) < maxAgeMs) return cache.models;
  try {
    return refreshModels(cfg);
  } catch (e) {
    try {
      const logs = join(mandorHome(), "logs");
      ensureDir(logs);
      appendFileSync(join(logs, "models.log"), `${new Date().toISOString()} model refresh failed: ${clampDetail((e as Error).message)}\n`, { mode: 0o600 });
    } catch {}
    return cache?.models ?? [];
  }
}

// What `models` and `init` print. The version comes from the cache that was just used.
export function modelsReport(cfg: Config, refresh: boolean): { codexVersion: string | null; fetchedAt: string | null; models: ModelInfo[]; warnings: string[] } {
  const models = refresh ? refreshModels(cfg) : loadModels(MODELS_MAX_AGE_MS, cfg);
  const cache = readModelCache();
  const codexVersion = cache?.codexVersion || null;
  const problems = Object.entries(cache?.problems ?? {}).map(([tool, why]) => `${tool}: ${why}`);
  // A tool with a problem of its own has that to say, not a word about its version.
  const zcode = cfg.tools.zcode.enabled && cache?.problems.zcode === undefined ? zcodeWarnings(cache?.versions.zcode ?? null) : [];
  return { codexVersion, fetchedAt: cache?.fetchedAt ?? null, models, warnings: [...codexWarnings(codexVersion), ...zcode, ...problems] };
}
