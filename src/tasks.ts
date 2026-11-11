import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, sep } from "node:path";
import { loadRounds, renderBrief, renderConflictMessage, renderFixMessage, renderHandoff, saveRoundFile } from "./brief.ts";
import { loadConfig, resolveBin, WORKER_TOOLS, type Config } from "./config.ts";
import type { Candidate, FileRef, GoalRecord, JobKind, JobRecord, LedgerEvent, ModelInfo, Pending, ProjectState, StallReason, TaskRecord, TaskStatus, Tier, ToolName, ToolState } from "./contracts.ts";
import {
  addWorktree, apply3way, applyCheck, applyToIndex, assertCommitIdentity, assertHeadIdentity, assertHomeOutsideRepos, assertRepoOutsideHome, branchExists, changedPaths, commitRunning, commitStaged, configuredDrivers, configuredPromisors,
  confineProblem, deleteBranchAt, diffSinceBaseBytes, diffStat, dropLastCommit, git, GitFailure, indexLockPath, indexTree, isClean, PARTIAL_CLONE, projectRoot,
  removeOwnedWorktree, resetHardHead, resetTo, revParse, stagedDiff, worktreeAddRunning,
} from "./git.ts";
import { checkCommitMessage, checkDiff, checkName } from "./guards.ts";
import { assertOutsideRepos, jobDir, mandorHome, processAlive, processStart, projectDir, projectIdFor, roundDir, workerEnv, worktreesDir } from "./home.ts";
import { appendEvent, appendToolEvent, ledgerSize, listProjects, loadState, loadToolState, now, readEvents } from "./ledger.ts";
import { cachedWarnings } from "./modelcache.ts";
import { DEFAULT_DENY, loadProjectConfig, provisionWorktree, type ProjectConfig } from "./provision.ts";
import { catalogGap, countActiveJobs, hasUsableModel, selectCandidate } from "./routing.ts";
import { cancelMarker, completeJobLocked, failedResult, gitLogPath, logGit, logRunner, logRunnerTail, readJob } from "./runner.ts";
import { spawnRunner } from "./spawn.ts";
import { clampDetail, ensureDir, fileRef, readJson, withProjectLock, withSlotsLock, writeFileAtomic, writeJsonAtomic } from "./store.ts";

// The directory is created exclusively, so two jobs started in the same second never share one.
function newJobId(): string {
  ensureDir(dirname(jobDir("x")));
  for (;;) {
    const id = `j-${new Date().toISOString().slice(0, 19).replace(/\D/g, "")}-${randomBytes(2).toString("hex")}`;
    try {
      mkdirSync(jobDir(id), { mode: 0o700 });
      return id;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

// A cancel writes its marker, waits for the task's job without the lock, then records the task cancelled. The marker
// stands while that cancel lives, and once the task is cancelled, so it still stops a job that outlived the wait. One whose
// cancel died before it recorded the task is half a cancel and stops nothing: the job it stopped would leave the task
// working with no job, which nothing would ever settle.
export function cancelStands(projectId: string, taskId: string): boolean {
  const writer = readOwnerFile(cancelMarker(projectId, taskId));
  if (writer === undefined) return false;
  if (writer !== null && processAlive(writer.pid, writer.start)) return true;
  return loadState(projectId).tasks[taskId]?.status === "cancelled";
}

// Under the project lock, which a cancel takes to write its marker: half a cancel goes, and the log says so.
export function cancelStandsLocked(projectId: string, taskId: string): boolean {
  if (cancelStands(projectId, taskId)) return true;
  const marker = cancelMarker(projectId, taskId);
  if (existsSync(marker)) {
    rmSync(marker, { force: true });
    logRunner(`task ${taskId}: removed the marker of a cancel that did not finish`);
  }
  return false;
}

// The caller holds the project lock and then the slots lock, and pumps only after releasing the slots lock. Null when a
// cancel of the task is under way: the task stays as it is.
export function startJobLocked(projectId: string, task: TaskRecord, kind: JobKind, candidate: Candidate, prompt: string, sessionId: string | null): JobRecord | null {
  if (task.worktree === null) throw new Error(`task ${task.id} has no worktree`);
  // A job started now would only be stopped.
  if (cancelStandsLocked(projectId, task.id)) return null;
  const cfg = loadConfig();
  // Before anything is written, so a missing binary leaves no job behind.
  const bin = resolveBin(candidate.tool, cfg);
  const id = newJobId();
  const seq = task.seq + 1;
  const promptPath = join(jobDir(id), "prompt.md");
  writeFileAtomic(promptPath, prompt);
  const job: JobRecord = {
    id, projectId, taskId: task.id, seq, kind, candidate, worktree: task.worktree, sessionId, promptPath,
    timeoutMs: Math.round(cfg.jobTimeoutMinutes * 60_000), bin, env: workerEnv(id), queuedAt: now(),
    status: "queued", runnerPid: null, runnerStart: null, workerPid: null, startedAt: null, endedAt: null,
  };
  writeJsonAtomic(join(jobDir(id), "job.json"), job);
  appendEvent(projectId, { t: "job.started", at: job.queuedAt, job: { id, taskId: task.id, seq, kind, candidate } });
  appendEvent(projectId, {
    t: "task.updated", at: job.queuedAt, taskId: task.id, reason: `${kind} job ${id} started`,
    patch: { status: "working", stallReason: null, pending: null, seq, candidate, sessionId, jobIds: [...task.jobIds, id] },
  });
  try {
    spawnRunner(id);
    return job;
  } catch (e) {
    logRunner(`job ${id}: ${(e as Error).message}`);
    // A failed result never reads the models, and no pump may run while the slots lock is held.
    completeJobLocked(id, failedResult("runner did not start"), [], { pump: false });
    return readJob(id) ?? job;
  }
}

// A fresh session's prompt: the rendered brief, what happened so far, and the changes in the files now.
export function handoffPrompt(projectId: string, task: TaskRecord): string {
  if (task.worktree === null || task.base === null) throw new Error(`task ${task.id} has no worktree or base`);
  const root = recordedRoot(projectId);
  // The diffstat stages the worktree, which would run a driver configured since dispatch. The pump and the runner reach
  // this with no command in front of them to refuse it.
  refuseUnsupported(root);
  return renderHandoff({ originalBrief: readFileSync(task.briefPath, "utf8"), rounds: loadRounds(projectId, task.id), diffStat: diffStat(root, task.worktree, task.base) });
}

// A dependent waits in a worktree made from an older tip. The reset comes first, so a crash before the event only
// repeats it. An unmoved tip writes nothing: this runs on every poll of a task waiting for a slot.
function moveToGoalTipLocked(projectId: string, task: TaskRecord): void {
  if (task.worktree === null) throw new Error(`task ${task.id} has no worktree`);
  const root = recordedRoot(projectId);
  const tip = revParse(root, `refs/heads/${task.goalBranch}`);
  if (tip === task.base) return;
  // The reset checks out the tip, which would run a driver configured since dispatch. After the return above, as this
  // runs on every poll.
  refuseUnsupported(root);
  resetTo(root, task.worktree, tip);
  appendEvent(projectId, { t: "task.updated", at: now(), taskId: task.id, patch: { base: tip }, reason: `moved to the goal tip ${tip}` });
}

// What the pending entry sends. Null for a handoff with no slot in sight: its git work runs in a worktree the worker
// shaped, so it stays out of the lock every project shares, and this runs on every poll of a task waiting for a slot.
function pendingPrompt(projectId: string, task: TaskRecord, pending: Pending, select: () => ReturnType<typeof selectCandidate>): string | null {
  if (pending.kind === "start") return readFileSync(task.briefPath, "utf8");
  if (pending.kind === "handoff") return "candidate" in select() ? handoffPrompt(projectId, task) : null;
  if (task.sessionId === null || task.candidate === null) throw new Error(`task ${task.id} has a pending resume with no session or candidate`);
  // A fix round's message is the notes of the round it starts.
  return pending.message ?? readFileSync(join(roundDir(projectId, task.id, task.seq + 1), "notes.md"), "utf8");
}

// When selectCandidate refuses the task's own candidate at a limit, the lead can reassign or wait it out. Any other
// refusal is a fault to inspect.
function stallForUse(use: Candidate, tools: ToolState): StallReason {
  if (Object.hasOwn(tools, `${use.tool}:${use.model}`)) return "model-limit";
  return Object.hasOwn(tools, use.tool) ? "quota" : "failed";
}

const readTools = () => loadToolState(Math.floor(Date.now() / 1000));

// The running step names a failure in the ledger, which the lead reads. The error itself only goes to the log: git's
// stderr can quote file names a worker chose.
const COULD_NOT_PREPARE = "could not prepare the worktree";
export const COULD_NOT_BUILD = "could not build the handoff";
const COULD_NOT_START = "could not start the job";

// Starts a task's pending entry if it can. One task's problem stalls that task, its pending entry kept for whoever revives
// it. False when the slots lock is busy: it passes, and every other task would only wait it out as well.
function takeTurnLocked(projectId: string, task: TaskRecord, preferTool: ToolName | null, config: Config, models: ModelInfo[]): boolean {
  const pending = task.pending!;
  // A session belongs to the candidate that holds it; a handoff is a fresh session on whatever is free.
  const use = pending.kind === "start" ? task.use : pending.kind === "resume" ? task.candidate : null;
  let tools: ToolState = {};
  // Reads the tools again: the wait for the lock and the git work give a tool time to be marked exhausted.
  const select = () => {
    tools = readTools();
    return selectCandidate(task.tier, { config, models, tools, active: countActiveJobs(), use, preferTool });
  };
  const stall = (stallReason: StallReason, reason: string) => appendEvent(projectId, { t: "task.updated", at: now(), taskId: task.id, patch: { status: "stalled", stallReason }, reason });
  let step = COULD_NOT_PREPARE;
  try {
    if (pending.kind === "start" && task.after !== null) moveToGoalTipLocked(projectId, task);
    step = pending.kind === "handoff" ? COULD_NOT_BUILD : COULD_NOT_START;
    const prompt = pendingPrompt(projectId, task, pending, select);
    step = COULD_NOT_START;
    withSlotsLock(() => {
      const picked = select();
      if ("none" in picked) {
        const gap = catalogGap(task.tier, config, models);
        stall(gap === null ? "all-exhausted" : "failed", gap ?? `no candidate left from tier ${task.tier} up`);
      } else if ("candidate" in picked && prompt !== null) {
        const resume = pending.kind === "resume";
        if (pending.kind === "handoff") saveRoundFile(projectId, task.id, task.seq + 1, "handoff.md", prompt);
        startJobLocked(projectId, task, resume ? "resume" : "start", picked.candidate, prompt, resume ? task.sessionId : null);
      }
    });
  } catch (e) {
    const { message } = e as Error;
    logRunnerTail(`pump of ${projectId}, task ${task.id}`, message);
    if (message.startsWith("slots busy")) return false;
    if (message.startsWith("cannot use ")) stall(stallForUse(use!, tools), message);
    else stall("failed", step);
  }
  return true;
}

// Starts what can start, in ledger order. A bad file that every task reads (the state, the config, the tool state, a job
// record) throws from here instead: it is no one task's fault, and the lead sees it through the command.
export function pumpLocked(projectId: string, models: ModelInfo[]): void {
  if (!hasUsableModel(models)) {
    logRunner(`pump of ${projectId}: no usable model in the catalog, so every task stays as it is`);
    return;
  }
  const { tasks } = loadState(projectId);
  const turns = Object.values(tasks).filter((t) => t.status === "waiting" && t.pending !== null && (t.after === null || tasks[t.after]?.status === "accepted"));
  if (turns.length === 0) return;
  const config = loadConfig();
  // Up front, so a bad file throws here and not inside a turn, where it would stall that task.
  readTools();
  countActiveJobs();
  for (const task of turns) if (!takeTurnLocked(projectId, task, null, config, models)) return;
}

// A command's state is on record by now, so a pump that cannot run never fails it: the log says why, and a later pump
// reports a file it cannot read.
function pumpAfterCommand(projectId: string, models: ModelInfo[], what: string): void {
  try {
    pumpLocked(projectId, models);
  } catch (e) {
    logRunnerTail(what, (e as Error).message);
  }
}

// Loaded on use, as runner.ts does, so the modules that import this one for a job start or the pump never load the
// vendor adapter. The commands below are synchronous, so the module is required rather than imported.
const requireOnUse = createRequire(import.meta.url);

// Every command loads the catalog before it takes a lock: a refresh runs codex.
export function loadCatalog(): ModelInfo[] {
  const { loadModels, MODELS_MAX_AGE_MS } = requireOnUse("./adapters/index.ts") as typeof import("./adapters/index.ts");
  return loadModels(MODELS_MAX_AGE_MS, loadConfig());
}

// A worker can rewrite <worktree>/.git, so a cwd inside the mandor worktrees resolves its project from the root
// that goal start or project setup recorded, never from git discovery. `checkout` is where HEAD is read from when a
// command needs one: the user's own checkout or linked worktree the command ran in, or the recorded root.
export function resolveProject(cwd: string): { root: string; id: string; checkout: string } {
  const real = realpathSync.native(cwd);
  const all = dirname(worktreesDir("x"));
  const worktrees = existsSync(all) ? realpathSync.native(all) : null;
  if (worktrees !== null && real.startsWith(worktrees + sep)) {
    const id = real.slice(worktrees.length + 1).split(sep)[0];
    const record = join(projectDir(id), "root");
    if (!existsSync(record)) throw new Error(`${cwd} is in the mandor worktrees, but project ${id} has no recorded repository`);
    const root = recordedRoot(id);
    return { root, id, checkout: root };
  }
  const root = projectRoot(cwd);
  if (root === null) throw new Error(`${cwd} is not inside a git repository`);
  return { root, id: projectIdFor(root), checkout: cwd };
}

// Runner-side code binds its git calls to this root too.
export function recordRoot(id: string, root: string): void {
  writeFileAtomic(join(projectDir(id), "root"), `${root}\n`);
}

export function recordedRoot(id: string): string {
  return readFileSync(join(projectDir(id), "root"), "utf8").replace(/\n$/, "");
}

// A configured filter or merge driver runs a command that worker-written files (.gitattributes, scripts, modules on
// the command's path) can steer into running code in the lead, and no parse of the command closes every spelling. A
// promisor remote makes git contact it for the objects a checkout, a diff or an apply lacks.
export function refuseUnsupported(root: string): void {
  const drivers = configuredDrivers(root);
  if (drivers.length > 0) throw new Error(`refusing ${root}: its git config defines ${drivers.join(", ")}; filter and merge drivers are not supported`);
  const promisors = configuredPromisors(root);
  if (promisors.length > 0) throw new Error(`refusing ${root}: its git config defines ${promisors.join(", ")}; ${PARTIAL_CLONE}`);
}

const refuseNames = (problems: string[]) => {
  if (problems.length > 0) throw new Error(problems.join("; "));
};

// Before anything is written: a goal or task started where sandbox-exec cannot run could never be worked on.
function refuseUnconfined(): void {
  const why = confineProblem();
  if (why !== null) throw new Error(why);
}

const taskDir = (id: string, slug: string) => join(projectDir(id), "tasks", slug);
// The tree id of the staged change the last review showed, which is the only tree accept commits.
export const reviewedFile = (id: string, slug: string) => join(taskDir(id, slug), "reviewed.json");
const pathSlug = (branch: string) => branch.replaceAll("/", "__");

function readNonEmpty(file: string, what: string): string {
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") throw new Error(`the ${what} file ${file} is empty`);
  return text;
}

// appendJsonl's limit, checked before anything changes that the event would record.
function assertFits(ev: LedgerEvent): void {
  const bytes = Buffer.byteLength(`${JSON.stringify(ev)}\n`);
  if (bytes > 4096) throw new Error(`ledger line of ${bytes} bytes exceeds 4096`);
}

// A file naming the process that holds something: undefined when there is none, null when it does not parse.
function readOwnerFile(file: string): { pid: unknown; start: unknown; tip?: unknown } | null | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Takes back a branch a failed or dead command made. A goal branch is outside wip/, so it is never forced: it goes only
// from the commit it was made at, and git branch -d also keeps one holding commits the main checkout lacks.
function dropBranch(root: string, branch: string, tip: string): void {
  if (branch.startsWith("wip/")) return deleteBranchAt(root, branch, tip);
  if (!branchExists(root, branch)) return;
  const at = revParse(root, `refs/heads/${branch}`);
  if (at !== tip) throw new Error(`branch ${branch} moved from ${tip} to ${at}, so it keeps its work; delete it yourself to start over`);
  const r = git(["branch", "-d", branch], root);
  if (r.code !== 0) throw new Error(r.stderr.trim());
}

// A reservation holds a slug or goal branch from before its worktree exists until its ledger event, and records the
// commit the branch is made at. Neither the branch nor the worktree path may exist when it is written, so whatever a
// stale one finds there is what its dead owner left. It goes last, so a cleanup cut short can be done again.
function reserve(root: string, all: string, file: string, worktree: string, branch: string, tip: string, busy: string): void {
  const held = readOwnerFile(file);
  if (held !== undefined) {
    if (held !== null && processAlive(held.pid, held.start)) throw new Error(`${busy} by pid ${held.pid}`);
    // A dead owner can leave its git running, which would go on writing here after this cleanup.
    const add = worktreeAddRunning(worktree);
    if (add !== null) throw new Error(`an earlier command is still finishing; retry shortly (git pid ${add})`);
    removeOwnedWorktree(root, worktree, null, all);
    // Only the recorded commit can show that a branch is the one its owner made.
    if (typeof held?.tip === "string") dropBranch(root, branch, held.tip);
    rmSync(file);
  }
  if (branchExists(root, branch)) throw new Error(`branch ${branch} already exists`);
  if (lstatSync(worktree, { throwIfNoEntry: false }) !== undefined) throw new Error(`${worktree} already exists`);
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify({ pid: process.pid, start: processStart(process.pid), tip }), { flag: "wx", mode: 0o600 });
}

export function goalStart(cwd: string, branch: string, from: string | null): { goal: GoalRecord; cursor: number } {
  const { root, id, checkout } = resolveProject(cwd);
  refuseUnconfined();
  assertHomeOutsideRepos();
  const models = loadCatalog();
  refuseNames(checkName(branch).map((v) => v.detail));
  // wip/ holds the disposable task branches: no accept can commit on one, and a branch named wip blocks them all.
  if (branch === "wip" || branch.startsWith("wip/")) throw new Error(`refusing goal branch ${branch}: wip/ is for task branches`);
  // Goals are keyed by branch, and a name of digits only reorders them as it would a task slug.
  if (/^\d+$/.test(branch)) throw new Error(`refusing goal branch ${branch}: a name of digits only is not allowed`);
  refuseUnsupported(root);
  assertRepoOutsideHome(root);
  const config = loadProjectConfig(id);
  // Peeled, so a tag names its commit; a ref that looks like an option then fails as a revision. Without --from, the
  // HEAD of the checkout the command ran in, which is the branch the user is on.
  const base = revParse(from === null ? checkout : root, `${from ?? "HEAD"}^{commit}`);
  const all = worktreesDir(id);
  const path = join(all, `goal-${pathSlug(branch)}`);
  const reserved = join(projectDir(id), "goals", pathSlug(branch), "reserved");
  recordRoot(id, root);
  withProjectLock(id, () => {
    // By path too: two branch names can share a worktree path, and a reservation that outlived its goal must not take it.
    const taken = Object.values(loadState(id).goals).find((g) => g.branch === branch || g.integrationWorktree === path);
    if (taken !== undefined) throw new Error(`goal ${taken.branch} already exists`);
    reserve(root, all, reserved, path, branch, base, `goal ${branch} is being started`);
  });
  let started = false;
  try {
    ensureDir(all);
    addWorktree(root, path, branch, base);
    // Proof commands rerun here after an accept, so they get the ignored build inputs a task worktree gets.
    provisionWorktree(root, path, config);
    return withProjectLock(id, () => {
      const goal: GoalRecord = { branch, from: base, integrationWorktree: path, createdAt: now() };
      const cursor = ledgerSize(id);
      appendEvent(id, { t: "goal.started", at: goal.createdAt, goal });
      started = true;
      rmSync(reserved, { force: true });
      pumpAfterCommand(id, models, `goal start of ${branch}`);
      return { goal, cursor };
    })!;
  } catch (e) {
    if (!started) {
      try {
        removeOwnedWorktree(root, path, null, all);
        dropBranch(root, branch, base);
        rmSync(reserved, { force: true });
      } catch (c) {
        (e as Error).message += `; cleanup failed: ${(c as Error).message}`;
      }
    }
    throw e;
  }
}

export function planSet(cwd: string, goal: string, planFile: string, description: string): { cursor: number } {
  const { id } = resolveProject(cwd);
  const models = loadCatalog();
  assertOutsideRepos(planFile, projectRoot);
  const plan = readFileSync(planFile);
  return withProjectLock(id, () => {
    if (loadState(id).goals[goal] === undefined) throw new Error(`no goal ${goal}`);
    const copy = join(projectDir(id), "goals", pathSlug(goal), "plan.md");
    const at = now();
    // Checked before plan.md is overwritten, so a refused plan leaves the last one in place.
    assertFits({ t: "plan.set", at, goal, description, plan: { ...fileRef(planFile), path: copy } });
    writeFileAtomic(copy, plan);
    const cursor = ledgerSize(id);
    appendEvent(id, { t: "plan.set", at, goal, description, plan: fileRef(copy) });
    pumpAfterCommand(id, models, `plan set of ${goal}`);
    return { cursor };
  })!;
}

// Checked before task.created, so a candidate that can never start is refused rather than left waiting. Counting no
// job active, the answer is the candidate itself with an empty effort settled, so every later pump runs the same one;
// a full tool is the pump's to wait out.
function checkUse(use: Candidate, tier: Tier, models: ModelInfo[]): Candidate {
  const active = { codex: 0, zcode: 0, agy: 0 };
  const checked = selectCandidate(tier, { config: loadConfig(), models, tools: loadToolState(Math.floor(Date.now() / 1000)), active, use, preferTool: null });
  return (checked as { candidate: Candidate }).candidate;
}

// Not digits only: records are keyed by slug, and an object lists whole-number keys first, in numeric order, so such a
// name would reorder the tasks that wait for a slot and the session summary.
const SLUG = /^(?!\d+$)[a-z0-9][a-z0-9-]*$/;

// The user vouches for the commits at the top of a goal branch that mandor did not make: from then on accept counts the tip
// as recorded. A commit that lands above it without an accept is unrecorded again.
export function goalAdopt(cwd: string, branch: string): { branch: string; adopted: string; commits: string[]; cursor: number } {
  const { root, id } = resolveProject(cwd);
  return withProjectLock(id, () => {
    const cursor = ledgerSize(id);
    const state = loadState(id);
    const goal = state.goals[branch];
    if (goal === undefined) throw new Error(`no goal ${branch}`);
    if (acceptInDoubt(id, goal)) throw new Error(`an earlier accept of goal ${branch} did not finish; accept settles it first`);
    const commits = unrecordedCommits(root, state, goal);
    if (commits.length === 0) throw new Error(`goal ${branch} holds no commit that mandor did not record`);
    appendEvent(id, { t: "goal.adopted", at: now(), branch, commit: commits[0] });
    return { branch, adopted: commits[0], commits, cursor };
  })!;
}

// Three phases, so git and provisioning run without the project lock: reserve the slug, build the worktree, record.
export function dispatch(cwd: string, o: { goal: string; slug: string; tier: Tier; briefFile: string;
  scope: string[]; use: Candidate | null; after: string | null }): { task: TaskRecord; cursor: number; warnings?: string[] } {
  const { root, id } = resolveProject(cwd);
  refuseUnconfined();
  assertHomeOutsideRepos();
  const models = loadCatalog();
  assertOutsideRepos(o.briefFile, projectRoot);
  const { slug } = o;
  refuseNames([...(SLUG.test(slug) ? [] : [`invalid task slug "${slug}": use lowercase letters, digits and -, and not digits only`]), ...checkName(slug).map((v) => v.detail)]);
  // Every start needs its tool's binary, so nothing is recorded while an enabled tool lacks one, and it comes first
  // because its absence also empties the catalog. Resolving searches PATH but takes a configured path on trust.
  const config = loadConfig();
  for (const tool of WORKER_TOOLS.filter((t) => config.tools[t].enabled)) {
    const bin = resolveBin(tool, config);
    if (!existsSync(bin)) throw new Error(`${tool} not found at ${bin}`);
  }
  if (!hasUsableModel(models)) throw new Error("no model catalog; run mandor models --refresh");
  const use = o.use === null ? null : checkUse(o.use, o.tier, models);
  // A use never reads the tier's list, so only a routed task needs a candidate there.
  const gap = use === null ? catalogGap(o.tier, config, models) : null;
  if (gap !== null) throw new Error(gap);
  // What the enabled tools said when their models were read, which the lead sees nowhere else before work starts.
  const warnings = cachedWarnings(config);
  refuseUnsupported(root);
  assertRepoOutsideHome(root);
  const body = readFileSync(o.briefFile, "utf8");
  const project = loadProjectConfig(id);
  const all = worktreesDir(id);
  const worktree = join(all, `task-${slug}`);
  const branch = `wip/${slug}`;
  const reserved = join(taskDir(id, slug), "reserved");

  const tip = withProjectLock(id, () => {
    const state = loadState(id);
    if (state.goals[o.goal] === undefined) throw new Error(`no goal ${o.goal}`);
    if (state.tasks[slug] !== undefined) throw new Error(`task ${slug} already exists`);
    if (o.after !== null && state.tasks[o.after]?.goalBranch !== o.goal) throw new Error(`--after ${o.after}: no such task in goal ${o.goal}`);
    // It could never start, and nothing would ever say so.
    if (o.after !== null && state.tasks[o.after].status === "cancelled") throw new Error(`--after ${o.after}: that task is cancelled`);
    const tip = revParse(root, `refs/heads/${o.goal}`);
    reserve(root, all, reserved, worktree, branch, tip, `task ${slug} is being dispatched`);
    return tip;
  })!;

  let created = false;
  try {
    ensureDir(all);
    addWorktree(root, worktree, branch, tip);
    provisionWorktree(root, worktree, project);
    // The rendered brief, header included, so a later handoff carries the worker rules too.
    const briefPath = join(taskDir(id, slug), "brief.md");
    writeFileAtomic(briefPath, renderBrief({ shared: project.shared, scope: o.scope, taskBody: body }));
    return withProjectLock(id, () => {
      const task: TaskRecord = {
        id: slug, goalBranch: o.goal, tier: o.tier, after: o.after, status: "waiting", stallReason: null,
        pending: { kind: "start", message: null }, base: tip, worktree, branch, scope: o.scope, seq: 0, fixRounds: 0,
        candidate: null, sessionId: null, use, jobIds: [], integratedCommit: null, briefPath,
      };
      const cursor = ledgerSize(id);
      appendEvent(id, { t: "task.created", at: now(), task });
      created = true;
      rmSync(reserved, { force: true });
      pumpAfterCommand(id, models, `dispatch of ${slug}`);
      return { task: loadState(id).tasks[slug], cursor, ...(warnings.length > 0 ? { warnings } : {}) };
    })!;
  } catch (e) {
    if (!created) {
      try {
        removeOwnedWorktree(root, worktree, null, all);
        dropBranch(root, branch, tip);
        rmSync(reserved, { force: true });
      } catch (c) {
        // The reservation stays, so a later dispatch of this slug finds it stale and finishes the cleanup.
        (e as Error).message += `; cleanup failed: ${(c as Error).message}`;
      }
    }
    throw e;
  }
}

// Each clone path, as itself and with everything under it, so a cloned file is never committed even after the worker
// edits .gitignore.
const cloneDeny = (clone: string[]): string[] => clone.flatMap((p) => [p, `${p}/**`]);

// What accept refuses in a diff, and what the review pack reports as violations. A glob that matches a directory covers
// what is under it.
export const diffDeny = (project: ProjectConfig): string[] => [...DEFAULT_DENY, ...project.deny, ...cloneDeny(project.clone)];

// The directories on the way to a clone path, as exact entries: nothing (a link included) takes the place of one, while
// the tracked files inside it stay committable.
export const diffExact = (project: ProjectConfig): string[] =>
  project.clone.flatMap((p) => {
    const dirs: string[] = [];
    for (let d = posix.dirname(p); d !== "."; d = posix.dirname(d)) dirs.push(d);
    return dirs;
  });

function acceptedEvents(slug: string, seq: number, file: FileRef | null, commit: string): [LedgerEvent, LedgerEvent] {
  const at = now();
  return [
    { t: "verdict", at, taskId: slug, verdict: "accept", seq, file },
    { t: "task.updated", at, taskId: slug, patch: { status: "integrating", integratedCommit: commit }, reason: "accepted" },
  ];
}

const intentFile = (id: string, goal: string) => join(projectDir(id), "goals", pathSlug(goal), "accept-intent.json");

// A killed accept leaves its marker until the next accept settles it: the commit it made may not be on record yet.
export const acceptInDoubt = (id: string, goal: GoalRecord): boolean => existsSync(intentFile(id, goal.branch));

// A killed accept leaves its marker. Under the project lock nothing else moves the goal, so what the marker and HEAD
// say decides: nothing landed and it is undone, or one commit landed from the recorded tip and tree and it stands, or
// the user decides. Returns a commit it adopted.
function recoverAcceptLocked(root: string, id: string, goal: GoalRecord, allowTestIdentity: boolean): { slug: string; commit: string } | null {
  const file = intentFile(id, goal.branch);
  if (!existsSync(file)) return null;
  const { slug, tip, tree } = readJson<{ slug: string; tip: string; tree?: string }>(file);
  const integration = goal.integrationWorktree;
  const lock = indexLockPath(root, integration);
  if (existsSync(lock)) throw new Error(`an earlier accept is still finishing; retry shortly. If no git runs there, remove ${lock}`);
  const running = commitRunning(integration);
  if (running !== null) throw new Error(`an earlier accept is still finishing; retry shortly (git pid ${running})`);
  const head = revParse(integration, "HEAD");
  const stop = (why: string) => new Error(`an earlier accept left ${integration} at ${head}: ${why}. Decide what to keep, then remove ${file}`);
  // The marker explains only a HEAD the goal branch is at: a commit anywhere else would leave the goal without the change.
  const goalAt = revParse(root, `refs/heads/${goal.branch}`);
  if (goalAt !== head) throw stop(`${goal.branch} is at ${goalAt}`);
  if (head === tip) {
    gitStep(`settle an earlier accept of ${goal.branch}`, () => resetHardHead(root, integration));
    rmSync(file);
    return null;
  }
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"], integration).stdout.trim().split(" ").slice(1);
  if (parents.length !== 1 || parents[0] !== tip) throw stop(`it is not one commit on ${tip}`);
  if (revParse(integration, "HEAD^{tree}") !== tree) throw stop(`its tree is not the recorded ${tree ?? "(none)"}`);
  const task = loadState(id).tasks[slug];
  if (task?.integratedCommit !== head) {
    if (task?.status !== "needs-review" && task?.status !== "takeover") throw stop(`task ${slug} is ${task?.status ?? "unknown"}`);
    // The hooks ran in the killed command, whose check of the commit they might have changed never came.
    const raw = git(["cat-file", "commit", "HEAD"], integration).stdout;
    const project = loadProjectConfig(id);
    const bad = checkCommitMessage(raw.slice(raw.indexOf("\n\n") + 2), [...DEFAULT_DENY, ...project.deny], project.nameIsWord);
    if (bad.length > 0) throw stop(bad.map((v) => v.detail).join("; "));
    try {
      assertHeadIdentity(root, integration, allowTestIdentity);
    } catch (e) {
      throw stop((e as Error).message);
    }
    const evidence = join(roundDir(id, slug, task.seq), "evidence-accept.md");
    const [verdict, integrating] = acceptedEvents(slug, task.seq, existsSync(evidence) ? fileRef(evidence) : null, head);
    // Only what the killed command had not appended.
    if (!readEvents(id).items.some((e) => e.t === "verdict" && e.taskId === slug && e.verdict === "accept" && e.seq === task.seq)) appendEvent(id, verdict);
    appendEvent(id, integrating);
  }
  rmSync(file);
  return { slug, commit: head };
}

const runnerLogPath = () => join(mandorHome(), "logs", "runner.log");

// What a failed git step shows the lead: a fixed sentence and the log, where git's own words go whole, as they can quote
// file names a worker chose or the output of a hook. Every error built from git's text is a GitFailure; a refusal of
// mandor's own is as fixed already and passes.
export function fixedFailure(what: string, e: unknown): Error {
  if (!(e instanceof GitFailure)) return e as Error;
  logRunnerTail(what, e.message);
  logGit(what, e.message);
  return new Error(`could not ${what}; see ${gitLogPath()}`);
}

export function gitStep<T>(what: string, step: () => T): T {
  try {
    return step();
  } catch (e) {
    throw fixedFailure(what, e);
  }
}

function taskOf(id: string, slug: string): TaskRecord {
  const task = loadState(id).tasks[slug];
  if (task === undefined) throw new Error(`no task ${slug}`);
  return task;
}

// The commits at the top of a goal branch that no accept of the goal made and the user has not adopted, newest first: a
// commit made by hand passed no review and no guard, so an accept goes no further while the branch ends in one. It reads
// the goal's own line down to the first commit that is recorded or adopted, so a merge counts as one commit, whatever it
// brings in, and one that lies under a recorded commit, which an earlier version allowed, is no refusal. Throws when git
// cannot list them.
export function unrecordedCommits(root: string, state: ProjectState, goal: GoalRecord): string[] {
  const r = git(["rev-list", "--first-parent", `${goal.from}..refs/heads/${goal.branch}`], root);
  if (r.code !== 0) throw new Error(`cannot list the commits of goal ${goal.branch}: ${r.stderr.trim()}`);
  const known = new Set(Object.values(state.tasks).flatMap((t) => (t.goalBranch === goal.branch && t.integratedCommit !== null ? [t.integratedCommit] : [])));
  for (const c of goal.adopted ?? []) known.add(c);
  const unrecorded: string[] = [];
  for (const c of r.stdout.split("\n")) {
    if (c === "") continue;
    if (known.has(c)) break;
    unrecorded.push(c);
  }
  return unrecorded;
}

// Five of them at most, and how many more: a goal rebased or merged outside mandor holds hundreds.
export function unrecordedNote(branch: string, commits: string[]): string {
  const more = commits.length > 5 ? ` and ${commits.length - 5} more` : "";
  return `goal ${branch} holds ${commits.length} commit${commits.length === 1 ? "" : "s"} that mandor did not record (${commits.slice(0, 5).map((c) => c.slice(0, 12)).join(", ")}${more})`;
}

function refuseOpenJob(state: ProjectState, slug: string): void {
  if (Object.values(state.jobs).some((j) => j.taskId === slug && j.outcome === null)) throw new Error(`task ${slug} has a queued or running job`);
}

const rebaseMarker = (id: string, slug: string) => join(taskDir(id, slug), "rebase.json");
const rebasePatch = (id: string, slug: string) => join(taskDir(id, slug), "rebase.patch");

// The marker goes first: a patch left without its marker is only a stray file, a marker without its patch could not restore.
function clearRebase(id: string, slug: string): void {
  rmSync(rebaseMarker(id, slug), { force: true });
  rmSync(rebasePatch(id, slug), { force: true });
}

function restoreWorkerChanges(root: string, task: TaskRecord, oldBase: string, patch: string): void {
  try {
    resetTo(root, task.worktree!, oldBase);
    applyToIndex(root, task.worktree!, patch);
  } catch (e) {
    logRunnerTail(`restore of ${task.id}`, (e as Error).message);
    throw new Error(`could not restore task ${task.id} to its base; its changes are in ${patch}; see ${runnerLogPath()}`);
  }
}

// A rebase killed after its reset leaves the worktree on the goal tip and the ledger on the old base, where the next diff
// would read the goal's own changes as the task's. Only the outcome event moves the base, so the ledger says which it was.
export function recoverRebaseLocked(root: string, id: string, task: TaskRecord): void {
  const marker = rebaseMarker(id, task.id);
  if (!existsSync(marker)) return;
  const { oldBase } = readJson<{ oldBase: string }>(marker);
  if (task.base === oldBase) {
    refuseUnsupported(root);
    restoreWorkerChanges(root, task, oldBase, rebasePatch(id, task.id));
  }
  clearRebase(id, task.id);
}

// The round's message goes to notes.md and never into the ledger: notes stay out of events, the excerpt too, as a conflict
// message lists file names a worker chose, and an event has a size limit. The pump starts the round or, with the tool at
// its limit or spent, leaves it waiting or stalled, so a fix round never runs on an exhausted tool. Whatever the caller
// moved in the task lands in the event that decides the round.
function startFixRoundLocked(projectId: string, task: TaskRecord, message: string, counts: boolean, models: ModelInfo[], verdict: "fix" | "drop"): void {
  const at = now();
  const taskId = task.id;
  const fixRounds = task.fixRounds + (counts ? 1 : 0);
  const moved = { base: task.base, integratedCommit: task.integratedCommit, fixRounds };
  const { maxFixRounds } = loadConfig();
  if (counts && fixRounds > maxFixRounds) {
    // A drop has already removed its commit, which no stall undoes, so it goes on record first.
    const seq = verdict === "drop" ? leadRoundLocked(projectId, task, message, at) : task.seq;
    appendEvent(projectId, { t: "task.updated", at, taskId, patch: { ...moved, seq, status: "stalled", stallReason: "fix-rounds-exceeded" }, reason: `fix round ${fixRounds} is over the limit of ${maxFixRounds}` });
    return;
  }
  const seq = task.seq + 1;
  recordNotesLocked(projectId, taskId, seq, message, verdict, at);
  appendEvent(projectId, { t: "task.updated", at, taskId, patch: { ...moved, status: "waiting", stallReason: null, pending: { kind: "resume", message: null } }, reason: `${verdict}: round ${seq} is next` });
  pumpAfterCommand(projectId, models, `${verdict} of ${taskId}`);
}

function recordNotesLocked(projectId: string, taskId: string, seq: number, notes: string, verdict: "fix" | "drop", at: string): void {
  const { path, sha256 } = saveRoundFile(projectId, taskId, seq, "notes.md", notes);
  appendEvent(projectId, { t: "verdict", at, taskId, verdict, seq, file: { path, sha256, excerpt: "" } });
}

// The first round after the task's own that holds nothing yet.
function freshRound(projectId: string, task: TaskRecord): number {
  let seq = task.seq + 1;
  while (existsSync(roundDir(projectId, task.id, seq))) seq++;
  return seq;
}

// A drop that no worker round follows still opens a round, and the task moves to it: its notes go there, and so does the
// evidence of the lead's next accept, so neither lands on a record of an earlier round. Returns the round.
function leadRoundLocked(projectId: string, task: TaskRecord, notes: string, at: string): number {
  const seq = freshRound(projectId, task);
  recordNotesLocked(projectId, task.id, seq, notes, "drop", at);
  return seq;
}

type RebaseResult = { rebased: true; cursor: number } | { conflict: string[]; cursor: number } | { stalled: "rebase-failed"; cursor: number };

// The goal moved past the task's base, so the change is merged onto the new tip in the task's own worktree, from a patch of
// the rebase's own. Its files come before the reset, so a kill leaves what the next command needs to undo it, and any
// failure on the way ends back on the old base: a restore that fails keeps the marker, so the next command tries again.
function rebaseLocked(root: string, id: string, task: TaskRecord, tip: string, bytes: Buffer, models: ModelInfo[], cursor: number): RebaseResult {
  const slug = task.id;
  const oldBase = task.base!;
  const patch = rebasePatch(id, slug);
  writeFileAtomic(patch, bytes);
  // The round keeps the change as its first rebase found it, under the round it was made in. A later rebase in the round
  // holds the lead's state instead, and after a rebase-failed takeover this record is the only copy of the worker's change.
  const record = join(roundDir(id, slug, task.seq), "conflict.patch");
  if (!existsSync(record)) writeFileAtomic(record, bytes);
  writeJsonAtomic(rebaseMarker(id, slug), { oldBase });
  // A task in takeover has no worker round: the lead resolves any markers.
  const inTakeover = task.status === "takeover";
  let outcome: { rebased: true } | { conflict: string[] } | null = null;
  let failed = false;
  try {
    resetTo(root, task.worktree!, tip);
    const { applied, conflicted } = apply3way(root, task.worktree!, patch);
    if (applied) {
      if (conflicted.length > 0 && !inTakeover) startFixRoundLocked(id, { ...task, base: tip }, renderConflictMessage(task.goalBranch, conflicted), false, models, "fix");
      else appendEvent(id, { t: "task.updated", at: now(), taskId: slug, patch: { base: tip }, reason: `rebased onto the goal tip ${tip}` });
      outcome = conflicted.length > 0 ? { conflict: conflicted } : { rebased: true };
    }
  } catch (e) {
    logRunnerTail(`rebase of ${slug}`, (e as Error).message);
    failed = true;
  }
  if (outcome === null) restoreWorkerChanges(root, task, oldBase, patch);
  clearRebase(id, slug);
  if (failed) throw new Error(`could not rebase task ${slug} onto the goal tip, so it stays on its base; see ${runnerLogPath()}`);
  if (outcome !== null) return { ...outcome, cursor };
  if (!inTakeover) appendEvent(id, { t: "task.updated", at: now(), taskId: slug, patch: { status: "stalled", stallReason: "rebase-failed" }, reason: "the change does not apply on the goal tip, so it stays on its base" });
  return { stalled: "rebase-failed", cursor };
}

export function verdictAccept(cwd: string, slug: string, evidenceFile: string, messageFile: string,
  opts: { allowTestIdentity?: boolean } = {}): { commit: string; cursor: number } | RebaseResult {
  const { root, id } = resolveProject(cwd);
  const models = loadCatalog();
  for (const f of [evidenceFile, messageFile]) assertOutsideRepos(f, projectRoot);
  // A driver configured since dispatch would otherwise run in the recovery, the staging and the apply below.
  refuseUnsupported(root);
  const allowTestIdentity = opts.allowTestIdentity ?? false;
  return withProjectLock(id, () => {
    const cursor = ledgerSize(id);
    const wanted = loadState(id).tasks[slug];
    if (wanted === undefined) throw new Error(`no task ${slug}`);
    const adopted = recoverAcceptLocked(root, id, loadState(id).goals[wanted.goalBranch], allowTestIdentity);
    if (adopted?.slug === slug) {
      pumpAfterCommand(id, models, `accept of ${slug}`);
      return { commit: adopted.commit, cursor };
    }
    recoverRebaseLocked(root, id, wanted);
    const state = loadState(id);
    const task = state.tasks[slug];
    if (task.status !== "needs-review" && task.status !== "takeover") throw new Error(`task ${slug} is ${task.status}, not needs-review or takeover`);
    refuseOpenJob(state, slug);
    const other = Object.values(state.tasks).find((t) => t.goalBranch === task.goalBranch && t.status === "integrating");
    if (other !== undefined) throw new Error(`task ${other.id} of goal ${task.goalBranch} is integrating; confirm or drop it first`);
    const evidence = readNonEmpty(evidenceFile, "evidence");
    const message = readNonEmpty(messageFile, "message");
    const goal = state.goals[task.goalBranch];
    const integration = goal.integrationWorktree;
    // commitStaged checks the identity again; this fails before any work.
    assertCommitIdentity(root, integration, allowTestIdentity);
    const tip = revParse(root, `refs/heads/${goal.branch}`);
    // On the goal branch itself: on another branch at the same commit, the commit would miss the goal.
    const head = git(["symbolic-ref", "-q", "HEAD"], integration).stdout.trim();
    if (head !== `refs/heads/${goal.branch}` || revParse(integration, "HEAD") !== tip || !gitStep(`read the integration worktree of ${goal.branch}`, () => isClean(root, integration))) {
      throw new Error(`integration worktree not clean: ${integration} must be clean and on ${goal.branch} at ${tip}`);
    }
    const unrecorded = unrecordedCommits(root, state, goal);
    if (unrecorded.length > 0) throw new Error(`refusing to accept: ${unrecordedNote(goal.branch, unrecorded)}; they passed no review and no guard, so the user removes them from the branch or adopts them with mandor goal adopt ${goal.branch}, which the lead does not run`);
    if (task.worktree === null || task.base === null) throw new Error(`task ${slug} has no worktree or base`);
    const { bytes, text, tree } = gitStep(`stage task ${slug} for its accept`, () => stagedDiff(root, task.worktree!, task.base!));
    if (bytes.length === 0) throw new Error(`task ${slug} has no changes to accept`);
    // Only the tree the lead saw: a worker round, a rebase, a takeover edit or a process left in the worktree changes it.
    const pin = reviewedFile(id, slug);
    if (!existsSync(pin)) throw new Error(`task ${slug} has no review on record; run mandor review ${slug} first`);
    if (readJson<{ tree: string }>(pin).tree !== tree) throw new Error(`task ${slug} changed since its last review; run mandor review ${slug} again`);
    const patch = join(taskDir(id, slug), "accepted.patch");
    writeFileAtomic(patch, bytes);
    const project = loadProjectConfig(id);
    const deny = [...DEFAULT_DENY, ...project.deny];
    const guarded = (nameIsWord: boolean) => [...checkDiff(text, diffDeny(project), nameIsWord, diffExact(project)), ...checkCommitMessage(message, deny, nameIsWord)];
    const violations = guarded(project.nameIsWord);
    if (violations.length > 0) {
      // Where the repository's own subject uses the name, such prose is no trace, and only the user can say so.
      const hint = !project.nameIsWord && guarded(true).length < violations.length
        ? "\nIf this repository uses that name as a word of its own subject, the user allows it with project setup --name-is-a-word; do not run it yourself."
        : "";
      throw new Error(`accept refused:\n${violations.map((v) => `- ${v.kind}: ${v.detail}`).join("\n")}${hint}`);
    }
    // Sized before anything changes, and saved only once the accept is to commit: a rebase records no accept.
    const sized: FileRef = { path: join(roundDir(id, slug, task.seq), "evidence-accept.md"), sha256: "0".repeat(64), excerpt: clampDetail(evidence) };
    for (const ev of acceptedEvents(slug, task.seq, sized, "0".repeat(64))) assertFits(ev);
    if (!applyCheck(root, integration, patch)) {
      // A merge onto where the task started changes nothing, so something in the integration worktree is in the way.
      if (task.base === tip) throw new Error(`task ${slug} does not apply to ${integration}, though the goal has not moved since its base`);
      return rebaseLocked(root, id, task, tip, bytes, models, cursor);
    }
    const file = saveRoundFile(id, slug, task.seq, "evidence-accept.md", evidence);
    // From here a kill can leave staged changes or a commit the ledger never hears of.
    const intent = intentFile(id, goal.branch);
    writeJsonAtomic(intent, { slug, tip });
    let commit: string;
    try {
      applyToIndex(root, integration, patch);
      writeJsonAtomic(intent, { slug, tip, tree: indexTree(root, integration) });
      commit = commitStaged(root, integration, changedPaths(text).map((c) => c.path), message, allowTestIdentity);
    } catch (e) {
      // The marker goes only with nothing of this attempt left, so the next accept recovers a commit that landed anyway.
      try {
        resetHardHead(root, integration);
        if (revParse(integration, "HEAD") === tip) rmSync(intent, { force: true });
      } catch (r) {
        logRunner(`accept of ${slug}: reset after a failed commit: ${(r as Error).message}`);
      }
      throw fixedFailure(`commit the change of ${slug}`, e);
    }
    for (const ev of acceptedEvents(slug, task.seq, file, commit)) appendEvent(id, ev);
    rmSync(intent, { force: true });
    pumpAfterCommand(id, models, `accept of ${slug}`);
    return { commit, cursor };
  })!;
}

export function confirm(cwd: string, slug: string, evidenceFile: string): { cursor: number; cleanup?: "failed" } {
  const { root, id } = resolveProject(cwd);
  const models = loadCatalog();
  assertOutsideRepos(evidenceFile, projectRoot);
  // git status in the integration worktree runs a clean filter on a file whose timestamp the index does not hold.
  refuseUnsupported(root);
  return withProjectLock(id, () => {
    const state = loadState(id);
    const task = state.tasks[slug];
    if (task === undefined) throw new Error(`no task ${slug}`);
    if (task.status !== "integrating") throw new Error(`task ${slug} is ${task.status}, not integrating`);
    const evidence = readNonEmpty(evidenceFile, "evidence");
    const integration = state.goals[task.goalBranch].integrationWorktree;
    // The goal branch too: a commit HEAD names is not yet one the goal has.
    if (!isClean(root, integration) || revParse(integration, "HEAD") !== task.integratedCommit || revParse(root, `refs/heads/${task.goalBranch}`) !== task.integratedCommit) {
      throw new Error(`integration worktree not clean: ${integration} and ${task.goalBranch} must be clean at ${task.integratedCommit}`);
    }
    const at = now();
    const cursor = ledgerSize(id);
    appendEvent(id, { t: "verdict", at, taskId: slug, verdict: "confirm", seq: task.seq, file: saveRoundFile(id, slug, task.seq, "evidence-confirm.md", evidence) });
    appendEvent(id, { t: "task.updated", at, taskId: slug, patch: { status: "accepted" }, reason: "confirmed" });
    // The task is accepted now, so a worktree that will not go is reported, not a failure of the command.
    let failed = false;
    try {
      if (task.worktree !== null) removeOwnedWorktree(root, task.worktree, task.branch, worktreesDir(id));
    } catch (e) {
      logRunner(`confirm of ${slug}: ${(e as Error).message}`);
      failed = true;
    }
    pumpAfterCommand(id, models, `confirm of ${slug}`);
    return failed ? { cursor, cleanup: "failed" as const } : { cursor };
  })!;
}

export function verdictFix(cwd: string, slug: string, notesFile: string): { cursor: number } {
  const { root, id } = resolveProject(cwd);
  refuseUnconfined();
  const models = loadCatalog();
  assertOutsideRepos(notesFile, projectRoot);
  return withProjectLock(id, () => {
    const cursor = ledgerSize(id);
    const task = taskOf(id, slug);
    recoverRebaseLocked(root, id, task);
    if (task.status !== "needs-review") throw new Error(`task ${slug} is ${task.status}, not needs-review`);
    refuseOpenJob(loadState(id), slug);
    startFixRoundLocked(id, task, renderFixMessage(readNonEmpty(notesFile, "notes")), true, models, "fix");
    return { cursor };
  })!;
}

export function drop(cwd: string, slug: string, notesFile: string): { cursor: number } {
  const { root, id } = resolveProject(cwd);
  refuseUnconfined();
  const models = loadCatalog();
  assertOutsideRepos(notesFile, projectRoot);
  // The reset in the integration worktree would run a driver configured since dispatch.
  refuseUnsupported(root);
  return withProjectLock(id, () => {
    const cursor = ledgerSize(id);
    const state = loadState(id);
    const task = taskOf(id, slug);
    if (task.status !== "integrating") throw new Error(`task ${slug} is ${task.status}, not integrating`);
    const notes = readNonEmpty(notesFile, "notes");
    const { branch, integrationWorktree: integration } = state.goals[task.goalBranch];
    const commit = task.integratedCommit;
    // Elsewhere the reset would move another ref, and a HEAD that sits at the commit's parent would read as a drop done.
    if (git(["symbolic-ref", "-q", "HEAD"], integration).stdout.trim() !== `refs/heads/${branch}`) throw new Error(`refusing to drop ${commit}: ${integration} is not on ${branch}`);
    // A drop killed after its reset finds the goal branch on the commit's parent, with the commit still on record.
    if (commit !== null && revParse(root, `refs/heads/${branch}`) !== revParse(root, `${commit}^`)) {
      try {
        dropLastCommit(root, integration, commit);
      } catch (e) {
        const { message } = e as Error;
        if (message.startsWith("refusing")) throw e; // says what is in the way, and quotes no git stderr
        logRunnerTail(`drop of ${slug}`, message);
        throw new Error(`could not drop ${commit}; see ${runnerLogPath()}`);
      }
    } else if (commit !== null && !isClean(root, integration)) {
      // The reset is already done, so what the worktree holds now is not the commit's: a fix round would go on over it.
      throw new Error(`refusing to drop ${commit}: ${integration} is not clean`);
    }
    // A task the lead took over stays the lead's: no worker round, and no fix round counted.
    if (readEvents(id).items.some((e) => e.t === "verdict" && e.taskId === slug && e.verdict === "takeover")) {
      const at = now();
      const seq = leadRoundLocked(id, task, notes, at);
      appendEvent(id, { t: "task.updated", at, taskId: slug, patch: { status: "takeover", integratedCommit: null, seq }, reason: "dropped; the lead goes on with it" });
      return { cursor };
    }
    startFixRoundLocked(id, { ...task, integratedCommit: null }, renderFixMessage(notes), true, models, "drop");
    return { cursor };
  })!;
}

const REASSIGNABLE: readonly StallReason[] = ["quota", "model-limit", "failed", "timeout", "runner-died", "account-mismatch", "all-exhausted"];

export function reassign(cwd: string, slug: string): { task: TaskRecord; cursor: number } {
  const { root, id } = resolveProject(cwd);
  refuseUnconfined();
  const models = loadCatalog();
  // The handoff's diffstat stages the worktree, which would run a driver configured since dispatch.
  refuseUnsupported(root);
  return withProjectLock(id, () => {
    const cursor = ledgerSize(id);
    const state = loadState(id);
    const task = taskOf(id, slug);
    if (task.status !== "stalled" || task.stallReason === null) throw new Error(`task ${slug} is ${task.status}, not stalled`);
    if (!REASSIGNABLE.includes(task.stallReason)) throw new Error(`task ${slug} is stalled with ${task.stallReason}, which reassign cannot help`);
    const dependency = task.after === null ? undefined : state.tasks[task.after];
    if (dependency !== undefined && dependency.status !== "accepted") throw new Error(`task ${slug} depends on ${dependency.id}, which is ${dependency.status}; cancel it or take it over`);
    refuseOpenJob(state, slug);
    // All-exhausted says candidates exist and their limits stopped them, so a catalog holding none of them must not reach it.
    if (!hasUsableModel(models)) throw new Error("no model catalog; run mandor models --refresh");
    const config = loadConfig();
    const gap = catalogGap(task.tier, config, models);
    if (gap !== null) throw new Error(gap);
    const preferTool = task.stallReason === "model-limit" ? task.candidate?.tool ?? null : null;
    const left = selectCandidate(task.tier, { config, models, tools: readTools(), active: countActiveJobs(), use: null, preferTool });
    const update = (patch: Partial<TaskRecord>, reason: string) => appendEvent(id, { t: "task.updated", at: now(), taskId: slug, patch, reason });
    if ("none" in left) update({ status: "stalled", stallReason: "all-exhausted" }, `no candidate left from tier ${task.tier} up`);
    else {
      update({ status: "waiting", stallReason: null, pending: { kind: "handoff", message: null } }, `reassigned after ${task.stallReason}`);
      // A busy slots lock passes, and the pump below would only wait it out again.
      if (!takeTurnLocked(id, taskOf(id, slug), preferTool, config, models)) return { task: taskOf(id, slug), cursor };
    }
    pumpAfterCommand(id, models, `reassign of ${slug}`);
    return { task: taskOf(id, slug), cursor };
  })!;
}

const READY_REVIVES: readonly (StallReason | null)[] = ["quota", "model-limit", "all-exhausted"];

// A task that still holds a pending entry keeps it, so deferred fix notes reach the worker.
function revivedPending(task: TaskRecord): Pending {
  if (task.pending !== null) return task.pending;
  if (task.candidate === null) return { kind: "start", message: null };
  if (task.sessionId !== null) return { kind: "resume", message: "Continue the task from the current state of the files." };
  return { kind: "handoff", message: null };
}

// Runs from any directory, over every project. `failed` lists a project this could not reach, whose tasks a later ready
// revives; the tool stays marked ready, and one bad ledger or busy lock must not keep the other projects from it.
export function ready(tool: ToolName): { resumed: string[]; failed?: string[] } {
  refuseUnconfined();
  const config = loadConfig();
  if (!Object.hasOwn(config.tools, tool)) throw new Error(`unknown tool ${tool}`);
  const { refreshModels } = requireOnUse("./adapters/index.ts") as typeof import("./adapters/index.ts");
  const models = refreshModels(config);
  appendToolEvent({ t: "tool.ready", at: now(), tool });
  const resumed: string[] = [];
  const failed: string[] = [];
  for (const id of listProjects()) {
    try {
      withProjectLock(id, () => {
        for (const task of Object.values(loadState(id).tasks)) {
          if (task.status !== "stalled" || !READY_REVIVES.includes(task.stallReason) || (task.candidate !== null && task.candidate.tool !== tool)) continue;
          appendEvent(id, { t: "task.updated", at: now(), taskId: task.id, patch: { status: "waiting", stallReason: null, pending: revivedPending(task) }, reason: `${tool} is ready` });
          resumed.push(task.id);
        }
        pumpAfterCommand(id, models, `ready ${tool}`);
      });
    } catch (e) {
      logRunnerTail(`ready ${tool} in ${id}`, (e as Error).message);
      failed.push(id);
    }
  }
  return failed.length > 0 ? { resumed, failed } : { resumed };
}

const CANCEL_WAIT_MS = 20_000;
const CANCELLABLE: readonly TaskStatus[] = ["waiting", "working", "needs-review", "stalled", "takeover"];

export function cancel(cwd: string, slug: string): { cursor: number; cleanup?: "failed" } {
  const { root, id } = resolveProject(cwd);
  const models = loadCatalog();
  const marker = cancelMarker(id, slug);
  const cancellable = (): TaskRecord => {
    const task = taskOf(id, slug);
    if (task.status === "integrating") throw new Error(`task ${slug} is integrating; drop it first`);
    if (!CANCELLABLE.includes(task.status)) throw new Error(`task ${slug} is ${task.status}`);
    return task;
  };
  const cursor = withProjectLock(id, () => {
    cancellable();
    // Its writer, so a start can tell a cancel under way from one that died.
    writeJsonAtomic(marker, { pid: process.pid, start: processStart(process.pid) });
    return ledgerSize(id);
  })!;
  // Without the lock, which the runner needs to record the job's end. A job that outlives this wait still meets the marker.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const end = Date.now() + CANCEL_WAIT_MS;
  while (Date.now() < end && Object.values(loadState(id).jobs).some((j) => j.taskId === slug && j.outcome === null)) Atomics.wait(pause, 0, 0, 100);
  return withProjectLock(id, () => {
    let task: TaskRecord;
    try {
      task = cancellable();
    } catch (e) {
      rmSync(marker, { force: true }); // the task goes on, and this would stop its next job
      throw e;
    }
    const at = now();
    appendEvent(id, { t: "verdict", at, taskId: slug, verdict: "cancel", seq: task.seq, file: null });
    appendEvent(id, { t: "task.updated", at, taskId: slug, patch: { status: "cancelled", stallReason: null, pending: null }, reason: "cancelled" });
    // No pump would ever start these, so they would wait for good.
    const { tasks } = loadState(id);
    const dependsOn = (t: TaskRecord) => {
      for (let a = t.after; a !== null; a = tasks[a]?.after ?? null) if (a === slug) return true;
      return false;
    };
    for (const t of Object.values(tasks)) {
      if ((t.status === "waiting" || t.status === "stalled") && t.jobIds.length === 0 && dependsOn(t)) {
        appendEvent(id, { t: "task.updated", at, taskId: t.id, patch: { status: "stalled", stallReason: "failed" }, reason: `dependency ${slug} was cancelled` });
      }
    }
    clearRebase(id, slug); // the worktree it would restore goes now
    // The task is cancelled now, so a worktree that will not go is reported, not a failure of the command.
    let failed = false;
    try {
      if (task.worktree !== null) removeOwnedWorktree(root, task.worktree, task.branch, worktreesDir(id));
    } catch (e) {
      logRunnerTail(`cancel of ${slug}`, (e as Error).message);
      failed = true;
    }
    pumpAfterCommand(id, models, `cancel of ${slug}`);
    return failed ? { cursor, cleanup: "failed" as const } : { cursor };
  })!;
}

// Frees no slot and queues no job, so it needs no catalog and no pump.
export function takeover(cwd: string, slug: string, approved: boolean): { cursor: number } {
  const { root, id } = resolveProject(cwd);
  return withProjectLock(id, () => {
    const cursor = ledgerSize(id);
    const task = taskOf(id, slug);
    recoverRebaseLocked(root, id, task);
    if (task.status !== "needs-review" && task.status !== "stalled") throw new Error(`task ${slug} is ${task.status}, not needs-review or stalled`);
    refuseOpenJob(loadState(id), slug);
    if ((task.stallReason === "all-exhausted" || task.stallReason === "fix-rounds-exceeded") && !approved) throw new Error(`task ${slug} needs the user's approval for a takeover: ask, then pass --approved`);
    // The lead's work is a round of its own, which the task moves to, so what the lead records (an accept's evidence, the
    // change saved below) never lands on a record of an earlier round.
    const seq = freshRound(id, task);
    const patch: Partial<TaskRecord> = { status: "takeover", stallReason: null, pending: null, seq };
    // The change did not apply on the tip, so the lead starts there and the later accept applies. The reset throws away the
    // worktree that holds the change, edits the lead made since the round's first rebase included, so the change goes
    // first to the new round, as its conflict.patch. The rebase's marker undoes a takeover killed after its reset, as it
    // undoes a killed rebase.
    const reset = task.stallReason === "rebase-failed";
    if (reset) {
      refuseUnsupported(root);
      const tip = revParse(root, `refs/heads/${task.goalBranch}`);
      let saved = false;
      try {
        const bytes = diffSinceBaseBytes(root, task.worktree!, task.base!);
        writeFileAtomic(rebasePatch(id, slug), bytes);
        writeJsonAtomic(rebaseMarker(id, slug), { oldBase: task.base });
        saved = true;
        resetTo(root, task.worktree!, tip);
        writeFileAtomic(join(roundDir(id, slug, seq), "conflict.patch"), bytes);
      } catch (e) {
        logRunnerTail(`takeover of ${slug}`, (e as Error).message);
        if (saved) restoreWorkerChanges(root, task, task.base!, rebasePatch(id, slug));
        clearRebase(id, slug);
        throw new Error(`could not move task ${slug} to the goal tip; see ${runnerLogPath()}`);
      }
      patch.base = tip;
    }
    const at = now();
    appendEvent(id, { t: "verdict", at, taskId: slug, verdict: "takeover", seq, file: null });
    appendEvent(id, { t: "task.updated", at, taskId: slug, patch, reason: "taken over by the lead" });
    if (reset) clearRebase(id, slug);
    return { cursor };
  })!;
}

// What a job's start or completion wrote only repeats the job's outcome, which says more.
const JOB_UPDATE = /^(?:(?:start|resume) )?job j-/;
const REASONS_IN_THE_LOG: readonly string[] = [COULD_NOT_PREPARE, COULD_NOT_BUILD, COULD_NOT_START];

// What wait and show say about a task when its newest update is newer than its last job outcome; null when the outcome
// has the say.
export function newerReason(projectId: string, slug: string): string | null {
  const own = new Set<string>();
  let reason: string | null = null;
  for (const ev of readEvents(projectId).items) {
    if (ev.t === "job.started" && ev.job.taskId === slug) own.add(ev.job.id);
    else if (ev.t === "job.finished" && own.has(ev.jobId)) reason = null;
    else if (ev.t === "task.updated" && ev.taskId === slug && !JOB_UPDATE.test(ev.reason)) reason = ev.reason;
  }
  return reason !== null && REASONS_IN_THE_LOG.includes(reason) ? clampDetail(`${reason}; see ${runnerLogPath()}`) : reason;
}
