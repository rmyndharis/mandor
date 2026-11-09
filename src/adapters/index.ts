import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Adapter, ModelInfo, ToolName } from "../contracts.ts";
import { mandorHome } from "../home.ts";
import { clampDetail, ensureDir, readJson, writeJsonAtomic } from "../store.ts";
import { codexWarnings, createCodexAdapter } from "./codex.ts";

export const MODELS_MAX_AGE_MS = 5 * 60 * 1000;

export interface ModelCache { fetchedAt: string; codexVersion: string; models: ModelInfo[] }

const cacheFile = () => join(mandorHome(), "models.json");

export function getAdapter(tool: ToolName, cfg: Config): Adapter {
  if (tool === "codex") return createCodexAdapter(cfg);
  throw new Error(`adapter for ${tool} is not available`);
}

// Throws when codex fails, before anything is written, so the last good list stays in place.
export function refreshModels(cfg: Config): ModelInfo[] {
  const codex = getAdapter("codex", cfg);
  const codexVersion = codex.version();
  const models = codex.detectModels();
  writeJsonAtomic(cacheFile(), { fetchedAt: new Date().toISOString(), codexVersion, models });
  return models;
}

export function readModelCache(): ModelCache | null {
  try {
    const c = readJson<ModelCache>(cacheFile());
    return Array.isArray(c?.models) && typeof c.fetchedAt === "string" ? c : null;
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
  const codexVersion = cache?.codexVersion ?? null;
  return { codexVersion, fetchedAt: cache?.fetchedAt ?? null, models, warnings: codexWarnings(codexVersion) };
}
