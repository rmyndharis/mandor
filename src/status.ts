import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROUND_FILES, askOf, roundReport } from "./brief.ts";
import { formatCandidate } from "./config.ts";
import type { JobRecord, JobResult, ProjectState, TaskRecord, ToolState } from "./contracts.ts";
import { jobDir, projectDir, roundDir } from "./home.ts";
import { ledgerSize, loadState, loadToolState } from "./ledger.ts";
import { readJob, reconcileLocked } from "./runner.ts";
import { readJson, withProjectLock } from "./store.ts";
import { acceptInDoubt, loadCatalog, newerReason, resolveProject, unfinishedAccept, unrecordedCommits, unrecordedNote } from "./tasks.ts";

const NO_PROJECT = "mandor: no project here";

// Two spaces between columns, so a line splits back into its cells.
function columns(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

function duration(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return m < 60 ? `${m}m${pad(s % 60)}s` : `${Math.floor(m / 60)}h${pad(m % 60)}m`;
}

const statusOf = (t: TaskRecord) => (t.stallReason === null ? t.status : `${t.status} (${t.stallReason})`);

// The time of the task's newest job: its run when finished, the run so far while it lasts.
function elapsed(t: TaskRecord, jobs: JobRecord[], nowMs: number): string {
  const job = jobs.findLast((j) => j.taskId === t.id);
  if (job === undefined) return "-";
  const ms = (job.endedAt === null ? nowMs : Date.parse(job.endedAt)) - Date.parse(job.startedAt ?? job.queuedAt);
  return Number.isNaN(ms) ? "-" : duration(ms);
}

// A reset time that is missing or not a date reads as unknown rather than failing the table.
function resetTime(epochSec: number | null): string {
  const d = new Date((epochSec ?? NaN) * 1000);
  return Number.isNaN(d.getTime()) ? "unknown" : `${d.toISOString().slice(0, 19)}Z`;
}

export function statusTable(state: ProjectState, jobs: JobRecord[], tools: ToolState, nowMs: number): string {
  const tasks = Object.values(state.tasks);
  const rows = tasks.map((t) => [t.id, statusOf(t), t.candidate === null ? "-" : formatCandidate(t.candidate), String(t.seq), String(t.fixRounds), elapsed(t, jobs, nowMs)]);
  const exhausted = Object.entries(tools).map(([key, v]) => `exhausted: ${key} until ${resetTime(v.resetsAt)}${v.detail === "" ? "" : `: ${v.detail}`}`);
  const head = ["task", "status", "candidate", "seq", "fix rounds", "elapsed"];
  return [tasks.length === 0 ? "no tasks" : columns([head, ...rows]), ...exhausted].join("\n");
}

function taskOf(state: ProjectState, slug: string): TaskRecord {
  const t = state.tasks[slug];
  if (t === undefined) throw new Error(`no task ${slug}; mandor status lists the tasks`);
  return t;
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

// Only the names mandor writes, so a stray temp file is not listed. Paths only, never contents.
function roundFiles(projectId: string, slug: string): string[] {
  const seqs = entries(join(projectDir(projectId), "tasks", slug, "rounds")).filter((n) => /^(0|[1-9]\d*)$/.test(n)).map(Number).sort((a, b) => a - b);
  return seqs.flatMap((seq) => ROUND_FILES.map((n) => join(roundDir(projectId, slug, seq), n)).filter(existsSync));
}

// One line per job of the task, with what its run used. Codex reports a session's usage summed over its runs, so a run's
// own usage is what it added to the count the session's run before it left; a tool that reports each run's own says so. A job with no result on disk (not ended yet,
// ended without one, or its directory cleared out) has none to show.
function jobLines(jobs: ProjectState["jobs"][string][]): string[] {
  const counted = new Map<string, Record<string, number>>();
  return jobs.map((j) => {
    let used = "no usage recorded";
    try {
      const { sessionId, usageCumulative: total, usagePerRun } = readJson<JobResult>(join(jobDir(j.id), "result.json"));
      if (total !== null) {
        const before = (!usagePerRun && sessionId !== null && counted.get(sessionId)) || {};
        used = Object.entries(total).map(([k, n]) => `${k} ${n - (before[k] ?? 0)}`).join(", ");
        if (sessionId !== null) counted.set(sessionId, total);
      }
    } catch {}
    return `  ${j.id} ${formatCandidate(j.candidate)} ${j.outcome?.status ?? "unfinished"}: ${used}`;
  });
}

export function showTask(projectId: string, slug: string): string {
  const state = loadState(projectId);
  const t = taskOf(state, slug);
  const outcome = Object.values(state.jobs).findLast((j) => j.taskId === slug && j.outcome !== null)?.outcome;
  const reason = newerReason(projectId, slug);
  const last = reason !== null ? `${t.status}: ${reason}` : outcome == null ? "none" : outcome.detail === "" ? outcome.status : `${outcome.status}: ${outcome.detail}`;
  const ask = t.status === "needs-review" ? askOf(roundReport(projectId, slug, t.seq)) : null;
  const files = roundFiles(projectId, slug);
  const jobs = jobLines(Object.values(state.jobs).filter((j) => j.taskId === slug));
  // confirm and cancel remove the worktree, so its path alone would send the lead to a directory that is gone.
  const settled = t.status === "accepted" || t.status === "cancelled";
  const worktree = t.worktree === null ? "none" : settled && !existsSync(t.worktree) ? `${t.worktree} (removed)` : t.worktree;
  return [
    `task: ${t.id}`, `status: ${statusOf(t)}`, `brief: ${t.briefPath}`, `worktree: ${worktree}`, `branch: ${t.branch}`,
    `base: ${t.base ?? "none"}`, `session: ${t.sessionId ?? "none"}`, `fix rounds: ${t.fixRounds}`, `last outcome: ${last}`,
    ...(ask === null ? [] : [`next: answer: ${ask}`]),
    ...(files.length === 0 ? [] : ["round files:", ...files.map((f) => `  ${f}`)]),
    ...(jobs.length === 0 ? [] : ["jobs:", ...jobs]),
  ].join("\n");
}

// The ledger lists the jobs, since a job can be there without being on its task. Only logs that exist.
export function logPaths(projectId: string, slug: string): string[] {
  const state = loadState(projectId);
  taskOf(state, slug);
  return Object.values(state.jobs)
    .filter((j) => j.taskId === slug)
    .flatMap((j) => ["raw.log", "stderr.log"].map((n) => join(jobDir(j.id), n)))
    .filter(existsSync);
}

// Outside a project it reads and creates nothing: the lock would create the project directory, and a stray one
// must not arm the hooks. The models load before the lock, as in every command.
function statusReport(cwd: string, json: boolean): string {
  let id: string, root: string;
  try {
    ({ id, root } = resolveProject(cwd));
  } catch (e) {
    if (/is not inside a git repository/.test((e as Error).message)) return NO_PROJECT;
    throw e;
  }
  if (ledgerSize(id) === 0) return NO_PROJECT;
  const models = loadCatalog();
  const nowMs = Date.now();
  // The cursor is taken before reconcile appends, so a wait from it still reports what reconcile found.
  const { cursor, state, jobs, unrecorded, unfinished } = withProjectLock(id, () => {
    const cursor = ledgerSize(id);
    reconcileLocked(id, models);
    const state = loadState(id);
    // Under the lock, with the state it was read from, so an accept cannot land between them. A goal whose branch cannot
    // be read says nothing here, as the commands that need it say why they fail, and one with an accept that was killed
    // names that accept until the next one has settled it: the commit it made may not be on record yet.
    const unrecorded: Record<string, string[]> = {};
    const unfinished: Record<string, string> = {};
    for (const goal of Object.values(state.goals)) {
      const inDoubt = acceptInDoubt(id, goal);
      if (inDoubt !== null) {
        unfinished[goal.branch] = inDoubt;
        continue;
      }
      try {
        const commits = unrecordedCommits(root, state, goal);
        if (commits.length > 0) unrecorded[goal.branch] = commits;
      } catch {}
    }
    return { cursor, state, jobs: Object.keys(state.jobs).flatMap((j) => readJob(j) ?? []), unrecorded, unfinished };
  })!;
  const tools = loadToolState(Math.floor(nowMs / 1000));
  // A job's env is the worker's environment and never reaches output.
  const goals = Object.values(state.goals).map((g) => ({ branch: g.branch, integrationWorktree: g.integrationWorktree, description: g.description, plan: g.plan?.path ?? null }));
  if (json) return JSON.stringify({ project: id, cursor, goals, tasks: Object.values(state.tasks), jobs: jobs.map(({ env, ...rest }) => rest), tools, unrecorded, unfinished }, null, 2);
  const notes = Object.entries(unrecorded).map(([branch, commits]) => `${unrecordedNote(branch, commits)}; accept refuses until the user removes them or runs mandor goal adopt ${branch}, which the lead does not run`);
  // "?" is a marker that cannot be read, so no accept can settle it: only the user can.
  const doubts = Object.entries(unfinished).map(([branch, slug]) => `goal ${branch}: ${unfinishedAccept(slug)}`);
  const where = goals.map((g) => `goal ${g.branch}: ${g.integrationWorktree}`);
  return `${[statusTable(state, jobs, tools, nowMs), ...where, ...doubts, ...notes].join("\n")}\ncursor: ${cursor}`;
}

// argv is status [--json], show <slug> or logs <slug>. Prints, and returns the exit code.
export function viewMain(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const wellFormed = cmd === "status" ? rest.length === 0 || (rest.length === 1 && rest[0] === "--json") : rest.length === 1;
  if (!wellFormed) {
    console.error(`mandor: usage: ${cmd === "status" ? "status [--json]" : `${cmd} <slug>`}`);
    return 2;
  }
  try {
    const cwd = process.cwd();
    if (cmd === "status") console.log(statusReport(cwd, rest.length === 1));
    else if (cmd === "show") console.log(showTask(resolveProject(cwd).id, rest[0]));
    else console.log(logPaths(resolveProject(cwd).id, rest[0]).join("\n") || `no logs for ${rest[0]} yet`);
    return 0;
  } catch (e) {
    console.error(`mandor: ${(e as Error).message}`);
    return 1;
  }
}
