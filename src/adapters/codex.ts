import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { parseReport } from "../brief.ts";
import type { Config } from "../config.ts";
import { resolveCodexBin } from "../config.ts";
import type { Adapter, JobRecord, JobResult, JobStatus, ModelInfo, RawRun } from "../contracts.ts";
import { jobTmpDir, ownTempEnv, workerEnv } from "../home.ts";
import { CREDIT_OFF_SWITCH, CREDIT_SIGNAL, NETWORK_KEY, ROLLOUT_GLOB, STATE_DB } from "../spikes.ts";
import { clampDetail } from "../store.ts";
import { keepVendorStderr, lostSession } from "./vendor.ts";

export const TESTED_CODEX_VERSION = "0.166.0";

type Run = (bin: string, args: string[]) => { code: number; stdout: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<![A-Za-z0-9])(?:(?:org|user)-[A-Za-z0-9]{20,}|req_[A-Za-z0-9]{16,})/gi;
const QUOTA = ["hit your usage limit", "reached your usage limit", "usage limit reached", "out of credits", "credit limit", "spend cap", "quota exceeded", "to use codex with your chatgpt plan"];
const MISMATCH = ["invalid_encrypted_content", "organization_id did not match"];

// The worker environment keeps an API key in the lead's environment from changing the catalog.
function runVendor(bin: string, args: string[]): { code: number; stdout: string } {
  const r = spawnSync(bin, args, {
    stdio: ["ignore", "pipe", "pipe"], timeout: 30000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, encoding: "utf8", env: workerEnv(null),
  });
  keepVendorStderr("codex", args, r);
  return { code: r.status ?? -1, stdout: r.stdout ?? "" };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const get = (v: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), v);
const percent = (v: unknown, path: string): number => {
  const n = get(v, path);
  return typeof n === "number" ? n : -Infinity;
};

// null for an entry without a slug or a levels list, so one odd entry does not discard the catalog.
function modelInfo(m: unknown): ModelInfo | null {
  const levels = get(m, "supported_reasoning_levels");
  const slug = get(m, "slug");
  if (typeof slug !== "string" || slug === "" || !Array.isArray(levels)) return null;
  const label = get(m, "display_name");
  const effort = get(m, "default_reasoning_level");
  return {
    tool: "codex", model: slug, label: typeof label === "string" ? label : slug,
    efforts: levels.map((l) => get(l, "effort")).filter((e): e is string => typeof e === "string"),
    defaultEffort: typeof effort === "string" ? effort : null, hidden: get(m, "visibility") === "hide",
  };
}

function failedStatus(message: string): JobStatus {
  const m = message.replace(/\u2019/g, "'").toLowerCase();
  if (m.includes("usage limit for ")) return "model-limit";
  if (QUOTA.some((p) => m.includes(p))) return "quota";
  if (MISMATCH.some((p) => m.includes(p))) return "account-mismatch";
  return "failed";
}

// A row of this job's own turns; a resumed thread still holds the row of the quota that stalled it.
function hitUsageLimit(codexHome: string, thread: string, startedAt: string): boolean {
  if (STATE_DB === null) return false;
  const file = join(codexHome, STATE_DB.file);
  if (!existsSync(file)) return false;
  // Loaded on demand: node:sqlite is experimental in Node 22 and warns when first loaded.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 }); // wait out a writer's lock instead of failing at once
  try {
    const t = Date.parse(startedAt);
    const since = STATE_DB.startedUnit === "s" ? Math.floor(t / 1000) : STATE_DB.startedUnit === "ms" ? t : startedAt;
    const rows = db.prepare(`SELECT "${STATE_DB.errorColumn}" AS e FROM "${STATE_DB.table}" WHERE "${STATE_DB.threadColumn}" = ? AND "${STATE_DB.startedColumn}" >= ?`).all(thread, since);
    return rows.some((row) => {
      try {
        const info = get(JSON.parse(String(row.e)), "codexErrorInfo");
        return info === "usageLimitExceeded" || (isObject(info) && Object.hasOwn(info, "usageLimitExceeded"));
      } catch {
        return false;
      }
    });
  } finally {
    db.close();
  }
}

// Resume appends to the thread's rollout and a failed turn may add no token_count, so only an
// event written since the job started describes this run.
function rateLimitsSince(codexHome: string, thread: string, since: number): { found: boolean; rl: unknown } {
  let best = { found: false, at: -Infinity, rl: undefined as unknown };
  for (const rel of globSync(ROLLOUT_GLOB.replace("{sessionId}", thread), { cwd: codexHome })) {
    const p = join(codexHome, rel);
    let text: string;
    try {
      text = p.endsWith(".zst") ? zstdDecompressSync(readFileSync(p)).toString("utf8") : readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (get(e, "type") !== "event_msg" || get(e, "payload.type") !== "token_count") continue;
      const at = Date.parse(String(get(e, "timestamp")));
      if (at >= since && at >= best.at) best = { found: true, at, rl: get(e, "payload.rate_limits") };
    }
  }
  return best;
}

export function createCodexAdapter(cfg: Config, run: Run = runVendor): Adapter {
  return {
    tool: "codex",

    version() {
      const r = run(resolveCodexBin(cfg), ["--version"]);
      if (r.code !== 0) throw new Error(`codex --version failed (exit ${r.code})`);
      const v = /\d+\.\d+\.\d+\S*/.exec(r.stdout)?.[0];
      if (v === undefined) throw new Error("codex --version printed no version number");
      return v;
    },

    detectModels() {
      const r = run(resolveCodexBin(cfg), ["debug", "models"]);
      if (r.code !== 0) throw new Error(`codex debug models failed (exit ${r.code})`);
      let list: unknown;
      try {
        list = get(JSON.parse(r.stdout), "models");
      } catch {} // the parser's message quotes vendor output
      if (!Array.isArray(list)) throw new Error("codex debug models printed a catalog that does not parse");
      const models = list.map(modelInfo).filter((m): m is ModelInfo => m !== null);
      // Saving an empty list would replace the last good one and leave every candidate without a model.
      if (models.length === 0) throw new Error("codex debug models listed no usable model");
      return models;
    },

    prepare(job, files, project) {
      const { model, effort } = job.candidate;
      if (effort === "") throw new Error("codex candidate needs an effort");
      // No -C: the runner binds the worker's cwd to the worktree and verifies it, and a path here would be followed
      // again by Codex. Codex rejects -s and --add-dir after `resume`; -m and -c work on either side. The prompt is the
      // job's own file, read from stdin through the "-" at the end: as an argument it would show in every process list and
      // fail the start where it passes the system's limit on arguments, about a megabyte.
      const before = ["-s", "workspace-write"];
      if (cfg.tools.codex.ignoreUserConfig) before.push("--ignore-user-config");
      if (project.network && NETWORK_KEY !== null) before.push("-c", NETWORK_KEY);
      // The shared temporary directories (/tmp and $TMPDIR) are closed, as the lead's proofs and the user's own tools keep
      // caches and compiled files there; the worker's TMPDIR is a directory of the job's own, which is open instead.
      // Unless the project keeps them open (--shared-temp), for a toolchain that needs them.
      const own = project.sharedTemp === true ? null : jobTmpDir(job.id);
      if (own !== null) before.push("-c", "sandbox_workspace_write.exclude_slash_tmp=true", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "--add-dir", own);
      for (const d of project.addDirs) before.push("--add-dir", d);
      const after = [
        ...(CREDIT_OFF_SWITCH === null ? [] : ["-c", CREDIT_OFF_SWITCH]),
        "-m", model, "-c", `model_reasoning_effort="${effort}"`,
        "--output-schema", files.schemaPath, "-o", files.lastMessagePath, "-",
      ];
      const stdinFile = job.promptPath;
      const env = own === null ? job.env : { ...job.env, ...ownTempEnv(own) };
      if (job.kind === "start") return { command: job.bin, args: ["exec", "--json", ...before, ...after], env, stdinFile };
      const id = job.sessionId ?? "";
      if (!UUID.test(id)) throw new Error("codex resume needs a session UUID");
      return { command: job.bin, args: ["exec", ...before, "resume", id, "--json", ...after], env, stdinFile };
    },

    classify(raw: RawRun): JobResult {
      const events: unknown[] = [];
      for (const line of raw.stdout.split("\n")) {
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
      const thread = get(events.find((e) => get(e, "type") === "thread.started"), "thread_id");
      const sessionId = typeof thread === "string" && UUID.test(thread) ? thread : null;
      const result = (status: JobStatus, detail: string): JobResult => ({
        status, sessionId, report: null, usageCumulative: null, detail: clampDetail(detail), resetsAt: null, exitCode: raw.exitCode, creditFunded: false,
      });
      const exit = raw.exitCode ?? raw.signal;
      const end = events.findLast((e) => get(e, "type") === "turn.completed" || get(e, "type") === "turn.failed");
      if (get(end, "type") === "turn.completed") {
        if (raw.exitCode !== 0) return result("failed", `exit ${exit} after turn.completed; see stderr.log`);
        const report = raw.lastMessage === null ? null : parseReport(raw.lastMessage);
        if (report === null) return result("failed", "report not valid JSON");
        const usage = get(end, "usage");
        const usageCumulative = isObject(usage) ? Object.fromEntries(Object.entries(usage).filter((kv): kv is [string, number] => typeof kv[1] === "number")) : null;
        return { ...result("done", ""), report, usageCumulative };
      }
      if (get(end, "type") === "turn.failed") {
        const message = get(end, "error.message");
        const text = typeof message === "string" && message !== "" ? message : "turn failed";
        return result(failedStatus(text), text.replace(IDS, "<id>"));
      }
      if (raw.exitCode === 0) return result("failed", "stream ended early");
      // Never copy stderr into a detail: only these fixed phrases are recognized.
      if (raw.stderr.includes("already has an active writer")) return result("failed", "session busy");
      if (raw.stderr.includes("Not inside a trusted directory")) return result("failed", "not a git repository");
      return result("failed", `exit ${exit}; see stderr.log`);
    },

    // Best effort: an unreadable database, rollout or line leaves the result as classify left it.
    refine(result: JobResult, job: JobRecord): JobResult {
      // Last, so a run that lost its session still has its credits judged: they paid for it.
      const settled = (r: JobResult) => lostSession(r, job) ?? r;
      const codexHome = job.env.CODEX_HOME;
      const thread = result.sessionId ?? job.sessionId ?? "";
      if (!codexHome || !UUID.test(thread) || job.startedAt === null) return settled(result);
      let out = result;
      try {
        if (out.status === "failed" && hitUsageLimit(codexHome, thread, job.startedAt)) out = { ...out, status: "quota" };
      } catch {}
      try {
        const { found, rl } = rateLimitsSince(codexHome, thread, Date.parse(job.startedAt));
        if (found) {
          const resets = ["primary", "secondary"].filter((w) => percent(rl, `${w}.used_percent`) >= 100)
            .map((w) => get(rl, `${w}.resets_at`)).filter((n): n is number => typeof n === "number");
          const s = CREDIT_SIGNAL;
          out = {
            ...out,
            resetsAt: resets.length > 0 ? Math.max(...resets) : null,
            creditFunded: s !== null && get(rl, s.creditsPath) === true && s.windowPaths.some((p) => percent(rl, p) >= s.threshold),
          };
        }
      } catch {}
      return settled(out);
    },
  };
}

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY/i;

// Codex runs every worker command through `<SHELL> -lc`, so the login files can add variables
// that workerEnv never passes. Only names are kept; values are never read past the split.
function loginShellSecretNames(): string[] | null {
  const env = workerEnv(null);
  // From a directory of no repository: the command may run in a task worktree, which holds files a worker wrote.
  const r = spawnSync(env.SHELL ?? "/bin/zsh", ["-lc", "env -0"], { env, cwd: "/", timeout: 10000, encoding: "utf8" });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  const names = r.stdout.split("\0").map((entry) => {
    const eq = entry.indexOf("=");
    return eq < 0 ? "" : (entry.slice(0, eq).split("\n").pop() ?? ""); // a login file may print text before the first entry
  });
  return names.filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && (SECRET_NAME.test(n) || n === "SSH_AUTH_SOCK"));
}

export function codexWarnings(codexVersion: string | null): string[] {
  const warnings: string[] = [];
  if (codexVersion !== TESTED_CODEX_VERSION) warnings.push(`codex ${codexVersion ?? "(version unknown)"} is not the tested version ${TESTED_CODEX_VERSION}`);
  if (CREDIT_OFF_SWITCH === null) warnings.push("codex has no per-run switch to keep workers off workspace credits");
  const names = loginShellSecretNames();
  if (names === null) warnings.push("could not read the environment of the worker login shell");
  else if (names.length > 0) warnings.push(`the worker login shell exports secret-like variables that worker commands can read: ${names.join(", ")}`);
  return warnings;
}
