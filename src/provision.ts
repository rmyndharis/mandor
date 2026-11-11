import childProcess, { type SpawnSyncReturns } from "node:child_process";
import fs, { type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { git, isClean } from "./git.ts";
import { isAgentPath, isDenied, SECRET_FILE_GLOBS } from "./guards.ts";
import { mandorHome, projectDir, workerEnv } from "./home.ts";
import { ensureDir, readJson, writeJsonAtomic } from "./store.ts";

// fs and child_process are called through their module objects, so tests can stub statSync and count cp runs.

export interface ProjectConfig {
  clone: string[];
  setup: string | null;
  shared: string[];
  deny: string[];
  generators: Record<string, string[]>; // clone path -> globs of the scripts that produce it
  workerNetwork: boolean;
  workerAddDirs: string[];
  nameIsWord: boolean; // the repository's own subject uses the tool's name as a word; see checkDiff
}

export const DEFAULT_DENY: readonly string[] = [...SECRET_FILE_GLOBS, "**/CLAUDE.md", "**/AGENTS.md", "**/GEMINI.md", "**/.claude/**", "**/_docs/**"];

export const emptyProjectConfig = (): ProjectConfig =>
  ({ clone: [], setup: null, shared: [], deny: [], generators: {}, workerNetwork: false, workerAddDirs: [], nameIsWord: false });

const configFile = (projectId: string) => join(projectDir(projectId), "project.json");

// A project that never ran project setup clones nothing.
export function loadProjectConfig(projectId: string): ProjectConfig {
  try {
    return { ...emptyProjectConfig(), ...readJson<Partial<ProjectConfig>>(configFile(projectId)) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyProjectConfig();
    throw e;
  }
}

export function saveProjectConfig(projectId: string, c: ProjectConfig): void {
  writeJsonAtomic(configFile(projectId), c);
}

// A glob that matches a directory covers everything under it, as an ignore pattern would (a .env directory too).
// seen memoizes the answer per path, so the many files of one directory check that directory once.
function blocked(p: string, deny: readonly string[], seen = new Map<string, boolean>()): boolean {
  if (p === "" || dirname(p) === p) return false; // "." or "/": above every path
  let v = seen.get(p);
  if (v === undefined) {
    v = isAgentPath(p) || isDenied(p, DEFAULT_DENY) || isDenied(p, deny) || blocked(dirname(p), deny, seen);
    seen.set(p, v);
  }
  return v;
}

// Repo-relative and without a trailing slash, as BSD cp copies the contents of a slash-terminated source.
export function checkClonePath(raw: string, deny: readonly string[]): string {
  const p = posix.normalize(raw).replace(/\/+$/, "");
  if (p === "" || p === "." || isAbsolute(raw) || raw.split("/").includes("..") || p.split("/").some((s) => s.toLowerCase() === ".git")) {
    throw new Error(`refusing clone path ${raw}: not a plain path inside the repository`);
  }
  if (blocked(p, deny)) throw new Error(`refusing clone path ${raw}: it is a denied or agent path`);
  return p;
}

// Deduplicated, and never one inside another: the second copy would land where the first one already wrote.
export function checkClonePaths(raws: readonly string[], deny: readonly string[]): string[] {
  const paths = [...new Set(raws.map((raw) => checkClonePath(raw, deny)))];
  for (const outer of paths) {
    const inner = paths.find((p) => p.startsWith(`${outer}/`));
    if (inner !== undefined) throw new Error(`refusing clone path ${inner}: it lies inside clone path ${outer}`);
  }
  return paths;
}

// Literal pathspecs, so git lists exactly the path cp copies: no glob or magic reading of *, [ or :.
function list(src: string, p: string, ...args: string[]): string[] {
  const r = git(["--literal-pathspecs", "ls-files", "-z", ...args, "--", p], src);
  if (r.code !== 0) throw new Error(`git ls-files failed in ${src}: ${r.stderr.trim()}`);
  return r.stdout.split("\0").filter(Boolean);
}

// null when the path leads nowhere: missing, dangling or looping.
function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

// p is dir itself or lies below it.
function within(dir: string, p: string): boolean {
  const r = relative(dir, p);
  return r !== ".." && !r.startsWith("../");
}

// A link is recreated, never followed, so what counts is where it leads: to a denied file, judged in the main checkout,
// or, once recreated in the worktree, to a directory at, above or inside the main checkout, whose ignored files no name
// check sees. A link to a directory elsewhere (an SDK, a package cache) is kept, and what that directory holds goes unchecked.
function linkExposes(srcRoot: string, realRoot: string, worktree: string, f: string, deny: readonly string[], seen: Map<string, boolean>): boolean {
  const target = fs.readlinkSync(join(srcRoot, f));
  if (blocked(relative(srcRoot, resolve(srcRoot, dirname(f), target)), deny, seen)) return true;
  const inCheckout = realOrNull(join(srcRoot, f)); // through a chain of links
  if (inCheckout !== null && blocked(relative(realRoot, inCheckout), deny, seen)) return true;
  // null: it lands nowhere yet, dangling or inside the clone still to be made.
  const lands = realOrNull(isAbsolute(target) ? target : resolve(dirname(join(worktree, f)), target));
  return lands !== null && fs.lstatSync(lands).isDirectory() && (within(realRoot, lands) || within(lands, realRoot));
}

// empty holds the leaves of directory trees that hold nothing else, which carry no content.
interface Clone { p: string; keep: string[]; links: Set<string>; empty: string[]; skip: string[] }

function planClone(srcRoot: string, realRoot: string, worktree: string, p: string, deny: readonly string[]): Clone {
  if (list(srcRoot, p).length > 0) throw new Error(`refusing clone path ${p}: it holds tracked files`);
  if (list(srcRoot, p, "--others", "--exclude-standard").length > 0) throw new Error(`refusing clone path ${p}: it holds untracked files that are not ignored`);
  // git reports names precomposed (NFC) on macOS, while readdir returns them as stored, so names are compared in NFC
  // and copied as stored.
  const listed = new Set(list(srcRoot, p, "--others", "--ignored", "--exclude-standard").map((f) => f.normalize("NFC")));
  const clone: Clone = { p, keep: [], links: new Set(), empty: [], skip: [] };
  if (listed.size === 0) return clone; // nothing is copied where git lists nothing: cp would copy what git did not check
  const seen = new Map<string, boolean>();
  // The source is walked, so whatever git leaves out (an entry named .git in any case, a nested repository, a socket,
  // a FIFO) is reported and never copied, and a single cp copies exactly what was checked. Empty directories carry no
  // content, so they are cloned as they are.
  const visit = (f: string, e: Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink">): void => {
    const key = f.normalize("NFC");
    // git never lists a .git entry, and lists a nested repository as one directory entry without looking inside.
    if (basename(f).toLowerCase() === ".git" || listed.has(`${key}/`)) {
      clone.skip.push(e.isDirectory() ? `${f}/` : f);
      return;
    }
    if (e.isDirectory()) {
      const children = fs.readdirSync(join(srcRoot, f), { withFileTypes: true });
      if (children.length === 0) clone.empty.push(f);
      for (const child of children) visit(`${f}/${child.name}`, child);
      return;
    }
    const link = e.isSymbolicLink();
    if (!listed.has(key) || !(e.isFile() || link) || blocked(f, deny, seen) || (link && linkExposes(srcRoot, realRoot, worktree, f, deny, seen))) {
      clone.skip.push(f);
    } else {
      clone.keep.push(f);
      if (link) clone.links.add(f);
    }
  };
  visit(p, fs.lstatSync(join(srcRoot, p)));
  for (const entries of [clone.keep, clone.empty, clone.skip]) entries.sort();
  return clone;
}

// mkdir and cp follow a link at any directory on the way, so their writes would land outside the worktree, where the
// final check cannot see them. The worktree's base need not match the main checkout and can track a link where the main
// checkout keeps an ignored directory, so every existing directory on the way must be a plain one, and nothing may be
// at the destination yet. plain memoizes the directories already checked.
function assertFresh(worktree: string, f: string, plain: Set<string>): void {
  const parts = f.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    if (plain.has(dir)) continue;
    const st = fs.lstatSync(join(worktree, dir), { throwIfNoEntry: false });
    if (st === undefined) break; // mkdir makes it and everything below as plain directories
    if (!st.isDirectory()) throw new Error(`refusing to provision ${worktree}: ${dir} is a symlink or not a directory`);
    plain.add(dir);
  }
  if (fs.lstatSync(join(worktree, f), { throwIfNoEntry: false }) !== undefined) throw new Error(`refusing to provision ${worktree}: ${f} already exists`);
}

// Far below ARG_MAX (1 MiB) even when every path is PATH_MAX (1024) bytes long.
const CP_BATCH = 256;

function cp(args: string[], log: string): void {
  const r = childProcess.spawnSync("/bin/cp", args, { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status === 0) return;
  ensureDir(dirname(log));
  fs.appendFileSync(log, r.stderr ?? "", { mode: 0o600 });
  throw new Error(`cp failed (exit ${r.status ?? r.signal}); see ${log}`);
}

function runSetup(cmd: string, worktree: string, log: string): void {
  ensureDir(dirname(log));
  const fd = fs.openSync(log, "a", 0o600);
  let r: SpawnSyncReturns<Buffer>;
  try {
    // Output goes to a file: inherited it would land in the CLI's JSON stdout, and a daemon the setup starts could hold a pipe open.
    r = childProcess.spawnSync("/bin/sh", ["-c", cmd], { cwd: worktree, env: workerEnv(null), stdio: ["ignore", fd, fd], timeout: 30 * 60 * 1000, killSignal: "SIGKILL" });
  } finally {
    fs.closeSync(fd);
  }
  if (r.status !== 0) throw new Error(`setup failed (exit ${r.status ?? r.signal}); see ${log}`);
}

// Clones the configured ignored paths from the main checkout into a fresh worktree, then runs the setup command.
// The lead calls it without any lock held.
export function provisionWorktree(srcRoot: string, worktree: string, c: ProjectConfig): { cloned: number; skipped: string[] } {
  // Only on the same volume does cp -c make a real clone, and only a clone path is ever copied.
  if (c.clone.length > 0 && fs.statSync(srcRoot).dev !== fs.statSync(worktree).dev) {
    throw new Error(`refusing to provision ${worktree}: not on the same volume as ${srcRoot}; a clone path is copied with APFS clones, so MANDOR_HOME must be on the repository's volume`);
  }
  // Nothing is written until the destination proves to be a fresh mandor worktree of srcRoot, so a wrong
  // path can never have cp overwrite files in another checkout.
  if (!isClean(srcRoot, worktree)) throw new Error(`refusing to provision ${worktree}: it is not clean`);
  const realRoot = fs.realpathSync.native(srcRoot);
  // Every path is checked, in the main checkout and then in the worktree, before anything is written, so a refusal
  // leaves the worktree untouched.
  const clones = checkClonePaths(c.clone, c.deny).map((p) => planClone(srcRoot, realRoot, worktree, p, c.deny));
  const plain = new Set<string>();
  for (const { p, keep, empty, skip } of clones) {
    if (keep.length + empty.length > 0) for (const f of skip.length === 0 ? [p] : [...keep, ...empty]) assertFresh(worktree, f, plain);
  }
  const log = join(mandorHome(), "logs", `setup-${basename(worktree)}.log`);
  let cloned = 0;
  const skipped: string[] = [];
  for (const { p, keep, links, empty, skip } of clones) {
    cloned += keep.length;
    skipped.push(...skip);
    if (keep.length + empty.length === 0) continue;
    if (skip.length === 0) {
      // Checked above: no directory on the way is a link, and nothing is at the destination yet.
      const parent = join(worktree, dirname(p));
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      cp(["-c", "-R", join(srcRoot, p), `${parent}/`], log);
      continue;
    }
    for (const d of empty) fs.mkdirSync(join(worktree, d), { recursive: true, mode: 0o700 });
    const batches = new Map<string, string[]>();
    for (const f of keep) {
      const dest = join(worktree, f);
      const dir = dirname(dest);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // cp without -R follows a link, which would copy its target's bytes under the link's name.
      if (links.has(f)) fs.symlinkSync(fs.readlinkSync(join(srcRoot, f)), dest);
      else {
        if (!batches.has(dir)) batches.set(dir, []);
        batches.get(dir)!.push(join(srcRoot, f));
      }
    }
    for (const [dir, srcs] of batches) {
      for (let i = 0; i < srcs.length; i += CP_BATCH) cp(["-c", ...srcs.slice(i, i + CP_BATCH), `${dir}/`], log);
    }
  }
  if (c.setup) runSetup(c.setup, worktree, log);
  if (!isClean(srcRoot, worktree)) throw new Error("provisioning left untracked files");
  return { cloned, skipped };
}
