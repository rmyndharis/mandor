import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";
import { foldPath } from "./guards.ts";
import { mandorHome } from "./home.ts";
import { ensureDir } from "./store.ts";

// Inherited, these would point git at another repository or work tree than the one asked for.
// Identity (GIT_AUTHOR_*, GIT_COMMITTER_*) and GIT_CONFIG_* stay, as the identity check reads them.
export const LOCATION_VARS: readonly string[] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"];

type Location = Record<string, string>;
type Result = { code: number; stdout: Buffer; stderr: string };

// The inherited location variables are removed first; a bound worktree then sets its own GIT_DIR and GIT_WORK_TREE.
function gitEnv(location: Location): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const k of LOCATION_VARS) delete env[k];
  // Only git config reads this, so with it set the read of the drivers would see a file that no other git command does.
  delete env.GIT_CONFIG;
  // An empty or relative PATH entry resolves a bare command (a filter or driver name) against cwd, the worktree.
  if (env.PATH !== undefined) env.PATH = env.PATH.split(delimiter).filter(isAbsolute).join(delimiter);
  return { ...env, ...location };
}

function run(args: string[], cwd: string, location: Location = {}): Result {
  // Node's default 1 MiB buffer kills git and truncates large ignored-file listings and diffs.
  const r = spawnSync("git", args, { cwd, env: gitEnv(location), maxBuffer: 64 * 1024 * 1024 });
  if (r.error === undefined && typeof r.status === "number") return { code: r.status, stdout: r.stdout, stderr: r.stderr.toString() };
  // A spawn error or a kill is a failure, and its partial output is never handed on.
  return { code: 1, stdout: Buffer.alloc(0), stderr: r.error ? r.error.message : `git ${args[0]} killed by ${r.signal}` };
}

// A git command that failed. Its message holds git's own words, which can quote what a worker wrote or what a hook
// printed, so a command that shows an error to the lead keeps them out of the output.
export class GitFailure extends Error {}

function okBytes(args: string[], cwd: string, location: Location = {}): Buffer {
  const r = run(args, cwd, location);
  if (r.code !== 0) throw new GitFailure(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.trim()}`);
  return r.stdout;
}

function ok(args: string[], cwd: string, location: Location = {}): string {
  return okBytes(args, cwd, location).toString();
}

export function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const r = run(args, cwd);
  return { ...r, stdout: r.stdout.toString() };
}

// The real path of the main work tree of the repository cwd is in; null outside one, and in a bare one. A linked worktree
// of an ordinary repository shares its .git, whose parent is the main work tree. In any other main work tree (a git
// directory kept elsewhere, a submodule) the top level is the root, as the parent of the git directory is no work tree. A
// linked worktree of such a repository has no answer in git and is taken as a root of its own.
export function projectRoot(cwd: string): string | null {
  const r = git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"], cwd);
  if (r.code !== 0) return null;
  const [gitDir, common, top] = r.stdout.split("\n");
  return realpathSync(gitDir !== common && basename(common) === ".git" ? dirname(common) : top);
}

// The state home holds the worktrees, the ledgers and every file the lead hands over. Inside a git working tree, that
// repository's `git add` would take them in, and every file under scratch would be refused. The nearest directory that
// exists stands for a home that is not made yet. A directory above it that holds a .git entry makes it a working tree,
// whatever git says of that repository, which it refuses when another account owns it.
export function assertHomeOutsideRepos(): void {
  const home = mandorHome();
  let dir = home;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  for (dir = realpathSync(dir); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) throw new Error(`refusing the mandor home ${home}: it lies inside the git working tree ${dir}; set MANDOR_HOME to a directory outside every repository`);
    if (dirname(dir) === dir) return;
  }
}

export function revParse(cwd: string, ref: string): string {
  return ok(["rev-parse", "--verify", ref], cwd).trim();
}

// Creates the branch itself, so it fails when the branch already exists. The worktree is made without a checkout, which
// git would run under the user's configuration, hooks and drivers included, before the configuration of the new
// worktree could be read. The checkout then runs bound to the worktree and confined, as every write into one does.
// Both steps carry the tag: a command killed between them can leave either one running.
export function addWorktree(repo: string, path: string, branch: string, base: string): void {
  ok(["-c", pathTag("add", path), "worktree", "add", "--no-checkout", "-b", branch, path, base], repo);
  const g = bind(repo, path);
  okConfined(g, checkoutAllow(g), ["-c", pathTag("add", path), ...READ_TREE, "HEAD"]);
}

const lines = (s: string) => s.replace(/\n$/, "").split("\n");

// The real form of a path whose last parts may not exist, so a half-made or removed worktree still compares equal.
export function realOf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    const up = dirname(p);
    return up === p ? p : join(realOf(up), basename(p));
  }
}

// A worktree's own path with only its parent resolved: mandor built the parent, so the parent is trusted, but a
// process the worker leaves behind is granted its own worktree root by the sandbox and can empty that root and put a
// link at its name. The final name stays literal, so a worktree is identified by the path mandor constructed,
// never by where a swapped root now points.
function constructedPath(p: string): string {
  return join(realOf(dirname(p)), basename(p));
}

// A worktree's constructed path, once its root entry proves to be a real directory at that very path. Whatever runs,
// writes or reads there by path would otherwise follow a link a worker put at the root to a sibling task worktree or
// the integration worktree.
export function worktreeRoot(worktree: string): string {
  const real = constructedPath(worktree);
  try {
    if (lstatSync(real).isDirectory() && realpathSync.native(real) === real) return real;
  } catch {} // no entry, or one that went away between the two reads
  throw new Error(`refusing ${worktree}: its root ${real} is not a directory at its own path`);
}

// git holds no lock while a hook runs or a checkout starts, so a git that a command killed alone left running shows only
// in its command line, where addWorktree and commitStaged put these tags. A failed ps read counts as none.
const pathTag = (what: string, path: string) => `lead.${what}=${createHash("sha256").update(realOf(path)).digest("hex").slice(0, 16)}`;

function taggedProcess(tag: string): number | null {
  const r = spawnSync("/bin/ps", ["-axww", "-o", "pid=", "-o", "command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const line = (r.stdout ?? "").split("\n").find((l) => l.includes(tag));
  return line === undefined ? null : Number.parseInt(line, 10);
}

// The pid of a git worktree add still working on this path, or null.
export const worktreeAddRunning = (path: string) => taggedProcess(pathTag("add", path));
// The pid of a commit still working in this worktree, or null.
export const commitRunning = (worktree: string) => taggedProcess(pathTag("commit", worktree));

function commonDirOf(repo: string): string {
  // Exactly one absolute path: git before 2.31 echoes the unknown --path-format flag instead.
  const common = lines(ok(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo));
  if (common.length !== 1 || !isAbsolute(common[0])) throw new Error(`refusing ${repo}: git did not give one absolute common dir; mandor needs git 2.31 or later, so update git`);
  return realpathSync.native(common[0]);
}

// A repository under the home would be a worker's own, not the user's.
function refuseInsideHome(subject: string, commonDir: string, home: string): void {
  if (commonDir.startsWith(home + sep)) throw new Error(`refusing ${subject}: its repository ${commonDir} is inside the mandor home ${home}`);
}

// For a command about to run git in repo and write there: nothing of a repository under the home may run, its
// reference-transaction hook included, so this comes before the first such command.
export function assertRepoOutsideHome(repo: string): void {
  refuseInsideHome(repo, commonDirOf(repo), realpathSync.native(mandorHome()));
}

// The admin dirs the user's own repository keeps for this worktree, found by the back-pointer each one holds. The
// worktree is given by its constructed path. A pointer <wt>/.git is matched by resolving its grandparent (the
// worktree's parent, mandor's own) and keeping the worktree name literal, so a root a worker replaced with a link
// to a sibling is never followed: both the pointer's worktree and the one asked for are compared at their own names.
function adminDirs(commonDir: string, constructed: string): string[] {
  const admins = join(commonDir, "worktrees");
  const want = join(constructed, ".git");
  return (existsSync(admins) ? readdirSync(admins) : []).map((n) => join(admins, n)).filter((dir) => {
    try {
      const p = resolve(dir, readFileSync(join(dir, "gitdir"), "utf8").replace(/\n$/, "")); // <wt>/.git
      const wt = dirname(p);
      return join(realOf(dirname(wt)), basename(wt), basename(p)) === want;
    } catch {
      return false; // a pruned or partly written admin dir names no worktree
    }
  });
}

// A process the worker leaves in the tree can swap a directory it holds for a link to one outside, such as the same
// path in the user's checkout; both rm's fts walk and Node's rmSync follow that swap under load and delete there. So rm
// runs confined by the kernel sandbox, which denies every write outside the tree: a steered unlink gets EPERM and the
// removal fails closed, nothing deleted outside. ROOT is the resolved path, as seatbelt matches the real one
// (/private/var, not /var). sandbox-exec that cannot apply exits non-zero, so this throws rather than fall back.
export function removeTree(raw: string): void {
  // The parent resolved, as the sandbox matches the real path: a home reached through a link (/tmp, /var) is denied otherwise.
  // The last entry stays as it is, so a link at the path itself is removed and never followed.
  const path = join(realOf(dirname(raw)), basename(raw));
  const profile = '(version 1)(allow default)(deny file-write*)(allow file-write-data (literal "/dev/null"))(allow file-write* (subpath (param "ROOT")))';
  // A directory without write permission (a Go module cache has them), or a file with the user immutable or append-only
  // flag, which a worker can make of its own files, stops the removal, so they are cleared first, inside the same
  // confinement. A failure to clear one is no answer: rm says. An ACL that denies the removal is left, and rm names the file.
  const r = spawnSync("/usr/bin/sandbox-exec", ["-D", `ROOT=${path}`, "-p", profile, "/bin/sh", "-c",
    'chflags -R nouchg,nouappnd -- "$1" 2>/dev/null; chmod -R u+rwX -- "$1" 2>/dev/null; exec rm -rf -- "$1"', "sh", path],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (r.status === 0) return;
  // One line, control characters masked: the names in it are the worker's, and rm passes a tab, DEL and C1 codes through.
  const why = r.error?.message ?? (r.stderr.split("\n")[0].replace(/[\x00-\x1f\x7f-\x9f]/g, "?") || `exit ${r.status ?? r.signal}`);
  throw new Error(`could not remove ${path}: ${why}`);
}

// Forced removal is only for mandor's own worktrees and wip/ branches. It goes by what exists, so it also clears
// what a killed command or a worker left: a locked or half-made worktree, a directory git does not know, a registered
// worktree whose directory is gone, or nothing at all. git is not asked: it validates the worker's .git first, and its
// removal walks by path like rmSync, which a left-behind process can steer; removeTree confines the walk instead.
// The worktree is named by its constructed path. Its admin dirs are the ones whose pointer names that path, found
// without resolving through the root, so a sibling the worker linked the root to keeps its tree, files and admin dir.
export function removeOwnedWorktree(repo: string, path: string, branch: string | null, worktreesRoot: string): void {
  const constructed = constructedPath(path); // the path mandor built, not a link a worker put at its name
  const underRoot = realOf(worktreesRoot) + sep;
  if (!constructed.startsWith(underRoot)) throw new Error(`refusing to remove ${path}: not under ${worktreesRoot}`);
  if (branch !== null && !branch.startsWith("wip/")) throw new Error(`refusing to delete branch ${branch}: not a wip/ branch`);
  const admins = adminDirs(commonDirOf(repo), constructed);
  const st = lstatSync(constructed, { throwIfNoEntry: false });
  if (st !== undefined && st.isDirectory()) {
    removeTree(constructed); // a real directory, removed confined so a swapped subdir cannot steer the walk outside it
  } else if (st !== undefined) {
    // A link or other entry a worker put at the worktree's own name: remove that entry only, never recurse through it,
    // so a sibling task worktree or the integration worktree it points at is left intact. Refuse if it leads outside.
    if (!realOf(constructed).startsWith(underRoot)) throw new Error(`refusing to remove ${path}: it leads outside, not under ${worktreesRoot}`);
    rmSync(constructed);
  }
  // Only once the tree is gone, so one that will not go stays registered and a later call finishes it.
  for (const admin of admins) removeTree(admin);
  if (branch !== null && branchExists(repo, branch)) ok(["branch", "-D", branch], repo);
}

// Whether anything removeOwnedWorktree takes away is still there: the directory, its registration or the branch.
export function worktreeLeft(repo: string, path: string, branch: string | null): boolean {
  const constructed = constructedPath(path);
  if (lstatSync(constructed, { throwIfNoEntry: false }) !== undefined) return true;
  return adminDirs(commonDirOf(repo), constructed).length > 0 || (branch !== null && branchExists(repo, branch));
}

export function branchExists(repo: string, branch: string): boolean {
  return run(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], repo).code === 0;
}

// Only a wip/ branch, and only from the commit it was made at: one that has moved keeps its work, and the failure says so.
export function deleteBranchAt(repo: string, branch: string, tip: string): void {
  if (!branch.startsWith("wip/")) throw new Error(`refusing to delete branch ${branch}: not a wip/ branch`);
  if (branchExists(repo, branch)) ok(["update-ref", "-d", `refs/heads/${branch}`, tip], repo);
}

const DRIVER_KEYS = "^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver)$";
// A hook that the configuration defines (git 2.54 and later) is not looked up in the hooks directory.
const HOOK_KEYS = "^hook\\..*\\.(command|event)$";

// The keys of the configuration that cwd sees, whose names match the pattern. With a location that is the
// configuration of a worktree: an include that depends on its branch and its own config.worktree count, which a read
// from the main checkout does not see. Throws when the configuration cannot be read, so a caller never takes an
// unreadable one for one without such keys.
function configKeys(cwd: string, pattern: string, location: Location = {}): string[] {
  const r = run(["config", "-z", "--name-only", "--get-regexp", pattern], cwd, location);
  // Only a silent exit 1 is "no such key": run reports a spawn failure or a kill as exit 1 with a message.
  if (r.code === 1 && r.stdout.length === 0 && r.stderr === "") return [];
  if (r.code !== 0) throw new GitFailure(`cannot read the git config of ${cwd}: ${r.stderr.trim()}`);
  return r.stdout.toString().split("\0").filter(Boolean);
}

// The filter and merge driver commands the main checkout sees, for the commands that refuse before they touch a worktree.
export function configuredDrivers(repo: string): string[] {
  return configKeys(repo, DRIVER_KEYS);
}

// In a partial clone git fetches an object it lacks from its promisor remote by itself, in a checkout, a diff or an apply,
// and no command of mandor may contact a remote.
const PROMISOR_KEYS = "^(extensions\\.partialclone|remote\\..*\\.promisor)$";

export function configuredPromisors(repo: string): string[] {
  return configKeys(repo, PROMISOR_KEYS);
}

export const PARTIAL_CLONE = "a partial clone is not supported, as git would fetch the objects it lacks from a remote";

interface Bound {
  gitDir: string;
  worktree: string;
  commonDir: string;
  run(args: string[]): Result;
  ok(args: string[]): string;
  okBytes(args: string[]): Buffer;
  confined(allow: [string, string][], args: string[], extra?: Location): Result;
  // The same binding with more git environment, as a staging that keeps its index and objects of its own needs.
  with(extra: Location): Bound;
}

// A git command that writes a bound worktree, confined by the kernel sandbox to write only the paths in allow, which
// each caller names: the worktree subtree, the admin dir's two index files by exact name, and for an apply its object
// quarantine. Refs are never in the allow set; a branch moves separately, through the trusted repository. git opens
// /dev/null, so that one write is allowed too. sandbox-exec that cannot apply (nested under another sandbox, or absent)
// prints its own error and runs nothing: this throws, so a worktree write never runs unconfined.
function confinedRun(cwd: string, location: Location, pre: string[], allow: [string, string][], args: string[]): Result {
  const rules = allow.map(([kind], i) => `(${kind} (param "P${i}"))`).join(" ");
  const profile = `(version 1)(allow default)(deny file-write*)(allow file-write-data (literal "/dev/null"))(allow file-write* ${rules})`;
  const defs = allow.flatMap(([, p], i) => ["-D", `P${i}=${p}`]);
  const r = spawnSync("/usr/bin/sandbox-exec", [...defs, "-p", profile, "git", ...pre, ...args], { cwd, env: gitEnv(location), maxBuffer: 64 * 1024 * 1024 });
  let i = 0; // the subcommand, past any leading -c key pairs, for the messages
  while (args[i] === "-c") i += 2;
  const cmd = args[i] ?? args[0];
  if (r.error) throw new Error(`cannot confine git ${cmd} in ${cwd}: ${r.error.message}`);
  const stderr = r.stderr.toString();
  // sandbox-exec prefixes its own failures and never execs git; a git error carries no such prefix.
  if (stderr.startsWith("sandbox-exec:")) throw new Error(`cannot confine git ${cmd} in ${cwd}: ${stderr.split("\n")[0]}`);
  if (typeof r.status === "number") return { code: r.status, stdout: r.stdout, stderr };
  return { code: 1, stdout: Buffer.alloc(0), stderr: `git ${cmd} killed by ${r.signal}` };
}

// A profile of the kind the confined calls use (a deny rule with narrow allows), on a path that exists nowhere: an
// allow-all profile applies even nested under an allow-all sandbox, where profiles with a deny rule fail.
const PROBE_PROFILE = '(version 1)(allow default)(deny file-write*)(allow file-write-data (literal "/dev/null"))(allow file-write* (subpath "/nonexistent"))';

// Why sandbox-exec cannot apply such a profile here, or null when it can. It cannot nest, so inside Claude Code's
// own Bash sandbox no confined write and no worker could run: the commands that start work refuse up front, and init
// warns. Nothing in the environment or on the command line can skip this.
export function confineProblem(): string | null {
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", PROBE_PROFILE, "/usr/bin/true"], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (r.status === 0) return null;
  const why = r.error?.message ?? (r.stderr.split("\n")[0] || `exit ${r.status ?? r.signal}`);
  return `cannot confine with sandbox-exec (${why}): run mandor outside Claude Code's Bash sandbox, which sandbox-exec cannot nest in`;
}

// Runs a confined write and throws its stderr on a non-zero exit, like ok.
function okConfined(g: Bound, allow: [string, string][], args: string[], extra: Location = {}): string {
  const r = g.confined(allow, args, extra);
  if (r.code !== 0) throw new GitFailure(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.toString();
}

// Whether the deflated bytes are the loose object named by oid (sha1, or sha256 for a 64-hex id).
function isLooseObject(raw: Buffer, oid: string): boolean {
  try {
    return createHash(oid.length === 64 ? "sha256" : "sha1").update(inflateSync(raw)).digest("hex") === oid;
  } catch {
    return false;
  }
}

// Loose objects a confined apply wrote to its quarantine, copied into the repository's object store so the staged index
// they back reads later. The quarantine is in apply's allow set, so a process left in the worktree could have steered
// patch content there through a link; so only a real directory and a real file are read, never a planted symlink, each
// is checked to be the object its name hashes to (the bytes written are those, so a swap after the check cannot smuggle
// others in), and one the store already holds with the right bytes is left as is. Anything else throws.
export function migrateObjects(from: string, to: string): void {
  for (const sub of readdirSync(from, { withFileTypes: true })) {
    if (!sub.isDirectory() || !/^[0-9a-f]{2}$/.test(sub.name)) continue; // a real fanout dir; skips a link, info/, pack/
    for (const ent of readdirSync(join(from, sub.name), { withFileTypes: true })) {
      if (!ent.isFile()) continue; // a real loose object, never a planted link
      const oid = sub.name + ent.name;
      const raw = readFileSync(join(from, sub.name, ent.name));
      if (!isLooseObject(raw, oid)) throw new Error(`refusing to keep ${oid}: not the loose object it is named for`);
      const dir = join(to, sub.name);
      const dst = join(dir, ent.name);
      // A killed write or an ENOSPC could have left a truncated object under this name; an existing one is kept only
      // when its own bytes are the object it is named for, so a bad one is replaced rather than trusted and skipped.
      if (existsSync(dst) && isLooseObject(readFileSync(dst), oid)) continue;
      mkdirSync(dir, { recursive: true });
      // Written through a temp file in the same fanout dir and renamed into place, as git writes objects: a kill
      // between the write and the rename leaves the temp, never a truncated object under the final name, and the
      // rename replaces a bad one atomically, even read-only, since it needs only the directory writable. The tmp_obj_
      // prefix is git's own, so fsck passes over a temp a kill left and prune removes it once stale.
      const tmp = join(dir, `tmp_obj_${randomBytes(8).toString("hex")}`);
      try {
        writeFileSync(tmp, raw);
        renameSync(tmp, dst);
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  }
}

// An empty hooks directory to point git at, so no hook fires. Refuse to run if anything is in it.
function emptyHooks(): string {
  const dir = join(mandorHome(), "empty-hooks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (readdirSync(dir).length > 0) throw new Error(`refusing: ${dir} is not empty`);
  return dir;
}

// GIT_DIR and GIT_WORK_TREE below point git at the admin dir the user's own repository keeps for this worktree,
// never at the worktree's .git file, which the worker may rewrite. The user's own repository config still applies,
// so hardened callers also override core.hooksPath and core.fsmonitor: a relative hooksPath resolves against the
// worktree root, and a nested repository brings its own config, either of which would otherwise run worker-planted
// code. A -c override reaches a child git (one spawned to inspect a submodule) through GIT_CONFIG_PARAMETERS.
// commitStaged alone keeps the user's hooks and config, and refuses a wip/ HEAD so it only runs in an integration
// worktree; it still turns fsmonitor off, as a relative command would be taken from the worktree.
function bind(repo: string, worktree: string, userConfig = false): Bound {
  // The path the root check returns is the one git, the cwd and the sandbox get, so nothing below follows a replaced
  // root, and a swap after the check lands outside the sandbox allow set, where it is denied. It resolves only the
  // parent, natively, so a home spelled in another case still compares equal.
  const real = worktreeRoot(worktree);
  const home = realpathSync.native(mandorHome());
  if (!real.startsWith(home + sep)) throw new Error(`refusing ${worktree}: not under the mandor home ${home}`);
  const commonDir = commonDirOf(repo);
  refuseInsideHome(worktree, commonDir, home);
  const named = adminDirs(commonDir, real);
  if (named.length !== 1) throw new Error(`refusing ${worktree}: ${named.length === 0 ? "not a worktree of" : "named by more than one admin dir of"} ${repo}`);
  const location = { GIT_DIR: named[0], GIT_WORK_TREE: real };
  // git runs a driver command with the worktree as cwd, where a worker-written attributes file and script can steer it
  // into running worker code in the lead. No bound call goes on under one, whichever scope of the configuration defines it.
  const drivers = configKeys(real, DRIVER_KEYS, location);
  if (drivers.length > 0) throw new Error(`refusing ${real}: its git config defines ${drivers.join(", ")}; filter and merge drivers are not supported`);
  const promisors = configKeys(real, PROMISOR_KEYS, location);
  if (promisors.length > 0) throw new Error(`refusing ${real}: its git config defines ${promisors.join(", ")}; ${PARTIAL_CLONE}`);
  // Hardened callers point git at an empty hooks dir and turn fsmonitor off (both reach a submodule child through
  // GIT_CONFIG_PARAMETERS). diff.ignoreSubmodules=dirty makes the apply calls ignore submodule work-tree state too;
  // diff-index and status pass the flag explicitly, and stageAll excludes gitlinks from `add`, which the flag cannot.
  // A hook that the configuration itself defines is not in the hooks dir, so each one is switched off by its name.
  const configured = userConfig ? [] : configKeys(real, HOOK_KEYS, location).map((key) => key.slice("hook.".length, key.lastIndexOf(".")));
  // --config-env splits at the last equals sign, so a name that holds one still reaches git whole; -c would split at the first.
  const hooksOff = [...new Set(configured)].map((name) => `--config-env=hook.${name}.enabled=LEAD_HOOK_OFF`);
  const env: Location = hooksOff.length > 0 ? { ...location, LEAD_HOOK_OFF: "false" } : location;
  const pre = userConfig ? ["-c", "core.fsmonitor=false"] : ["-c", `core.hooksPath=${emptyHooks()}`, "-c", "core.fsmonitor=false", "-c", "diff.ignoreSubmodules=dirty", ...hooksOff];
  const make = (e: Location): Bound => ({
    gitDir: named[0],
    worktree: real,
    commonDir,
    run: (a) => run([...pre, ...a], real, e),
    ok: (a) => ok([...pre, ...a], real, e),
    okBytes: (a) => okBytes([...pre, ...a], real, e),
    confined: (allow, a, extra = {}) => confinedRun(real, { ...e, ...extra }, pre, allow, a),
    with: (extra) => make({ ...e, ...extra }),
  });
  return make(env);
}

// Untracked files count even when status.showUntrackedFiles hides them; ignored files never do.
// --ignore-submodules=dirty keeps a gitlink pointer change counting, without git inspecting a nested work tree.
const STATUS = ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"];
const clean = (g: Bound) => g.ok(STATUS) === "";

export function isClean(repo: string, worktree: string): boolean {
  return clean(bind(repo, worktree));
}

// A plain index, so no split-index write (sharedindex.*) lands in the admin dir outside the narrow allow set.
const SPLIT_OFF = ["-c", "core.splitIndex=false"];
// git worktree add resets without recursing into submodules. A user's submodule.recurse would make read-tree do so, and
// create their directories in the git dir, where the sandbox denies a write.
const READ_TREE = [...SPLIT_OFF, "read-tree", "--reset", "-u", "--no-recurse-submodules"];

// The allow set a confined checkout needs: the worktree subtree, and the two index files by exact name, so a target
// tree or untracked file named like an admin-dir pointer (gitdir, commondir, HEAD) cannot be written through a link.
function checkoutAllow(g: Bound): [string, string][] {
  return [["subpath", g.worktree], ["literal", join(g.gitDir, "index")], ["literal", join(g.gitDir, "index.lock")]];
}

// reset --hard, as a confined checkout plus a branch move outside it. The worktree checkout (read-tree -u, which may
// also write the index) and the untracked sweep (clean, the worktree only) run under the sandbox, so a process left in
// the worktree cannot steer either to a link reaching outside. The branch ref moves through the trusted repository.
export function resetTo(repo: string, worktree: string, ref: string): void {
  const g = bind(repo, worktree);
  // The reset moves whatever branch is checked out, so that must be one of mandor's own.
  const branch = lines(g.run(["symbolic-ref", "-q", "HEAD"]).stdout.toString())[0];
  if (!branch.startsWith("refs/heads/wip/")) throw new Error(`refusing to reset ${worktree}: HEAD is ${branch || "detached"}, not a wip/ branch`);
  const target = g.ok(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  okConfined(g, checkoutAllow(g), [...READ_TREE, target]); // tracked files to the target tree
  okConfined(g, [["subpath", g.worktree]], ["clean", "-ffd"]); // -ff also removes a nested repository; no -x, so ignored stay
  ok(["update-ref", branch, target], repo); // the shared branch, from the repo, not the worktree
}

// Plumbing, because git diff follows user config (diff.external, textconv, prefixes, color, context,
// submodule format and ignores) that changes what git apply reads back and what the commit check sees.
// --ignore-submodules=dirty reports a gitlink pointer change (overriding a worker .gitmodules ignore line), and not
// a nested repository's work-tree dirtiness.
const DIFF_INDEX = ["diff-index", "--cached", "--no-renames", "--ignore-submodules=dirty"];

// Stage everything, but never descend into a tracked gitlink's work tree: `git add` has no --ignore-submodules,
// and for a stat-dirty gitlink it refreshes the entry by running a child git in the nested repository, which would
// run that repository's clean filter. Excluding the gitlink paths (known from the trusted index) leaves the
// pointer as the index already holds it, which diff-index --ignore-submodules=dirty still reports.
function stageAll(g: Bound): void {
  const gitlinks = g.ok(["ls-files", "--stage", "-z"]).split("\0").filter((l) => l.startsWith("160000 ")).map((l) => l.slice(l.indexOf("\t") + 1));
  g.ok(["add", "-A", "--", ".", ...gitlinks.map((p) => `:(exclude)${p}`)]);
}

// What staging for a read leaves behind. In the repository's own object store every worker file it read would stay as an
// unreachable object until git prunes it, and in the worker's own index the entries would name objects that the worker's git
// could not find. So the staging runs on a copy of the index, in a directory of its own under the state home, with an
// object directory of its own that reads through the repository's, and the whole directory goes at the end. The tree it
// makes has the id it would have made anywhere else, as an id is a hash of the content.
function privateStage<T>(repo: string, worktree: string, use: (g: Bound) => T): T {
  const g = bind(repo, worktree);
  const stages = join(mandorHome(), "stage");
  ensureDir(stages);
  const dir = mkdtempSync(join(stages, "s-"));
  try {
    // A split index keeps most of its entries in a shared file beside it. A copy keeps the modification time of its original:
    // git trusts an entry whose file looks unchanged only when the entry is older than the index, so an index that looked
    // newer than it is would let an edit of the same size, within the second of the last write, pass unseen.
    for (const name of readdirSync(g.gitDir)) {
      if (name !== "index" && !name.startsWith("sharedindex.")) continue;
      const from = join(g.gitDir, name);
      const at = statSync(from);
      copyFileSync(from, join(dir, name));
      // Rounded down, so that no entry that was racy in the original reads as safe in the copy.
      utimesSync(join(dir, name), Math.floor(at.atimeMs / 1000), Math.floor(at.mtimeMs * 1000) / 1e6);
    }
    const objects = join(dir, "objects");
    mkdirSync(objects, { mode: 0o700 });
    return use(g.with({ GIT_INDEX_FILE: join(dir, "index"), GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(g.commonDir, "objects") }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What the staged tree leaves out: the ignored files whose status changed after sinceMs, counted by their first path segment
// (a directory is named with a closing slash), most files first. The status change time, not the modification time: a
// worker can set the latter back on a file of its own, and not the former. Whether a path is ignored is the worktree's own
// rule, a .gitignore a worker edited included, which the staged tree shows as a change of that file.
export function ignoredChanged(repo: string, worktree: string, sinceMs: number): { path: string; files: number }[] {
  const g = bind(repo, worktree);
  const found = new Map<string, number>();
  for (const path of g.okBytes(["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]).toString().split("\0").filter(Boolean)) {
    const stat = lstatSync(join(g.worktree, path), { throwIfNoEntry: false });
    if (stat === undefined || !(stat.ctimeMs > sinceMs)) continue;
    const slash = path.indexOf("/");
    const key = slash < 0 ? path : `${path.slice(0, slash)}/`;
    found.set(key, (found.get(key) ?? 0) + 1);
  }
  return [...found].map(([path, files]) => ({ path, files })).sort((a, b) => b.files - a.files || (a.path < b.path ? -1 : 1));
}

// The exact patch bytes: a text file that is not UTF-8 would not survive a decode and re-encode.
export function diffSinceBaseBytes(repo: string, worktree: string, base: string): Buffer {
  return privateStage(repo, worktree, (g) => {
    stageAll(g);
    return g.okBytes([...DIFF_INDEX, "--binary", base, "--"]);
  });
}

// The patch to apply, the text the guards read and the stat the lead sees, from one tree: write-tree fixes what was
// staged as an object, so neither a process left in the worktree nor one that rewrites the index can make them differ.
// The text passes --text, which prints every file as hunks, so a worker's .gitattributes (-diff) or a NUL byte cannot turn
// added lines into a binary patch that no check reads; the patch itself is never taken from it.
// The tree id names exactly what was read, for a later check that nothing changed since.
export function stagedDiff(repo: string, worktree: string, base: string): { bytes: Buffer; text: string; stat: string; tree: string } {
  return privateStage(repo, worktree, (g) => {
    stageAll(g);
    const tree = g.ok(["write-tree"]).trim();
    const read = (flags: string[]) => g.okBytes(["diff-tree", "-r", "--no-renames", "--ignore-submodules=dirty", ...flags, base, tree, "--"]);
    return { bytes: read(["--binary"]), text: read(["--patch", "--text"]).toString(), stat: read(["--stat"]).toString(), tree };
  });
}

export function diffStat(repo: string, worktree: string, base: string): string {
  return privateStage(repo, worktree, (g) => {
    stageAll(g);
    return g.ok([...DIFF_INDEX, "--stat", base, "--"]);
  });
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

// Octal escapes are the path's raw bytes, so they are decoded together with any raw UTF-8 as one byte string.
function unquote(s: string): string {
  const bytes = Buffer.from(s).toString("latin1").replace(/\\([0-7]{3}|[abtnvfr"\\])/g, (_, e: string) => String.fromCharCode(e.length === 3 ? parseInt(e, 8) : ESCAPES[e]));
  return Buffer.from(bytes, "latin1").toString();
}

// Without renames both sides name one path: a/P b/P, or "a/P" "b/P" with P C-quoted. P may itself contain " b/".
function headerPath(rest: string): string {
  const q = rest.startsWith('"') ? '"' : "";
  const n = (rest.length - 5 - 4 * q.length) / 2;
  const p = rest.slice(2 + q.length, 2 + q.length + n);
  if (rest !== `${q}a/${p}${q} ${q}b/${p}${q}`) throw new Error(`unexpected diff header: diff --git ${rest}`);
  return q ? unquote(p) : p;
}

// Hunk lines start with a space, +, - or \ and binary patch lines hold no spaces, so only headers start with these words.
export function changedPaths(diff: string): { path: string; status: "A" | "M" | "D" }[] {
  const out: { path: string; status: "A" | "M" | "D" }[] = [];
  for (const line of diff.split("\n")) {
    const last = out.at(-1);
    if (line.startsWith("diff --git ")) out.push({ path: headerPath(line.slice(11)), status: "M" });
    else if (last && line.startsWith("new file mode ")) last.status = "A";
    else if (last && line.startsWith("deleted file mode ")) last.status = "D";
  }
  return out;
}

// apply.whitespace=fix would rewrite reviewed lines, and =error would refuse them.
const APPLY = ["apply", "--whitespace=nowarn"];

// A 3-way apply with rerere on records the conflict by writing MERGE_RR in the admin dir, which the sandbox denies, so
// git reports no conflict and leaves markers behind instead. Off, a real conflict is reported as one. A bare rr-cache
// directory enables rerere even with no config set, so it is forced off rather than left to the config.
const RERERE_OFF = ["-c", "rerere.enabled=false"];

// git apply writes worktree files and the index, so it runs confined. It also writes new blob objects; those go to a
// quarantine under the admin dir (in the allow set) with the repository's objects as a read-only alternate, then
// migrate into the repository so the staged index reads after. The quarantine is cleared before and after.
function applyConfined(g: Bound, mode: string, patchFile: string): Result {
  const objects = join(g.commonDir, "objects");
  const quarantine = join(g.gitDir, "lead-apply-objects");
  rmSync(quarantine, { recursive: true, force: true });
  mkdirSync(join(quarantine, "pack"), { recursive: true, mode: 0o700 });
  try {
    return g.confined([...checkoutAllow(g), ["subpath", quarantine]], [...SPLIT_OFF, ...RERERE_OFF, ...APPLY, mode, patchFile], { GIT_OBJECT_DIRECTORY: quarantine, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects });
  } finally {
    migrateObjects(quarantine, objects);
    rmSync(quarantine, { recursive: true, force: true });
  }
}

// --check writes nothing, so it needs no sandbox.
export function applyCheck(repo: string, worktree: string, patchFile: string): boolean {
  return bind(repo, worktree).run([...APPLY, "--index", "--check", patchFile]).code === 0;
}

export function applyToIndex(repo: string, worktree: string, patchFile: string): void {
  const r = applyConfined(bind(repo, worktree), "--index", patchFile);
  if (r.code !== 0) throw new GitFailure(`git apply --index failed: ${r.stderr.trim()}`);
}

export function indexTree(repo: string, worktree: string): string {
  return bind(repo, worktree).ok(["write-tree"]).trim();
}

export function indexLockPath(repo: string, worktree: string): string {
  return join(bind(repo, worktree).gitDir, "index.lock");
}

// A conflicted merge and a patch that did not apply both exit non-zero; only unmerged paths tell them apart.
export function apply3way(repo: string, worktree: string, patchFile: string): { applied: boolean; conflicted: string[] } {
  const g = bind(repo, worktree);
  const code = applyConfined(g, "--3way", patchFile).code;
  const conflicted = g.ok(["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean);
  return { applied: conflicted.length > 0 || code === 0, conflicted };
}

// Read the same way as the patch, so a path visible on one side is never hidden on the other.
const staged = (g: Bound) => g.ok([...DIFF_INDEX, "--name-only", "-z", "HEAD", "--"]).split("\0").filter(Boolean);

const PLACEHOLDER_DOMAINS = ["example.com", "example.org", "example.net", "localhost", "t.t"];

export function isPlaceholderEmail(email: string, allowTestIdentity: boolean): boolean {
  const parts = email.toLowerCase().split("@");
  // Whitespace or a second @ could put a real-looking address after a placeholder.
  if (parts.length !== 2 || /\s/.test(email)) return true;
  const [local, fqdn] = parts;
  const domain = fqdn.replace(/\.$/, ""); // the root dot of a fully qualified name
  if (local === "" || !domain.includes(".") || domain.split(".").includes("")) return true;
  const within = (d: string) => domain === d || domain.endsWith(`.${d}`);
  return PLACEHOLDER_DOMAINS.some(within) || (!allowTestIdentity && within("invalid"));
}

// With guessing off, a missing identity fails instead of becoming <user>@<host>, which passes as a real address.
const IDENTITY = ["-c", "user.useConfigOnly=true"];
// git keeps < and > out of names, so the address is the one bracketed part, just before the timestamp.
const emailOf = (ident: string | undefined) => /<([^<>]*)> \d+ [+-]\d{4}$/.exec(ident ?? "")?.[1] ?? "";
// A commit made while one of these is present takes a second parent, or its author, from another commit.
// The pseudo-refs are asked for by name, since a reftable repository keeps some of them out of the git dir.
const IN_PROGRESS_REFS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
const IN_PROGRESS_DIRS = ["rebase-merge", "rebase-apply"];

// What a commit here would carry, by git var: GIT_*_EMAIL, author.email and committer.email override user.email.
function commitIdentity(g: Bound, worktree: string, allowTestIdentity: boolean): string[] {
  return ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"].map((v) => {
    const r = g.run([...IDENTITY, "var", v]);
    if (r.code !== 0) throw new GitFailure(`refusing to commit in ${worktree}: no ${v}: ${r.stderr.trim()}`);
    const email = emailOf(r.stdout.toString().trim());
    if (isPlaceholderEmail(email, allowTestIdentity)) throw new Error(`refusing to commit in ${worktree}: ${v} email "${email}" is a placeholder`);
    return email;
  });
}

// Throws when a commit made here now would carry a placeholder address, or none. Accept asks before it changes anything;
// commitStaged asks again for the commit itself.
export function assertCommitIdentity(repo: string, worktree: string, allowTestIdentity: boolean): void {
  commitIdentity(bind(repo, worktree, true), worktree, allowTestIdentity);
}

// The directory core.hooksPath names, relative to the worktree root, where git resolves a relative one (husky sets
// .husky), folded as APFS compares names: a staged path in another case or normalization (.Husky/pre-commit) names
// the same file on disk. An absolute one is taken by its real path first, so one spelled through a symlinked prefix
// of the worktree (/tmp for /private/tmp) is still inside it. "" is the root itself; null when unset or outside the
// worktree. Its hooks run at commit, so a staged change under it would be worker code running in the lead.
function hooksDir(g: Bound): string | null {
  const r = g.run(["config", "--type=path", "--get", "core.hooksPath"]);
  if (r.code !== 0) return null;
  const [dir, root] = [realOf(resolve(g.worktree, r.stdout.toString().trim())), g.worktree].map(foldPath);
  return dir === root ? "" : dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : null;
}

// The first shell word of a command: its program, honouring a single pair of surrounding quotes.
function firstShellWord(value: string): string {
  const s = value.replace(/^\s+/, "");
  if (s[0] === '"' || s[0] === "'") {
    const close = s.indexOf(s[0], 1);
    return close === -1 ? s.slice(1) : s.slice(1, close);
  }
  return s.split(/\s/)[0];
}

// The programs git starts to sign a commit, and the command that names the default ssh key. One that is a path relative
// to the worktree names the staged file of that path, which git starts from the worktree. A leading ~ counts as
// relative, as git before 2.51 does not expand it. A bare name is looked up on the PATH, which holds no relative entry.
function assertSafeSigning(g: Bound, worktree: string): void {
  const r = g.run(["config", "-z", "--get-regexp", "^gpg\\.(.*\\.)?program$|^gpg\\.ssh\\.defaultkeycommand$"]);
  if (r.code === 1 && r.stdout.length === 0 && r.stderr === "") return; // no such key
  if (r.code !== 0) throw new GitFailure(`cannot read the git config of ${worktree}: ${r.stderr.trim()}`);
  for (const entry of r.stdout.toString().split("\0").filter(Boolean)) {
    const nl = entry.indexOf("\n");
    const [key, value] = [entry.slice(0, nl), entry.slice(nl + 1)];
    const word = firstShellWord(value);
    if (word.includes("/") && !word.startsWith("/")) {
      throw new Error(`refusing to commit in ${worktree}: config ${key} "${value}" is relative to the worktree; use an absolute path or a bare name on PATH`);
    }
  }
}

// A header of a commit object, undefined unless it appears exactly once.
function commitHeader(raw: string, key: string): string | undefined {
  const found = raw.slice(0, raw.indexOf("\n\n")).split("\n").filter((h) => h.startsWith(`${key} `));
  return found.length === 1 ? found[0].slice(key.length + 1) : undefined;
}

export function commitStaged(repo: string, worktree: string, expectedPaths: string[], message: string, allowTestIdentity: boolean): string {
  // Keep the user's hooks and config: this commit is the reviewed patch on the goal tip, in an integration worktree.
  const g = bind(repo, worktree, true);
  const branch = lines(g.run(["symbolic-ref", "-q", "HEAD"]).stdout.toString())[0]; // empty when HEAD is detached
  // Only an integration worktree: a branch outside refs/heads/wip/. A wip/ branch or a detached HEAD is a worker's,
  // whose hooks and files (a relative husky hooksPath included) are not the lead's to run here.
  if (!branch.startsWith("refs/heads/") || branch.startsWith("refs/heads/wip/")) throw new Error(`refusing to commit in ${worktree}: HEAD is ${branch || "detached"}, not an integration branch`);
  const [author, committer] = commitIdentity(g, worktree, allowTestIdentity);
  const busy = [
    ...IN_PROGRESS_REFS.filter((name) => g.run(["rev-parse", "-q", "--verify", name]).code === 0),
    ...IN_PROGRESS_DIRS.filter((name) => existsSync(join(g.gitDir, name))),
  ];
  if (busy.length > 0) throw new Error(`refusing to commit in ${worktree}: ${busy.join(", ")} present`);
  const stagedSet = new Set(staged(g));
  const expected = new Set(expectedPaths);
  const extra = [...stagedSet].filter((p) => !expected.has(p)).sort();
  const missing = [...expected].filter((p) => !stagedSet.has(p)).sort();
  if (extra.length > 0 || missing.length > 0) {
    throw new Error(`refusing to commit in ${worktree}: staged but not reviewed ${JSON.stringify(extra)}, reviewed but not staged ${JSON.stringify(missing)}`);
  }
  const hooks = hooksDir(g);
  const touched = hooks === null ? [] : [...stagedSet].filter((p) => hooks === "" || foldPath(p) === hooks || foldPath(p).startsWith(`${hooks}/`)).sort();
  if (touched.length > 0) {
    throw new Error(`refusing to commit in ${worktree}: core.hooksPath ${hooks || "."} is inside the worktree and the staged changes touch ${JSON.stringify(touched)}`);
  }
  assertSafeSigning(g, worktree);
  const tip = g.ok(["rev-parse", "--verify", "HEAD"]).trim();
  const tree = g.ok(["write-tree"]).trim();
  // Hooks still run, so HEAD must then name exactly the commit asked for. Verbatim keeps git's cleanup off the message.
  g.ok([...IDENTITY, "-c", pathTag("commit", worktree), "commit", "--cleanup=verbatim", "-m", message]);
  const raw = g.ok(["cat-file", "commit", "HEAD"]); // the raw object, which no log config can decorate
  const end = raw.indexOf("\n\n");
  if (end < 0 || commitHeader(raw, "tree") !== tree || commitHeader(raw, "parent") !== tip || emailOf(commitHeader(raw, "author")) !== author
    || emailOf(commitHeader(raw, "committer")) !== committer || raw.slice(end + 2).trimEnd() !== message.trimEnd()) {
    // Back to the recorded branch at the recorded tip, even if a hook checked out another branch or added commits.
    g.ok(["symbolic-ref", "HEAD", branch]);
    g.ok(["update-ref", branch, tip]);
    throw new Error("a commit hook changed the commit; nothing was committed");
  }
  return g.ok(["rev-parse", "--verify", "HEAD"]).trim();
}

// What commitStaged checks of its own commit, for one a killed command left at HEAD: the addresses a commit here would
// carry, neither of them a placeholder.
export function assertHeadIdentity(repo: string, worktree: string, allowTestIdentity: boolean): void {
  const g = bind(repo, worktree, true);
  const [author, committer] = commitIdentity(g, worktree, allowTestIdentity);
  const raw = g.ok(["cat-file", "commit", "HEAD"]);
  const [a, c] = ["author", "committer"].map((key) => emailOf(commitHeader(raw, key)));
  if (a !== author || c !== committer) throw new Error(`its author ${a} and committer ${c} are not ${author} and ${committer}`);
}

export function resetHardHead(repo: string, worktree: string): void {
  // reset --hard HEAD: discards tracked changes without moving HEAD and without removing untracked files, so a confined
  // read-tree --reset -u to HEAD is the whole of it.
  const g = bind(repo, worktree);
  okConfined(g, checkoutAllow(g), [...READ_TREE, "HEAD"]);
}

// Whether the parent of HEAD is exactly checked out under a HEAD still at the commit: the index holds the parent's
// tree, the worktree matches the index, and no file is untracked. The state a drop leaves when it is cut between its
// confined checkout and its branch move.
function parentCheckedOut(g: Bound, parent: string): boolean {
  const index = g.run(["write-tree"]); // fails on an unmerged index, which is not this state
  if (index.code !== 0 || index.stdout.toString().trim() !== g.ok(["rev-parse", "--verify", `${parent}^{tree}`]).trim()) return false;
  // Column two is the worktree against the index; ?? is an untracked file.
  return lines(g.ok(STATUS)).every((l) => l === "" || (l[1] === " " && !l.startsWith("??")));
}

export function dropLastCommit(repo: string, worktree: string, expectedSha: string): void {
  const g = bind(repo, worktree);
  const head = g.ok(["rev-parse", "--verify", "HEAD"]).trim();
  if (head !== expectedSha) throw new Error(`refusing to drop the last commit: HEAD is ${head}, expected ${expectedSha}`);
  const parent = g.ok(["rev-parse", "--verify", "HEAD~1"]).trim();
  // A drop cut between its two steps left only the branch move to do; any other unclean state still refuses.
  const resumed = parentCheckedOut(g, parent);
  if (!resumed && !clean(g)) throw new Error(`refusing to drop the last commit: ${worktree} is not clean`);
  // A commit a remote-tracking branch contains has already left this machine.
  if (g.ok(["branch", "-r", "--contains", "HEAD"]) !== "") throw new Error(`refusing to drop ${head}: a remote branch contains it`);
  // The worktree is clean, so reset --keep is a plain checkout of the parent: confined, then the branch moves to it.
  if (!resumed) okConfined(g, checkoutAllow(g), [...READ_TREE, parent]);
  g.ok(["update-ref", "HEAD", parent]);
}
