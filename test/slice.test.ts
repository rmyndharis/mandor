import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Candidate, JobRecord, ModelInfo, StallReason, TaskRecord, WaitItem } from "../src/contracts.ts";
import { addWorktree, assertRepoOutsideHome, projectRoot } from "../src/git.ts";
import { jobDir, processStart, projectDir, projectIdFor, scratchDir, worktreesDir } from "../src/home.ts";
import { appendEvent, ledgerSize, listProjects, loadState, now, readEvents } from "../src/ledger.ts";
import { emptyProjectConfig, saveProjectConfig } from "../src/provision.ts";
import { reviewPack } from "../src/review.ts";
import { withProjectLock, writeJsonAtomic } from "../src/store.ts";
import { confirm, dispatch, goalStart, planSet, verdictAccept } from "../src/tasks.ts";
import { waitForNext } from "../src/wait.ts";
import { diffSinceBase, temp, tempHome, tempRepo, writeScenarios, writeTestConfig } from "./helpers.ts";

const LAUNCHER = join(import.meta.dirname, "..", "bin", "mandor");
const LUNA: Candidate = { tool: "codex", model: "gpt-6-luna", effort: "medium" };
const GOAL = "feat/slice";
const MESSAGE = "Add hello.txt\n\nGreets whoever reads it.\n";
const HELLO = { stdout: "generated:done", writeFile: [{ path: "hello.txt", content: "hello\n" }] };

const must = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

async function until(ok: () => boolean, ms = 20_000): Promise<boolean> {
  for (const end = Date.now() + ms; !ok(); await sleep(50)) if (Date.now() > end) return false;
  return true;
}

const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};

// Whatever a test leaves running dies with it: runners other than this process, and every worker group.
// A pid of 0 or 1 would signal this process's own group or everything, so only real pids are used.
function reap(home: string): void {
  const jobs = join(home, "jobs");
  for (const id of existsSync(jobs) ? readdirSync(jobs) : []) {
    const p = join(jobs, id, "job.json");
    if (!existsSync(p)) continue;
    const job = JSON.parse(readFileSync(p, "utf8")) as JobRecord;
    const runner = job.runnerPid ?? 0;
    if (runner > 1 && runner !== process.pid && processStart(runner) === job.runnerStart) kill(runner);
    if ((job.workerPid ?? 0) > 1) kill(-job.workerPid!);
  }
}

interface Slice { home: string; repo: string; id: string; file(name: string, body: string | Buffer): string }

function setup(t: TestContext): Slice {
  const home = tempHome({ config: true });
  t.after(() => reap(home));
  const repo = tempRepo();
  const id = projectIdFor(repo);
  const scratch = scratchDir(id, "t");
  const file = (name: string, body: string | Buffer) => {
    const p = join(scratch, name);
    writeFileSync(p, body);
    return p;
  };
  return { home, repo, id, file };
}

// Two live jobs of another project fill codex's two slots, so a dispatch records its task and starts no job.
function fillSlots(): void {
  for (const n of [1, 2]) {
    const id = `j-20261108100000-000${n}`;
    const job: JobRecord = {
      id, projectId: "other-000000000000", taskId: "x", seq: 1, kind: "start", candidate: LUNA, worktree: "/tmp", sessionId: null, promptPath: "/tmp/x", timeoutMs: 60_000,
      bin: "/usr/bin/false", env: {}, queuedAt: now(), status: "running", runnerPid: process.pid, runnerStart: processStart(process.pid), workerPid: null, startedAt: null, endedAt: null,
    };
    writeJsonAtomic(join(jobDir(id), "job.json"), job);
  }
}

const task = (s: Slice, slug: string) => loadState(s.id).tasks[slug];

type DispatchOptions = Parameters<typeof dispatch>[1];

function send(s: Slice, slug: string, over: Partial<DispatchOptions> = {}, cwd = s.repo) {
  return dispatch(cwd, { goal: GOAL, slug, tier: "light", briefFile: s.file(`${slug}.md`, `Create the file for ${slug}.\n`), scope: [], use: LUNA, after: null, ...over });
}

// Reviewed first, as accept commits only the tree the last review showed.
const accept = (s: Slice, slug: string, evidence = "node --test: 1 passed\n") => {
  reviewPack(s.repo, slug);
  return verdictAccept(s.repo, slug, s.file("evidence.md", evidence), s.file("message.txt", MESSAGE), { allowTestIdentity: true });
};

// The completion that set needs-review still holds the project lock for its pump; taking it once waits that out.
async function needsReview(s: Slice, slug: string): Promise<void> {
  assert.ok(await until(() => task(s, slug)?.status === "needs-review"), `${slug} reaches needs-review`);
  withProjectLock(s.id, () => {});
}

// A refused accept leaves the goal branch, the task and the ledger's verdicts as they were.
function refused(s: Slice, slug: string, tip: string): void {
  assert.equal(must(s.repo, "rev-parse", GOAL), tip);
  assert.equal(task(s, slug).status, "needs-review");
  assert.equal(readEvents(s.id).items.filter((e) => e.t === "verdict").length, 0);
}

const taskRecord = (slug: string, over: Partial<TaskRecord>): TaskRecord => ({
  id: slug, goalBranch: GOAL, tier: "light", after: null, status: "waiting", stallReason: null, pending: null, base: null, worktree: null,
  branch: `wip/${slug}`, scope: [], seq: 0, fixRounds: 0, candidate: LUNA, sessionId: null, use: null, jobIds: [], integratedCommit: null, briefPath: "", ...over,
});

// The state accept reads, without a worker run: a worktree from the goal tip holding what a worker would have left.
function reviewable(s: Slice, slug: string, files: Record<string, string | Buffer>, over: Partial<TaskRecord> = {}): TaskRecord {
  const base = must(s.repo, "rev-parse", GOAL);
  const worktree = join(worktreesDir(s.id), `task-${slug}`);
  addWorktree(s.repo, worktree, `wip/${slug}`, base);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), body);
  }
  const record = taskRecord(slug, { status: "needs-review", base, worktree, seq: 1, use: LUNA, ...over });
  appendEvent(s.id, { t: "task.created", at: now(), task: record });
  return record;
}

const hook = (repo: string, name: string, body: string) => {
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  writeFileSync(join(repo, ".git", "hooks", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
};
const unhook = (repo: string, name: string) => rmSync(join(repo, ".git", "hooks", name));

// Sleeps where git worktree add has made its admin dir and its locked file, before the checkout.
const holdWorktreeAdd = (repo: string, mark: string) =>
  hook(repo, "reference-transaction", `case "$(cat)" in *ref:refs/heads/*HEAD*) touch "${mark}"; exec sleep 30;; esac`);

const cli = (s: Slice, ...args: string[]) => {
  const r = spawnSync(LAUNCHER, args, { cwd: s.repo, encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : null };
};

// A command in a process group of its own, so a test can kill it alone or with every git and hook under it.
function detached(s: Slice, t: TestContext, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const c = spawn(LAUNCHER, args, { cwd: s.repo, stdio: "ignore", detached: true, env });
  t.after(() => kill(-c.pid!));
  return c;
}

// A git earlier on PATH; the script gets the real one as $REAL. Returns the PATH that finds it.
function wrappedGit(body: string): string {
  const dir = temp("mandor-git-wrap-");
  const real = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "git"), `#!/bin/sh\nREAL="${real}"\n${body}\n`, { mode: 0o755 });
  return `${dir}:${process.env.PATH}`;
}
const ended = (c: ChildProcess) => new Promise<void>((done) => (c.exitCode !== null || c.signalCode !== null ? done() : c.once("exit", () => done())));

// A live holder by pid and start time, which this process never took through the lock functions.
const holdLock = (path: string) => writeFileSync(path, JSON.stringify({ pid: process.pid, start: processStart(process.pid) }));

// A held lock reports busy after 30 s of waiting; under this each of its 50 ms pauses moves the clock 10 s.
function skewClock(t: TestContext): () => void {
  const [realNow, realWait] = [Date.now, Atomics.wait];
  let skew = 0;
  const restore = () => {
    Date.now = realNow;
    Atomics.wait = realWait;
  };
  t.after(restore);
  Date.now = () => realNow() + skew;
  Atomics.wait = ((a: Int32Array, i: number, v: number, ms?: number) => {
    skew += 10_000;
    return realWait(a, i, v, ms);
  }) as typeof Atomics.wait;
  return restore;
}

// A reservation whose owner is gone: its pid has exited, and a pid reused since would have started at another time.
const staleReservation = (file: string, tip: string) => writeJsonAtomic(file, { pid: spawnSync("/usr/bin/true").pid!, start: "Thu Jan  1 00:00:00 1970", tip });
const reservationOf = (s: Slice, slug: string) => join(projectDir(s.id), "tasks", slug, "reserved");
const goalReservation = (s: Slice) => join(projectDir(s.id), "goals", "feat__slice", "reserved");
const intentOf = (s: Slice) => join(projectDir(s.id), "goals", "feat__slice", "accept-intent.json");
const verdicts = (s: Slice) => readEvents(s.id).items.flatMap((e) => (e.t === "verdict" ? [`${e.taskId}:${e.verdict}`] : []));

// The slice

test("slice: goal start, plan set, dispatch, wait, accept and confirm make one commit on the goal branch", async (t) => {
  const s = setup(t);
  const base = must(s.repo, "rev-parse", "HEAD");
  const { goal, cursor: started } = goalStart(s.repo, GOAL, null);
  assert.equal(started, 0);
  assert.equal(existsSync(goalReservation(s)), false);
  assert.deepEqual([goal.branch, goal.from, goal.integrationWorktree], [GOAL, base, join(worktreesDir(s.id), "goal-feat__slice")]);
  assert.equal(must(goal.integrationWorktree, "symbolic-ref", "HEAD"), `refs/heads/${GOAL}`);
  const root = join(projectDir(s.id), "root");
  assert.equal(readFileSync(root, "utf8"), `${s.repo}\n`);
  assert.equal(statSync(root).mode & 0o777, 0o600);

  const afterGoal = ledgerSize(s.id);
  assert.equal(planSet(s.repo, GOAL, s.file("plan.md", "1. Say hello.\n"), "Say hello").cursor, afterGoal);
  const plan = join(projectDir(s.id), "goals", "feat__slice", "plan.md");
  assert.equal(readFileSync(plan, "utf8"), "1. Say hello.\n");
  const g = loadState(s.id).goals[GOAL];
  assert.deepEqual([g.description, g.plan?.path], ["Say hello", plan]);

  writeScenarios([HELLO]);
  const beforeTask = ledgerSize(s.id);
  const sent = send(s, "hello", { scope: ["hello.txt"] });
  assert.equal(sent.cursor, beforeTask);
  assert.deepEqual([sent.task.status, sent.task.base, sent.task.use, sent.task.branch], ["working", base, LUNA, "wip/hello"]);
  assert.equal(sent.task.worktree, join(worktreesDir(s.id), "task-hello"));
  // The brief on disk carries the worker rules, so a later handoff does too.
  assert.equal(sent.task.briefPath, join(projectDir(s.id), "tasks", "hello", "brief.md"));
  const brief = readFileSync(sent.task.briefPath, "utf8");
  assert.ok(brief.includes("only on files within this scope: hello.txt") && brief.endsWith("Create the file for hello.\n"), brief);

  const woke = await waitForNext(s.repo, { since: sent.cursor, timeoutMs: 30_000 });
  assert.deepEqual(woke, {
    kind: "events", cursor: ledgerSize(s.id),
    items: [{ task: "hello", status: "needs-review", candidate: "codex:gpt-6-luna@medium", detail: "", next: "review" }],
  });

  const accepted = accept(s, "hello") as { commit: string; cursor: number };
  assert.equal(accepted.cursor, woke.cursor);
  assert.equal(must(s.repo, "rev-list", "--count", `${base}..${GOAL}`), "1");
  assert.equal(must(s.repo, "rev-parse", GOAL), accepted.commit);
  assert.equal(must(s.repo, "show", "--name-only", "--format=", GOAL), "hello.txt");
  const raw = must(s.repo, "cat-file", "commit", accepted.commit);
  assert.equal(`${raw.slice(raw.indexOf("\n\n") + 2)}\n`, MESSAGE);
  assert.match(readFileSync(join(projectDir(s.id), "tasks", "hello", "accepted.patch"), "utf8"), /^diff --git a\/hello\.txt b\/hello\.txt$/m);
  assert.deepEqual([task(s, "hello").status, task(s, "hello").integratedCommit], ["integrating", accepted.commit]);

  const beforeConfirm = ledgerSize(s.id);
  assert.deepEqual(confirm(s.repo, "hello", s.file("confirm.md", "node --test on the goal branch: 1 passed\n")), { cursor: beforeConfirm });
  assert.equal(task(s, "hello").status, "accepted");
  assert.equal(must(s.repo, "branch", "--list", "wip/hello"), "");
  assert.equal(existsSync(sent.task.worktree!), false);
  assert.equal(must(s.repo, "rev-parse", GOAL), accepted.commit);
  const recorded = readEvents(s.id).items.flatMap((e) => (e.t === "verdict" ? [[e.verdict, e.seq, e.file?.path]] : []));
  const round = join(projectDir(s.id), "tasks", "hello", "rounds", "1");
  assert.deepEqual(recorded, [["accept", 1, join(round, "evidence-accept.md")], ["confirm", 1, join(round, "evidence-confirm.md")]]);
});

// Accept guards

test("accept commits only the tree the last review showed", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const { worktree } = reviewable(s, "hello", { "hello.txt": "hello\n" });
  const tip = must(s.repo, "rev-parse", GOAL);
  const unreviewed = () => verdictAccept(s.repo, "hello", s.file("evidence.md", "ok\n"), s.file("message.txt", MESSAGE), { allowTestIdentity: true });
  assert.throws(unreviewed, /^Error: task hello has no review on record; run mandor review hello first$/);
  refused(s, "hello", tip);
  reviewPack(s.repo, "hello");
  const pin = join(projectDir(s.id), "tasks", "hello", "reviewed.json");
  assert.equal(JSON.parse(readFileSync(pin, "utf8")).tree, must(worktree!, "write-tree"));
  // An edit after the review, a tracked file or an untracked one, is not what the review showed.
  writeFileSync(join(worktree!, "hello.txt"), "hello, changed after the review\n");
  assert.throws(unreviewed, /^Error: task hello changed since its last review; run mandor review hello again$/);
  refused(s, "hello", tip);
  reviewPack(s.repo, "hello");
  writeFileSync(join(worktree!, "extra.txt"), "x\n");
  assert.throws(unreviewed, /changed since its last review/);
  refused(s, "hello", tip);
  // Back to the reviewed content, the tree is the one on record again.
  rmSync(join(worktree!, "extra.txt"));
  const { commit } = unreviewed() as { commit: string };
  assert.equal(must(s.repo, "show", `${commit}:hello.txt`), "hello, changed after the review");
});

test("accept refuses AGENTS.md", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([{ stdout: "generated:done", writeFile: [{ path: "hello.txt", content: "hello\n" }, { path: "AGENTS.md", content: "Rules.\n" }] }]);
  send(s, "hello");
  await needsReview(s, "hello");
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "hello"), /agent-path: AGENTS\.md/);
  refused(s, "hello", tip);
});

test("accept refuses an attribution line hidden behind a worker .gitattributes -diff entry", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const trailer = `${["Co", "Authored", "By"].join("-")}: Someone <someone@example.invalid>`;
  const credit = ["Generated", "with", "Claude", "Code"].join(" ");
  writeScenarios([{
    stdout: "generated:done", writeFile: [
      { path: ".gitattributes", content: "notes.txt -diff\n" },
      { path: "notes.txt", content: `Notes.\n${trailer}\n` },
      { path: "nul.txt", content: `a\u0000b\n${credit}\n` },
    ],
  }]);
  const sent = send(s, "notes");
  await needsReview(s, "notes");
  // git's own patch shows both files as binary, with no added line for a guard to read.
  const binary = diffSinceBase(s.repo, sent.task.worktree!, sent.task.base!);
  assert.ok(!binary.includes(trailer) && !binary.includes(credit), binary);
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "notes"), (e: Error) => /attribution: notes\.txt: /.test(e.message) && /attribution: nul\.txt: /.test(e.message));
  refused(s, "notes", tip);
});

test("accept refuses a message file inside the repo", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([HELLO]);
  send(s, "hello");
  await needsReview(s, "hello");
  const tip = must(s.repo, "rev-parse", GOAL);
  const inside = join(s.repo, "message.txt");
  writeFileSync(inside, MESSAGE);
  assert.throws(() => verdictAccept(s.repo, "hello", s.file("evidence.md", "ok\n"), inside, { allowTestIdentity: true }), /inside the git working tree/);
  refused(s, "hello", tip);
});

test("accept refuses while another task is integrating", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([
    { stdout: "generated:done", writeFile: [{ path: "a.txt", content: "a\n" }] },
    { stdout: "generated:done", writeFile: [{ path: "b.txt", content: "b\n" }] },
  ]);
  send(s, "first");
  send(s, "second");
  await needsReview(s, "first");
  await needsReview(s, "second");
  const { commit } = accept(s, "first") as { commit: string };
  assert.throws(() => accept(s, "second"), /task first of goal feat\/slice is integrating/);
  assert.equal(must(s.repo, "rev-parse", GOAL), commit);
  assert.equal(task(s, "second").status, "needs-review");
});

test("accept refuses a dirty integration worktree", async (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  writeScenarios([HELLO]);
  send(s, "hello");
  await needsReview(s, "hello");
  const tip = must(s.repo, "rev-parse", GOAL);
  // Another branch at the same commit: the commit would land there and miss the goal.
  must(goal.integrationWorktree, "switch", "-q", "-c", "elsewhere");
  assert.throws(() => accept(s, "hello"), /integration worktree not clean/);
  must(goal.integrationWorktree, "switch", "-q", GOAL);
  writeFileSync(join(goal.integrationWorktree, "stray.txt"), "left by a proof run\n");
  assert.throws(() => accept(s, "hello"), /integration worktree not clean/);
  refused(s, "hello", tip);
});

test("accept refuses a cloned file and a link put in place of a clone path's directory", async (t) => {
  const s = setup(t);
  writeFileSync(join(s.repo, ".gitignore"), "out/gen/\n");
  must(s.repo, "add", ".gitignore");
  must(s.repo, "commit", "-q", "-m", "Ignore generated output");
  mkdirSync(join(s.repo, "out", "gen"), { recursive: true });
  writeFileSync(join(s.repo, "out", "gen", "x.txt"), "generated\n");
  saveProjectConfig(s.id, { ...emptyProjectConfig(), clone: ["out/gen"] });
  goalStart(s.repo, GOAL, null);
  // The worker stops ignoring the clone, so the cloned file shows up as its own addition.
  writeScenarios([{ stdout: "generated:done", writeFile: [{ path: ".gitignore", content: "" }] }, HELLO]);
  send(s, "unignore");
  await needsReview(s, "unignore");
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "unignore"), /denied-path: out\/gen\/x\.txt/);
  refused(s, "unignore", tip);

  const link = send(s, "link");
  await needsReview(s, "link");
  const out = join(link.task.worktree!, "out");
  rmSync(out, { recursive: true });
  symlinkSync(tmpdir(), out);
  assert.throws(() => accept(s, "link"), /denied-path: out$/m);
  assert.equal(must(s.repo, "rev-parse", GOAL), tip);
});

test("accept refuses a task with no changes", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([{ stdout: "generated:done" }]);
  send(s, "hello");
  await needsReview(s, "hello");
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "hello"), /task hello has no changes to accept/);
  refused(s, "hello", tip);
});

test("accept refuses a commit message that names the tool", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([HELLO]);
  send(s, "hello");
  await needsReview(s, "hello");
  const tip = must(s.repo, "rev-parse", GOAL);
  const message = s.file("named.txt", "Add hello.txt\n\nRun mandor wait to see it.\n");
  reviewPack(s.repo, "hello");
  assert.throws(() => verdictAccept(s.repo, "hello", s.file("evidence.md", "ok\n"), message, { allowTestIdentity: true }), /message: names the tool \(mandor wait\)/);
  refused(s, "hello", tip);
});

test("a commit a hook refuses leaves the integration worktree clean, and the accept can run again", async (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  writeScenarios([HELLO]);
  send(s, "hello");
  await needsReview(s, "hello");
  const tip = must(s.repo, "rev-parse", GOAL);
  const hook = join(s.repo, ".git", "hooks", "pre-commit");
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.throws(() => accept(s, "hello"), / failed in .*goal-feat__slice/);
  assert.equal(must(goal.integrationWorktree, "status", "--porcelain", "--untracked-files=all"), "");
  refused(s, "hello", tip);
  rmSync(hook);
  const { commit } = accept(s, "hello") as { commit: string };
  assert.equal(must(s.repo, "rev-parse", GOAL), commit);
});

test("confirm refuses a dirty integration worktree and empty evidence", async (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  writeScenarios([HELLO]);
  send(s, "hello");
  await needsReview(s, "hello");
  accept(s, "hello");
  const evidence = s.file("confirm.md", "node --test: 1 passed\n");
  const stray = join(goal.integrationWorktree, "stray.txt");
  writeFileSync(stray, "left by a proof run\n");
  assert.throws(() => confirm(s.repo, "hello", evidence), /integration worktree not clean/);
  rmSync(stray);
  assert.throws(() => confirm(s.repo, "hello", s.file("blank.md", " \n")), /evidence file .* is empty/);
  assert.throws(() => confirm(s.repo, "hello", join(s.repo, "README.md")), /inside the git working tree/);
  assert.equal(task(s, "hello").status, "integrating");
  confirm(s.repo, "hello", evidence);
  assert.equal(task(s, "hello").status, "accepted");
});

test("accept refuses attribution in UTF-16 text and beside a NUL byte", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const trailer = `${["Co", "Authored", "By"].join("-")}: Someone <someone@example.invalid>`;
  const credit = ["Generated", "with", "Claude", "Code"].join(" ");
  const utf16le = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const utf16be = (text: string) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
  const files = {
    "nul-trailer.txt": `${trailer.replace("-", "\0-")}\n`,
    "nul-credit.txt": `${credit.split(" ").join(" \0")}\n`,
    "le-trailer.txt": utf16le(`Notes\n${trailer}\n`),
    "le-credit.md": utf16le(`${credit}\n`),
    "be-credit.md": utf16be(`${credit}\n`),
  };
  reviewable(s, "hidden", files);
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "hidden"), (e: Error) => {
    for (const path of Object.keys(files)) assert.ok(e.message.includes(`attribution: ${path}: `), `${path} in ${e.message}`);
    return true;
  });
  refused(s, "hidden", tip);
});

test("accept reads and applies one staged state, whatever a process left in the worktree does in between", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const trailer = `${["Co", "Authored", "By"].join("-")}: Someone <someone@example.invalid>`;
  const { worktree } = reviewable(s, "flip", { "notes.txt": `notes\n${trailer}\n` });
  const tip = must(s.repo, "rev-parse", GOAL);
  reviewPack(s.repo, "flip");
  const notes = join(worktree!, "notes.txt");
  // After the patch is read the file turns clean: two stages would commit the first read and show the guards the second.
  const path = process.env.PATH;
  process.env.PATH = wrappedGit(`"$REAL" "$@"\ncode=$?\ncase "$*" in *--binary*) echo notes > "${notes}";; esac\nexit $code`);
  t.after(() => {
    process.env.PATH = path;
  });
  assert.throws(() => verdictAccept(s.repo, "flip", s.file("evidence.md", "ok\n"), s.file("message.txt", MESSAGE), { allowTestIdentity: true }), /attribution: notes\.txt/);
  process.env.PATH = path;
  refused(s, "flip", tip);
});

test("accept reads one tree, whatever rewrites the task's index between the patch and the text", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const trailer = `${["Co", "Authored", "By"].join("-")}: Someone <someone@example.invalid>`;
  const { worktree } = reviewable(s, "flip", { "notes.txt": `notes\n${trailer}\n` });
  const tip = must(s.repo, "rev-parse", GOAL);
  reviewPack(s.repo, "flip");
  const notes = join(worktree!, "notes.txt");
  // Right after the patch is read, the index gets the clean form through a plain git add in the worktree.
  const path = process.env.PATH;
  process.env.PATH = wrappedGit(`"$REAL" "$@"\ncode=$?\ncase "$*" in *--binary*) echo notes > "${notes}"; ( unset GIT_DIR GIT_WORK_TREE; cd "${worktree}" && "$REAL" add notes.txt );; esac\nexit $code`);
  t.after(() => {
    process.env.PATH = path;
  });
  assert.throws(() => verdictAccept(s.repo, "flip", s.file("evidence.md", "ok\n"), s.file("message.txt", MESSAGE), { allowTestIdentity: true }), /attribution: notes\.txt/);
  process.env.PATH = path;
  refused(s, "flip", tip);
});

test("accept refuses default-denied and project-denied paths", (t) => {
  const s = setup(t);
  saveProjectConfig(s.id, { ...emptyProjectConfig(), deny: ["secret/**"] });
  goalStart(s.repo, GOAL, null);
  reviewable(s, "dotenv", { ".env": "TOKEN=1\n" });
  reviewable(s, "keyed", { "secret/key.txt": "k\n" });
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "dotenv"), /denied-path: \.env/);
  assert.throws(() => accept(s, "keyed"), /denied-path: secret\/key\.txt/);
  assert.equal(must(s.repo, "rev-parse", GOAL), tip);
  // A message that names a denied path is refused too.
  reviewable(s, "named", { "hello.txt": "hello\n" });
  reviewPack(s.repo, "named");
  for (const message of ["Add secret/key.txt\n", "Move notes into _docs/plan.md\n"]) {
    assert.throws(() => verdictAccept(s.repo, "named", s.file("evidence.md", "ok\n"), s.file("named.txt", message), { allowTestIdentity: true }), /message: denied path/);
  }
  assert.equal(must(s.repo, "rev-parse", GOAL), tip);
});

test("accept judges a symlink by where it leads", (t) => {
  const s = setup(t);
  writeFileSync(join(s.repo, ".gitignore"), "a/b/c/\n");
  must(s.repo, "add", ".gitignore");
  must(s.repo, "commit", "-q", "-m", "Ignore generated output");
  saveProjectConfig(s.id, { ...emptyProjectConfig(), clone: ["a/b/c"] });
  goalStart(s.repo, GOAL, null);
  const { worktree } = reviewable(s, "linked", {});
  mkdirSync(join(worktree!, "sub"));
  symlinkSync("../a/b/c/gen.txt", join(worktree!, "sub", "gen-link"));
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "linked"), /denied-path: sub\/gen-link -> \.\.\/a\/b\/c\/gen\.txt/);
  refused(s, "linked", tip);
});

test("accept commits a Latin-1 file and a binary file byte for byte", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const latin = Buffer.from("caf\xe9\n", "latin1");
  const binary = Buffer.from([0, 1, 2, 255, 254, 0, 10]);
  reviewable(s, "bytes", { "latin1.txt": latin, "data.bin": binary });
  const { commit } = accept(s, "bytes") as { commit: string };
  const blob = (path: string) => execFileSync("git", ["show", `${commit}:${path}`], { cwd: s.repo });
  assert.deepEqual([blob("latin1.txt"), blob("data.bin")], [latin, binary]);
  assert.deepEqual(readFileSync(join(projectDir(s.id), "tasks", "bytes", "accepted.patch")).includes(Buffer.from("+caf\xe9\n", "latin1")), true);
});

test("accept refuses a task with an open job", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  appendEvent(s.id, { t: "job.started", at: now(), job: { id: "j-20261108100000-abcd", taskId: "hello", seq: 2, kind: "resume", candidate: LUNA } });
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "hello"), /task hello has a queued or running job/);
  refused(s, "hello", tip);
});

test("accept takes a task in takeover", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" }, { status: "takeover" });
  const { commit } = accept(s, "hello") as { commit: string };
  assert.deepEqual([task(s, "hello").status, task(s, "hello").integratedCommit], ["integrating", commit]);
});

test("accept, plan set and dispatch refuse files inside the repository", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const inside = join(s.repo, "inside.md");
  writeFileSync(inside, "x\n");
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const tip = must(s.repo, "rev-parse", GOAL);
  const before = ledgerSize(s.id);
  assert.throws(() => planSet(s.repo, GOAL, inside, "Say hello"), /inside the git working tree/);
  assert.throws(() => send(s, "x", { briefFile: inside, use: null }), /inside the git working tree/);
  assert.throws(() => verdictAccept(s.repo, "hello", inside, s.file("message.txt", MESSAGE), { allowTestIdentity: true }), /inside the git working tree/);
  assert.equal(ledgerSize(s.id), before);
  refused(s, "hello", tip);
});

test("accept refuses a driver configured since dispatch, before it can run", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n", ".gitattributes": "hello.txt filter=x\n" });
  const ran = join(s.home, "driver-ran");
  const script = join(s.home, "clean.sh");
  writeFileSync(script, `#!/bin/sh\ntouch "${ran}"\ncat\n`, { mode: 0o755 });
  must(s.repo, "config", "filter.x.clean", script);
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "hello"), /filter\.x\.clean/);
  assert.equal(existsSync(ran), false);
  refused(s, "hello", tip);
});

test("confirm refuses a driver configured since dispatch, before git reads the integration worktree", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n", ".gitattributes": "hello.txt filter=x\n" });
  accept(s, "hello");
  const ran = join(s.home, "driver-ran");
  const script = join(s.home, "clean.sh");
  writeFileSync(script, `#!/bin/sh\ntouch "${ran}"\ncat\n`, { mode: 0o755 });
  must(s.repo, "config", "filter.x.clean", script);
  // git status compares the content of a file whose timestamp the index does not hold, and so runs its clean filter.
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(goal.integrationWorktree, "hello.txt"), later, later);
  assert.throws(() => confirm(s.repo, "hello", s.file("c.md", "ok\n")), /filter\.x\.clean/);
  assert.equal(existsSync(ran), false);
  assert.equal(task(s, "hello").status, "integrating");
});

// A repository that keeps its hooks in a tracked directory, as husky does: core.hooksPath names it (in the spelling
// `configured`, by default the directory's own) and its pre-commit hook leaves a marker when it runs.
function trackedHooks(s: Slice, dir = ".hooks", configured = dir): string {
  const ran = join(s.home, "hook-ran");
  mkdirSync(join(s.repo, dir));
  writeFileSync(join(s.repo, dir, "pre-commit"), `#!/bin/sh\ntouch "${ran}"\n`, { mode: 0o755 });
  must(s.repo, "add", dir);
  must(s.repo, "commit", "-qm", "Add the hooks");
  must(s.repo, "config", "core.hooksPath", configured);
  return ran;
}

test("the hooks-directory refusal compares a path as APFS does: another case of the directory's name is the same directory", (t) => {
  const s = setup(t);
  // The hooks directory is configured but not yet in the tree, as a repository that has not committed its hooks: a
  // worker can then create it under another case, and on APFS git runs the hooks from there.
  must(s.repo, "config", "core.hooksPath", ".hooks");
  goalStart(s.repo, GOAL, null);
  const tip = must(s.repo, "rev-parse", GOAL);
  const planted = join(temp("marks-"), "planted-hook-ran");
  for (const [slug, path] of [["upper", ".Hooks/pre-commit"], ["deep", ".HOOKS/sub/x"]] as const) {
    const { worktree } = reviewable(s, slug, { [path]: `#!/bin/sh\ntouch "${planted}"\n`, "hello.txt": `${slug}\n` });
    chmodSync(join(worktree!, path), 0o755);
    assert.throws(() => accept(s, slug), (e: Error) => e.message.includes("core.hooksPath .hooks is inside the worktree") && e.message.includes(`"${path}"`), path);
    assert.equal(existsSync(planted), false, `${path}: the planted hook never ran`);
    refused(s, slug, tip);
  }
  reviewable(s, "plain", { "tools/x": "x\n" });
  const { commit } = accept(s, "plain") as { commit: string };
  assert.equal(must(s.repo, "rev-parse", GOAL), commit, "a change elsewhere commits");
});

test("the hooks-directory refusal follows an absolute hooks path through a symlinked prefix of the worktree", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  // The worktree's path, spelled through a link to the home: the same directory by another route, as /tmp is for
  // /private/tmp.
  const link = join(temp("mandor-link-"), "home");
  symlinkSync(s.home, link);
  const hooksPath = join(link, relative(s.home, goal.integrationWorktree), ".hooks");
  assert.notEqual(hooksPath, join(goal.integrationWorktree, ".hooks"));
  must(s.repo, "config", "core.hooksPath", hooksPath);
  const planted = join(temp("marks-"), "planted-hook-ran");
  const { worktree } = reviewable(s, "hooked", { ".hooks/pre-commit": `#!/bin/sh\ntouch "${planted}"\n`, "hello.txt": "hello\n" });
  chmodSync(join(worktree!, ".hooks", "pre-commit"), 0o755);
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "hooked"), /is inside the worktree and the staged changes touch \["\.hooks\/pre-commit"\]/);
  assert.equal(existsSync(planted), false, "the planted hook never ran");
  refused(s, "hooked", tip);
});

test("the hooks-directory refusal reads a normalization variant of the directory's name as the same directory", (t) => {
  const s = setup(t);
  const ran = trackedHooks(s, ".hooksé"); // precomposed on disk and in the index
  // Decomposed in the config: written to the file, as git precomposes a value given on its command line on macOS.
  appendFileSync(join(s.repo, ".git", "config"), "[core]\n\thooksPath = .hooksé\n");
  assert.equal(must(s.repo, "config", "--get", "core.hooksPath"), ".hooksé");
  goalStart(s.repo, GOAL, null);
  const planted = join(temp("marks-"), "planted-hook-ran");
  const { worktree } = reviewable(s, "hooked", { ".hooksé/pre-commit": `#!/bin/sh\ntouch "${planted}"\n` });
  chmodSync(join(worktree!, ".hooksé", "pre-commit"), 0o755);
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "hooked"), /core\.hooksPath \S+ is inside the worktree and the staged changes touch/);
  assert.deepEqual([existsSync(planted), existsSync(ran)], [false, false], "no hook ran");
  refused(s, "hooked", tip);
});

test("accept refuses a change under the repository's hooks directory, and runs the repository's own hook otherwise", (t) => {
  const s = setup(t);
  const ran = trackedHooks(s);
  const { goal } = goalStart(s.repo, GOAL, null);
  // Outside the worktree, which the refused accept resets, so the mark shows whether the planted hook ran.
  const planted = join(temp("marks-"), "planted-hook-ran");
  const { worktree } = reviewable(s, "hooked", { ".hooks/pre-commit": `#!/bin/sh\ntouch "${planted}"\n`, "hello.txt": "hello\n" });
  chmodSync(join(worktree!, ".hooks", "pre-commit"), 0o755);
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "hooked"), /refusing to commit in .*: core\.hooksPath \.hooks is inside the worktree and the staged changes touch \["\.hooks\/pre-commit"\]/);
  assert.deepEqual([existsSync(planted), existsSync(ran)], [false, false], "no hook ran");
  refused(s, "hooked", tip);
  assert.equal(must(goal.integrationWorktree, "status", "--porcelain", "--untracked-files=all"), "", "the applied patch was reset");
  // A change elsewhere commits through the repository's own hook.
  reviewable(s, "plain", { "hello.txt": "hello\n" });
  const { commit } = accept(s, "plain") as { commit: string };
  assert.equal(must(s.repo, "rev-parse", GOAL), commit);
  assert.deepEqual([existsSync(planted), existsSync(ran)], [false, true], "the repository's hook ran, the planted one never did");
});

test("a relative core.fsmonitor command is not run by the commit", (t) => {
  const s = setup(t);
  const ran = join(s.home, "fsmonitor-ran");
  writeFileSync(join(s.repo, "fsmon.sh"), `#!/bin/sh\ntouch "${ran}"\nexit 1\n`, { mode: 0o755 });
  must(s.repo, "add", "fsmon.sh");
  must(s.repo, "commit", "-qm", "Add the monitor");
  goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  // Set once the worktrees exist, so only the accept's own git calls could run it.
  must(s.repo, "config", "core.fsmonitor", "./fsmon.sh");
  const { commit } = accept(s, "hello") as { commit: string };
  assert.equal(must(s.repo, "rev-parse", GOAL), commit);
  assert.equal(existsSync(ran), false, "the monitor command never ran");
});

test("accept refuses, before it commits, an event too long for the ledger", (t) => {
  const s = setup(t);
  // Only characters JSON escapes can reach the limit: here in the path of the evidence file and in its excerpt.
  const home = join(s.home, "\u0001".repeat(200), "\u0001".repeat(200));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  process.env.MANDOR_HOME = home;
  writeTestConfig(home);
  goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const tip = must(s.repo, "rev-parse", GOAL);
  assert.throws(() => accept(s, "hello", "\u0001".repeat(300)), /ledger line of \d+ bytes exceeds 4096/);
  refused(s, "hello", tip);
  assert.equal(existsSync(intentOf(s)), false);
});

test("a reset that fails after a refused commit keeps the commit's error, and the next accept finishes the job", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const tip = must(s.repo, "rev-parse", GOAL);
  // The hook refuses the commit and leaves a lock that stops the reset behind it.
  hook(s.repo, "pre-commit", 'touch "$GIT_DIR/index.lock"; exit 1');
  assert.throws(() => accept(s, "hello"), (e: Error) => {
    assert.match(e.message, / commit .* failed in /s);
    assert.doesNotMatch(e.message, /reset/);
    return true;
  });
  assert.match(readFileSync(join(s.home, "logs", "runner.log"), "utf8"), /accept of hello: reset after a failed commit: .* read-tree --reset -u HEAD/);
  assert.equal(existsSync(intentOf(s)), true);
  refused(s, "hello", tip);

  unhook(s.repo, "pre-commit");
  rmSync(join(s.repo, ".git", "worktrees", "goal-feat__slice", "index.lock"));
  const { commit } = accept(s, "hello") as { commit: string };
  assert.equal(must(s.repo, "rev-parse", GOAL), commit);
  assert.equal(must(goal.integrationWorktree, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(existsSync(intentOf(s)), false);
});

test("a commit that fails because another landed keeps the marker, and the next accept adopts what landed", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const tip = must(s.repo, "rev-parse", GOAL);
  // What a commit left running by a killed accept does to the one after it: it lands first, with the same staged tree.
  hook(s.repo, "pre-commit", 'git commit -q --no-verify -m "Add hello.txt"; exit 1');
  assert.throws(() => accept(s, "hello"), / failed in /);
  const landed = must(s.repo, "rev-parse", GOAL);
  assert.notEqual(landed, tip);
  assert.deepEqual([task(s, "hello").status, existsSync(intentOf(s)), verdicts(s)], ["needs-review", true, []]);
  unhook(s.repo, "pre-commit");
  assert.equal((accept(s, "hello") as { commit: string }).commit, landed);
  assert.deepEqual([task(s, "hello").status, task(s, "hello").integratedCommit, existsSync(intentOf(s)), verdicts(s)], ["integrating", landed, false, ["hello:accept"]]);
  assert.equal(must(s.repo, "rev-list", "--count", `${tip}..${GOAL}`), "1");
});

// A killed accept

// What accept writes before it commits, by hand, with the integration worktree's next commit made the same way.
function orphanCommit(s: Slice, integration: string, slug: string, file: string, message = MESSAGE, env: Record<string, string> = {}): { tip: string; tree: string; commit: string } {
  const tip = must(integration, "rev-parse", "HEAD");
  writeFileSync(join(integration, file), `${file}\n`);
  must(integration, "add", file);
  const tree = must(integration, "write-tree");
  writeJsonAtomic(intentOf(s), { slug, tip, tree });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: integration, stdio: "pipe", env: { ...process.env, ...env } });
  return { tip, tree, commit: must(integration, "rev-parse", "HEAD") };
}

test("an accept killed alone during a slow pre-commit hook is adopted from the commit its orphan lands", async (t) => {
  const s = setup(t);
  must(s.repo, "config", "user.email", "dev@host.test");
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const tip = must(s.repo, "rev-parse", GOAL);
  const [entered, release] = [join(s.home, "hook-entered"), join(s.home, "hook-release")];
  // Bounded, so a retry that wrongly runs this hook too, with this test blocked on it, fails instead of hanging.
  hook(s.repo, "pre-commit", `touch "${entered}"; i=0; while [ ! -e "${release}" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done`);
  const before = ledgerSize(s.id);
  reviewPack(s.repo, "hello");
  const args = ["verdict", "hello", "accept", "--evidence-file", s.file("e.md", "node --test: 1 passed\n"), "--message-file", s.file("m.txt", MESSAGE)];
  const c = detached(s, t, args);
  t.after(() => writeFileSync(release, ""));
  assert.ok(await until(() => existsSync(entered)), "the commit reaches its hook");
  kill(c.pid!);
  await ended(c);

  // The orphan git is inside its hook, where it holds no lock: only its command line shows it is still there.
  assert.equal(existsSync(join(s.repo, ".git", "worktrees", "goal-feat__slice", "index.lock")), false);
  const early = cli(s, ...args);
  assert.equal(early.status, 1, early.stderr);
  const named = /an earlier accept is still finishing; retry shortly \(git pid (\d+)\)/.exec(early.stderr);
  assert.ok(named !== null, early.stderr);
  assert.match(execFileSync("/bin/ps", ["-o", "command=", "-p", named[1]], { encoding: "utf8" }), / commit /, "the pid is the orphan git's");
  assert.equal(must(s.repo, "rev-parse", GOAL), tip);

  writeFileSync(release, "");
  assert.ok(await until(() => must(s.repo, "rev-parse", GOAL) !== tip), "the orphan's commit lands");
  let again = cli(s, ...args);
  assert.ok(await until(() => {
    if (again.status === 0) return true;
    again = cli(s, ...args);
    return again.status === 0;
  }), again.stderr);
  const commit = must(s.repo, "rev-parse", GOAL);
  assert.deepEqual(again.json, { commit, cursor: before });
  assert.equal(must(s.repo, "rev-list", "--count", `${tip}..${GOAL}`), "1");
  assert.deepEqual(verdicts(s), ["hello:accept"]);
  assert.deepEqual([task(s, "hello").status, task(s, "hello").integratedCommit, existsSync(intentOf(s))], ["integrating", commit, false]);
  const verdict = readEvents(s.id).items.find((e) => e.t === "verdict");
  assert.equal(verdict?.t === "verdict" && verdict.file?.path, join(projectDir(s.id), "tasks", "hello", "rounds", "1", "evidence-accept.md"));
  assert.equal(must(goal.integrationWorktree, "status", "--porcelain", "--untracked-files=all"), "");
  confirm(s.repo, "hello", s.file("c.md", "ok\n"));
  assert.equal(task(s, "hello").status, "accepted");
});

test("an accept killed with its whole group during a slow pre-commit hook is reset and done over", async (t) => {
  const s = setup(t);
  must(s.repo, "config", "user.email", "dev@host.test");
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const tip = must(s.repo, "rev-parse", GOAL);
  const entered = join(s.home, "hook-entered");
  hook(s.repo, "pre-commit", `touch "${entered}"; exec sleep 30`);
  reviewPack(s.repo, "hello");
  const args = ["verdict", "hello", "accept", "--evidence-file", s.file("e.md", "ok\n"), "--message-file", s.file("m.txt", MESSAGE)];
  const c = detached(s, t, args);
  assert.ok(await until(() => existsSync(entered)), "the commit reaches its hook");
  kill(-c.pid!);
  await ended(c);
  assert.equal(must(goal.integrationWorktree, "status", "--porcelain"), "A  hello.txt", "the change stays staged");
  unhook(s.repo, "pre-commit");
  const again = cli(s, ...args);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(must(s.repo, "rev-list", "--count", `${tip}..${GOAL}`), "1");
  assert.deepEqual([again.json.commit, verdicts(s), task(s, "hello").status, existsSync(intentOf(s))], [must(s.repo, "rev-parse", GOAL), ["hello:accept"], "integrating", false]);
});

test("an accept killed between its apply and its tree record is undone and done over", async (t) => {
  const s = setup(t);
  must(s.repo, "config", "user.email", "dev@host.test");
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const tip = must(s.repo, "rev-parse", GOAL);
  const atTree = join(s.home, "at-tree");
  // Parks the integration worktree's first write-tree, which comes right after the apply.
  const path = wrappedGit(`case "$*:$GIT_WORK_TREE" in *write-tree*goal-*) touch "${atTree}"; exec sleep 30;; esac\nexec "$REAL" "$@"`);
  reviewPack(s.repo, "hello");
  const args = ["verdict", "hello", "accept", "--evidence-file", s.file("e.md", "ok\n"), "--message-file", s.file("m.txt", MESSAGE)];
  const c = detached(s, t, args, { ...process.env, PATH: path });
  assert.ok(await until(() => existsSync(atTree)), "the accept applies its patch");
  kill(-c.pid!);
  await ended(c);
  assert.equal(must(goal.integrationWorktree, "status", "--porcelain"), "A  hello.txt", "the change stays staged");
  assert.deepEqual(JSON.parse(readFileSync(intentOf(s), "utf8")), { slug: "hello", tip });
  const again = cli(s, ...args);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(must(s.repo, "rev-list", "--count", `${tip}..${GOAL}`), "1");
  assert.deepEqual([again.json.commit, verdicts(s), task(s, "hello").status, existsSync(intentOf(s))], [must(s.repo, "rev-parse", GOAL), ["hello:accept"], "integrating", false]);
});

for (const [shape, leave] of [["another branch", ["-c", "rescue"]], ["a detached HEAD", ["--detach"]]] as const) {
  test(`an orphan's commit on ${shape} is not adopted, as the goal branch would never get the change`, (t) => {
    const s = setup(t);
    const { goal } = goalStart(s.repo, GOAL, null);
    reviewable(s, "hello", { "hello.txt": "hello\n" });
    const integration = goal.integrationWorktree;
    const tip = must(integration, "rev-parse", "HEAD");
    writeFileSync(join(integration, "hello.txt"), "hello\n");
    must(integration, "add", "hello.txt");
    writeJsonAtomic(intentOf(s), { slug: "hello", tip, tree: must(integration, "write-tree") });
    must(integration, "switch", "-q", ...leave);
    must(integration, "commit", "-q", "-m", MESSAGE);
    const head = must(integration, "rev-parse", "HEAD");
    assert.throws(() => accept(s, "hello"), (e: Error) => {
      for (const part of [head, GOAL, intentOf(s)]) assert.ok(e.message.includes(part), `${part} in ${e.message}`);
      return true;
    });
    refused(s, "hello", tip);
    assert.equal(existsSync(intentOf(s)), true);
  });
}

test("a marker does not reset a worktree whose HEAD is at the marker's tip while the goal branch has moved", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const integration = goal.integrationWorktree;
  const tip = must(integration, "rev-parse", "HEAD");
  writeJsonAtomic(intentOf(s), { slug: "hello", tip });
  must(integration, "switch", "-q", "--detach");
  writeFileSync(join(integration, "staged.txt"), "kept\n");
  must(integration, "add", "staged.txt");
  must(s.repo, "update-ref", `refs/heads/${GOAL}`, must(s.repo, "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "Moved"));
  assert.throws(() => accept(s, "hello"), (e: Error) => e.message.includes(GOAL) && e.message.includes(intentOf(s)));
  assert.equal(must(integration, "status", "--porcelain"), "A  staged.txt", "nothing was reset");
  assert.equal(existsSync(intentOf(s)), true);
});

test("an orphan's commit is adopted only with the author and committer the repository would write", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const integration = goal.integrationWorktree;
  const tip = must(integration, "rev-parse", "HEAD");
  const cases: [Record<string, string>, string][] = [
    [{ GIT_AUTHOR_EMAIL: "you@example.com" }, "you@example.com"],
    [{ GIT_COMMITTER_EMAIL: "you@example.com" }, "you@example.com"],
    [{ GIT_AUTHOR_EMAIL: "someone@host.test" }, "someone@host.test"],
    [{ GIT_COMMITTER_EMAIL: "someone@host.test" }, "someone@host.test"],
  ];
  for (const [env, shown] of cases) {
    must(integration, "reset", "-q", "--hard", tip);
    orphanCommit(s, integration, "hello", "other.txt", MESSAGE, env);
    assert.throws(() => accept(s, "hello"), (e: Error) => {
      for (const part of [shown, intentOf(s)]) assert.ok(e.message.includes(part), `${part} in ${e.message}`);
      return true;
    });
    assert.deepEqual([task(s, "hello").status, verdicts(s), existsSync(intentOf(s))], ["needs-review", [], true]);
  }
  // With the repository's own identity it is the same commit that adoption takes.
  must(integration, "reset", "-q", "--hard", tip);
  const { commit } = orphanCommit(s, integration, "hello", "other.txt");
  assert.equal((accept(s, "hello") as { commit: string }).commit, commit);
});

test("through the CLI, adoption refuses a placeholder identity and a test identity alike", (t) => {
  const s = setup(t);
  must(s.repo, "config", "user.email", "dev@host.test");
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const integration = goal.integrationWorktree;
  const tip = must(integration, "rev-parse", "HEAD");
  const args = ["verdict", "hello", "accept", "--evidence-file", s.file("e.md", "ok\n"), "--message-file", s.file("m.txt", MESSAGE)];
  orphanCommit(s, integration, "hello", "other.txt", MESSAGE, { GIT_AUTHOR_EMAIL: "you@example.com", GIT_COMMITTER_EMAIL: "you@example.com" });
  const placeholder = cli(s, ...args);
  assert.equal(placeholder.status, 1, placeholder.stderr);
  assert.ok(placeholder.stderr.includes("you@example.com") && placeholder.stderr.includes(intentOf(s)), placeholder.stderr);
  assert.equal(task(s, "hello").status, "needs-review");
  // Only an in-process caller can allow a test identity, here as anywhere.
  must(integration, "reset", "-q", "--hard", tip);
  must(s.repo, "config", "user.email", "test@example.invalid");
  orphanCommit(s, integration, "hello", "other.txt");
  const test_ = cli(s, ...args);
  assert.equal(test_.status, 1, test_.stderr);
  assert.ok(test_.stderr.includes("is a placeholder") && test_.stderr.includes(intentOf(s)), test_.stderr);
  assert.deepEqual([task(s, "hello").status, verdicts(s)], ["needs-review", []]);
});

test("accept takes the identity git would commit with, even when user.email is unset", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  // author.* and committer.* decide a commit's identity before user.* does.
  must(s.repo, "config", "--unset", "user.email");
  for (const who of ["author", "committer"]) {
    must(s.repo, "config", `${who}.name`, "Dev");
    must(s.repo, "config", `${who}.email`, "dev@host.test");
  }
  reviewPack(s.repo, "hello");
  const { commit } = verdictAccept(s.repo, "hello", s.file("evidence.md", "ok\n"), s.file("message.txt", MESSAGE)) as { commit: string };
  assert.equal(must(s.repo, "log", "-1", "--format=%ae|%ce", commit), "dev@host.test|dev@host.test");
  assert.equal(task(s, "hello").status, "integrating");
});

test("accept refuses a placeholder commit identity before it writes anything", (t) => {
  const s = setup(t);
  must(s.repo, "config", "user.email", "dev@host.test");
  goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const tip = must(s.repo, "rev-parse", GOAL);
  // user.email is real, but the address a commit would carry as its author is not.
  must(s.repo, "config", "author.email", "you@example.com");
  reviewPack(s.repo, "hello");
  assert.throws(() => verdictAccept(s.repo, "hello", s.file("evidence.md", "ok\n"), s.file("message.txt", MESSAGE)), /GIT_AUTHOR_IDENT email "you@example\.com" is a placeholder/);
  refused(s, "hello", tip);
  const dir = join(projectDir(s.id), "tasks", "hello");
  assert.deepEqual([existsSync(join(dir, "accepted.patch")), existsSync(join(dir, "rounds", "1", "evidence-accept.md")), existsSync(intentOf(s))], [false, false, false]);
});

test("a held index.lock makes the next accept wait", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const tip = must(s.repo, "rev-parse", GOAL);
  writeJsonAtomic(intentOf(s), { slug: "hello", tip });
  const lock = join(s.repo, ".git", "worktrees", "goal-feat__slice", "index.lock");
  writeFileSync(lock, "");
  assert.throws(() => accept(s, "hello"), (e: Error) => {
    assert.match(e.message, /an earlier accept is still finishing; retry shortly/);
    assert.ok(e.message.includes(lock), e.message);
    return true;
  });
  refused(s, "hello", tip);
  rmSync(lock);
  const { commit } = accept(s, "hello") as { commit: string };
  assert.equal(must(goal.integrationWorktree, "rev-parse", "HEAD"), commit);
  assert.equal(existsSync(intentOf(s)), false);
});

test("a marker that matches nothing it can explain stops every accept of the goal, naming the state and the marker", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const { commit, tree } = orphanCommit(s, goal.integrationWorktree, "hello", "other.txt");
  // HEAD has moved past the commit with the same tree, so only its parent differs from what the marker says.
  must(goal.integrationWorktree, "commit", "-q", "--allow-empty", "-m", "Move on");
  const head = must(goal.integrationWorktree, "rev-parse", "HEAD");
  assert.throws(() => accept(s, "hello"), (e: Error) => {
    assert.ok(e.message.includes(head) && e.message.includes(intentOf(s)), e.message);
    return true;
  });
  assert.equal(existsSync(intentOf(s)), true);
  assert.equal(task(s, "hello").status, "needs-review");
  // One commit on the tip, but not with the tree the marker recorded.
  must(goal.integrationWorktree, "reset", "-q", "--hard", commit);
  writeJsonAtomic(intentOf(s), { slug: "hello", tip: must(goal.integrationWorktree, "rev-parse", "HEAD~1"), tree: `${tree.slice(0, -1)}${tree.endsWith("0") ? "1" : "0"}` });
  assert.throws(() => accept(s, "hello"), (e: Error) => e.message.includes(intentOf(s)));
  assert.deepEqual(verdicts(s), []);
});

test("an orphan's commit whose message fails the guards is not adopted", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  // A hook of the user's can rewrite the message, which a commit the lead waited for would have caught.
  orphanCommit(s, goal.integrationWorktree, "hello", "other.txt", `Add other.txt\n\n${["Co", "Authored", "By"].join("-")}: Someone <someone@example.invalid>\n`);
  assert.throws(() => accept(s, "hello"), (e: Error) => {
    assert.match(e.message, /attribution/);
    assert.ok(e.message.includes(intentOf(s)), e.message);
    return true;
  });
  assert.equal(task(s, "hello").status, "needs-review");
  assert.deepEqual(verdicts(s), []);
});

test("a task the orphan's commit belongs to is adopted first, then the accept of another task goes on", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "first", { "first.txt": "first\n" });
  reviewable(s, "second", { "second.txt": "second\n" });
  const before = ledgerSize(s.id);
  const { commit } = orphanCommit(s, goal.integrationWorktree, "first", "other.txt");
  assert.throws(() => accept(s, "second"), /task first of goal feat\/slice is integrating/);
  assert.deepEqual([task(s, "first").status, task(s, "first").integratedCommit, existsSync(intentOf(s))], ["integrating", commit, false]);
  assert.equal(task(s, "second").status, "needs-review");
  assert.deepEqual(verdicts(s), ["first:accept"]);
  assert.ok(ledgerSize(s.id) > before);
});

test("adoption appends only what the killed accept had not, and answers with the cursor from before it", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const { commit } = orphanCommit(s, goal.integrationWorktree, "hello", "other.txt");
  // Killed right after the verdict was appended.
  appendEvent(s.id, { t: "verdict", at: now(), taskId: "hello", verdict: "accept", seq: 1, file: null });
  const before = ledgerSize(s.id);
  assert.deepEqual(accept(s, "hello"), { commit, cursor: before });
  assert.deepEqual(verdicts(s), ["hello:accept"]);
  assert.deepEqual([task(s, "hello").status, task(s, "hello").integratedCommit, existsSync(intentOf(s))], ["integrating", commit, false]);

  // Killed after both lines, with only the marker left to remove: the same answer, and no new line.
  const { tip, tree } = { tip: must(goal.integrationWorktree, "rev-parse", "HEAD~1"), tree: must(goal.integrationWorktree, "rev-parse", "HEAD^{tree}") };
  writeJsonAtomic(intentOf(s), { slug: "hello", tip, tree });
  const size = ledgerSize(s.id);
  assert.deepEqual(accept(s, "hello"), { commit, cursor: size });
  assert.equal(ledgerSize(s.id), size);
  assert.equal(existsSync(intentOf(s)), false);
});

test("an orphan's commit is not adopted for a task that has moved on", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" }, { status: "working" });
  orphanCommit(s, goal.integrationWorktree, "hello", "other.txt");
  assert.throws(() => accept(s, "hello"), (e: Error) => /task hello is working/.test(e.message) && e.message.includes(intentOf(s)));
  assert.deepEqual([task(s, "hello").status, verdicts(s)], ["working", []]);
});

// Confirm

test("confirm refuses HEAD past the integrated commit", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const { commit } = accept(s, "hello") as { commit: string };
  // Off the goal branch, HEAD moves while the goal stays where accept put it.
  must(goal.integrationWorktree, "switch", "-q", "--detach");
  must(goal.integrationWorktree, "commit", "-q", "--allow-empty", "-m", "Extra");
  assert.equal(must(s.repo, "rev-parse", GOAL), commit);
  assert.throws(() => confirm(s.repo, "hello", s.file("c.md", "ok\n")), /integration worktree not clean/);
  // On it, the two move together.
  must(goal.integrationWorktree, "switch", "-q", GOAL);
  must(goal.integrationWorktree, "commit", "-q", "--allow-empty", "-m", "Extra");
  assert.throws(() => confirm(s.repo, "hello", s.file("c.md", "ok\n")), /integration worktree not clean/);
  assert.equal(task(s, "hello").status, "integrating");
});

test("confirm refuses when the goal branch is not at HEAD", (t) => {
  const s = setup(t);
  const { goal } = goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  const tip = must(s.repo, "rev-parse", GOAL);
  const { commit } = accept(s, "hello") as { commit: string };
  // HEAD still names the integrated commit, but the goal branch does not have it.
  must(goal.integrationWorktree, "switch", "-q", "--detach");
  must(s.repo, "update-ref", `refs/heads/${GOAL}`, tip);
  assert.equal(must(goal.integrationWorktree, "rev-parse", "HEAD"), commit);
  assert.throws(() => confirm(s.repo, "hello", s.file("c.md", "ok\n")), /integration worktree not clean/);
  assert.equal(task(s, "hello").status, "integrating");
});

test("confirm never writes through a link that a process left in the worktree keeps planting", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const victim = join(s.repo, ".git", "config");
  const before = readFileSync(victim, "utf8");
  // Ends by itself once the worktree is gone, or after 30 s.
  const survivor = `
    const fs = require("fs");
    const [dotGit, victim, ready] = process.argv.slice(1);
    fs.writeFileSync(ready, "");
    for (const end = Date.now() + 30000; Date.now() < end;) {
      try { fs.unlinkSync(dotGit); } catch {}
      try { fs.symlinkSync(victim, dotGit); } catch (e) { if (e.code === "ENOENT") process.exit(0); }
    }`;
  for (const slug of ["one", "two", "three", "four", "five"]) {
    const { worktree } = reviewable(s, slug, { [`${slug}.txt`]: `${slug}\n` });
    accept(s, slug);
    const ready = join(s.home, `ready-${slug}`);
    const child = spawn(process.execPath, ["-e", survivor, join(worktree!, ".git"), victim, ready], { stdio: "ignore" });
    t.after(() => kill(child.pid!));
    assert.ok(await until(() => existsSync(ready)), "the survivor runs");
    await sleep(5);
    const r = confirm(s.repo, slug, s.file("c.md", "ok\n"));
    kill(child.pid!);
    assert.equal(task(s, slug).status, "accepted");
    assert.ok(r.cleanup === "failed" || !existsSync(worktree!), `confirm of ${slug} left its worktree without saying so`);
    assert.equal(readFileSync(victim, "utf8"), before, `confirm of ${slug} wrote through the link`);
  }
  assert.equal(must(s.repo, "status", "--porcelain"), "");
});

test("confirm never deletes the user's files through a link that a process left in the worktree swaps in", async (t) => {
  const s = setup(t);
  const src = join(s.repo, "src");
  mkdirSync(src);
  for (let k = 0; k < 200; k++) writeFileSync(join(src, `keep-${k}`), `${k}\n`);
  must(s.repo, "add", "src");
  must(s.repo, "commit", "-q", "-m", "Add sources");
  goalStart(s.repo, GOAL, null);
  // An edit nothing else holds: the worktree mirrors the checkout's tracked names, so this file is in the line of fire.
  writeFileSync(join(src, "keep-0"), "uncommitted\n");
  const snapshot = () => readdirSync(src).sort().map((n) => `${n}:${readFileSync(join(src, n), "utf8")}`);
  const before = snapshot();
  // Swaps a directory for a link and back in a tight loop, each step on its own. sub is relative and cwd is the
  // worktree, so a removal that renames the worktree first does not shake it off. Ends by itself after 30 s.
  const swapper = `
    const fs = require("fs");
    const [sub, victim, ready] = process.argv.slice(1);
    const aside = sub + ".held";
    const quiet = (f) => { try { f(); } catch {} };
    fs.writeFileSync(ready, "");
    for (const end = Date.now() + 30000; Date.now() < end;) {
      quiet(() => fs.renameSync(sub, aside));
      quiet(() => fs.symlinkSync(victim, sub));
      quiet(() => fs.unlinkSync(sub));
      quiet(() => fs.renameSync(aside, sub));
    }`;
  for (let round = 0; round < 10; round++) {
    const slug = `round-${"abcdefghij"[round]}`;
    const { worktree } = reviewable(s, slug, { [`${slug}.txt`]: `${slug}\n` });
    accept(s, slug);
    const ready = join(s.home, `ready-${slug}`);
    const child = spawn(process.execPath, ["-e", swapper, "src", src, ready], { cwd: worktree!, stdio: "ignore" });
    t.after(() => kill(child.pid!));
    assert.ok(await until(() => existsSync(ready)), "the swapper runs");
    await sleep(1);
    const r = confirm(s.repo, slug, s.file("c.md", "ok\n"));
    kill(child.pid!);
    assert.equal(task(s, slug).status, "accepted");
    assert.ok(r.cleanup === "failed" || !existsSync(worktree!), `confirm of ${slug} left its worktree without saying so`);
    assert.deepEqual(snapshot(), before, `confirm of ${slug} reached the user's checkout`);
  }
});

test("confirm removes a worktree whose .git the worker rewrote, deleted or replaced", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const decoy = tempRepo();
  const decoyHead = must(decoy, "rev-parse", "HEAD");
  const shapes: Record<string, (dotGit: string) => void> = {
    decoy: (g) => writeFileSync(g, `gitdir: ${join(decoy, ".git")}\n`),
    deleted: (g) => rmSync(g),
    directory: (g) => {
      rmSync(g);
      mkdirSync(join(g, "hooks"), { recursive: true });
    },
  };
  for (const [slug, plant] of Object.entries(shapes)) {
    const { worktree } = reviewable(s, slug, { [`${slug}.txt`]: `${slug}\n` });
    plant(join(worktree!, ".git"));
    const { commit } = accept(s, slug) as { commit: string };
    assert.equal(must(s.repo, "show", "--name-only", "--format=", commit), `${slug}.txt`);
    const before = ledgerSize(s.id);
    assert.deepEqual(confirm(s.repo, slug, s.file("c.md", "ok\n")), { cursor: before });
    assert.deepEqual([task(s, slug).status, existsSync(worktree!), must(s.repo, "branch", "--list", `wip/${slug}`)], ["accepted", false, ""], slug);
  }
  assert.equal(must(decoy, "rev-parse", "HEAD"), decoyHead);
  assert.equal(must(decoy, "status", "--porcelain"), "");
});

test("a cleanup that fails after confirm is reported with exit 0, and the task stays accepted", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  reviewable(s, "hello", { "hello.txt": "hello\n" });
  accept(s, "hello");
  must(s.repo, "update-ref", "-d", "refs/heads/wip/hello"); // branch -D will find nothing to delete
  const before = ledgerSize(s.id);
  const r = cli(s, "confirm", "hello", "--evidence-file", s.file("c.md", "ok\n"));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json, { cursor: before, cleanup: "failed" });
  assert.equal(task(s, "hello").status, "accepted");
  assert.match(readFileSync(join(s.home, "logs", "runner.log"), "utf8"), /confirm of hello: /);
});

// Plan

test("plan set checks its ledger line before it overwrites plan.md", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  planSet(s.repo, GOAL, s.file("plan.md", "First plan.\n"), "First");
  const size = ledgerSize(s.id);
  assert.throws(() => planSet(s.repo, GOAL, s.file("plan2.md", "Second plan.\n"), "x".repeat(5000)), /ledger line of \d+ bytes exceeds 4096/);
  assert.equal(readFileSync(join(projectDir(s.id), "goals", "feat__slice", "plan.md"), "utf8"), "First plan.\n");
  assert.equal(ledgerSize(s.id), size);
});

test("accept refuses a working task", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...HELLO, delayMs: 30_000 }]);
  const sent = send(s, "hello");
  const job = join(jobDir(sent.task.jobIds[0]), "job.json");
  assert.ok(await until(() => (JSON.parse(readFileSync(job, "utf8")) as JobRecord).workerPid !== null), "the worker runs");
  assert.throws(() => accept(s, "hello"), /task hello is working/);
  assert.equal(task(s, "hello").status, "working");
});

test("10 KB evidence is kept in a file and the event stays small", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([HELLO]);
  send(s, "hello");
  await needsReview(s, "hello");
  const evidence = "ok 1 - hello.txt says hello\n".repeat(400);
  assert.ok(evidence.length > 10_000);
  accept(s, "hello", evidence);
  const saved = join(projectDir(s.id), "tasks", "hello", "rounds", "1", "evidence-accept.md");
  assert.equal(readFileSync(saved, "utf8"), evidence);
  const line = readFileSync(join(projectDir(s.id), "ledger.jsonl"), "utf8").split("\n").find((l) => l.includes('"verdict"'))!;
  assert.ok(Buffer.byteLength(line) < 1024, line);
  const file = JSON.parse(line).file;
  assert.equal(file.path, saved);
  assert.ok(file.excerpt.length <= 300);
});

// Wait

test("wait returns idle when nothing runs", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  assert.deepEqual(await waitForNext(s.repo, { since: 0, timeoutMs: 10_000 }), { kind: "idle", cursor: ledgerSize(s.id) });
  assert.deepEqual(readdirSync(join(projectDir(s.id), "waiters")), []);
});

test("wait refuses a cursor inside a line of the ledger, and takes one at the start of any line", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([HELLO]);
  const sent = send(s, "first");
  await needsReview(s, "first");
  const lines = readFileSync(join(projectDir(s.id), "ledger.jsonl"), "utf8").split("\n").slice(0, -1);
  // Where each line starts, the end of the ledger included: the cursors the commands print are all of these.
  const starts = lines.reduce((at, line) => [...at, at.at(-1)! + Buffer.byteLength(line) + 1], [0]);
  assert.ok(lines.length > 2 && starts.includes(sent.cursor));
  for (const since of [1, starts[1] - 1, starts[1] + 1]) {
    await assert.rejects(waitForNext(s.repo, { since, timeoutMs: 1000 }), new RegExp(`^Error: invalid cursor ${since}: .*start of a line`), String(since));
  }
  assert.equal(existsSync(join(projectDir(s.id), "waiters")), false, "a refused cursor leaves no heartbeat");
  for (const since of [starts[0], starts[1], starts.at(-1)!]) assert.notEqual((await waitForNext(s.repo, { since, timeoutMs: 1000 })).kind, undefined, String(since));
});

test("wait does not go idle while a task waits with pending", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([HELLO]);
  send(s, "first");
  await needsReview(s, "first");
  const since = ledgerSize(s.id);
  send(s, "second", { after: "first" });
  assert.deepEqual([task(s, "second").status, task(s, "second").pending], ["waiting", { kind: "start", message: null }]);
  const begun = Date.now();
  // Its line yields no item, so the wait moves past it, and the cursor it returns says so.
  assert.deepEqual(await waitForNext(s.repo, { since, timeoutMs: 1500 }), { kind: "timeout", cursor: ledgerSize(s.id) });
  assert.ok(Date.now() - begun >= 1500);
  assert.ok(ledgerSize(s.id) > since);
});

test("wait maps each task state to what the lead does next", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const since = ledgerSize(s.id);
  const stalled = (stallReason: StallReason): Partial<TaskRecord> => ({ status: "stalled", stallReason });
  const table: [Partial<TaskRecord>, WaitItem["next"] | null][] = [
    [{ status: "needs-review" }, "review"],
    [stalled("all-exhausted"), "offer-takeover"],
    [stalled("fix-rounds-exceeded"), "fix-rounds-exceeded"],
    [stalled("quota"), "reassign-or-ready"],
    [stalled("model-limit"), "reassign-or-ready"],
    [stalled("failed"), "inspect"],
    [stalled("timeout"), "inspect"],
    [stalled("runner-died"), "inspect"],
    [stalled("account-mismatch"), "inspect"],
    [stalled("rebase-failed"), "inspect"],
    [{ status: "waiting" }, null],
    [{ status: "integrating" }, null],
    [{ status: "accepted" }, null],
    [{ status: "takeover" }, null],
    [{ status: "cancelled" }, null],
  ];
  table.forEach(([over], i) => appendEvent(s.id, { t: "task.created", at: now(), task: taskRecord(`t${i}`, over) }));
  const w = await waitForNext(s.repo, { since, timeoutMs: 10_000 });
  assert.equal(w.kind, "events");
  const expected = table.flatMap(([, next], i) => (next === null ? [] : [[`t${i}`, "codex:gpt-6-luna@medium", next]]));
  assert.deepEqual(w.kind === "events" && w.items.map((i) => [i.task, i.candidate, i.next]), expected);
});

test("wait reports a failed job with next inspect and the outcome's detail", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([{ stdout: "generated:no-terminal", exitCode: 1 }]);
  const sent = send(s, "hello");
  assert.deepEqual(await waitForNext(s.repo, { since: sent.cursor, timeoutMs: 30_000 }), {
    kind: "events", cursor: ledgerSize(s.id),
    items: [{ task: "hello", status: "stalled", candidate: "codex:gpt-6-luna@medium", detail: "exit 1; see stderr.log", next: "inspect" }],
  });
});

test("wait removes its heartbeat on SIGTERM and ends by the signal", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...HELLO, delayMs: 30_000 }]); // a running job keeps the wait from going idle
  const sent = send(s, "hello");
  const child = spawn(LAUNCHER, ["wait", "--since", String(sent.cursor)], { cwd: s.repo, stdio: "ignore" });
  t.after(() => kill(child.pid!));
  const waiters = join(projectDir(s.id), "waiters");
  assert.ok(await until(() => existsSync(join(waiters, `${child.pid}-1.json`))), "the wait writes its heartbeat");
  const ended = new Promise<NodeJS.Signals | null>((done) => child.once("exit", (_, signal) => done(signal)));
  child.kill("SIGTERM");
  assert.equal(await ended, "SIGTERM");
  assert.deepEqual(readdirSync(waiters), []);
});

test("a wait whose parent died returns timeout", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...HELLO, delayMs: 30_000 }]); // a running job keeps the wait from going idle
  const sent = send(s, "hello");
  const out = s.file("wait.out", "");
  // The shell exits at once, leaving the backgrounded wait with parent pid 1.
  const shell = spawnSync("/bin/sh", ["-c", `"${LAUNCHER}" wait --since ${sent.cursor} > "${out}" 2>&1 & echo $!`], { cwd: s.repo, encoding: "utf8" });
  const pid = Number(shell.stdout.trim());
  assert.ok(pid > 1, shell.stderr);
  t.after(() => kill(pid));
  assert.ok(await until(() => processStart(pid) === null), "the wait ends");
  assert.equal(JSON.parse(readFileSync(out, "utf8")).kind, "timeout");
});

test("wait skips a poll that finds the project lock busy and polls again", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const lock = join(projectDir(s.id), "lock");
  holdLock(lock);
  const begun = Date.now();
  const pending = waitForNext(s.repo, { since: 0, timeoutMs: 120_000 });
  // The first poll ran before waitForNext first yielded, and did not wait for the lock.
  assert.ok(Date.now() - begun < 10_000, `the first poll took ${Date.now() - begun} ms`);
  rmSync(lock);
  assert.deepEqual(await pending, { kind: "idle", cursor: ledgerSize(s.id) });
});

test("a busy lock costs a wait nothing: its timeout and SIGTERM stay prompt", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const since = ledgerSize(s.id);
  const lock = join(projectDir(s.id), "lock");
  holdLock(lock);
  const begun = Date.now();
  assert.deepEqual(await waitForNext(s.repo, { since, timeoutMs: 1500 }), { kind: "timeout", cursor: since });
  assert.ok(Date.now() - begun < 10_000, `the timeout took ${Date.now() - begun} ms`);

  const child = spawn(LAUNCHER, ["wait", "--since", String(since)], { cwd: s.repo, stdio: "ignore" });
  t.after(() => kill(child.pid!));
  const waiters = join(projectDir(s.id), "waiters");
  assert.ok(await until(() => existsSync(join(waiters, `${child.pid}-1.json`))), "the wait writes its heartbeat");
  await sleep(300); // inside its polling of the busy lock
  const signalled = Date.now();
  const stopped = new Promise<NodeJS.Signals | null>((done) => child.once("exit", (_, signal) => done(signal)));
  child.kill("SIGTERM");
  assert.equal(await stopped, "SIGTERM");
  assert.ok(Date.now() - signalled < 10_000, `SIGTERM took ${Date.now() - signalled} ms`);
  assert.deepEqual(readdirSync(waiters), []);
});

test("wait takes idle only from the current poll", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const lock = join(projectDir(s.id), "lock");
  const pending = waitForNext(s.repo, { since: 0, timeoutMs: 1500 });
  // Its first poll saw new lines and would be idle, so it reads again after a moment, and now it cannot tell.
  holdLock(lock);
  assert.deepEqual(await pending, { kind: "timeout", cursor: ledgerSize(s.id) });
  rmSync(lock);
});

test("wait waits a moment after new lines, so tasks that end together come back as one answer", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const since = ledgerSize(s.id);
  appendEvent(s.id, { t: "task.created", at: now(), task: taskRecord("first", { status: "needs-review" }) });
  const pending = waitForNext(s.repo, { since, timeoutMs: 10_000 });
  appendEvent(s.id, { t: "task.created", at: now(), task: taskRecord("second", { status: "needs-review" }) });
  const w = await pending;
  assert.deepEqual(w.kind === "events" && w.items.map((i) => i.task), ["first", "second"]);
  assert.equal(w.cursor, ledgerSize(s.id));
});

test("wait reports a dead runner it found itself", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...HELLO, delayMs: 30_000 }]);
  const sent = send(s, "hello");
  const file = join(jobDir(sent.task.jobIds[0]), "job.json");
  const job = () => JSON.parse(readFileSync(file, "utf8")) as JobRecord;
  assert.ok(await until(() => job().workerPid !== null), "the worker runs");
  const { runnerPid, workerPid } = job();
  kill(runnerPid!);
  assert.ok(await until(() => processStart(runnerPid!) === null), "the runner dies");
  kill(-workerPid!);
  assert.deepEqual(await waitForNext(s.repo, { since: sent.cursor, timeoutMs: 5000 }), {
    kind: "events", cursor: ledgerSize(s.id),
    items: [{ task: "hello", status: "stalled", candidate: "codex:gpt-6-luna@medium", detail: "runner died", next: "inspect" }],
  });
});

test("a wait loads the catalog once, however often it polls", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  appendEvent(s.id, { t: "task.created", at: now(), task: taskRecord("held", { after: "nothing-yet", pending: { kind: "start", message: null } }) });
  // A stale cache and a codex that fails: every load would run it again.
  const runs = join(s.home, "codex-runs");
  const broken = join(s.home, "broken-codex");
  writeFileSync(broken, `#!/bin/sh\necho run >> "${runs}"\nexit 1\n`, { mode: 0o755 });
  const cache = join(s.home, "models.json");
  writeFileSync(cache, JSON.stringify({ ...JSON.parse(readFileSync(cache, "utf8")), fetchedAt: new Date(Date.now() - 3_600_000).toISOString() }));
  process.env.MANDOR_CODEX_BIN = broken;
  const since = ledgerSize(s.id);
  assert.deepEqual(await waitForNext(s.repo, { since, timeoutMs: 2500 }), { kind: "timeout", cursor: since });
  assert.equal(readFileSync(runs, "utf8").split("\n").filter(Boolean).length, 1);
});

test("two waits with their own cursors both see the same event", async (t) => {
  const s = setup(t);
  const { cursor: early } = goalStart(s.repo, GOAL, null);
  writeScenarios([{ ...HELLO, delayMs: 1500 }]);
  const sent = send(s, "hello");
  const waiters = join(projectDir(s.id), "waiters");
  const handlers = process.listenerCount("SIGTERM");
  const both = Promise.all([early, sent.cursor].map((since) => waitForNext(s.repo, { since, timeoutMs: 30_000 })));
  const beats = readdirSync(waiters).sort();
  assert.equal(beats.length, 2, "each wait writes its own heartbeat");
  for (const name of beats) {
    assert.match(name, new RegExp(`^${process.pid}-\\d+\\.json$`));
    assert.deepEqual(JSON.parse(readFileSync(join(waiters, name), "utf8")), { pid: process.pid, start: processStart(process.pid) });
    assert.equal(statSync(join(waiters, name)).mode & 0o777, 0o600);
  }
  for (const w of await both) {
    assert.equal(w.kind, "events");
    assert.deepEqual(w.kind === "events" && w.items.map((i) => [i.task, i.next]), [["hello", "review"]]);
  }
  assert.deepEqual(readdirSync(waiters), []);
  assert.ok(process.listenerCount("SIGTERM") <= handlers + 1, "signal handlers are installed once per process");
});

// Project resolution

test("dispatch from inside a task worktree resolves the same project", (t) => {
  const s = setup(t);
  fillSlots();
  goalStart(s.repo, GOAL, null);
  const first = send(s, "first", { use: null });
  const deep = join(first.task.worktree!, "src", "deep");
  mkdirSync(deep, { recursive: true });
  send(s, "second", { use: null }, deep);
  assert.equal(task(s, "second").goalBranch, GOAL);
  assert.deepEqual(listProjects(), [s.id]);
});

test("a cwd inside a task worktree whose .git is rewritten still resolves the right project", (t) => {
  const s = setup(t);
  fillSlots();
  goalStart(s.repo, GOAL, null);
  const first = send(s, "first", { use: null });
  const decoy = tempRepo();
  writeFileSync(join(first.task.worktree!, ".git"), `gitdir: ${join(decoy, ".git")}\n`);
  assert.notEqual(projectRoot(first.task.worktree!), s.repo, "git discovery no longer names the repository");
  send(s, "second", { use: null }, first.task.worktree!);
  assert.equal(task(s, "second").goalBranch, GOAL);
  assert.deepEqual(listProjects(), [s.id]);
});

// Dispatch validation

test("dispatch refuses slug claude-fix", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  assert.throws(() => send(s, "claude-fix", { use: null }), /claude-fix contains claude/);
  assert.throws(() => send(s, "Fix_It", { use: null }), /invalid task slug "Fix_It"/);
  assert.equal(task(s, "claude-fix"), undefined);
  assert.equal(existsSync(join(worktreesDir(s.id), "task-claude-fix")), false);
});

test("dispatch checks --after and --use before it creates anything", (t) => {
  const s = setup(t);
  fillSlots();
  goalStart(s.repo, GOAL, null);
  goalStart(s.repo, "feat/other", null);
  send(s, "elsewhere", { goal: "feat/other", use: null });
  const cases: [Partial<DispatchOptions>, RegExp][] = [
    [{ after: "nope" }, /--after nope: no such task in goal feat\/slice/],
    [{ after: "elsewhere" }, /--after elsewhere: no such task in goal feat\/slice/],
    [{ use: { tool: "codex", model: "gpt-reserve", effort: "high" } }, /codex:gpt-reserve is hidden/],
    [{ use: { tool: "codex", model: "gpt-9-nope", effort: "high" } }, /codex:gpt-9-nope is not in the model catalog/],
    [{ use: { tool: "zcode", model: "GLM-5.3", effort: "high" } }, /zcode is not enabled/],
    [{ goal: "feat/none" }, /no goal feat\/none/],
  ];
  for (const [over, error] of cases) assert.throws(() => send(s, "x", over), error);
  assert.throws(() => send(s, "elsewhere", { goal: "feat/other", use: null }), /task elsewhere already exists/);
  assert.throws(() => goalStart(s.repo, GOAL, null), /goal feat\/slice already exists/);
  assert.throws(() => goalStart(s.repo, "fix/claude-login", null), /contains claude/);
  assert.throws(() => goalStart(s.repo, "wip/slice", null), /wip\/ is for task branches/);
  assert.throws(() => goalStart(s.repo, "wip", null), /wip\/ is for task branches/);

  // An empty effort takes the model's default; a model without one is refused.
  const models = (list: ModelInfo[]) => writeJsonAtomic(join(s.home, "models.json"), { fetchedAt: new Date().toISOString(), codexVersion: "0.166.0", models: list });
  models([{ tool: "codex", model: "gpt-6-luna", label: "Luna", efforts: ["medium"], defaultEffort: null, hidden: false }]);
  assert.throws(() => send(s, "x", { use: { ...LUNA, effort: "" } }), /codex:gpt-6-luna has no default effort/);
  models([]);
  assert.throws(() => send(s, "x"), /no model catalog; run mandor models --refresh/);

  assert.equal(task(s, "x"), undefined);
  assert.equal(existsSync(join(worktreesDir(s.id), "task-x")), false);
  assert.equal(existsSync(join(projectDir(s.id), "tasks", "x", "reserved")), false);
});

test("a --use dispatch at the tool's limit keeps waiting with its pending start", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  fillSlots();
  const { task: waiting } = send(s, "hello");
  assert.deepEqual([waiting.status, waiting.pending, waiting.jobIds, waiting.use], ["waiting", { kind: "start", message: null }, [], LUNA]);
});

test("a failed provisioning removes what goal start and dispatch added", (t) => {
  const s = setup(t);
  fillSlots();
  saveProjectConfig(s.id, { ...emptyProjectConfig(), setup: "exit 3" });
  assert.throws(() => goalStart(s.repo, GOAL, null), /setup failed \(exit 3\)/);
  assert.equal(must(s.repo, "branch", "--list", GOAL), "");
  assert.equal(existsSync(join(worktreesDir(s.id), "goal-feat__slice")), false);
  assert.equal(ledgerSize(s.id), 0);

  saveProjectConfig(s.id, emptyProjectConfig());
  goalStart(s.repo, GOAL, null);
  saveProjectConfig(s.id, { ...emptyProjectConfig(), setup: "exit 3" });
  assert.throws(() => send(s, "hello", { use: null }), /setup failed \(exit 3\)/);
  assert.equal(must(s.repo, "branch", "--list", "wip/hello"), "");
  assert.equal(existsSync(join(worktreesDir(s.id), "task-hello")), false);
  assert.equal(existsSync(join(projectDir(s.id), "tasks", "hello", "reserved")), false);
  assert.equal(task(s, "hello"), undefined);

  saveProjectConfig(s.id, emptyProjectConfig());
  assert.equal(send(s, "hello", { use: null }).task.worktree, join(worktreesDir(s.id), "task-hello"));
});

test("a stale reservation is recovered", (t) => {
  const s = setup(t);
  fillSlots();
  goalStart(s.repo, GOAL, null);
  // What a dispatch killed between its reservation and task.created leaves behind.
  const wt = join(worktreesDir(s.id), "task-stale");
  addWorktree(s.repo, wt, "wip/stale", GOAL);
  writeFileSync(join(wt, "leftover.txt"), "half provisioned\n");
  const reserved = join(projectDir(s.id), "tasks", "stale", "reserved");
  const tip = must(s.repo, "rev-parse", GOAL);
  writeJsonAtomic(reserved, { pid: process.pid, start: processStart(process.pid), tip });
  assert.throws(() => send(s, "stale", { use: null }), /task stale is being dispatched by pid \d+/);
  assert.ok(existsSync(join(wt, "leftover.txt")), "a live reservation is left alone");

  staleReservation(reserved, tip);
  const sent = send(s, "stale", { use: null });
  assert.equal(sent.task.worktree, wt);
  assert.equal(existsSync(join(wt, "leftover.txt")), false);
  assert.equal(existsSync(reserved), false);
  assert.equal(must(wt, "rev-parse", "HEAD"), must(s.repo, "rev-parse", GOAL));
});

test("a stale reservation is recovered from whatever its dead owner left", (t) => {
  const s = setup(t);
  fillSlots();
  goalStart(s.repo, GOAL, null);
  const tip = must(s.repo, "rev-parse", GOAL);
  const worktree = (slug: string) => join(worktreesDir(s.id), `task-${slug}`);
  const admin = (slug: string) => join(s.repo, ".git", "worktrees", `task-${slug}`);
  const states: Record<string, (slug: string) => void> = {
    "nothing": () => {},
    "branch-only": (slug) => must(s.repo, "branch", `wip/${slug}`, tip),
    "stray-dir": (slug) => {
      mkdirSync(join(worktree(slug), "sub"), { recursive: true });
      writeFileSync(join(worktree(slug), "sub", "a.txt"), "half made\n");
    },
    "locked": (slug) => {
      addWorktree(s.repo, worktree(slug), `wip/${slug}`, tip);
      writeFileSync(join(admin(slug), "locked"), "initializing");
    },
    "locked-dir-gone": (slug) => {
      addWorktree(s.repo, worktree(slug), `wip/${slug}`, tip);
      writeFileSync(join(admin(slug), "locked"), "initializing");
      rmSync(worktree(slug), { recursive: true });
    },
    "forged-pointer": (slug) => {
      addWorktree(s.repo, worktree(slug), `wip/${slug}`, tip);
      writeFileSync(join(worktree(slug), ".git"), "gitdir: /nowhere\n");
    },
  };
  for (const [slug, leave] of Object.entries(states)) {
    leave(slug);
    staleReservation(reservationOf(s, slug), tip);
    assert.equal(send(s, slug, { use: null }).task.worktree, worktree(slug), slug);
    assert.deepEqual([must(worktree(slug), "symbolic-ref", "HEAD"), existsSync(reservationOf(s, slug)), existsSync(join(admin(slug), "locked"))], [`refs/heads/wip/${slug}`, false, false], slug);
    assert.equal(existsSync(join(worktree(slug), "sub")), false, slug);
  }
});

test("a stale reservation keeps a branch that moved, and fails loudly with the reservation in place", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const tip = must(s.repo, "rev-parse", GOAL);
  const moved = must(s.repo, "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "Work on it");
  must(s.repo, "branch", "wip/moved", moved);
  staleReservation(reservationOf(s, "moved"), tip);
  for (let i = 0; i < 2; i++) assert.throws(() => send(s, "moved", { use: null }), /wip\/moved/);
  assert.equal(must(s.repo, "rev-parse", "wip/moved"), moved);
  assert.equal(existsSync(reservationOf(s, "moved")), true);
  assert.equal(task(s, "moved"), undefined);
});

test("dispatch refuses a branch or a worktree path it did not create, and leaves them alone", (t) => {
  const s = setup(t);
  fillSlots();
  goalStart(s.repo, GOAL, null);
  must(s.repo, "branch", "wip/mine", GOAL);
  assert.throws(() => send(s, "mine", { use: null }), /branch wip\/mine already exists/);
  assert.equal(must(s.repo, "rev-parse", "wip/mine"), must(s.repo, "rev-parse", GOAL));
  assert.equal(existsSync(reservationOf(s, "mine")), false);

  const stray = join(worktreesDir(s.id), "task-stray");
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, "keep.txt"), "not a dispatch's\n");
  assert.throws(() => send(s, "stray", { use: null }), /task-stray already exists/);
  assert.equal(readFileSync(join(stray, "keep.txt"), "utf8"), "not a dispatch's\n");
  assert.equal(existsSync(reservationOf(s, "stray")), false);

  // A record with no commit in it can still clear a directory, but it cannot prove a branch was made here.
  writeJsonAtomic(reservationOf(s, "stray"), { pid: spawnSync("/usr/bin/true").pid!, start: "Thu Jan  1 00:00:00 1970" });
  assert.equal(send(s, "stray", { use: null }).task.worktree, stray);
  writeJsonAtomic(reservationOf(s, "mine"), { pid: spawnSync("/usr/bin/true").pid!, start: "Thu Jan  1 00:00:00 1970" });
  assert.throws(() => send(s, "mine", { use: null }), /branch wip\/mine already exists/);
  assert.equal(must(s.repo, "rev-parse", "wip/mine"), must(s.repo, "rev-parse", GOAL));
});

test("a dispatch whose post-checkout hook fails removes its worktree and branch, and the next one starts clean", (t) => {
  const s = setup(t);
  fillSlots();
  goalStart(s.repo, GOAL, null);
  hook(s.repo, "post-checkout", "exit 3");
  assert.throws(() => send(s, "hooky", { use: null }), /worktree add/);
  assert.deepEqual([existsSync(join(worktreesDir(s.id), "task-hooky")), must(s.repo, "branch", "--list", "wip/hooky"), existsSync(reservationOf(s, "hooky"))], [false, "", false]);
  unhook(s.repo, "post-checkout");
  assert.equal(send(s, "hooky", { use: null }).task.worktree, join(worktreesDir(s.id), "task-hooky"));
});

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`a dispatch stopped by ${signal} during its worktree add is recovered by the next one`, async (t) => {
    const s = setup(t);
    goalStart(s.repo, GOAL, null);
    const inAdd = join(s.home, "in-add");
    holdWorktreeAdd(s.repo, inAdd);
    const args = ["dispatch", "--goal", GOAL, "--task", "hello", "--tier", "light", "--brief", s.file("hello.md", "Say hello.\n")];
    const c = detached(s, t, args);
    assert.ok(await until(() => existsSync(inAdd) || c.exitCode !== null), "the add reaches its hook, or ends");
    if (!existsSync(inAdd)) return t.skip("this git runs no reference-transaction hook for a symbolic HEAD");
    const worktree = join(worktreesDir(s.id), "task-hello");
    const locked = join(s.repo, ".git", "worktrees", "task-hello", "locked");
    assert.equal(existsSync(locked), true);
    process.kill(-c.pid!, signal);
    await ended(c);
    unhook(s.repo, "reference-transaction");
    if (signal === "SIGKILL") assert.deepEqual([existsSync(locked), existsSync(worktree)], [true, true], "SIGKILL leaves everything, the lock too");
    else assert.ok(await until(() => !existsSync(worktree)), "SIGTERM lets git remove its junk, and only the branch stays");
    assert.notEqual(must(s.repo, "branch", "--list", "wip/hello"), "");
    assert.equal(existsSync(reservationOf(s, "hello")), true);

    const again = cli(s, ...args);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual([again.json.task.worktree, existsSync(reservationOf(s, "hello")), existsSync(locked)], [worktree, false, false]);
    assert.equal(must(worktree, "rev-parse", "HEAD"), must(s.repo, "rev-parse", GOAL));
  });
}

for (const what of ["dispatch", "goal start"] as const) {
  test(`a ${what} waits while the git of one killed alone is still adding that worktree`, async (t) => {
    const s = setup(t);
    if (what === "dispatch") goalStart(s.repo, GOAL, null);
    const args = what === "dispatch"
      ? ["dispatch", "--goal", GOAL, "--task", "hello", "--tier", "light", "--brief", s.file("hello.md", "Say hello.\n")]
      : ["goal", "start", GOAL];
    const worktree = join(worktreesDir(s.id), what === "dispatch" ? "task-hello" : "goal-feat__slice");
    const reservation = what === "dispatch" ? reservationOf(s, "hello") : goalReservation(s);
    const [parked, release] = [join(s.home, "parked"), join(s.home, "release")];
    // Parked before its checkout, and bounded, so a retry that wrongly goes on fails instead of hanging.
    hook(s.repo, "reference-transaction", `case "$(cat)" in *ref:refs/heads/*HEAD*) touch "${parked}"; i=0; while [ ! -e "${release}" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done;; esac`);
    const c = detached(s, t, args);
    t.after(() => writeFileSync(release, ""));
    assert.ok(await until(() => existsSync(parked) || c.exitCode !== null), "the add reaches its hook, or ends");
    if (!existsSync(parked)) return t.skip("this git runs no reference-transaction hook for a symbolic HEAD");
    kill(c.pid!);
    await ended(c);

    const early = cli(s, ...args);
    assert.equal(early.status, 1, early.stderr);
    assert.match(early.stderr, /an earlier command is still finishing; retry shortly/);
    assert.deepEqual([existsSync(worktree), existsSync(reservation)], [true, true], "the retry touched nothing");

    // Once the orphan is done, what it made is cleared and the next run starts clean, with nothing left to undo it.
    unhook(s.repo, "reference-transaction");
    writeFileSync(release, "");
    let again = cli(s, ...args);
    assert.ok(await until(() => {
      if (again.status === 0) return true;
      again = cli(s, ...args);
      return again.status === 0;
    }), again.stderr);
    assert.deepEqual([existsSync(join(worktree, "README.md")), existsSync(reservation)], [true, false]);
    assert.equal(must(worktree, "status", "--porcelain"), "");
    if (what === "dispatch") assert.equal(task(s, "hello").worktree, worktree);
    else assert.equal(loadState(s.id).goals[GOAL].integrationWorktree, worktree);
  });
}

test("a dispatch killed during its post-checkout hook, with the worktree whole, is recovered by the next one", async (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const inHook = join(s.home, "in-hook");
  hook(s.repo, "post-checkout", `touch "${inHook}"; exec sleep 30`);
  const args = ["dispatch", "--goal", GOAL, "--task", "hello", "--tier", "light", "--brief", s.file("hello.md", "Say hello.\n")];
  const c = detached(s, t, args);
  assert.ok(await until(() => existsSync(inHook)), "the add reaches its hook");
  kill(-c.pid!);
  await ended(c);
  unhook(s.repo, "post-checkout");
  const worktree = join(worktreesDir(s.id), "task-hello");
  assert.equal(existsSync(join(worktree, "README.md")), true);
  const again = cli(s, ...args);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual([again.json.task.worktree, existsSync(reservationOf(s, "hello"))], [worktree, false]);
});

test("a failure after task.created keeps the worktree and branch the task needs", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  // During the worktree add a directory takes the reservation's place, so removing it throws right after task.created.
  hook(s.repo, "post-checkout", `rm -f "${reservationOf(s, "hello")}" && mkdir "${reservationOf(s, "hello")}"`);
  assert.throws(() => send(s, "hello", { use: null }), /is a directory/);
  const record = task(s, "hello");
  assert.equal(existsSync(join(record.worktree!, "README.md")), true);
  assert.notEqual(must(s.repo, "branch", "--list", "wip/hello"), "");
});

test("a failure after goal.started keeps the worktree and branch the goal needs", (t) => {
  const s = setup(t);
  // During the worktree add a directory takes the reservation's place, so removing it throws right after goal.started.
  hook(s.repo, "post-checkout", `rm -f "${goalReservation(s)}" && mkdir "${goalReservation(s)}"`);
  assert.throws(() => goalStart(s.repo, GOAL, null), /is a directory/);
  const goal = loadState(s.id).goals[GOAL];
  assert.equal(existsSync(join(goal.integrationWorktree, "README.md")), true);
  assert.notEqual(must(s.repo, "branch", "--list", GOAL), "");
});

test("dispatch refuses a missing codex binary before it records the task", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null); // leaves a fresh catalog, so only the job start would need the binary
  const configFile = join(s.home, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.tools.codex.bin = "codex-not-installed";
  writeFileSync(configFile, JSON.stringify(config));
  delete process.env.MANDOR_CODEX_BIN;
  assert.throws(() => send(s, "hello"), /codex not found on PATH/);
  assert.equal(task(s, "hello"), undefined);
  assert.deepEqual([existsSync(join(worktreesDir(s.id), "task-hello")), must(s.repo, "branch", "--list", "wip/hello"), existsSync(reservationOf(s, "hello"))], [false, "", false]);
});

test("a dispatch that cannot start its job answers with its cursor and leaves the task waiting", (t) => {
  const s = setup(t);
  goalStart(s.repo, GOAL, null);
  const slots = join(s.home, "slots.lock");
  holdLock(slots);
  const before = ledgerSize(s.id);
  const restore = skewClock(t);
  const sent = send(s, "hello");
  restore();
  rmSync(slots);
  assert.equal(sent.cursor, before);
  assert.deepEqual([sent.task.status, sent.task.pending, sent.task.jobIds], ["waiting", { kind: "start", message: null }, []]);
  assert.equal(existsSync(join(sent.task.worktree!, "README.md")), true);
  assert.equal(existsSync(reservationOf(s, "hello")), false);
  assert.match(readFileSync(join(s.home, "logs", "runner.log"), "utf8"), /hello: slots busy/);
});

// Goal start

test("goal start clones the project's ignored paths into the integration worktree", (t) => {
  const s = setup(t);
  writeFileSync(join(s.repo, ".gitignore"), "build/\n");
  must(s.repo, "add", ".gitignore");
  must(s.repo, "commit", "-q", "-m", "Ignore build outputs");
  mkdirSync(join(s.repo, "build"));
  writeFileSync(join(s.repo, "build", "out.txt"), "built\n");
  const setupRun = spawnSync(LAUNCHER, ["project", "setup", "--clone", "build"], { cwd: s.repo, encoding: "utf8" });
  assert.equal(setupRun.status, 0, setupRun.stderr);
  const root = join(projectDir(s.id), "root");
  assert.equal(readFileSync(root, "utf8"), `${s.repo}\n`);
  assert.equal(statSync(root).mode & 0o777, 0o600);
  const { goal } = goalStart(s.repo, GOAL, null);
  assert.equal(readFileSync(join(goal.integrationWorktree, "build", "out.txt"), "utf8"), "built\n");
});

test("goal start --from starts the branch at that commit", (t) => {
  const s = setup(t);
  must(s.repo, "switch", "-q", "-c", "topic");
  writeFileSync(join(s.repo, "t.txt"), "t\n");
  must(s.repo, "add", "t.txt");
  must(s.repo, "commit", "-q", "-m", "Topic");
  const topic = must(s.repo, "rev-parse", "HEAD");
  must(s.repo, "switch", "-q", "main");
  assert.notEqual(must(s.repo, "rev-parse", "HEAD"), topic);
  const { goal } = goalStart(s.repo, GOAL, "topic");
  assert.deepEqual([goal.from, must(s.repo, "rev-parse", GOAL), must(goal.integrationWorktree, "rev-parse", "HEAD")], [topic, topic, topic]);
  // A tag names its commit.
  must(s.repo, "tag", "-a", "-m", "Release", "v1", "topic");
  assert.equal(goalStart(s.repo, "feat/tagged", "v1").goal.from, topic);
});

test("goal start without --from branches from the HEAD of the checkout it runs in, the main checkout's from a mandor worktree", (t) => {
  const s = setup(t);
  // The user's own linked worktree, on a branch one commit ahead of main.
  const linked = temp("mandor-linked-");
  must(s.repo, "worktree", "add", "-q", "-b", "topic", linked, "main");
  writeFileSync(join(linked, "extra.txt"), "extra\n");
  must(linked, "add", "extra.txt");
  must(linked, "commit", "-q", "-m", "Add extra");
  const ahead = must(linked, "rev-parse", "HEAD");
  const main = must(s.repo, "rev-parse", "HEAD");
  assert.notEqual(ahead, main);
  const { goal } = goalStart(join(linked, "."), GOAL, null);
  assert.deepEqual([goal.from, must(s.repo, "rev-parse", GOAL)], [ahead, ahead]);
  assert.equal(readFileSync(join(goal.integrationWorktree, "extra.txt"), "utf8"), "extra\n");
  // Inside a mandor worktree the recorded main checkout's HEAD is the base, never the worktree's own.
  assert.equal(goalStart(goal.integrationWorktree, "feat/other", null).goal.from, main);
});

test("a failed goal start never forces the branch away", (t) => {
  const s = setup(t);
  must(s.repo, "switch", "-q", "-c", "topic");
  writeFileSync(join(s.repo, "t.txt"), "t\n");
  must(s.repo, "add", "t.txt");
  must(s.repo, "commit", "-q", "-m", "Topic");
  const topic = must(s.repo, "rev-parse", "HEAD");
  must(s.repo, "switch", "-q", "main");
  saveProjectConfig(s.id, { ...emptyProjectConfig(), setup: "exit 3" });
  // Not merged into the main checkout's HEAD, so a non-forced delete refuses, and that is reported.
  const failed = cli(s, "goal", "start", GOAL, "--from", "topic");
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /setup failed \(exit 3\).*; cleanup failed: .*not fully merged/s);
  assert.equal(must(s.repo, "rev-parse", GOAL), topic);
  assert.equal(existsSync(join(worktreesDir(s.id), "goal-feat__slice")), false);
  assert.equal(existsSync(goalReservation(s)), true);

  // The next run will not force it away either: it says so and keeps its reservation, and the user decides.
  saveProjectConfig(s.id, emptyProjectConfig());
  const refusedAgain = cli(s, "goal", "start", GOAL, "--from", "topic");
  assert.equal(refusedAgain.status, 1);
  assert.match(refusedAgain.stderr, /feat\/slice.*not fully merged/s);
  assert.equal(must(s.repo, "rev-parse", GOAL), topic);
  assert.equal(existsSync(goalReservation(s)), true);

  must(s.repo, "branch", "-D", GOAL);
  const again = cli(s, "goal", "start", GOAL, "--from", "topic");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.goal.from, topic);
  assert.equal(existsSync(goalReservation(s)), false);
});

test("a stale goal reservation keeps a branch that moved, and fails loudly with the reservation in place", (t) => {
  const s = setup(t);
  const tip = must(s.repo, "rev-parse", "HEAD");
  const moved = must(s.repo, "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "Work on it");
  must(s.repo, "branch", GOAL, moved);
  staleReservation(goalReservation(s), tip);
  assert.throws(() => goalStart(s.repo, GOAL, null), /branch feat\/slice moved from/);
  assert.deepEqual([must(s.repo, "rev-parse", GOAL), existsSync(goalReservation(s)), ledgerSize(s.id)], [moved, true, 0]);
});

test("a goal start that finds the lock busy after provisioning removes what it added", (t) => {
  const s = setup(t);
  const lock = join(projectDir(s.id), "lock");
  const holder = JSON.stringify({ pid: process.pid, start: processStart(process.pid) });
  saveProjectConfig(s.id, { ...emptyProjectConfig(), setup: `printf '%s' '${holder}' > '${lock}'` });
  const restore = skewClock(t);
  assert.throws(() => goalStart(s.repo, GOAL, null), /project busy/);
  restore();
  rmSync(lock);
  assert.deepEqual([must(s.repo, "branch", "--list", GOAL), existsSync(join(worktreesDir(s.id), "goal-feat__slice")), existsSync(goalReservation(s)), ledgerSize(s.id)], ["", false, false, 0]);
  saveProjectConfig(s.id, emptyProjectConfig());
  assert.equal(goalStart(s.repo, GOAL, null).cursor, 0);
});

test("a goal start whose post-checkout hook fails removes what it added, and the next one starts clean", (t) => {
  const s = setup(t);
  hook(s.repo, "post-checkout", "exit 3");
  assert.throws(() => goalStart(s.repo, GOAL, null), /worktree add/);
  assert.deepEqual([must(s.repo, "branch", "--list", GOAL), existsSync(join(worktreesDir(s.id), "goal-feat__slice")), existsSync(goalReservation(s)), ledgerSize(s.id)], ["", false, false, 0]);
  unhook(s.repo, "post-checkout");
  assert.equal(goalStart(s.repo, GOAL, null).goal.branch, GOAL);
});

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`a goal start stopped by ${signal} during its worktree add is recovered by the next one`, async (t) => {
    const s = setup(t);
    const inAdd = join(s.home, "in-add");
    holdWorktreeAdd(s.repo, inAdd);
    const c = detached(s, t, ["goal", "start", GOAL]);
    assert.ok(await until(() => existsSync(inAdd) || c.exitCode !== null), "the add reaches its hook, or ends");
    if (!existsSync(inAdd)) return t.skip("this git runs no reference-transaction hook for a symbolic HEAD");
    process.kill(-c.pid!, signal);
    await ended(c);
    unhook(s.repo, "reference-transaction");
    const worktree = join(worktreesDir(s.id), "goal-feat__slice");
    if (signal === "SIGTERM") assert.ok(await until(() => !existsSync(worktree)), "SIGTERM lets git remove its junk, and only the branch stays");
    assert.notEqual(must(s.repo, "branch", "--list", GOAL), "");
    assert.equal(existsSync(goalReservation(s)), true);

    const again = cli(s, "goal", "start", GOAL);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual([again.json.goal.integrationWorktree, existsSync(goalReservation(s))], [worktree, false]);
    assert.equal(must(worktree, "symbolic-ref", "HEAD"), `refs/heads/${GOAL}`);
  });
}

test("a goal start killed during provisioning is recovered by the next one", async (t) => {
  const s = setup(t);
  const inSetup = join(s.home, "in-setup");
  saveProjectConfig(s.id, { ...emptyProjectConfig(), setup: `touch "${inSetup}"; exec sleep 30` });
  const c = detached(s, t, ["goal", "start", GOAL]);
  assert.ok(await until(() => existsSync(inSetup)), "provisioning runs the setup");
  kill(-c.pid!);
  await ended(c);
  saveProjectConfig(s.id, emptyProjectConfig());
  const again = cli(s, "goal", "start", GOAL);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(Object.keys(loadState(s.id).goals), [GOAL]);
});

test("goal start refuses a branch or a worktree path it did not create, and leaves them alone", (t) => {
  const s = setup(t);
  const head = must(s.repo, "rev-parse", "HEAD");
  // The branch the main checkout is on, and one merged into it, which a non-forced delete would take.
  assert.throws(() => goalStart(s.repo, "main", null), /branch main already exists/);
  assert.deepEqual([must(s.repo, "symbolic-ref", "HEAD"), must(s.repo, "rev-parse", "main")], ["refs/heads/main", head]);
  must(s.repo, "branch", "merged", head);
  assert.throws(() => goalStart(s.repo, "merged", null), /branch merged already exists/);
  assert.equal(must(s.repo, "rev-parse", "merged"), head);

  // Two branches can name one worktree path; the second must not take the first one's worktree down, not even through
  // the reservation a crash left right after the first one's goal.started.
  const { goal } = goalStart(s.repo, "a/b", null);
  staleReservation(join(projectDir(s.id), "goals", "a__b", "reserved"), head);
  assert.throws(() => goalStart(s.repo, "a__b", null), /goal a\/b already exists/);
  assert.equal(must(goal.integrationWorktree, "symbolic-ref", "HEAD"), "refs/heads/a/b");
  assert.equal(must(s.repo, "branch", "--list", "a__b"), "");
});

test("goal start and dispatch refuse where sandbox-exec cannot apply a profile, before writing anything", (t) => {
  const s = setup(t);
  // Under an outer sandbox a nested sandbox-exec cannot apply the kind of profile the confined calls use, whether the
  // outer one denies something or allows everything, as Claude Code's Bash sandbox may.
  const outers = ['(version 1)(allow default)', '(version 1)(allow default)(deny file-write* (subpath "/nonexistent"))'];
  const nested = (outer: string, ...args: string[]) => spawnSync("/usr/bin/sandbox-exec", ["-p", outer, LAUNCHER, ...args], { cwd: s.repo, encoding: "utf8" });
  const refusal = /^mandor: cannot confine with sandbox-exec \(sandbox-exec: .+\): run mandor outside Claude Code's Bash sandbox, which sandbox-exec cannot nest in$/m;
  for (const outer of outers) {
    const start = nested(outer, "goal", "start", GOAL);
    assert.equal(start.status, 1, outer);
    assert.match(start.stderr, refusal, outer);
    assert.equal(must(s.repo, "branch", "--list", GOAL), "", outer);
    assert.equal(existsSync(join(worktreesDir(s.id), "goal-feat__slice")), false, outer);
    assert.equal(ledgerSize(s.id), 0, outer);
  }
  // Outside any sandbox the same command runs.
  assert.equal(cli(s, "goal", "start", GOAL).status, 0);
  const args = ["dispatch", "--goal", GOAL, "--task", "hello", "--tier", "light", "--brief", s.file("hello.md", "Say hello.\n")];
  for (const outer of outers) {
    const sent = nested(outer, ...args);
    assert.equal(sent.status, 1, outer);
    assert.match(sent.stderr, refusal, outer);
    assert.equal(task(s, "hello"), undefined, outer);
    assert.equal(existsSync(join(worktreesDir(s.id), "task-hello")), false, outer);
    assert.equal(must(s.repo, "branch", "--list", "wip/hello"), "", outer);
  }
});

test("goal start and dispatch refuse a repository whose config defines a filter or merge driver", (t) => {
  const s = setup(t);
  must(s.repo, "config", "filter.lfs.clean", "git-lfs clean -- %f");
  assert.throws(() => goalStart(s.repo, GOAL, null), /filter\.lfs\.clean/);
  assert.equal(must(s.repo, "branch", "--list", GOAL), "");
  assert.equal(existsSync(join(worktreesDir(s.id), "goal-feat__slice")), false);
  assert.equal(ledgerSize(s.id), 0);

  must(s.repo, "config", "--unset", "filter.lfs.clean");
  goalStart(s.repo, GOAL, null);
  must(s.repo, "config", "merge.ours.driver", "true");
  assert.throws(() => send(s, "hello", { use: null }), /merge\.ours\.driver/);
  assert.equal(task(s, "hello"), undefined);
  assert.equal(existsSync(join(worktreesDir(s.id), "task-hello")), false);
});

test("dispatch refuses a repository whose config cannot be read", (t) => {
  const s = setup(t);
  fillSlots();
  goalStart(s.repo, GOAL, null);
  const first = send(s, "first", { use: null });
  appendFileSync(join(s.repo, ".git", "config"), "[core\n bad");
  // From a task worktree the project comes from the recorded root, so this is the first read of that config.
  assert.throws(() => send(s, "second", { use: null }, first.task.worktree!), /cannot read the git config/);
  assert.equal(task(s, "second"), undefined);
  assert.equal(existsSync(join(worktreesDir(s.id), "task-second")), false);
});

test("goal start and dispatch refuse a repository inside the mandor home before anything of it runs", (t) => {
  const s = setup(t);
  // A repository under the home is a worker's own: its checkout hook must not run, and nothing may be added to it.
  const inside = join(s.home, "elsewhere", "repo");
  mkdirSync(inside, { recursive: true });
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) must(inside, ...args);
  writeFileSync(join(inside, "README.md"), "inside\n");
  must(inside, "add", "README.md");
  must(inside, "commit", "-q", "-m", "Initial commit");
  const marker = join(temp("mandor-hook-"), "ran");
  const hook = join(inside, ".git", "hooks", "post-checkout");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(hook, 0o755);
  const link = join(temp("mandor-link-"), "repo");
  symlinkSync(inside, link);
  const id = projectIdFor(inside);
  for (const where of [inside, link]) {
    assert.throws(() => goalStart(where, GOAL, null), /inside the mandor home/, where);
    assert.equal(existsSync(marker), false, `the checkout hook ran for ${where}`);
    assert.equal(must(inside, "branch", "--list", GOAL), "");
    assert.equal(existsSync(join(worktreesDir(id), "goal-feat__slice")), false);
    assert.equal(ledgerSize(id), 0);
  }
  assert.throws(() => send(s, "hello", {}, inside), /inside the mandor home/);
  assert.equal(existsSync(join(worktreesDir(id), "task-hello")), false);
});

test("assertRepoOutsideHome refuses a repository under the home however the home is spelled, and not a sibling that shares a prefix", (t) => {
  const s = setup(t);
  const inside = join(s.home, "elsewhere", "repo");
  mkdirSync(inside, { recursive: true });
  must(inside, "init", "-q", "-b", "main");
  const sibling = `${s.home}-sibling`;
  mkdirSync(sibling);
  t.after(() => rmSync(sibling, { recursive: true, force: true }));
  must(sibling, "init", "-q", "-b", "main");
  const spelled = join(temp("mandor-homelink-"), "home");
  symlinkSync(s.home, spelled);
  t.after(() => {
    process.env.MANDOR_HOME = s.home;
  });
  for (const home of [s.home, spelled]) {
    process.env.MANDOR_HOME = home;
    assert.throws(() => assertRepoOutsideHome(inside), /inside the mandor home/, home);
    assert.doesNotThrow(() => assertRepoOutsideHome(sibling), home);
  }
});

test("a task slug or a goal branch of digits only is refused", (t) => {
  const s = setup(t);
  fillSlots();
  // Records are keyed by slug and by branch, and an object lists whole-number keys first, in numeric order.
  for (const branch of ["2026", "007", "0"]) {
    assert.throws(() => goalStart(s.repo, branch, null), /digits only/, branch);
    assert.equal(must(s.repo, "branch", "--list", branch), "", branch);
  }
  assert.equal(ledgerSize(s.id), 0);
  goalStart(s.repo, GOAL, null);
  for (const slug of ["2026", "007", "0"]) {
    assert.throws(() => send(s, slug), /digits only/, slug);
    assert.equal(task(s, slug), undefined, slug);
    assert.equal(existsSync(join(worktreesDir(s.id), `task-${slug}`)), false, slug);
  }
  for (const slug of ["1a", "a1"]) {
    send(s, slug);
    assert.ok(task(s, slug), slug);
  }
  goalStart(s.repo, "feat/2026", null);
});

// CLI

test("the CLI prints JSON for scratch, goal start, plan set, dispatch, wait, verdict and confirm", async (t) => {
  const s = setup(t);
  const run = (...args: string[]) => cli(s, ...args);
  assert.deepEqual(run("scratch").json, { dir: join(projectDir(s.id), "scratch", "default") });
  assert.deepEqual(run("scratch", "notes").json, { dir: join(projectDir(s.id), "scratch", "notes") });

  const started = run("goal", "start", GOAL, "--from", "main");
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.json.goal.integrationWorktree, join(worktreesDir(s.id), "goal-feat__slice"));
  assert.equal(started.json.cursor, 0);
  const planned = run("plan", "set", "--goal", GOAL, "--file", s.file("plan.md", "1. a\n"), "--description", "Add a");
  assert.equal(planned.status, 0, planned.stderr);
  assert.ok(planned.json.cursor > 0);

  writeScenarios([{ stdout: "generated:done", writeFile: [{ path: "a.txt", content: "a\n" }] }]);
  const brief = s.file("brief.md", "Create a.txt.\n");
  // A bare directory covers everything under it, a dot directory too; a file, a glob and a dotted name are taken as given.
  const given = ["a.txt", "b/**", "src", "docs/", "lib/core", "x.d/", "c?.ts", ".github", ".vscode", ".circleci", ".github/", ".eslintrc.json", "Makefile", "*.mjs", "src/**"];
  const stored = ["a.txt", "b/**", "src/**", "docs/**", "lib/core/**", "x.d/", "c?.ts", ".github/**", ".vscode/**", ".circleci/**", ".github/**", ".eslintrc.json", "Makefile/**", "*.mjs", "src/**"];
  const one = run("dispatch", "--goal", GOAL, "--task", "one", "--tier", "light", "--brief", brief, ...given.flatMap((g) => ["--scope", g]), "--use", "codex:gpt-6-luna");
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual([one.json.task.use, one.json.task.scope], [LUNA, stored], "an empty effort takes the model default");
  // The Indonesian alias of a tier is recorded as the tier.
  const two = run("dispatch", "--goal", GOAL, "--task", "two", "--tier", "sedang", "--brief", brief, "--after", "one");
  assert.equal(two.status, 0, two.stderr);
  assert.deepEqual([two.json.task.status, two.json.task.after, two.json.task.use, two.json.task.tier], ["waiting", "one", null, "medium"]);

  const woke = run("wait", "--since", String(one.json.cursor), "--timeout", "30");
  assert.equal(woke.status, 0, woke.stderr);
  assert.deepEqual([woke.json.kind, woke.json.items.map((i: { task: string }) => i.task)], ["events", ["one"]]);

  // Only an in-process caller can allow a test identity.
  const evidence = s.file("evidence.md", "ok\n");
  const verdict = run("verdict", "one", "accept", "--evidence-file", evidence, "--message-file", s.file("message.txt", MESSAGE));
  assert.deepEqual([verdict.status, /GIT_AUTHOR_IDENT email "test@example\.invalid" is a placeholder/.test(verdict.stderr)], [1, true], verdict.stderr);
  const confirmed = run("confirm", "one", "--evidence-file", evidence);
  assert.deepEqual([confirmed.status, /task one is needs-review, not integrating/.test(confirmed.stderr)], [1, true], confirmed.stderr);

  assert.equal(run("dispatch", "--goal", GOAL, "--bogus", "x").status, 2);
  assert.equal(run("wait").status, 2);
  const late = run("wait", "--since", String(ledgerSize(s.id) + 1));
  assert.deepEqual([late.status, /invalid cursor/.test(late.stderr)], [1, true], late.stderr);
  assert.equal(run("dispatch", "--goal", GOAL, "--task", "x", "--tier", "huge", "--brief", brief).status, 2);
});
