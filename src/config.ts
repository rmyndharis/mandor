import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Candidate, Tier, ToolName } from "./contracts.ts";
import { TIER_ORDER } from "./contracts.ts";
import { mandorHome } from "./home.ts";
import { IGNORE_USER_CONFIG } from "./spikes.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

export interface ToolConfig { enabled: boolean; maxParallel: number; bin: string; ignoreUserConfig: boolean }
export interface Config {
  version: 1;
  tools: Record<ToolName, ToolConfig>;
  tiers: Record<Tier, string[]>;
  jobTimeoutMinutes: number;
  maxFixRounds: number;
}

const MAX_TIMEOUT_MINUTES = 1440;

const TOOLS: readonly ToolName[] = ["codex", "zcode", "agy"];

const tool = (name: ToolName, enabled: boolean): ToolConfig => ({ enabled, maxParallel: 2, bin: name, ignoreUserConfig: IGNORE_USER_CONFIG });

export const DEFAULT_CONFIG: Config = {
  version: 1,
  tools: { codex: tool("codex", true), zcode: tool("zcode", false), agy: tool("agy", false) },
  tiers: {
    berat: ["codex:gpt-6-astra@ultra", "codex:gpt-6.1-sol@max", "zcode:GLM-5.3@max", "agy:gemini-4-argon-high"],
    sedang: ["codex:gpt-6.1-sol@high", "zcode:GLM-5.3@high", "agy:gemini-4-argon-medium", "codex:gpt-6-luna@high"],
    ringan: ["codex:gpt-6-luna@medium", "zcode:GLM-5.3-Flash@high", "agy:gemini-3.8-flash-medium"],
  },
  jobTimeoutMinutes: 60,
  maxFixRounds: 3,
};

// "tool:model@effort". Model names may hold ":" and "@", so only the first ":" and the last "@" split.
export function parseCandidate(s: string): Candidate {
  const colon = s.indexOf(":");
  const name = s.slice(0, colon);
  if (colon < 0 || !TOOLS.includes(name as ToolName)) throw new Error(`invalid candidate "${s}": unknown tool`);
  const rest = s.slice(colon + 1);
  const at = rest.lastIndexOf("@");
  const model = at < 0 ? rest : rest.slice(0, at);
  const effort = at < 0 ? "" : rest.slice(at + 1);
  if (model.trim() === "") throw new Error(`invalid candidate "${s}": empty model`);
  if (at >= 0 && effort === "") throw new Error(`invalid candidate "${s}": empty effort after @`);
  // Whitespace would reach the worker CLI as part of the model or effort name.
  if (model !== model.trim() || effort !== effort.trim()) throw new Error(`invalid candidate "${s}": whitespace around model or effort`);
  return { tool: name as ToolName, model, effort };
}

export function formatCandidate(c: Candidate): string {
  return `${c.tool}:${c.model}${c.effort === "" ? "" : `@${c.effort}`}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function validateConfig(v: unknown): string[] {
  if (!isObject(v)) return ["config must be an object"];
  const errs: string[] = [];
  if (v.version !== 1) errs.push("version must be 1");

  if (!isObject(v.tools)) errs.push("tools must be an object");
  else {
    for (const k of Object.keys(v.tools)) if (!TOOLS.includes(k as ToolName)) errs.push(`unknown tool: ${k}`);
    for (const name of TOOLS) {
      const t = v.tools[name];
      if (!isObject(t)) {
        errs.push(`tools.${name} is missing`);
        continue;
      }
      if (typeof t.enabled !== "boolean") errs.push(`tools.${name}.enabled must be a boolean`);
      if (!Number.isInteger(t.maxParallel) || (t.maxParallel as number) < 1) errs.push(`tools.${name}.maxParallel must be a positive integer`);
      if (typeof t.bin !== "string" || t.bin === "") errs.push(`tools.${name}.bin must be a non-empty string`);
      if (typeof t.ignoreUserConfig !== "boolean") errs.push(`tools.${name}.ignoreUserConfig must be a boolean`);
    }
  }

  if (!isObject(v.tiers)) errs.push("tiers must be an object");
  else {
    for (const k of Object.keys(v.tiers)) if (!TIER_ORDER.includes(k as Tier)) errs.push(`unknown tier: ${k}`);
    for (const tier of TIER_ORDER) {
      const list = v.tiers[tier];
      if (list === undefined) errs.push(`tiers.${tier} is missing`);
      else if (!Array.isArray(list)) errs.push(`tiers.${tier} must be an array of candidates`);
      else {
        list.forEach((s, i) => {
          try {
            if (typeof s !== "string") throw new Error("candidate must be a string");
            parseCandidate(s);
          } catch (e) {
            errs.push(`tiers.${tier}[${i}]: ${(e as Error).message}`);
          }
        });
      }
    }
  }

  // Fractional minutes are allowed so a test can time a job out in seconds. The cap keeps the
  // timeout in milliseconds far below the 2^31-1 that setTimeout would clamp to 1 ms.
  const m = v.jobTimeoutMinutes;
  if (typeof m !== "number" || !(m > 0 && m <= MAX_TIMEOUT_MINUTES)) errs.push(`jobTimeoutMinutes must be a number above 0 and at most ${MAX_TIMEOUT_MINUTES}`);
  if (!Number.isInteger(v.maxFixRounds) || (v.maxFixRounds as number) < 0) errs.push("maxFixRounds must be a non-negative integer");
  return errs;
}

// A present file is the whole config: it is not merged with the defaults.
export function loadConfig(): Config {
  const file = join(mandorHome(), "config.json");
  let raw: unknown;
  try {
    raw = readJson(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      writeJsonAtomic(file, DEFAULT_CONFIG);
      return structuredClone(DEFAULT_CONFIG);
    }
    if (e instanceof SyntaxError) throw new Error(`invalid config: ${file}: ${e.message}`);
    throw e;
  }
  const errs = validateConfig(raw);
  if (errs.length > 0) throw new Error(`invalid config: ${errs.join("; ")}`);
  return raw as Config;
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue; // an empty or relative entry would search the current directory
    const p = join(dir, name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

// The env override is not checked for existence: tests point it at a fake that may not be written yet.
// A name with a slash is a path, never searched on PATH, as in a shell; the result is always absolute.
export function resolveCodexBin(cfg: Config): string {
  const override = process.env.MANDOR_CODEX_BIN;
  if (override) return resolve(override);
  const bin = cfg.tools.codex.bin;
  if (bin.includes("/")) return resolve(bin);
  const found = onPath(bin);
  if (found === null) throw new Error("codex not found on PATH");
  return found;
}
