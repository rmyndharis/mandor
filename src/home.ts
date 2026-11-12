import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";

// A relative home would resolve through whatever the cwd is at the time, a worker's worktree included once the runner
// has entered it, so only an absolute one is taken.
export function mandorHome(): string {
  const home = process.env.MANDOR_HOME;
  if (home && !isAbsolute(home)) throw new Error(`MANDOR_HOME must be an absolute path, not ${JSON.stringify(home)}; set it to one, or unset it`);
  return home || join(homedir(), ".mandor");
}

// The real path makes a symlinked checkout resolve to the same project.
export function projectIdFor(root: string): string {
  const real = realpathSync(root);
  return `${basename(real)}-${createHash("sha256").update(real).digest("hex").slice(0, 12)}`;
}

export function projectDir(id: string): string {
  return join(mandorHome(), "projects", id);
}

export function jobDir(jobId: string): string {
  return join(mandorHome(), "jobs", jobId);
}

// The home that the jobs of one project run on, one directory of the ZCode state per project (adapters/zcode.ts says why). What the
// tool keeps there between runs, and whatever a worker leaves in it, reaches the later jobs of that project and of no other.
export const zcodeHomesDir = (): string => join(mandorHome(), "zcode", "homes");
export function zcodeProjectHome(projectId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectId) || projectId.includes("..")) throw new Error(`refusing the project id ${projectId}: it is not a plain name; this is a bug in mandor: tell the user`);
  return join(zcodeHomesDir(), projectId);
}

// The one temporary directory a Codex or ZCode worker may write besides its worktree: the shared ones (/tmp, $TMPDIR) are
// where the lead's proofs and the user's own tools keep caches and compiled files, so a worker is given its own, inside the
// job's directory, which the runner makes before the start.
export function jobTmpDir(jobId: string): string {
  return join(jobDir(jobId), "tmp");
}

// What points the tools of a worker at that directory. TMPDIR is read by most of them; zsh writes the temporary files of a
// here-document and of a process substitution to a prefix of its own, which is /tmp/zsh unless TMPPREFIX says otherwise,
// and without it every here-document of a worker's login shell fails; clang keeps its module cache in the per-user cache
// directory, which the profile of a worker that has its own temporary directory does not open; and a JVM on macOS takes
// java.io.tmpdir from the system, not from TMPDIR. mktemp and the cache of xcrun do the same and cannot be pointed
// anywhere: a project whose toolchain needs them keeps the shared directories open.
export function ownTempEnv(dir: string): Record<string, string> {
  return { TMPDIR: dir, TMPPREFIX: join(dir, "zsh"), CLANG_MODULE_CACHE_PATH: join(dir, "clang-modules"), JAVA_TOOL_OPTIONS: `-Djava.io.tmpdir=${dir}` };
}

export function worktreesDir(id: string): string {
  return join(mandorHome(), "worktrees", id);
}

export function scratchDir(id: string, name: string): string {
  if (name === "" || name === "." || name === ".." || name !== basename(name)) throw new Error(`invalid scratch name: ${name}; use a name that is not a path`);
  const dir = join(projectDir(id), "scratch", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function roundDir(id: string, slug: string, seq: number): string {
  return join(projectDir(id), "tasks", slug, "rounds", String(seq));
}

// Files the lead hands to the CLI must never sit where a commit could pick them up.
export function assertOutsideRepos(path: string, repoRootOf: (dir: string) => string | null): void {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    real = join(realpathSync(dirname(path)), basename(path)); // not written yet
  }
  const dir = dirname(real);
  const worktrees = join(mandorHome(), "worktrees");
  if (existsSync(worktrees)) {
    const root = realpathSync(worktrees);
    if (dir === root || dir.startsWith(root + sep)) throw new Error(`${path} is under the mandor worktrees; write it under mandor scratch`);
  }
  const repo = repoRootOf(dir);
  if (repo !== null) throw new Error(`${path} is inside the git working tree ${repo}; write it under mandor scratch`);
}

// A fixed locale and zone give every caller the same text, so start times compare as strings.
export function processStart(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const r = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC" } });
  return (r.status === 0 && r.stdout.trim()) || null;
}

// Whether the process a pid and a start time name still runs: a pid that is gone, or that now belongs to a process started
// at another time, is dead. A start time never recorded, or a ps read that fails, never makes a live process dead. Signal 0
// sends nothing, but to a pid of 0 or -1 it would reach a whole group or every process, so only a real pid gets that far.
export function processAlive(pid: unknown, start: unknown): pid is number {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  const started = processStart(pid);
  return started === null || start === null || started === start;
}

const COPIED = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "CODEX_HOME"];

// Workers get an allowlist only: no API keys, agent sockets or tokens, and git and gh that cannot prompt or reach credentials.
export function workerEnv(jobId: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of COPIED) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  // An empty or relative PATH entry resolves a bare command against the worker's cwd, its worktree.
  if (env.PATH !== undefined) env.PATH = env.PATH.split(delimiter).filter(isAbsolute).join(delimiter);
  env.CODEX_HOME ||= join(env.HOME || homedir(), ".codex");
  const gh = join(mandorHome(), "empty-gh");
  mkdirSync(gh, { recursive: true, mode: 0o700 });
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_SSH_COMMAND: "/usr/bin/false",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GH_CONFIG_DIR: gh,
    GRADLE_OPTS: "-Dorg.gradle.daemon=false",
  });
  if (jobId !== null) env.MANDOR_JOB = jobId;
  return env;
}
