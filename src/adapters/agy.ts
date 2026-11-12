import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseReport } from "../brief.ts";
import type { Config } from "../config.ts";
import { AGY_NOTICE, resolveBin } from "../config.ts";
import type { Adapter, JobResult, JobStatus, ModelInfo, RawRun, WorkerReport } from "../contracts.ts";
import { mandorHome, workerEnv } from "../home.ts";
import { clampDetail, ensureDir } from "../store.ts";
import { keepVendorStderr } from "./vendor.ts";
import { fitsReport, lastJsonObject } from "./zcode.ts";

export const TESTED_AGY_VERSION = "1.5.2";

// The worker's own configuration directory. The CLI loads the user's plugins, MCP servers, hooks and rules from its
// directory, and a hook of theirs rewrites the worker's commands. The sign-in is in the Keychain, which this does not
// move, so the worker runs on the account the Antigravity app holds.
export const agyHome = (): string => join(mandorHome(), "agy", "home");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An id ends in its effort, which the CLI takes no other way.
const EFFORT = /-(low|medium|high|xhigh|max)$/;
// An argument, as print mode takes the prompt; the system's limit on arguments is about a megabyte.
const MAX_PROMPT_BYTES = 200_000;
// The CLI updates itself otherwise, in the middle of a job.
const NO_UPDATE = { AGY_CLI_DISABLE_AUTO_UPDATE: "true" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const get = (v: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), v);

const home = (): string[] => {
  ensureDir(agyHome());
  return [`--gemini_dir=${agyHome()}`];
};

function run(bin: string, args: string[]): { code: number; stdout: string } {
  const r = spawnSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, encoding: "utf8", env: { ...workerEnv(null), ...NO_UPDATE } });
  keepVendorStderr("agy", args, r);
  return { code: r.status ?? -1, stdout: r.stdout ?? "" };
}

export function createAgyAdapter(cfg: Config): Adapter {
  const bin = () => resolveBin("agy", cfg);
  return {
    tool: "agy",

    version() {
      const r = run(bin(), [...home(), "--version"]);
      if (r.code !== 0) throw new Error(`agy --version failed (exit ${r.code}); read logs/vendor.stderr in the state home for why`);
      const v = /\d+\.\d+\.\d+\S*/.exec(r.stdout)?.[0];
      if (v === undefined) throw new Error("agy --version printed no version number; run it yourself to see what it prints");
      return v;
    },

    // No turn runs for this. The list depends on the account's plan.
    detectModels() {
      const r = run(bin(), [...home(), "--output-format", "json", "models"]);
      if (r.code !== 0) throw new Error(`agy models failed (exit ${r.code}); read logs/vendor.stderr in the state home for why, then run mandor models --refresh`);
      let list: unknown;
      try {
        list = get(JSON.parse(r.stdout), "command.data.models");
      } catch {} // the parser's message quotes vendor output
      if (!Array.isArray(list)) throw new Error("agy models printed a list that does not parse; run it yourself to see what it prints");
      const models = list.flatMap((m): ModelInfo[] => {
        const id = get(m, "id");
        if (typeof id !== "string" || id === "") return [];
        const label = get(m, "label");
        const effort = EFFORT.exec(id)?.[1] ?? "default";
        return [{ tool: "agy", model: id, label: typeof label === "string" ? label : id, efforts: [effort], defaultEffort: effort, hidden: false }];
      });
      if (models.length === 0) throw new Error("agy models listed no model; sign in to Antigravity, then run mandor models --refresh");
      return models;
    },

    prepare(job, files, project) {
      // The tool's sandbox proxy, not the project's setting, decides what a command reaches, so a project that never
      // allowed worker network cannot be promised a closed one: the job is refused, as a ZCode job is.
      if (!project.network) throw new Error("agy workers reach the network through their sandbox's proxy, which the project's setting does not close: tell the user, who allows it with mandor project setup --update --worker-network");
      const prompt = readFileSync(job.promptPath, "utf8");
      const bytes = Buffer.byteLength(prompt);
      if (bytes > MAX_PROMPT_BYTES) throw new Error(`prompt of ${bytes} bytes is too long for agy; shorten the brief or the notes`);
      const resume = job.kind === "resume" ? job.sessionId ?? "" : null;
      if (resume !== null && !UUID.test(resume)) throw new Error("agy resume needs a conversation id; run mandor reassign on the task, which starts a new conversation");
      // Print mode cannot ask, so a tool that needs a permission is refused without a word. The rules name what this
      // run may touch: the worktree and the cache directories, and commands, which the CLI's own sandbox confines.
      // Paid credits are off for the run whatever the user's settings say: a run past the plan's quota would
      // otherwise be billed, with no quota error.
      const roots = [job.worktree, ...project.addDirs]; // the root the runner verified
      const settings = { useG1Credits: false, permissions: { allow: [...roots.flatMap((d) => [`write_file(${d})`, `read_file(${d})`]), "command(*)"] } };
      // No working directory option: the runner starts the worker in the worktree's root, which it has verified. The
      // model's id carries its effort, and the two together can be refused.
      const args = [...home(), ...project.addDirs.flatMap((d) => ["--add-dir", d]), ...(resume === null ? [] : ["--conversation", resume]),
        "-p", prompt, "--output-format", "stream-json", "--model", job.candidate.model, "--sandbox",
        "--json-schema", files.schemaPath, "--settings", JSON.stringify(settings)];
      return { command: job.bin, args, env: { ...job.env, ...NO_UPDATE } };
    },

    classify(raw: RawRun): JobResult {
      const events: unknown[] = [];
      for (const line of raw.stdout.split("\n")) {
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
      const end = get(events.findLast((e) => get(e, "event") === "result"), "result");
      const conversation = [get(end, "conversation_id"), ...events.map((e) => get(e, "conversation_id"))].find((c) => typeof c === "string" && UUID.test(c));
      const sessionId = typeof conversation === "string" ? conversation : null;
      const ran = get(events.find((e) => get(e, "event") === "init"), "init.model");
      const result = (status: JobStatus, detail: string): JobResult => ({
        status, sessionId, report: null, usageCumulative: null, detail: clampDetail(detail), resetsAt: null, exitCode: raw.exitCode, creditFunded: false,
        model: typeof ran === "string" ? ran : null,
      });
      const exit = raw.exitCode ?? raw.signal;
      if (get(end, "status") === "SUCCESS") {
        if (raw.exitCode !== 0) return result("failed", `exit ${exit} after the run finished; see stderr.log`);
        // A refused tool leaves the run a success with an empty answer. Whatever a refusal is called, the run failed;
        // only a name that is safe to print goes into the detail.
        const denied = get(end, "denied_actions");
        if (Array.isArray(denied) && denied.length > 0) {
          const names = denied.map((d) => get(d, "action")).filter((a): a is string => typeof a === "string" && /^[a-z_]+$/.test(a));
          return result("failed", `the run lacked a permission its tools needed${names.length > 0 ? `: ${names.join(", ")}` : ""}`);
        }
        const early = get(end, "finished_reason");
        if (typeof early === "string" && /^[A-Za-z_]+$/.test(early)) return result("failed", `the run stopped early: ${early}`);
        const structured = get(end, "structured_output");
        const response = get(end, "response");
        const found = isObject(structured) ? structured : typeof response === "string" ? lastJsonObject(response, fitsReport) : null;
        const report: WorkerReport | null = found === null ? null : parseReport(JSON.stringify(found));
        if (report === null) return result("failed", "report not valid JSON");
        const usage = get(end, "usage");
        const usageCumulative = isObject(usage) ? Object.fromEntries(Object.entries(usage).filter((kv): kv is [string, number] => typeof kv[1] === "number")) : null;
        return { ...result("done", ""), report, usageCumulative };
      }
      // Never copy stderr into a detail: only these fixed phrases are recognized.
      const err = raw.stderr;
      if (/QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED|exhausted your quota|AI credits balance is too low/.test(err)) {
        return err.includes("quota on this model") ? result("model-limit", "the quota of this model is used up") : result("quota", "the account's quota is used up");
      }
      if (err.includes("invalid model selection")) return result("failed", "the account does not offer this model");
      const status = get(end, "status");
      if (typeof status === "string" && /^[A-Z_]+$/.test(status)) return result("failed", `status ${status}; see stderr.log`);
      if (raw.exitCode === 0) return result("failed", "stream ended early");
      return result("failed", `exit ${exit}; see stderr.log`);
    },

    refine(result, job) {
      if (result.status !== "done") return result;
      // A conversation that is gone does not fail the resume: the CLI warns and starts a new one, whose worker knows
      // only the last message. The task then starts over once, from the work so far.
      if (job.kind === "resume" && result.sessionId !== job.sessionId) {
        return { ...result, status: "account-mismatch", report: null, detail: "the conversation was not found, so the run started a new one" };
      }
      if (result.model !== job.candidate.model) return { ...result, status: "failed", report: null, detail: `ran on ${result.model ?? "an unnamed model"}, not on ${job.candidate.model}` };
      return result;
    },
  };
}

export function agyWarnings(version: string | null): string[] {
  return [
    `agy is on: ${AGY_NOTICE}; see the README`,
    ...(version === TESTED_AGY_VERSION ? [] : [`agy ${version ?? "(version unknown)"} is not the tested version ${TESTED_AGY_VERSION}`]),
  ];
}
