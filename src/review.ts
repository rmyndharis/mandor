import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { askOf, loadRounds } from "./brief.ts";
import { changedPaths, ignoredChanged, stagedDiff } from "./git.ts";
import { attributionHints, checkDiff, matchesGlob, type Violation } from "./guards.ts";
import { jobDir } from "./home.ts";
import { loadState, now } from "./ledger.ts";
import { loadProjectConfig } from "./provision.ts";
import { clampDetail, maskControls, withProjectLock, writeJsonAtomic } from "./store.ts";
import { diffDeny, diffExact, gitStep, recoverRebaseLocked, refuseOpenJob, refuseUnsupported, resolveProject, reviewedFile } from "./tasks.ts";

export interface ReviewPack {
  diffStat: string;
  files: { path: string; status: string }[];
  redFlags: { kind: string; detail: string }[];
  violations: Violation[];
  worktree: string;
  reportPath: string | null;
}

const TEST_DIRS = ["test", "tests", "__tests__", "androidtest"];

function isTestFile(path: string): boolean {
  const segments = path.split("/");
  const name = segments.at(-1)!;
  return segments.some((s) => TEST_DIRS.includes(s.toLowerCase())) || name.includes(".test.") || name.includes("_test.")
    || name.endsWith("Test.kt") || name.endsWith("Test.java");
}

// A trailing slash covers everything under the directory; any other entry is a path or a glob.
const covers = (entry: string, path: string) => matchesGlob(path, entry.endsWith("/") ? `${entry}**` : entry);

// xit( must not start inside another word, or process.exit( and System.exit( would match.
const SKIP = /\.skip\(|\.only\(|(?<![\w$])xit\(|@Ignore(?!\w)|@Disabled(?!\w)/g;
const ASSERT = /assert|expect\(/i;
const TODO = /\b(?:TODO|FIXME)\b/;

// The words of a command line as a POSIX shell reads them: single quotes are literal, a backslash escapes the next
// character outside quotes and only ", \, $, ` and a newline inside double quotes, a backslash-newline is dropped,
// and quoted and bare pieces next to each other glue into one word. Null when a quote is left open.
function shellWords(line: string): string[] | null {
  const words: string[] = [];
  let word = "", open = false, quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i], next = line[i + 1];
    if (quote === "'") {
      if (c === "'") quote = "";
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "\\" && next === "\n") i++;
      else if (c === "\\" && next !== undefined && '"\\$`'.includes(next)) word += line[++i];
      else word += c;
    } else if (c === "\\") {
      if (next === "\n") i++;
      else if (next !== undefined) [word, open] = [word + line[++i], true];
    } else if (c === "'" || c === '"') [quote, open] = [c, true];
    else if (/\s/.test(c)) {
      if (open) words.push(word);
      [word, open] = ["", false];
    } else [word, open] = [word + c, true];
  }
  if (quote !== "") return null;
  if (open) words.push(word);
  return words;
}

// The commands a worker really ran, as the shell saw them. Codex runs each as `<shell> -lc <script>`, quoting the
// script as the shell needs it. Anything of another shape is kept whole, so a claim can still be found in it.
const SHELL = /^(?:.*\/)?[a-z]*sh$/;
function executedScript(command: string): string {
  const words = shellWords(command);
  return words !== null && words.length === 3 && SHELL.test(words[0]) && /^-l?c$/.test(words[1]) ? words[2] : command;
}
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function executedCommands(rawLog: string): string[] {
  const out: string[] = [];
  for (const line of rawLog.split("\n")) {
    let ev: { type?: unknown; item?: { type?: unknown; command?: unknown }; payload?: { kind?: unknown; input?: { command?: unknown } };
      event?: unknown; step_update?: { step_type?: unknown; tool_name?: unknown; tool_info?: { parameters?: { CommandLine?: unknown } } } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const item = ev?.item;
    // zcode shows a command as the input of a tool call it scheduled, as the shell got it.
    const scheduled = ev?.type === "tool.updated" && ev.payload?.kind === "scheduled" ? ev.payload.input?.command : undefined;
    if (typeof scheduled === "string") out.push(squash(scheduled));
    // agy shows it as a tool step, with the command line it ran.
    const step = ev?.event === "step_update" && ev.step_update?.tool_name === "run_command" ? ev.step_update.tool_info?.parameters?.CommandLine : undefined;
    if (typeof step === "string") out.push(squash(step));
    if (ev?.type !== "item.completed" || item?.type !== "command_execution" || typeof item.command !== "string") continue;
    out.push(squash(executedScript(item.command)));
  }
  return out;
}

// One flag per claimed command no executed command equals or contains. The text of the report stays out of the pack:
// the entry is named by index, and the lead reads it at reportPath.
function unrunClaims(claims: string[], rawLog: string): { kind: string; detail: string }[] {
  const ran = executedCommands(rawLog);
  return claims.flatMap((claim, i) => {
    const c = squash(claim);
    return c !== "" && ran.some((r) => r.includes(c)) ? [] : [{ kind: "unrun-claim", detail: `commands_run[${i}] has no command_execution item in the job's raw.log` }];
  });
}


// The task's change as the patch text the review reads. A lead that wants to see it would run git by hand in the task
// worktree, where the git pointer and the attribute files are the worker's, so this runs the review's own bound,
// confined staging instead. It records no review, so accept still wants one.
export function taskDiff(cwd: string, slug: string): string {
  const { root, id } = resolveProject(cwd);
  refuseUnsupported(root);
  return withProjectLock(id, () => {
    const state = loadState(id);
    const task = state.tasks[slug];
    if (task === undefined) throw new Error(`no task ${slug}; mandor status lists the tasks`);
    if (task.worktree === null || task.base === null) throw new Error(`task ${slug} has no worktree or base; the task's records are damaged: tell the user`);
    // Staging takes the worktree's index lock, which a worker in the middle of a git command would meet.
    refuseOpenJob(state, slug);
    recoverRebaseLocked(root, id, task);
    return maskControls(gitStep(`stage task ${slug} for its diff`, () => stagedDiff(root, task.worktree!, task.base!)).text);
  })!;
}

export function reviewPack(cwd: string, slug: string): ReviewPack {
  const { root, id } = resolveProject(cwd);
  // Staging the worktree would run a driver configured since dispatch, as accept's staging would.
  refuseUnsupported(root);
  // Under the project lock, so that it does not run while an accept stages and commits the same worktree.
  return withProjectLock(id, () => {
    const state = loadState(id);
    const task = state.tasks[slug];
    if (task === undefined) throw new Error(`no task ${slug}; mandor status lists the tasks`);
    if (task.worktree === null || task.base === null) throw new Error(`task ${slug} has no worktree or base; the task's records are damaged: tell the user`);
    // A rebase killed after its reset left the goal's own changes in the worktree, which the pack would read as the task's.
    recoverRebaseLocked(root, id, task);
    const project = loadProjectConfig(id);
    const { text, stat, tree } = gitStep(`stage task ${slug} for its review`, () => stagedDiff(root, task.worktree!, task.base!));
    const files = changedPaths(text);

    // Added and removed lines per file; headers before the first hunk are not content.
    const added = files.map(() => [] as string[]);
    const removed = files.map(() => [] as string[]);
    let at = -1, hunk = false;
    for (const line of text.split("\n")) {
      if (line.startsWith("diff --git ")) [at, hunk] = [at + 1, false];
      else if (line.startsWith("@@")) hunk = true;
      else if (hunk && line[0] === "+") added[at].push(line.slice(1));
      else if (hunk && line[0] === "-") removed[at].push(line.slice(1));
    }

    const flags: { kind: string; detail: string }[] = [];
    const flag = (kind: string, detail: string) => flags.push({ kind, detail: clampDetail(detail) });
    const count = (lines: string[], re: RegExp) => lines.filter((l) => re.test(l)).length;

    files.forEach((f) => f.status === "D" && isTestFile(f.path) && flag("test-deleted", f.path));
    files.forEach((f, i) => {
      const tokens = [...new Set(added[i].flatMap((l) => l.match(SKIP) ?? []))].sort();
      if (tokens.length > 0) flag("test-skipped", `${f.path}: ${tokens.join(", ")}`);
    });
    files.forEach((f, i) => {
      const gone = count(removed[i], ASSERT);
      if (gone > 0) flag("assert-removed", `${f.path}: ${gone} removed, ${count(added[i], ASSERT)} added`);
    });
    if (task.scope.length > 0) files.forEach((f) => task.scope.some((e) => covers(e, f.path)) || flag("out-of-scope", f.path));
    files.forEach((f) => project.shared.some((e) => covers(e, f.path)) && flag("shared-path", f.path));
    files.forEach((f, i) => {
      const n = count(added[i], TODO);
      if (n > 0) flag("todo-added", `${f.path}: ${n} added`);
    });

    // The report is the one the newest job wrote, and only that job's log can confirm its claims.
    const newest = task.jobIds.at(-1);
    const round = loadRounds(id, slug).findLast((r) => existsSync(join(r.dir, "report.json")));
    const job = newest === undefined ? undefined : state.jobs[newest];
    const log = job === undefined ? "" : join(jobDir(job.id), "raw.log");
    if (round?.report && job?.seq === round.seq && existsSync(log)) {
      for (const f of unrunClaims(round.report.commands_run.map((c) => c.command), readFileSync(log, "utf8"))) flag(f.kind, f.detail);
    }

    // What the staged tree leaves out and a proof may still run: the ignored paths that changed since the first job began.
    // The ids of its jobs hold the time they were queued, which is later than the provisioning, and the margin keeps what
    // the provisioning wrote in its last seconds from counting.
    const began = task.jobIds.map((j) => /^j-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(j)).find((m) => m !== null);
    if (began !== undefined && began !== null) {
      const [y, mo, d, h, mi, s] = began.slice(1).map(Number);
      // A listing that fails is no reason to withhold the pack: the error would quote the worker's own names, so it is not passed on.
      let changed: { path: string; files: number }[] | null = null;
      try {
        changed = ignoredChanged(root, task.worktree!, Date.UTC(y, mo - 1, d, h, mi, s) + 5_000);
      } catch {}
      if (changed === null) flag("ignored-changed", "the ignored paths could not be listed, so delete them and rebuild before the proofs");
      else {
        for (const c of changed.slice(0, 10)) flag("ignored-changed", `${c.path}: ${c.files} file${c.files === 1 ? "" : "s"} changed since the first job began`);
        if (changed.length > 10) flag("ignored-changed", `and ${changed.length - 10} more ignored paths changed`);
      }
    }

    // What the newest round's report asks of the lead, by status and count; the questions stay the worker's own words.
    const ask = round?.seq === task.seq ? askOf(round.report) : null;
    if (ask !== null) flag("report-asks", ask);

    files.forEach((f) => {
      for (const [clone, globs] of Object.entries(project.generators)) {
        if (globs.some((g) => covers(g, f.path))) flag("stale-input", `${f.path}: rebuild ${clone}`);
      }
    });
    for (const h of attributionHints(text)) flag("attribution-hint", `${h.path}: ${h.detail}`);

    const pack = {
      diffStat: stat, files, redFlags: flags, violations: checkDiff(text, diffDeny(project), project.nameIsWord, diffExact(project)),
      worktree: task.worktree, reportPath: round === undefined ? null : join(round.dir, "report.json"),
    };
    // What this pack shows is what accept may commit: it checks the staged tree against this record, which is written last,
    // so a review that failed on the way leaves none.
    writeJsonAtomic(reviewedFile(id, slug), { tree, at: now() });
    return pack;
  })!;
}
