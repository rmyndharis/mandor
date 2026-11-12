import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { JobRecord } from "../src/contracts.ts";
import { diffSinceBaseBytes, LOCATION_VARS } from "../src/git.ts";
import { processStart } from "../src/home.ts";
import { writeJsonAtomic } from "../src/store.ts";

const FAKE_CODEX = join(import.meta.dirname, "fake-bin", "fake-codex.mjs");

const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};

// Whether the process is the fake Codex (a worker, whose group is the fake's), by its command line: a job record
// outlives its worker, and the pid it holds may since name an unrelated process, a group leader among them.
const isFakeWorker = (pid: number) => spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.includes("fake-codex");

// A runner of this home still alive at exit (one that claimed its job after the test's own cleanup) would go on
// writing logs into the home once it is removed, and leave it behind; its worker group goes with it. Only a runner
// whose start time the record holds, and only a worker of an unfinished job that still is the fake. Real pids only:
// 0 or 1 would signal this process's own group or everything.
export function reapHome(home: string): void {
  const jobs = join(home, "jobs");
  for (const id of existsSync(jobs) ? readdirSync(jobs) : []) {
    let job: JobRecord;
    try {
      job = JSON.parse(readFileSync(join(jobs, id, "job.json"), "utf8"));
    } catch {
      continue;
    }
    const runner = job.runnerPid ?? 0;
    if (runner > 1 && runner !== process.pid && processStart(runner) === job.runnerStart) kill(runner);
    const worker = job.workerPid ?? 0;
    if (worker > 1 && job.endedAt === null && isFakeWorker(worker)) kill(-worker);
  }
}

// Every directory made here, removed when the process ends unless KEEP_TEST_TMP=1 keeps them for a look. The cwd
// leaves first: a runner started in process leaves it in a home that is about to go. One a test made unreadable stays.
const made: string[] = [];
process.on("exit", () => {
  if (process.env.KEEP_TEST_TMP === "1") return;
  process.chdir(tmpdir());
  for (const dir of made) reapHome(dir);
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// A fresh directory under the OS temp dir, by its real path, so it compares equal to what realpath and git report
// (/var is a symlink on macOS). Test files make their own scratch directories through this too, so they are removed.
export function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

// A fresh directory outside the shared temporary directories (/tmp and /var/folders), for the state home of a project that keeps
// those open, which may not lie under them. /var/tmp is neither of them.
export function tempAway(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join("/var/tmp", prefix)));
  made.push(dir);
  return dir;
}

// Inherited from a git hook or an outer git command, these would point every git call at that repository instead of
// the temp one asked for, and GIT_CONFIG_* would hand it config: tempRepo once wrote its test identity into the real
// repository a hook ran it from.
for (const k of Object.keys(process.env)) {
  if (LOCATION_VARS.includes(k) || k === "GIT_CONFIG_PARAMETERS" || /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete process.env[k];
}

// The developer's own git config at any level (a hooks path, rerere, a filter driver, any setting) must not change
// test outcomes, so every test file that imports these helpers runs git against an empty global config and no system
// one, whether or not it makes a temp home.
const emptyGitConfig = join(temp("mandor-gitconfig-"), "config");
writeFileSync(emptyGitConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";

// A config whose codex binary is the fake CLI, which may not exist yet.
export function writeTestConfig(home: string): void {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tools.codex.bin = FAKE_CODEX;
  writeJsonAtomic(join(home, "config.json"), cfg);
}

// A fresh state root, with a Codex home holding the fake CLI's control directory.
// No config file is written unless asked for, so loadConfig can be seen creating it.
export function tempHome(opts: { config?: boolean; away?: boolean } = {}): string {
  const home = opts.away ? tempAway("mandor-home-") : temp("mandor-home-");
  const codexHome = temp("mandor-codex-");
  mkdirSync(join(codexHome, "fake"));
  process.env.MANDOR_HOME = home;
  process.env.CODEX_HOME = codexHome;
  process.env.MANDOR_CODEX_BIN = FAKE_CODEX;
  if (opts.config) writeTestConfig(home);
  return home;
}

// The zcode worker's own home inside the current state root, as a sign-in leaves it: the plan as the default provider.
export function zcodeSignIn(provider = "account:zai-individual-coding-plan"): string {
  const home = join(process.env.MANDOR_HOME!, "zcode", "home");
  mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
  writeFileSync(join(home, ".zcode", "v2", "provider_config.json"), JSON.stringify({ schemaVersion: 1, config: { defaultModelSelection: { providerId: provider, modelId: "GLM-5.3" } } }));
  return home;
}

export const FAKE_ZCODE = join(import.meta.dirname, "fake-bin", "fake-zcode.mjs");

// A config with zcode switched on and pointed at its fake, next to the fake codex.
export function writeZcodeConfig(home: string): void {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tools.codex.bin = FAKE_CODEX;
  cfg.tools.zcode = { ...cfg.tools.zcode, enabled: true, bin: FAKE_ZCODE };
  writeJsonAtomic(join(home, "config.json"), cfg);
}

const FAKE_AGY = join(import.meta.dirname, "fake-bin", "fake-agy.mjs");
const agyFakeDir = () => join(process.env.MANDOR_HOME!, "agy", "home", "fake");

// A config with agy switched on and pointed at its fake, next to the fake codex, and the fake's control directory.
export function writeAgyConfig(home: string): void {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tools.codex.bin = FAKE_CODEX;
  cfg.tools.agy = { ...cfg.tools.agy, enabled: true, bin: FAKE_AGY };
  writeJsonAtomic(join(home, "config.json"), cfg);
  mkdirSync(agyFakeDir(), { recursive: true });
}

// The runs the fake agy plays, in order; see the fake for a scenario's fields.
export function writeAgyScenarios(entries: object[]): void {
  mkdirSync(agyFakeDir(), { recursive: true });
  rmSync(join(agyFakeDir(), "claims"), { recursive: true, force: true });
  writeFileSync(join(agyFakeDir(), "scenarios.json"), JSON.stringify(entries));
}

export function readAgyLog(): { argv: string[]; env: Record<string, string>; cwd: string }[] {
  const p = join(agyFakeDir(), "log.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

const zcodeFakeDir = () => join(process.env.MANDOR_HOME!, "zcode", "home", "fake");

// The runs the fake zcode plays, in order; see the fake for a scenario's fields.
export function writeZcodeScenarios(entries: object[]): void {
  mkdirSync(zcodeFakeDir(), { recursive: true });
  rmSync(join(zcodeFakeDir(), "claims"), { recursive: true, force: true });
  writeFileSync(join(zcodeFakeDir(), "scenarios.json"), JSON.stringify(entries));
}

export function readZcodeLog(): { argv: string[]; env: Record<string, string>; cwd: string }[] {
  const p = join(zcodeFakeDir(), "log.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// One exec of the fake CLI. stdout is a fixture file name or "generated:<kind>".
export interface Scenario {
  stdout: string; threadId?: string; stderr?: string; exitCode?: number; delayMs?: number; lastMessage?: string;
  writeFile?: { path: string; content: string }[]; sleeperPidFile?: string; commands?: string[];
}

const fakeDir = () => join(process.env.CODEX_HOME!, "fake");

// Each exec of the fake claims the lowest unclaimed entry, so clearing the claims restarts the list.
export function writeScenarios(entries: Scenario[]): void {
  rmSync(join(fakeDir(), "claims"), { recursive: true, force: true });
  writeFileSync(join(fakeDir(), "scenarios.json"), JSON.stringify(entries));
}

// Every invocation of the fake, in order, with the exact environment it saw and the prompt it read from stdin, if any.
export function readFakeLog(): { argv: string[]; env: Record<string, string>; stdin?: string }[] {
  const p = join(fakeDir(), "log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// A worktree's patch against its base, decoded as text: the code under test hands out the bytes only.
export const diffSinceBase = (repo: string, worktree: string, base: string): string => diffSinceBaseBytes(repo, worktree, base).toString();

// A repository on main with one commit by a test identity.
export function tempRepo(): string {
  const repo = temp("mandor-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  // Set before the first commit, so the commit never depends on a global identity.
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "README.md"), "temp repo\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "Initial commit");
  return repo;
}
