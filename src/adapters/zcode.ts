import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { parseReport, REPORT_SCHEMA } from "../brief.ts";
import type { Config } from "../config.ts";
import { resolveBin } from "../config.ts";
import { realOf, removeTree, spawnConfined, writeConfined } from "../git.ts";
import type { Adapter, JobResult, JobStatus, ModelInfo, RawRun, WorkerReport } from "../contracts.ts";
import { jobTmpDir, mandorHome, ownTempEnv, workerEnv, zcodeProjectHome } from "../home.ts";
import { ZCODE_BILLING } from "../modelcache.ts";
import { clampDetail, ensureDir, readJson, writeJsonAtomic } from "../store.ts";
import { keepVendorStderr, lostSession } from "./vendor.ts";

export const TESTED_ZCODE_VERSION = "0.17.1";

// The home that holds the sign-in, which `login`, a stored key and the version call use. No worker runs on it and none can read it:
// each project's jobs run on a home of their own (zcodeProjectHome), which gets a copy of the sign-in at every job start.
// The CLI reads the user's MCP servers, plugins, hooks, skills and instructions from HOME and nothing moves them, so a worker on
// the user's HOME would load all of it into every turn.
export const zcodeHome = (): string => join(mandorHome(), "zcode", "home");

// The key that the CLI encrypts a browser sign-in with is derived from the home directory unless this is set, so a sign-in made
// under one home would not open under another. One secret for the state home, made on first use, lets the sign-in that `login`
// makes be read under every project's home. A stored API key is plain and needs none of it.
export function credentialSecret(): string {
  const file = join(mandorHome(), "zcode", "credential-secret");
  const read = (): string | null => {
    try {
      const text = readFileSync(file, "utf8").trim();
      return /^[0-9a-f]{64}$/.test(text) ? text : null;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw new Error(`cannot read ${file}: ${code ?? "an error"}; tell the user, who repairs its permissions`);
    }
  };
  const held = read();
  if (held !== null) return held;
  ensureDir(dirname(file));
  const secret = randomBytes(32).toString("hex");
  // The secret is written whole to a name of its own and linked into place, which fails where a file is already: a reader never
  // finds the file empty, as it would between the create and the write of one made in place.
  const staging = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(staging, `${secret}\n`, { flag: "wx", mode: 0o600 });
    linkSync(staging, file);
    return secret;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const raced = read();
    if (raced === null) throw new Error(`${file} does not hold a secret; tell the user, who removes it`);
    return raced;
  } finally {
    rmSync(staging, { force: true });
  }
}

const SESSION = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<![A-Za-z0-9])(?:(?:org|user)-[A-Za-z0-9]{20,}|req_[A-Za-z0-9]{16,})/gi;
// The provider's codes for a limit of the account: the 5 hour and weekly windows, an expired or restricted plan, no balance.
const QUOTA_CODES = new Set(["1113", "1308", "1309", "1310", "1313", "1316", "1317", "1318", "1319", "1320", "1321"]);
// Tools that would wait for a person, and the one that loads skills.
const DISALLOWED_TOOLS = "AskUserQuestion EnterPlanMode ExitPlanMode Skill";
// The CLI enforces no output schema, so every prompt ends with the report's own: without it a worker ends with a JSON
// object of keys it made up.
export const REPORT_FORMAT = `\n\nThe report: your final message must be one JSON object and nothing else, with every key of this JSON schema and no other key:\n${JSON.stringify(REPORT_SCHEMA)}\n`;
// An argument, as the CLI takes the prompt no other way; the system's limit on arguments is about a megabyte.
const MAX_PROMPT_BYTES = 200_000;
// Where credentials of other tools and of the user live, relative to the user's home. The worker's commands share the
// network the CLI needs, so what they must not send out is kept from being read.
const PRIVATE_HOME_PATHS = [".ssh", ".aws", ".gnupg", ".netrc", ".docker", ".kube", ".npmrc", ".config/gh", ".codex", ".gemini", ".zcode", ".claude", ".claude.json",
  "Library/Keychains", "Library/Application Support/ZCode", "Library/Application Support/zcode"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const get = (v: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), v);

// How the binary is started and where its catalog is. The app keeps its CLI as a script the app's own executable runs
// as Node; any other binary is the CLI itself, with the catalog where the CLI looks for it first.
function layout(bin: string): { start: string[]; catalog: string; electron: boolean } {
  const app = /^(.*\.app\/Contents)\/MacOS\/[^/]+$/.exec(bin);
  if (app === null) return { start: [bin], catalog: join(dirname(bin), "provider", "zcode-builtin.json"), electron: false };
  return { start: [bin, join(app[1], "Resources", "glm", "zcode.cjs")], catalog: join(app[1], "Resources", "config", "provider", "zcode-builtin.json"), electron: true };
}

// The worker writes its home, so it can replace the home, or a directory of the sign-in in it, with a link, and what mandor
// writes or starts there would then work where the link leads. The profile keeps the home from being removed, the writes
// below are confined to it, and this names what is wrong before any of them and before the CLI starts, which signs in with
// no profile at all and lists its version with only its writes confined to the home.
function refuseLinks(home: string = zcodeHome()): void {
  for (const path of [home, join(home, ".zcode"), join(home, ".zcode", "v2")]) {
    let st;
    try {
      st = lstatSync(path, { throwIfNoEntry: false });
    } catch (e) {
      throw new Error(`cannot read ${path}: ${(e as NodeJS.ErrnoException).code}; tell the user, who repairs the permissions of the worker's home`);
    }
    if (st !== undefined && !st.isDirectory()) throw new Error(`refusing ${path}: not a directory in the worker's home; tell the user, who removes it`);
  }
}

// What the CLI needs wherever it runs: a HOME, the home of the sign-in unless a project's is given, and the catalog, copied into that
// HOME because the CLI writes lock files next to it, and the secret that its credentials are encrypted with. The copy is readable
// by the user only, as the app's catalog is readable by everyone.
export function zcodeEnv(bin: string, base: Record<string, string>, home: string = zcodeHome()): Record<string, string> {
  refuseLinks(home);
  ensureDir(dirname(home));
  const { catalog, electron } = layout(bin);
  writeConfined(home, "zcode-builtin.json", readFileSync(catalog));
  return { ...base, HOME: home, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(home, "zcode-builtin.json"), ZCODE_CREDENTIAL_SECRET: credentialSecret(), ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
}

const SIGN_IN_FILES = [join(".zcode", "v2", "credentials.json"), join(".zcode", "v2", "provider_config.json")];

// A sign-in file read without following a link, and only if it is a file with one name: a link or a second name of a file could lead
// to any file that the user can read, which mandor, running as the user, would copy to where the worker reads.
function readSignIn(file: string): Buffer | null {
  let fd: number;
  try {
    // O_NONBLOCK: opening a pipe that a worker left at the name would otherwise wait for a writer that never comes.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error(`refusing ${file}: it is a link; tell the user, who removes it and runs mandor login zcode`);
    throw new Error(`cannot read ${file}: ${code ?? "an error"}; tell the user, who repairs its permissions`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`refusing ${file}: it is not a file with one name; tell the user, who removes it and runs mandor login zcode`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

// The sign-in of the home that holds it, copied into a project's home at every job start: what a worker did to its own copy, a
// key or a plan put in its place, is undone by the next job, and no worker ever reaches the original. A file the sign-in lacks is
// taken out of the project's home as well.
function seedSignIn(home: string): void {
  refuseLinks();
  for (const rel of SIGN_IN_FILES) {
    const data = readSignIn(join(zcodeHome(), rel));
    if (data !== null) writeConfined(home, rel, data);
    else if (lstatSync(join(home, rel), { throwIfNoEntry: false }) !== undefined) removeTree(join(home, rel));
  }
}

export const zcodeStart = (bin: string): string[] => layout(bin).start;

// The shape of the catalog's own plan ids (account:zai-individual-coding-plan). The sign-in file is the worker's to write, and the
// id is printed, compared with the catalog and written into each job's provider file.
const PLAN_ID = /^account:[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The plan the worker signed in with, which the sign-in writes as its default provider.
function signedInProvider(): string {
  refuseLinks();
  let provider: unknown;
  try {
    provider = get(readJson(join(zcodeHome(), ".zcode", "v2", "provider_config.json")), "config.defaultModelSelection.providerId");
  } catch {}
  if (typeof provider !== "string" || provider === "") throw new Error("zcode worker is not signed in: run mandor login zcode");
  if (!PLAN_ID.test(provider)) throw new Error("the zcode worker's sign-in file names a plan of another shape than account:<name>; run mandor login zcode again");
  return provider;
}

// Signs the worker in, in a browser, under its own HOME: a sign-in made under the user's would only work there, and
// would replace the one their app holds. The CLI prints its sign-in address on stderr, which passes through; what it
// prints on stdout stays out, as it describes the account.
export function zcodeLogin(cfg: Config, provider: string): { tool: "zcode"; home: string; provider: string; warnings: string[] } {
  const bin = resolveBin("zcode", cfg);
  if (!existsSync(bin)) throw new Error(`zcode not found at ${bin}; tell the user, who installs ZCode or sets tools.zcode.bin in config.json`);
  const [command, ...args] = zcodeStart(bin);
  const r = spawnSync(command, [...args, "login", provider], { env: zcodeEnv(bin, workerEnv(null)), stdio: ["inherit", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error(`zcode login failed (exit ${r.status ?? r.signal}); run mandor login zcode again, with zai or bigmodel as the provider`);
  return { tool: "zcode", home: zcodeHome(), provider: signedInProvider(), warnings: [ZCODE_BILLING] };
}

// A personal provider file whose only content is the model a new session starts on.
const providerFile = (defaultModelSelection: object) => ({
  schemaVersion: 1,
  config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection },
});

// The other way to sign the worker in: a Coding Plan API key, which lasts until it is revoked, where a browser sign-in
// stops working after an hour. The CLI has no command to store one, but its runtime reads these three entries, plain
// values included, and then asks for no browser sign-in. Whatever sign-in the home held is replaced.
export function zcodeUseApiKey(family: string, key: string): { tool: "zcode"; home: string; provider: string; warnings: string[] } {
  const provider = `account:${family}-individual-coding-plan`;
  const identity = `key-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  refuseLinks();
  ensureDir(dirname(zcodeHome()));
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  writeConfined(zcodeHome(), join(".zcode", "v2", "credentials.json"), json({
    [`account-provider:${provider}:identity`]: identity,
    [`account-provider:${provider}:auth-source`]: "manual",
    [`account-provider:coding-plan:${provider}:account:${identity}:api-key`]: key,
  }));
  writeConfined(zcodeHome(), join(".zcode", "v2", "provider_config.json"), json(providerFile({ providerId: provider, modelId: "GLM-5.3" })));
  return { tool: "zcode", home: zcodeHome(), provider, warnings: [ZCODE_BILLING] };
}

// The index of the "}" that closes the "{" at start, or -1. A brace inside a string does not count.
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

// Whether the "{" at start can begin a JSON object: only white space, then a quote (a key) or a closing brace, follows it.
function opensObject(text: string, start: number): boolean {
  let i = start + 1;
  while (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r") i++;
  return text[i] === '"' || text[i] === "}";
}

// The last object in text that parses as JSON and that accept allows, or null. A worker ends with its report, which a
// model may wrap in prose or a code fence, so each object is cut from its own opening brace to the brace that closes
// it: braces before or after it do not matter. A candidate that does not parse or fit is passed over one brace at a
// time, so an object inside it can still be the one; an object that is taken is passed over whole, and a later one wins.
// A brace that cannot open an object is not scanned, so a long run of stray braces stays cheap.
export function lastJsonObject(text: string, accept: (v: Record<string, unknown>) => boolean = () => true): unknown {
  let found: unknown = null;
  let at = text.indexOf("{");
  while (at >= 0) {
    let next = at + 1;
    const end = opensObject(text, at) ? closingBrace(text, at) : -1;
    if (end >= 0) {
      try {
        const v: unknown = JSON.parse(text.slice(at, end + 1));
        if (isObject(v) && accept(v)) {
          found = v;
          next = end + 1;
        }
      } catch {}
    }
    at = text.indexOf("{", next);
  }
  return found;
}

// Whether an object is a worker's report, which is what the adapters look for at the end of an answer.
export const fitsReport = (v: Record<string, unknown>): boolean => parseReport(JSON.stringify(v)) !== null;

// Writes only to the worktree, the worker's home, the project's added directories and, in place of the shared temporary
// directories, a temporary directory of the job's own: /tmp and /var/folders hold what the lead's proofs and the user's own
// tools keep caches and compiled files in, the per-user cache directory under /var/folders among them. A project that
// keeps them open (--shared-temp) leaves tmp null, and the profile opens them as it did. What the user's credential
// directories and the state directory hold cannot be read, but for the worktree, the worker's home and the job's own
// directory, which holds the provider file; a path's metadata stays readable, as the CLI's database open resolves every
// directory above its file. The paths are parameters.
function sandbox(worktree: string, workerHome: string, jobFiles: string, tmp: string | null, addDirs: string[], denyRead: string[]): string[] {
  const user = homedir();
  // Seatbelt matches the real path of what a process opens, so a path that goes through a link (a state home spelled with
  // /tmp or /var, a cache directory that is a link) would match nothing. The state home is resolved, and what lies under
  // it is kept as it is named: a worker can write in those places and not replace them, and a name resolved after a swap
  // would grant the place the link leads to.
  const home = mandorHome();
  const real = realOf(home);
  const under = (p: string): string => {
    const rel = relative(home, p);
    return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? realOf(p) : join(real, rel);
  };
  // A credential path that is a link to a device (a .npmrc that leads to /dev/null) holds none, and /dev/null is read by commands.
  // The project's own paths close with the credential directories, and the worktree, the worker's home, the job's directory and
  // the cache directories that the project opens are opened after them, so no entry can hide those.
  const closed = [...new Set([...PRIVATE_HOME_PATHS.map((p) => join(user, p)), ...denyRead].map(realOf))].filter((p) => !p.startsWith("/dev/"));
  const params: [string, string][] = [["WT", worktree], ["WH", under(workerHome)], ["JOB", under(jobFiles)], ["STATE", real],
    ...(tmp === null ? [] : [["JT", under(tmp)] as [string, string]]),
    ...addDirs.map((d, i): [string, string] => [`ADD${i}`, realOf(d)]), ...closed.map((p, i): [string, string] => [`PRIV${i}`, p])];
  const sub = (names: string[]) => names.map((n) => `(subpath (param "${n}"))`).join(" ");
  const writable = ["WT", "WH", ...(tmp === null ? [] : ["JT"]), ...addDirs.map((_, i) => `ADD${i}`)];
  const shared = tmp === null ? ' (subpath "/private/tmp") (subpath "/private/var/folders")' : "";
  // The home is writable and is not the worker's to remove or move: a link put in its place would lead mandor's own writes, and
  // the CLI that signs in, to wherever the link goes.
  const profile = `(version 1)(allow default)(deny file-write*)(allow file-write-data (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`
    + `(allow file-write* ${sub(writable)}${shared})(deny file-write-unlink (literal (param "WH")))`
    + `(deny file-read-data ${sub(["STATE", ...closed.map((_, i) => `PRIV${i}`)])})(allow file-read-data ${sub(["WT", "WH", "JOB", ...addDirs.map((_, i) => `ADD${i}`)])})`;
  return [...params.flatMap(([k, v]) => ["-D", `${k}=${v}`]), "-p", profile];
}

function failedStatus(code: unknown): JobStatus {
  return QUOTA_CODES.has(String(code)) ? "quota" : "failed";
}

// A sign-in stops working on its own, about an hour after it was made in one trial, and only the user can renew it.
// Until then every run of the tool fails the same way, so it counts as a spent quota: the tool is set aside, its tasks
// can move on, and `ready` brings it back.
const SIGN_IN_GONE = "the zcode worker's sign-in is no longer valid: run mandor login zcode, then mandor ready zcode";
// A resume of a session that the home does not hold (a project's home is new, or was removed): the runner hands such a task over once.
const SESSION_GONE = "the session was not found, so the run could not resume it";

export function createZcodeAdapter(cfg: Config): Adapter {
  const bin = () => resolveBin("zcode", cfg);
  return {
    tool: "zcode",

    version() {
      const b = bin();
      // Confined to the worker's home, where it keeps what it writes: a version call has no reason to write anywhere else.
      const r = spawnConfined(zcodeHome(), zcodeStart(b)[0], [...zcodeStart(b).slice(1), "--version"], { env: zcodeEnv(b, { PATH: process.env.PATH ?? "" }), encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      keepVendorStderr("zcode", ["--version"], r);
      if (r.status !== 0) throw new Error(`zcode --version failed (exit ${r.status ?? r.signal}); read logs/vendor.stderr in the state home for why`);
      const v = /\d+\.\d+\.\d+\S*/.exec(r.stdout)?.[0];
      if (v === undefined) throw new Error("zcode --version printed no version number; run it yourself to see what it prints");
      return v;
    },

    // Read from the catalog the app ships: no run, and no account. A model's levels come from the last rule that
    // matches its name, as a later rule in that list is the more specific one.
    detectModels() {
      const provider = signedInProvider();
      const rules = get(readJson(layout(bin()).catalog), "config.modelConfigRules");
      const listed = (name: string): unknown[] => {
        const v = get(rules, name);
        return Array.isArray(v) ? v : [];
      };
      const models = listed("builtinProviderModelRules")
        .filter((r) => get(r, "providerId") === provider && get(r, "config.enabled") === true && typeof get(r, "modelId") === "string")
        .map((r): ModelInfo => {
          const model = get(r, "modelId") as string;
          const levels = listed("modelRules").findLast((m) => {
            const match = get(m, "modelMatch");
            return typeof match === "string" && Array.isArray(get(m, "config.optionSpecs.reasoningLevel.values")) && new RegExp(`^${match}$`, "i").test(model);
          });
          const efforts = ((get(levels, "config.optionSpecs.reasoningLevel.values") as unknown[] | undefined) ?? []).filter((e): e is string => typeof e === "string");
          return { tool: "zcode", model, label: model, efforts, defaultEffort: null, hidden: false };
        });
      if (models.length === 0) throw new Error(`the zcode catalog lists no model for ${provider}; sign in again with mandor login zcode, or update the ZCode app`);
      return models;
    },

    prepare(job, files, project) {
      const { model, effort } = job.candidate;
      if (effort === "") throw new Error("zcode candidate needs an effort; write the candidate as zcode:model@effort in config.json");
      // The sandbox cannot close the network for the worker's commands and leave it open for the CLI that runs them.
      if (!project.network) throw new Error("zcode workers need the network, which their commands share: tell the user, who allows it with mandor project setup --update --worker-network");
      const prompt = readFileSync(job.promptPath, "utf8") + REPORT_FORMAT;
      const bytes = Buffer.byteLength(prompt);
      if (bytes > MAX_PROMPT_BYTES) throw new Error(`prompt of ${bytes} bytes is too long for zcode; shorten the brief or the notes`);
      const resume = job.kind === "resume" ? job.sessionId ?? "" : null;
      if (resume !== null && !SESSION.test(resume)) throw new Error("zcode resume needs a session id; run mandor reassign on the task, which starts a new session");
      // The CLI has no model option: a session starts on the default of the personal provider file it is given.
      const personal = join(dirname(files.schemaPath), "zcode-provider.json");
      const provider = signedInProvider();
      const home = zcodeProjectHome(job.projectId);
      writeJsonAtomic(personal, providerFile({ providerId: provider, modelId: model, options: { reasoningLevel: effort } }));
      // No working directory option: the runner starts the worker in the worktree's root, which it has verified.
      const own = project.sharedTemp === true ? null : jobTmpDir(job.id);
      const env = zcodeEnv(job.bin, job.env, home);
      seedSignIn(home);
      const args = [...sandbox(job.worktree, home, dirname(personal), own, project.addDirs, project.denyRead ?? []), ...zcodeStart(job.bin), ...(resume === null ? [] : ["--resume", resume]),
        "-p", prompt, "--output-format", "stream-json", "--mode", "yolo", "--disallowed-tools", DISALLOWED_TOOLS];
      return { command: "/usr/bin/sandbox-exec", args, env: { ...env, ...(own === null ? {} : ownTempEnv(own)), ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal } };
    },

    classify(raw: RawRun): JobResult {
      const events: unknown[] = [];
      for (const line of raw.stdout.split("\n")) {
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
      const session = events.map((e) => get(e, "sessionId")).find((s) => typeof s === "string" && SESSION.test(s));
      const sessionId = typeof session === "string" ? session : null;
      const ran = get(events.findLast((e) => get(e, "type") === "session.updated" && typeof get(e, "payload.modelId") === "string"), "payload.modelId");
      const result = (status: JobStatus, detail: string): JobResult => ({
        status, sessionId, report: null, usageCumulative: null, detail: clampDetail(detail), resetsAt: null, exitCode: raw.exitCode, creditFunded: false,
        model: typeof ran === "string" ? ran : null, usagePerRun: true,
      });
      const exit = raw.exitCode ?? raw.signal;
      const failure = events.findLast((e) => get(e, "type") === "turn.failed");
      if (failure !== undefined) {
        const message = get(failure, "payload.error.message");
        const code = get(failure, "payload.error.attribution.providerErrorCode");
        if (message === "project_token_login_failed" || (typeof message === "string" && message.includes("Credential decrypt failed"))) return result("quota", SIGN_IN_GONE);
        const text = typeof message === "string" && message !== "" ? message.replace(IDS, "<id>") : "turn failed";
        return result(failedStatus(code), code === undefined ? text : `provider code ${code}: ${text}`);
      }
      const end = events.findLast((e) => get(e, "type") === "result");
      const response = get(end, "response");
      if (typeof response === "string") {
        if (raw.exitCode !== 0) return result("failed", `exit ${exit} after the run finished; see stderr.log`);
        const found = lastJsonObject(response, fitsReport);
        const report: WorkerReport | null = found === null ? null : parseReport(JSON.stringify(found));
        if (report === null) return result("failed", "report not valid JSON");
        const usage = get(end, "usage");
        const usageCumulative = isObject(usage) ? Object.fromEntries(Object.entries(usage).filter((kv): kv is [string, number] => typeof kv[1] === "number")) : null;
        return { ...result("done", ""), report, usageCumulative };
      }
      if (raw.exitCode === 0) return result("failed", "stream ended early");
      // Never copy stderr into a detail: only these fixed phrases are recognized. A browser sign-in made without the secret that every
      // call now carries cannot be decrypted, and the CLI says so.
      if (raw.stderr.includes("Select a model before sending a message") || raw.stderr.includes("Credential decrypt failed")) return result("quota", SIGN_IN_GONE);
      if (raw.stderr.includes("Session not found: sess_")) return result("account-mismatch", SESSION_GONE);
      return result("failed", `exit ${exit}; see stderr.log`);
    },

    // A model or a level the plan lacks does not fail: the CLI runs the sign-in's default model and says nothing, so a
    // light task would spend the heavy model's quota unseen.
    refine(result, job) {
      const lost = lostSession(result, job);
      if (lost !== null) return lost;
      if (result.status !== "done" || result.model === job.candidate.model) return result;
      return { ...result, status: "failed", report: null, detail: `ran on ${result.model ?? "an unnamed model"}, not on ${job.candidate.model}` };
    },
  };
}

export function zcodeWarnings(version: string | null): string[] {
  return version === TESTED_ZCODE_VERSION ? [] : [`zcode ${version ?? "(version unknown)"} is not the tested version ${TESTED_ZCODE_VERSION}`];
}

export { ZCODE_BILLING };
