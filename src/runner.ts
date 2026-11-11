import type { ChildProcess, StdioOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPORT_SCHEMA, saveRoundFile } from "./brief.ts";
import { loadConfig } from "./config.ts";
import type { Adapter, JobRecord, JobResult, JobStatus, ModelInfo, PreparedRun, ProjectState, StallReason, TaskRecord } from "./contracts.ts";
import { confineProblem, worktreeRoot } from "./git.ts";
import { jobDir, mandorHome, processAlive, processStart, projectDir } from "./home.ts";
import { appendEvent, appendToolEvent, listProjects, loadState, loadToolState, now, readEvents } from "./ledger.ts";
import { loadProjectConfig } from "./provision.ts";
import { catalogGap, countActiveJobs, selectCandidate } from "./routing.ts";
import { clampDetail, ensureDir, readJson, withProjectLock, withSlotsLock, writeFileAtomic, writeJsonAtomic } from "./store.ts";
import { cancelStands, cancelStandsLocked, COULD_NOT_BUILD, handoffPrompt, pumpLocked, startJobLocked } from "./tasks.ts";

const jobFile = (jobId: string) => join(jobDir(jobId), "job.json");
const resultFile = (jobId: string) => join(jobDir(jobId), "result.json");

// Per task, so a job started after the marker was written is stopped as well.
export function cancelMarker(projectId: string, taskId: string): string {
  return join(projectDir(projectId), "tasks", taskId, "cancel");
}

export function failedResult(detail: string): JobResult {
  return { status: "failed", sessionId: null, report: null, usageCumulative: null, detail, resetsAt: null, exitCode: null, creditFunded: false };
}

// null while a job directory has no job.json yet.
export function readJob(jobId: string): JobRecord | null {
  try {
    return readJson<JobRecord>(jobFile(jobId));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    // The parser's own message quotes the file; an I/O error's already names it.
    if (e instanceof SyntaxError) throw new Error(`${jobFile(jobId)} is not valid JSON`);
    throw e;
  }
}

export const runnerLogPath = () => join(mandorHome(), "logs", "runner.log");

// The whole text of a failed git step, which the lead is shown no word of: runner.log keeps one clamped line, and a hook
// that printed a screenful would lose its first lines there. Private, and never pruned (L-20). Never throws.
export const gitLogPath = () => join(mandorHome(), "logs", "git.stderr");
export function logGit(head: string, text: string): void {
  try {
    ensureDir(dirname(gitLogPath()));
    appendFileSync(gitLogPath(), `${now()} ${head}\n${text.slice(0, 64 * 1024).replace(/\n?$/, "\n")}`, { mode: 0o600 });
  } catch {}
}

// Never throws: it runs where an error would undo a completion.
export function logRunner(line: string): void {
  try {
    ensureDir(dirname(runnerLogPath()));
    appendFileSync(runnerLogPath(), `${now()} ${clampDetail(line)}\n`, { mode: 0o600 });
  } catch {}
}

// For a message whose cause comes last: git's own error follows its command line and the worktree path, which alone can
// fill logRunner's 300 characters. The message gives up its start, so the line still ends with the cause.
export function logRunnerTail(head: string, message: string): void {
  logRunner(`${head}: ${message.slice(head.length + 2 - 300)}`);
}

export const isRunnerAlive = (job: JobRecord): boolean => processAlive(job.runnerPid, job.runnerStart);

const QUEUED_GRACE_MS = 60_000;

// A queued job no runner has claimed within the grace never will be: the slot count stops counting
// it, reconcile fails it, and a runner that gets to it late fails it instead of running it.
export function neverStarted(job: JobRecord): boolean {
  return job.status === "queued" && job.runnerPid === null && Date.now() - Date.parse(job.queuedAt) > QUEUED_GRACE_MS;
}

// The name of every job directory, whatever its state; none while no job has ever run.
export function listJobIds(): string[] {
  try {
    return readdirSync(dirname(jobDir("x")), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

const JOB_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

// A job's directory (its logs, prompt and result) is the one thing in the home that only grows, and every slot count and
// status reads all of them. It goes 30 days after the job ended, once the ledger holds that end and the task is settled
// or has a newer job. A task still open keeps its newest job: the review reads its log, and a task left working by a
// crash is settled again from its result. Whatever cannot be shown to be done with, an unreadable ledger or job record
// included, stays, and one such record does not keep the others from going.
// Never throws: it runs where an error would hide the job that just ended.
export function pruneJobs(): void {
  const states = new Map<string, ProjectState | null>();
  const stateOf = (projectId: string): ProjectState | null => {
    if (!states.has(projectId)) {
      try {
        states.set(projectId, loadState(projectId));
      } catch {
        states.set(projectId, null);
      }
    }
    return states.get(projectId)!;
  };
  const prunable = (id: string): boolean => {
    const job = readJob(id);
    // Written so that an end time that does not parse keeps the job.
    if (job === null || job.endedAt === null || !(Date.now() - Date.parse(job.endedAt) > JOB_KEEP_MS)) return false;
    const state = stateOf(job.projectId);
    if (state?.jobs[id]?.outcome == null) return false;
    const task = state.tasks[job.taskId];
    const open = task !== undefined && task.status !== "accepted" && task.status !== "cancelled";
    return !open || Object.values(state.jobs).findLast((j) => j.taskId === job.taskId)?.id !== id;
  };
  try {
    for (const id of listJobIds()) {
      try {
        if (prunable(id)) rmSync(jobDir(id), { recursive: true, force: true });
      } catch (e) {
        logRunner(`job ${id} not pruned: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    logRunner(`old jobs not pruned: ${(e as Error).message}`);
  }
}

const STALLS: readonly JobStatus[] = ["quota", "model-limit", "account-mismatch", "failed", "timeout"];
const stallFor = (status: JobStatus): StallReason => (STALLS.includes(status) ? (status as StallReason) : "failed");

// The job's own status while routing still has somewhere to go, or a slot to wait for. All-exhausted says candidates
// exist and their limits stopped them, so a catalog holding none of them, an empty one included, keeps the status too.
// No slots lock: only `none` changes the answer, and the counts never decide `none`.
export function decideStallLocked(projectId: string, task: TaskRecord, status: JobStatus, models: ModelInfo[]): StallReason {
  const config = loadConfig();
  const preferTool = status === "model-limit" ? task.candidate?.tool ?? null : null;
  const network = loadProjectConfig(projectId).workerNetwork;
  const left = selectCandidate(task.tier, { config, models, tools: loadToolState(Math.floor(Date.now() / 1000)), active: countActiveJobs(), use: null, preferTool, network });
  return "none" in left && catalogGap(task.tier, config, models, network) === null ? "all-exhausted" : stallFor(status);
}

// A session the current account cannot resume restarts once, fresh, from the work so far, on the candidate that held it.
// false: that candidate cannot take it now, because the tool has no free slot, or was marked exhausted meanwhile, or the
// project no longer allows it; the pump then gives the handoff to whatever routing finds usable.
function startHandoffLocked(projectId: string, task: TaskRecord, job: JobRecord, models: ModelInfo[]): boolean {
  const prompt = handoffPrompt(projectId, task);
  return withSlotsLock(() => {
    // job.json turned terminal outside the slots lock, so another project may already hold the freed slot.
    const ctx = { config: loadConfig(), models, tools: loadToolState(Math.floor(Date.now() / 1000)), active: countActiveJobs(), preferTool: null, network: loadProjectConfig(projectId).workerNetwork };
    let picked: ReturnType<typeof selectCandidate>;
    try {
      picked = selectCandidate(task.tier, { ...ctx, use: job.candidate });
    } catch {
      return false; // routing refuses the candidate: not enabled, not listed, exhausted, or passed over
    }
    if (!("candidate" in picked)) return false;
    saveRoundFile(projectId, task.id, task.seq + 1, "handoff.md", prompt);
    startJobLocked(projectId, task, "start", picked.candidate, prompt, null);
    return true;
  });
}

// Idempotent: a job whose job.finished is in the ledger is left alone.
export function completeJobLocked(jobId: string, result: JobResult, models: ModelInfo[], opts: { stallReason?: StallReason; pump?: boolean } = {}): void {
  const job = readJson<JobRecord>(jobFile(jobId));
  if (readEvents(job.projectId).items.some((e) => e.t === "job.finished" && e.jobId === jobId)) return;
  // Settled before anything is written, so job.json and job.finished both record the cancel. Half a cancel goes here, and
  // the job keeps its own outcome.
  const status = cancelStandsLocked(job.projectId, job.taskId) ? "cancelled" : result.status;
  // A done run whose report says blocked or partial: the status alone would hand the lead an empty detail.
  const detail = result.detail === "" && result.report !== null && result.report.status !== "done" ? `the report says ${result.report.status}` : result.detail;
  const at = now();
  writeJsonAtomic(jobFile(jobId), { ...job, status, endedAt: at });
  appendEvent(job.projectId, { t: "job.finished", at, jobId, outcome: { status, sessionId: result.sessionId, detail, resetsAt: result.resetsAt, exitCode: result.exitCode } });
  settleTaskLocked(job, status, result, models, opts.stallReason);
  if (opts.pump ?? true) pumpAfterLocked(job, models);
}

// Never throws, so a pump problem cannot undo the completion before it.
function pumpAfterLocked(job: JobRecord, models: ModelInfo[]): void {
  try {
    pumpLocked(job.projectId, models);
  } catch (e) {
    logRunner(`pump of ${job.projectId} after job ${job.id}: ${(e as Error).message}`);
  }
}

// The task's part of a completion, after job.finished has recorded `status`. A crash can stop it
// part way, so reconcile runs it again for a task still working: each step is safe to repeat, and
// the task leaves working only with its last step.
function settleTaskLocked(job: JobRecord, status: JobStatus, result: JobResult, models: ModelInfo[], stallReason?: StallReason): void {
  const { id: jobId, projectId, taskId } = job;
  const state = loadState(projectId);
  const jobs = Object.values(state.jobs).filter((j) => j.taskId === taskId);
  // Only the task's newest job settles it: a late completion of a job the task has moved past, such
  // as a start that died before its task update, leaves the task alone.
  if (jobs.at(-1)?.id !== jobId) return;
  const task = state.tasks[taskId];
  const at = now();
  const update = (patch: Partial<TaskRecord>, reason: string) => appendEvent(projectId, { t: "task.updated", at, taskId, patch, reason });
  const stall = (reason: StallReason) => update({ status: "stalled", stallReason: reason }, `job ${jobId} ${status}`);
  const handoffLater = (why: string) => update({ status: "waiting", pending: { kind: "handoff", message: null } }, `job ${jobId} account-mismatch; ${why}`);
  const { tool, model } = job.candidate;
  if (result.report !== null) saveRoundFile(projectId, taskId, job.seq, "report.json", `${JSON.stringify(result.report, null, 2)}\n`);
  // A cancel leaves the task as it is, session id included: the cancel command settles it.
  if (status === "cancelled") return;
  const sessionId = result.sessionId ?? job.sessionId;
  if (sessionId !== null) update({ sessionId }, `job ${jobId} session`);
  if (status === "done") {
    // Workspace credits paid for this run, so the tool stays off until the user says it is ready.
    if (result.creditFunded) appendToolEvent({ t: "tool.exhausted", at, key: tool, resetsAt: result.resetsAt, detail: "plan limit reached while workspace credits are available" });
    update({ status: "needs-review" }, `job ${jobId} done`);
  } else if (status === "quota" || status === "model-limit") {
    appendToolEvent({ t: "tool.exhausted", at, key: status === "quota" ? tool : `${tool}:${model}`, resetsAt: result.resetsAt, detail: result.detail });
    stall(stallReason ?? decideStallLocked(projectId, task, status, models));
  } else if (status === "account-mismatch" && job.kind === "resume" && !jobs.some((j) => j.id !== jobId && j.outcome?.status === "account-mismatch")) {
    try {
      if (!startHandoffLocked(projectId, task, job, models)) handoffLater("the handoff waits for a slot or a usable tool");
    } catch (e) {
      const message = (e as Error).message;
      logRunnerTail(`handoff after job ${jobId}`, message);
      // A busy lock passes, so the pump retries the handoff. Anything else needs the lead: the job
      // is finished, so a task left working would never be picked up again. Its reason names the runner log, which
      // holds the cause; the job's own reason would only repeat the account mismatch.
      if (/^(project|slots) busy/.test(message)) handoffLater("the handoff waits for a busy lock");
      else update({ status: "stalled", stallReason: "account-mismatch" }, COULD_NOT_BUILD);
    }
  } else stall(stallReason ?? stallFor(status));
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {} // the group is gone already
}

// Starts the worker in the worktree's root, which this process enters itself and verifies by the physical path it is
// in before the spawn inherits it. A process an earlier round left behind is granted the root entry by its own sandbox
// and can swap the root for a link to a sibling worktree at any instant, so a cwd given to the spawn, a chdir by path in
// the child after the check, would still follow such a link; so would a path handed to the worker, which gets none.
export function spawnInRoot(worktree: string, run: PreparedRun, stdio: StdioOptions): ChildProcess {
  const root = worktreeRoot(worktree);
  process.chdir(root);
  try {
    if (process.cwd() !== root) throw new Error(`refusing ${worktree}: its root ${root} is not a directory at its own path`);
    // A process group of its own, so a stop reaches every process the worker starts.
    return spawn(run.command, run.args, { env: run.env, detached: true, stdio });
  } finally {
    process.chdir(mandorHome()); // it outlives every worktree, so a removal later never strands this process
  }
}

// One worker run between the claim and the completion; it writes result.json.
async function work(job: JobRecord, adapter: Adapter): Promise<JobResult> {
  const dir = jobDir(job.id);
  const files = { schemaPath: join(dir, "schema.json"), lastMessagePath: join(dir, "last-message.json") };
  writeFileAtomic(files.schemaPath, JSON.stringify(REPORT_SCHEMA));
  rmSync(files.lastMessagePath, { force: true });
  const project = loadProjectConfig(job.projectId);
  // Verified before anything is built from it: a write boundary made from the path would name what a link at the root
  // leads to, and the start's own check, a moment later, could pass again.
  const root = worktreeRoot(job.worktree);
  const run = adapter.prepare({ ...job, worktree: root }, files, { network: project.workerNetwork, addDirs: project.workerAddDirs });
  // The prompt file is the worker's stdin: opened here, so the worker needs no path to it.
  const input = run.stdinFile === undefined ? "ignore" : openSync(run.stdinFile, "r");
  const out = openSync(join(dir, "raw.log"), "w", 0o600);
  const err = openSync(join(dir, "stderr.log"), "w", 0o600);
  let child: ChildProcess;
  try {
    child = spawnInRoot(root, run, [input, out, err]);
  } finally {
    if (input !== "ignore") closeSync(input);
    closeSync(out);
    closeSync(err);
  }
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const pid = child.pid;
  if (pid === undefined) {
    await ended; // a spawn error rejects
    throw new Error("worker did not start");
  }
  // The marker is judged again only when it changes: half a cancel stays half until another cancel writes its own, and
  // judging it reads the whole ledger. A judgement that throws counts as no cancel, and the log says so once: a throw here
  // would end the runner and leave the worker running with no timeout.
  const marker = cancelMarker(job.projectId, job.taskId);
  let judged: { mtimeMs: number; stands: boolean } | null = null;
  let told = false;
  const cancelled = (): boolean => {
    try {
      const mtimeMs = statSync(marker, { throwIfNoEntry: false })?.mtimeMs;
      if (mtimeMs === undefined) return false;
      if (judged?.mtimeMs !== mtimeMs) {
        judged = { mtimeMs, stands: false };
        judged.stands = cancelStands(job.projectId, job.taskId);
      }
      return judged.stands;
    } catch (e) {
      if (!told) logRunnerTail(`job ${job.id}: could not judge the cancel marker`, (e as Error).message);
      told = true;
      return false;
    }
  };
  const startedAt = Date.now();
  let stop = null as "cancel" | "timeout" | null;
  let tick: NodeJS.Timeout | undefined;
  let hardKill: NodeJS.Timeout | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  try {
    // Only this runner writes job.json while it is alive, so this update needs no lock.
    writeJsonAtomic(jobFile(job.id), { ...job, workerPid: pid });
    // Wall-clock time, checked every second: a timer would not count the time a sleeping Mac skips.
    tick = setInterval(() => {
      if (stop !== null) return;
      // Read only: half a cancel goes at the completion, under the lock.
      if (cancelled()) stop = "cancel";
      else if (Date.now() - startedAt >= job.timeoutMs) stop = "timeout";
      else return;
      signalGroup(pid, "SIGINT");
      hardKill = setTimeout(() => signalGroup(pid, "SIGKILL"), 10_000);
    }, 1000);
    exit = await ended;
  } finally {
    clearInterval(tick);
    clearTimeout(hardKill);
    // Nothing the worker started outlives the run: not the background jobs a shell left, which ignore
    // SIGINT, and not the worker itself when a throw cut the run short.
    signalGroup(pid, "SIGKILL");
    if (exit === undefined) await ended.catch(() => {});
  }
  let lastMessage: string | null = null;
  if (existsSync(files.lastMessagePath)) {
    chmodSync(files.lastMessagePath, 0o600); // the worker writes it with its own umask
    lastMessage = readFileSync(files.lastMessagePath, "utf8");
  }
  const raw = { stdout: readFileSync(join(dir, "raw.log"), "utf8"), stderr: readFileSync(join(dir, "stderr.log"), "utf8"), exitCode: exit.code, signal: exit.signal, lastMessage };
  let result = adapter.refine(adapter.classify(raw), job);
  // An outcome the stream settled (done, quota) stands even when the stop raced it.
  if (stop === "timeout" && result.status === "failed") result = { ...result, status: "timeout", detail: `stopped at the ${Math.round(job.timeoutMs / 1000)} s job timeout` };
  writeJsonAtomic(resultFile(job.id), result);
  return result;
}

export async function runJob(jobId: string): Promise<void> {
  const { projectId } = readJson<JobRecord>(jobFile(jobId));
  // The claim comes first and loads nothing slow. Past the queued grace the slot count has already
  // dropped the job, so running it could exceed maxParallel: the runner fails it instead.
  const job = withProjectLock(projectId, () => {
    const queued = readJson<JobRecord>(jobFile(jobId));
    if (queued.status !== "queued" || existsSync(resultFile(jobId))) return null;
    if (neverStarted(queued)) {
      // A failed result never reads the models, and the slot count freed this slot long ago.
      completeJobLocked(jobId, failedResult("runner did not start"), [], { pump: false });
      return null;
    }
    const running: JobRecord = { ...queued, status: "running", runnerPid: process.pid, runnerStart: processStart(process.pid), startedAt: now() };
    writeJsonAtomic(jobFile(jobId), running);
    return running;
  }, { maxWaitMs: null });
  if (job === null) return; // finished, another runner's, or past the grace
  // The cause is a line of the runner log, and the detail says where, as a fixed sentence cannot say what.
  let result = failedResult(`runner error; see ${runnerLogPath()}`);
  let models: ModelInfo[] = [];
  try {
    // A runner started where sandbox-exec cannot apply a profile (inside Claude Code's Bash sandbox) cannot confine
    // what its worker writes: the job fails before the worker starts, and the log says why.
    const unconfined = confineProblem();
    if (unconfined !== null) throw new Error(unconfined);
    // Imported on use, so modules that only need completion or liveness never load the vendor adapter.
    const { getAdapter, loadModels, MODELS_MAX_AGE_MS } = await import("./adapters/index.ts");
    const cfg = loadConfig();
    models = loadModels(MODELS_MAX_AGE_MS, cfg); // only the completion uses them, and a refresh can take a minute
    result = await work(job, getAdapter(job.candidate.tool, cfg));
  } catch (e) {
    logRunner(`job ${jobId}: runner error: ${(e as Error).message}`);
  } finally {
    withProjectLock(projectId, () => completeJobLocked(jobId, result, models), { maxWaitMs: null });
  }
  // The completion pumped this project; others may have tasks waiting for the slot this job freed.
  for (const id of listProjects()) {
    if (id === projectId) continue;
    try {
      if (Object.values(loadState(id).tasks).some((t) => t.status === "waiting")) withProjectLock(id, () => pumpLocked(id, models));
    } catch (e) {
      logRunner(`pump of ${id} after job ${jobId}: ${(e as Error).message}`);
    }
  }
  // This runner is detached, so no command waits for the clearing out.
  pruneJobs();
}

// Finishes what a dead runner or a crashed completion left undone. It reads recorded pids and never
// signals them.
export function reconcileLocked(projectId: string, models: ModelInfo[]): string[] {
  const completed: string[] = [];
  const state = loadState(projectId);
  const jobs = Object.values(state.jobs);
  for (const task of Object.values(state.tasks)) {
    // The newest job in the ledger, listed by the task or not: a newer job than the finished one means
    // a handoff had already started it, so the task is left to that job.
    const last = task.status === "working" ? jobs.findLast((j) => j.taskId === task.id) : undefined;
    if (last === undefined || last.outcome === null) continue;
    if (last.outcome.status === "cancelled") {
      // The cancel that stopped the job settles the task. One that died first left it working with no job for good,
      // so it goes to the lead, who can reassign it or cancel it again.
      if (!cancelStandsLocked(projectId, task.id)) {
        appendEvent(projectId, { t: "task.updated", at: now(), taskId: task.id, patch: { status: "stalled", stallReason: "failed" }, reason: `a cancel stopped job ${last.id} and ended before it cancelled the task` });
      }
      continue;
    }
    const job = readJob(last.id);
    if (job === null) continue;
    const { status, sessionId, detail, resetsAt, exitCode } = last.outcome;
    // A failure no run judged (runner error, died, never started) has no result.json; job.finished holds it.
    const result = existsSync(resultFile(job.id)) ? readJson<JobResult>(resultFile(job.id)) : { ...failedResult(detail), sessionId, resetsAt, exitCode };
    settleTaskLocked(job, status, result, models);
    pumpAfterLocked(job, models);
    completed.push(job.id);
  }
  // A cancel that died after it recorded its task, before it stalled the tasks that follow, left them waiting for good.
  // Only a task that directly follows a cancelled one: a task further down waits behind one that the lead now sees
  // stalled, and one that follows a taken over or accepted task is not stuck at all. The state is read again, as the
  // loop above and its pump moved it.
  const current = loadState(projectId);
  for (const task of Object.values(current.tasks)) {
    if (task.status !== "waiting" || task.jobIds.length > 0 || task.after === null || current.tasks[task.after]?.status !== "cancelled") continue;
    appendEvent(projectId, { t: "task.updated", at: now(), taskId: task.id, patch: { status: "stalled", stallReason: "failed" }, reason: `dependency ${task.after} was cancelled` });
  }
  for (const { id, outcome } of jobs) {
    const job = outcome === null ? readJob(id) : null;
    if (job === null) continue;
    if (job.status === "queued") {
      if (!neverStarted(job)) continue;
      completeJobLocked(id, failedResult("runner did not start"), models);
    } else if (isRunnerAlive(job)) continue;
    else if (existsSync(resultFile(id))) completeJobLocked(id, readJson<JobResult>(resultFile(id)), models);
    else completeJobLocked(id, failedResult("runner died"), models, { stallReason: "runner-died" });
    completed.push(id);
  }
  return completed;
}
