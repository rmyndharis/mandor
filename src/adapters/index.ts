import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { WORKER_TOOLS } from "../config.ts";
import type { Adapter, ModelInfo, ToolName } from "../contracts.ts";
import { mandorHome } from "../home.ts";
import { clampDetail, ensureDir, readJson, writeJsonAtomic } from "../store.ts";
import type { ModelCache } from "../modelcache.ts";
import { cacheFile, clearRefreshFailure, noteRefreshFailure, readModelCache, refreshFailedWithin } from "../modelcache.ts";
import { agyWarnings, createAgyAdapter, TESTED_AGY_VERSION } from "./agy.ts";
import { codexWarnings, createCodexAdapter } from "./codex.ts";
import { createZcodeAdapter, zcodeWarnings } from "./zcode.ts";

export const MODELS_MAX_AGE_MS = 5 * 60 * 1000;

export { readModelCache };
export type { ModelCache };

export function getAdapter(tool: ToolName, cfg: Config): Adapter {
  if (tool === "codex") return createCodexAdapter(cfg);
  if (tool === "zcode") return createZcodeAdapter(cfg);
  if (tool === "agy") return createAgyAdapter(cfg);
  throw new Error(`adapter for ${tool} is not available; see tools in config.json for the tool names`);
}

// What a tool says about its version and its terms. A tool with a problem of its own has that to say, not a word about
// its version.
function toolWarnings(tool: ToolName, versions: ModelCache["versions"], problems: ModelCache["problems"]): string[] {
  if (tool === "codex") return codexWarnings(versions.codex || null);
  if (tool === "zcode") return problems.zcode === undefined ? zcodeWarnings(versions.zcode ?? null) : [];
  return agyWarnings(problems.agy === undefined ? versions.agy ?? null : TESTED_AGY_VERSION);
}

const enabledTools = (cfg: Config) => WORKER_TOOLS.filter((t) => cfg.tools[t].enabled);

// What each enabled tool says; a tool that is off says nothing.
function warningsOf(cfg: Config, versions: ModelCache["versions"], problems: ModelCache["problems"]): ModelCache["warnings"] {
  return Object.fromEntries(enabledTools(cfg).map((t) => [t, toolWarnings(t, versions, problems)]));
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
  if (listed === 0 && failure !== undefined) {
    noteRefreshFailure();
    throw failure;
  }
  writeJsonAtomic(cacheFile(), { fetchedAt: new Date().toISOString(), codexVersion: versions.codex ?? "", versions, problems, warnings: warningsOf(cfg, versions, problems), models });
  clearRefreshFailure();
  return models;
}

// Never throws: routing keeps the last good list while codex is broken, and an empty one
// only when no list was ever fetched.
export function loadModels(maxAgeMs: number, cfg: Config): ModelInfo[] {
  const cache = readModelCache();
  if (cache !== null && Date.now() - Date.parse(cache.fetchedAt) < maxAgeMs) return cache.models;
  if (refreshFailedWithin(maxAgeMs)) return cache?.models ?? [];
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
  const on = enabledTools(cfg);
  const problems = Object.entries(cache?.problems ?? {}).filter(([tool]) => on.includes(tool as ToolName)).map(([tool, why]) => `${tool}: ${why}`);
  // What the refresh stored for a tool, so a refresh reads the login shell once. One the cache holds nothing for (a tool
  // switched on since, or a cache from before the warnings were stored, or none) has them worked out here.
  const warnings = on.flatMap((t) => cache?.warnings[t] ?? toolWarnings(t, cache?.versions ?? {}, cache?.problems ?? {}));
  return { codexVersion, fetchedAt: cache?.fetchedAt ?? null, models, warnings: [...warnings, ...problems] };
}
