import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Candidate, Tier, ToolName } from "./contracts.ts";
import { TIER_ORDER, tierName } from "./contracts.ts";
import { mandorHome } from "./home.ts";
import { IGNORE_USER_CONFIG } from "./spikes.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

export interface ToolConfig { enabled: boolean; maxParallel: number; bin: string; ignoreUserConfig: boolean; acknowledged?: boolean } // acknowledged: Antigravity's, which also needs it
export interface Config {
  version: 1;
  tools: Record<ToolName, ToolConfig>;
  tiers: Record<Tier, string[]>;
  jobTimeoutMinutes: number;
  maxFixRounds: number;
}

const MAX_TIMEOUT_MINUTES = 1440;

// What the user is told of Antigravity: an understanding of what the vendor publishes, not a fact about its terms.
export const AGY_NOTICE = "as far as Google's published answers show, its terms for consumer plans do not cover driving the Antigravity CLI from another tool, which can cost the account";
export const AGY_UNACKNOWLEDGED = `agy is switched on but stays off until it is acknowledged: ${AGY_NOTICE}; tell the user, who sets tools.agy.acknowledged to true in config.json if they accept that risk`;

const TOOLS: readonly ToolName[] = ["codex", "zcode", "agy"];

const tool = (name: ToolName, enabled: boolean): ToolConfig => ({ enabled, maxParallel: 2, bin: name, ignoreUserConfig: IGNORE_USER_CONFIG });

export const agyUnacknowledged = (cfg: Config): boolean => cfg.tools.agy.enabled && cfg.tools.agy.acknowledged !== true;

// Whether a tool takes part: it is switched on, and for Antigravity the user has also acknowledged the notice above.
export const toolOn = (cfg: Config, tool: ToolName): boolean => cfg.tools[tool].enabled && (tool !== "agy" || cfg.tools.agy.acknowledged === true);

export const DEFAULT_CONFIG: Config = {
  version: 1,
  tools: { codex: tool("codex", true), zcode: tool("zcode", false), agy: { ...tool("agy", false), acknowledged: false } },
  tiers: {
    heavy: ["codex:gpt-6-astra@ultra", "codex:gpt-6.1-sol@max", "zcode:GLM-5.3@max", "agy:gemini-4-argon-high"],
    medium: ["codex:gpt-6.1-sol@high", "zcode:GLM-5.3@high", "agy:gemini-4-argon-medium", "codex:gpt-6-luna@high"],
    light: ["codex:gpt-6-luna@medium", "zcode:GLM-5.3-Flash@high", "agy:gemini-3.8-flash-medium"],
  },
  jobTimeoutMinutes: 60,
  maxFixRounds: 3,
};

// "tool:model@effort". Model names may hold ":" and "@", so only the first ":" and the last "@" split.
export function parseCandidate(s: string): Candidate {
  const colon = s.indexOf(":");
  const name = s.slice(0, colon);
  if (colon < 0 || !TOOLS.includes(name as ToolName)) throw new Error(`invalid candidate "${s}": unknown tool; write it as tool:model@effort, with codex, zcode or agy as the tool`);
  const rest = s.slice(colon + 1);
  const at = rest.lastIndexOf("@");
  const model = at < 0 ? rest : rest.slice(0, at);
  const effort = at < 0 ? "" : rest.slice(at + 1);
  if (model.trim() === "") throw new Error(`invalid candidate "${s}": empty model; write it as tool:model@effort`);
  if (at >= 0 && effort === "") throw new Error(`invalid candidate "${s}": empty effort after @; write it as tool:model@effort, or drop the @`);
  // Whitespace would reach the worker CLI as part of the model or effort name.
  if (model !== model.trim() || effort !== effort.trim()) throw new Error(`invalid candidate "${s}": whitespace around model or effort; write it as tool:model@effort with no spaces`);
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
      if (t.acknowledged !== undefined && typeof t.acknowledged !== "boolean") errs.push(`tools.${name}.acknowledged must be a boolean`);
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
            if (typeof s !== "string") throw new Error("candidate must be a string; write each candidate in config.json as tool:model@effort");
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

// A file whose tiers are keyed by an alias reads as if keyed by the tier's name. An alias beside its own tier is left
// as written, so the check below names it as an unknown tier rather than one list silently winning.
function withTierNames(raw: unknown): unknown {
  if (!isObject(raw) || !isObject(raw.tiers)) return raw;
  const given = raw.tiers;
  const tiers = Object.fromEntries(Object.entries(given).map(([k, list]) => [Object.hasOwn(given, tierName(k)) ? k : tierName(k), list]));
  return { ...raw, tiers };
}

// The config as it stands, for what must write nothing (the hooks): null when there is none or it cannot be read.
export function readConfig(): Config | null {
  try {
    const config = withTierNames(readJson(join(mandorHome(), "config.json")));
    return validateConfig(config).length === 0 ? (config as Config) : null;
  } catch {
    return null;
  }
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
    if (e instanceof SyntaxError) throw new Error(`invalid config: ${file}: ${e.message}; tell the user, who repairs config.json in the state home`);
    throw e;
  }
  const config = withTierNames(raw);
  const errs = validateConfig(config);
  if (errs.length > 0) throw new Error(`invalid config: ${errs.join("; ")}; tell the user, who repairs config.json in the state home`);
  return config as Config;
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

// The tools a worker can run on: the ones with an adapter.
export const WORKER_TOOLS: readonly ToolName[] = ["codex", "zcode", "agy"];

const ZCODE_APP_BIN = "/Applications/ZCode.app/Contents/MacOS/ZCode";

// A name with a slash is a path and is never searched on PATH, as in a shell. A relative one would resolve against the
// directory of the command that starts the job, which can be a task worktree, where a file a worker wrote would then be
// started as the tool, so it is refused. A "~" is not expanded here, so a path that starts with one is relative.
function pathBin(value: string, source: string, alternative = ""): string {
  if (!isAbsolute(value)) throw new Error(`refusing ${source} "${value}": a relative path; use an absolute path${alternative}`);
  return resolve(value);
}

const OR_BARE = ", or a bare name that is looked up on PATH";

// The binary a job of the tool starts, always absolute. zcode ships inside its app, so a bare name means the app's
// own executable and a path names another one.
export function resolveBin(tool: ToolName, cfg: Config): string {
  if (tool === "codex") return resolveCodexBin(cfg);
  const { bin } = cfg.tools[tool];
  if (bin.includes("/")) return pathBin(bin, `tools.${tool}.bin`, tool === "zcode" ? ", or a bare name for the app's own executable" : OR_BARE);
  if (tool === "zcode") return ZCODE_APP_BIN;
  const found = onPath(bin);
  if (found === null) throw new Error(`${tool} not found on PATH; tell the user, who installs it or sets its bin under tools in config.json`);
  return found;
}

// The env override is not checked for existence: tests point it at a fake that may not be written yet.
export function resolveCodexBin(cfg: Config): string {
  const override = process.env.MANDOR_CODEX_BIN;
  if (override) return pathBin(override, "MANDOR_CODEX_BIN");
  const bin = cfg.tools.codex.bin;
  if (bin.includes("/")) return pathBin(bin, "tools.codex.bin", OR_BARE);
  const found = onPath(bin);
  if (found === null) throw new Error("codex not found on PATH; tell the user, who installs it or sets its bin under tools in config.json");
  return found;
}
