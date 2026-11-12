import type { Config } from "./config.ts";
import { formatCandidate, parseCandidate } from "./config.ts";
import type { Candidate, ModelInfo, Tier, ToolName, ToolState } from "./contracts.ts";
import { TIER_ORDER } from "./contracts.ts";
import { isRunnerAlive, listJobIds, neverStarted, readJob } from "./runner.ts";

// Every project's jobs share one directory, so this is the global count the slots lock guards.
export function countActiveJobs(): Record<ToolName, number> {
  const active: Record<ToolName, number> = { codex: 0, zcode: 0, agy: 0 };
  for (const id of listJobIds()) {
    const job = readJob(id);
    if (job === null) continue;
    const live = job.status === "running" ? isRunnerAlive(job) : job.status === "queued" && !neverStarted(job);
    if (live) active[job.candidate.tool]++;
  }
  return active;
}

// Tools whose commands reach the network whatever the project says: ZCode's sandbox cannot close it for them, and
// Antigravity's own proxy decides. A job of theirs is refused in a project without worker network, so routing passes
// them over there.
const NEEDS_NETWORK: readonly ToolName[] = ["zcode", "agy"];

// A catalog with nothing it could run says something is wrong with the catalog, not with the account. Routing's answer
// from it must never read as every candidate gone: all-exhausted sends the user to switch accounts.
export function hasUsableModel(models: ModelInfo[]): boolean {
  return models.some((m) => !m.hidden && m.efforts.length > 0);
}

// What is wrong when no candidate of the tier or a heavier one could run, whatever the tool state: a model the vendor
// renamed, or a typo in the config. Null otherwise, and only then does `none` mean the candidates are exhausted.
export function catalogGap(tier: Tier, config: Config, models: ModelInfo[], network: boolean): string | null {
  const candidates = TIER_ORDER.slice(TIER_ORDER.indexOf(tier)).flatMap((t) => config.tiers[t]);
  const runs = (allowed: boolean) => candidates.some((s) => typeof settle(parseCandidate(s), { config, models, tools: {}, network: allowed }) !== "string");
  if (runs(network)) return null;
  if (!network && runs(true)) return `no candidate for tier ${tier} can run in this project, which allows no worker network: tell the user, who allows it with mandor project setup --update --worker-network`;
  return `no candidate for tier ${tier} can run: no listed model and effort match the config; see mandor models`;
}

// What init and models say about the tier lists, whatever the tool state: each candidate of an enabled tool that the
// catalog cannot run, which routing passes over without a word, and each tier a dispatch would refuse. Nothing for a
// catalog with no usable model, a fault the commands report on their own.
export function tierWarnings(config: Config, models: ModelInfo[]): string[] {
  if (!hasUsableModel(models)) return [];
  return TIER_ORDER.flatMap((tier) => {
    const unusable = config.tiers[tier].map(parseCandidate).filter((c) => config.tools[c.tool].enabled)
      .map((c) => settle(c, { config, models, tools: {}, network: true })).filter((why) => typeof why === "string").map((why) => `tier ${tier}: ${why}`);
    const gap = catalogGap(tier, config, models, true);
    return gap === null ? unusable : [...unusable, gap];
  });
}

export interface TierEntry { candidate: string; usable: boolean; reason: string | null; needsNetwork: boolean }

// What keeps a whole tool from running, whatever its candidates say: down is why its binary cannot be used, which dispatch
// refuses outright, and unread is the problem that the last read of its models ended with.
export interface ToolNotes { down: Partial<Record<ToolName, string>>; unread: Partial<Record<ToolName, string>> }

// Each candidate of each tier as the config writes it, with what keeps it from running whatever the project allows: its tool
// is off, the catalog lacks it, or it is exhausted. A tool that needs worker network says so, as whether the project allows
// it is a project setting that `tiers` does not read.
export function tierReport(config: Config, models: ModelInfo[], tools: ToolState, notes: ToolNotes = { down: {}, unread: {} }): Record<Tier, TierEntry[]> {
  // A tool with no model in the catalog was not read, so naming the candidate's model would blame the config for it.
  const unlisted = (tool: ToolName) => (notes.unread[tool] === undefined ? `${tool} lists no model; run mandor models --refresh` : `${tool}: its models could not be read: ${notes.unread[tool]}`);
  const entries = (tier: Tier) => config.tiers[tier].map((candidate): TierEntry => {
    const c = parseCandidate(candidate);
    const on = config.tools[c.tool].enabled;
    const why = !on ? settle(c, { config, models, tools, network: true }) : notes.down[c.tool] ?? (models.some((m) => m.tool === c.tool) ? settle(c, { config, models, tools, network: true }) : unlisted(c.tool));
    return { candidate, usable: typeof why !== "string", reason: typeof why === "string" ? why : null, needsNetwork: NEEDS_NETWORK.includes(c.tool) };
  });
  return Object.fromEntries(TIER_ORDER.map((tier) => [tier, entries(tier)])) as Record<Tier, TierEntry[]>;
}

// network: whether the project allows its workers the network.
interface RouteContext { config: Config; models: ModelInfo[]; tools: ToolState; active: Record<ToolName, number>; use: Candidate | null; preferTool: ToolName | null; network: boolean }

// The candidate with its effort settled, or the reason it cannot run whatever the slots say.
function settle(c: Candidate, { config, models, tools, network }: Pick<RouteContext, "config" | "models" | "tools" | "network">): Candidate | string {
  const name = `${c.tool}:${c.model}`;
  if (!config.tools[c.tool].enabled) return `${c.tool} is not enabled`;
  if (!network && NEEDS_NETWORK.includes(c.tool)) return `${c.tool} needs worker network, which this project does not allow`;
  const model = models.find((m) => m.tool === c.tool && m.model === c.model);
  if (model === undefined) return `${name} is not in the model catalog`;
  if (model.hidden) return `${name} is hidden`;
  const effort = c.effort === "" ? model.defaultEffort : c.effort;
  if (effort === null) return `${name} has no default effort; name one after @`;
  // Codex sends an effort it does not know to the API, which fails the run.
  if (!model.efforts.includes(effort)) return `${name} does not list effort ${effort}`;
  for (const key of [c.tool, name]) if (Object.hasOwn(tools, key)) return `${key} is exhausted`;
  return { ...c, effort };
}

// Tries the tier, then each heavier one, so a task never runs on less than it asked for. A tier that only lacks a free
// slot waits rather than escalates. Throws only for a use that cannot run.
export function selectCandidate(tier: Tier, ctx: RouteContext): { candidate: Candidate } | { wait: "at-limit" } | { none: true } {
  const hasSlot = (c: Candidate) => ctx.active[c.tool] < ctx.config.tools[c.tool].maxParallel;
  if (ctx.use !== null) {
    const use = settle(ctx.use, ctx);
    if (typeof use === "string") throw new Error(`cannot use ${formatCandidate(ctx.use)}: ${use}`);
    return hasSlot(use) ? { candidate: use } : { wait: "at-limit" };
  }
  for (const t of TIER_ORDER.slice(TIER_ORDER.indexOf(tier))) {
    const usable = ctx.config.tiers[t].map((s) => settle(parseCandidate(s), ctx)).filter((c) => typeof c !== "string");
    if (usable.length === 0) continue;
    const open = usable.filter(hasSlot);
    if (open.length === 0) return { wait: "at-limit" };
    // Strictly fewer, so the first candidate of the least busy tool wins and a tie goes to the first listed.
    const leastBusy = open.reduce((best, c) => (ctx.active[c.tool] < ctx.active[best.tool] ? c : best));
    return { candidate: open.find((c) => c.tool === ctx.preferTool) ?? leastBusy };
  }
  return { none: true };
}
