export type ToolName = "codex" | "zcode" | "agy";
export type Tier = "ringan" | "sedang" | "berat";
export const TIER_ORDER: readonly Tier[] = ["ringan", "sedang", "berat"];

export interface Candidate { tool: ToolName; model: string; effort: string } // effort "" when absent
export interface ModelInfo { tool: ToolName; model: string; label: string; efforts: string[]; defaultEffort: string | null; hidden: boolean }

export type JobKind = "start" | "resume";
export type JobStatus = "queued" | "running" | "done" | "failed" | "quota" | "model-limit"
  | "account-mismatch" | "timeout" | "cancelled";

export type TaskStatus = "waiting" | "working" | "needs-review" | "integrating" | "accepted"
  | "stalled" | "takeover" | "cancelled";
export type StallReason = "all-exhausted" | "fix-rounds-exceeded" | "quota" | "model-limit"
  | "account-mismatch" | "failed" | "timeout" | "runner-died" | "rebase-failed";
export interface Pending { kind: "start" | "handoff" | "resume"; message: string | null }

export interface WorkerReport {
  status: "done" | "blocked" | "partial"; summary: string; files_changed: string[];
  commands_run: { command: string; exit_code: number; summary: string }[];
  tests: { ran: boolean; passed: number; failed: number; notes: string };
  open_issues: string[]; questions_for_lead: string[];
}

export interface GoalRecord { branch: string; from: string; integrationWorktree: string; createdAt: string }
export interface TaskRecord {
  id: string;                       // the slug, unique per project
  goalBranch: string; tier: Tier; after: string | null; status: TaskStatus;
  stallReason: StallReason | null; pending: Pending | null;
  base: string | null; worktree: string | null; branch: string; scope: string[];
  seq: number;                      // job sequence; rounds/<seq>/ per job
  fixRounds: number;                // counted fix rounds for maxFixRounds
  candidate: Candidate | null; sessionId: string | null;
  use: Candidate | null;            // --use from dispatch; the pump honors it for a start pending
  jobIds: string[]; integratedCommit: string | null; briefPath: string;
}
export interface JobRecord {        // live record in jobs/<id>/job.json
  id: string;                       // "j-<yyyymmddHHMMss>-<4 hex>"
  projectId: string; taskId: string; seq: number; kind: JobKind; candidate: Candidate;
  worktree: string; sessionId: string | null; promptPath: string; timeoutMs: number;
  bin: string; env: Record<string, string>; queuedAt: string;
  status: JobStatus; runnerPid: number | null; runnerStart: string | null; workerPid: number | null;
  startedAt: string | null; endedAt: string | null;
}
export interface JobResult {        // full result in jobs/<id>/result.json
  status: JobStatus; sessionId: string | null; report: WorkerReport | null;
  usageCumulative: Record<string, number> | null; detail: string;
  resetsAt: number | null;          // epoch seconds
  exitCode: number | null; creditFunded: boolean;
  model?: string | null;            // the model the run itself named, for a tool that names one
  usagePerRun?: boolean;            // usageCumulative holds this run's own usage, not the session's sum
}
export interface JobOutcome { status: JobStatus; sessionId: string | null; detail: string; resetsAt: number | null; exitCode: number | null }
export interface RawRun { stdout: string; stderr: string; exitCode: number | null; signal: string | null; lastMessage: string | null }
export interface PreparedRun { command: string; args: string[]; env: Record<string, string>; stdinFile?: string } // stdinFile: becomes the worker's stdin
export interface Adapter {
  tool: ToolName;
  detectModels(): ModelInfo[];
  version(): string;
  prepare(job: JobRecord, files: { schemaPath: string; lastMessagePath: string }, project: { network: boolean; addDirs: string[] }): PreparedRun;
  classify(raw: RawRun): JobResult;
  refine(result: JobResult, job: JobRecord): JobResult;  // structured quota fallback, resetsAt, credit signal
}

export type Verdict = "accept" | "confirm" | "drop" | "fix" | "takeover" | "cancel";
export interface FileRef { path: string; sha256: string; excerpt: string }  // excerpt <= 300 chars
export type LedgerEvent =
  | { t: "goal.started"; at: string; goal: GoalRecord }
  | { t: "plan.set"; at: string; goal: string; description: string; plan: FileRef }
  | { t: "task.created"; at: string; task: TaskRecord }
  | { t: "task.updated"; at: string; taskId: string; patch: Partial<TaskRecord>; reason: string }
  | { t: "job.started"; at: string; job: { id: string; taskId: string; seq: number; kind: JobKind; candidate: Candidate } }
  | { t: "job.finished"; at: string; jobId: string; outcome: JobOutcome }
  | { t: "verdict"; at: string; taskId: string; verdict: Verdict; seq: number; file: FileRef | null };
export type ToolEvent =
  | { t: "tool.exhausted"; at: string; key: string; resetsAt: number | null; detail: string }  // key "codex" or "codex:<model>"
  | { t: "tool.ready"; at: string; tool: ToolName };

export interface ProjectState {
  goals: Record<string, GoalRecord & { description: string | null; plan: FileRef | null }>;
  tasks: Record<string, TaskRecord>;
  jobs: Record<string, { id: string; taskId: string; seq: number; kind: JobKind; candidate: Candidate; outcome: JobOutcome | null }>;
}
export type ToolState = Record<string, { resetsAt: number | null; detail: string }>;
export interface WaitItem { task: string; status: TaskStatus; candidate: string | null; detail: string;
  next: "review" | "reassign-or-ready" | "offer-takeover" | "fix-rounds-exceeded" | "inspect" }
export type WaitSummary = { kind: "events"; items: WaitItem[]; cursor: number }
  | { kind: "idle"; cursor: number } | { kind: "timeout"; cursor: number };
