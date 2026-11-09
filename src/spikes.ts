export const IGNORE_USER_CONFIG: boolean = true;

// The complete argument that follows `-c`.
export const NETWORK_KEY: string | null = "sandbox_workspace_write.network_access=true";

export const WORKER_NETWORK: "allowed" | "forbidden" = "allowed";

// Relative to HOME; consumers resolve them against os.homedir().
export const GRADLE_ADD_DIRS: readonly string[] = [".gradle/caches", ".gradle/wrapper", ".gradle/native", ".gradle/.tmp", ".gradle/daemon", ".android"];

// codex 0.166.0 has no per-run switch, so init and models warn.
export const CREDIT_OFF_SWITCH: string | null = null;

// The best reading of codex's rate-limit output, unconfirmed: no credit-funded run has been observed to check it against.
export const CREDIT_SIGNAL: { creditsPath: string; windowPaths: readonly string[]; threshold: number } | null = {
  creditsPath: "credits.has_credits",
  windowPaths: ["primary.used_percent", "secondary.used_percent"],
  threshold: 100,
};

export const ROLLOUT_GLOB: string = "sessions/*/*/*/rollout-*-{sessionId}.jsonl*";

export const STATE_DB: { file: string; table: string; threadColumn: string; errorColumn: string; startedColumn: string; startedUnit: "s" | "ms" | "iso" } | null = {
  file: "thread_history_1.sqlite",
  table: "thread_turns",
  threadColumn: "thread_id",
  errorColumn: "error_json",
  startedColumn: "started_at",
  startedUnit: "s",
};
