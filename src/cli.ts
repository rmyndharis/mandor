import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseCandidate } from "./config.ts";
import { TIER_ORDER, tierName, type Tier, type ToolName } from "./contracts.ts";
import { scratchDir } from "./home.ts";
import { checkClonePath, checkClonePaths, emptyProjectConfig, saveProjectConfig, type ProjectConfig } from "./provision.ts";
import { GRADLE_ADD_DIRS, NETWORK_KEY, WORKER_NETWORK } from "./spikes.ts";

// Workers may get write access only to these cache directories, compared as absolute paths.
function workerAddDir(d: string): string {
  const abs = resolve(d.replace(/^~\//, `${homedir()}/`));
  const allowed = GRADLE_ADD_DIRS.map((g) => resolve(homedir(), g));
  if (!allowed.includes(abs)) throw new Error(`refusing --worker-add-dir ${d}: not one of ${allowed.join(", ")}`);
  return abs;
}

// Each run states the whole configuration, so it replaces project.json rather than merging into it.
function projectSetup(id: string, args: string[]): ProjectConfig {
  const c = emptyProjectConfig();
  const generators: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--worker-network") {
      if (WORKER_NETWORK === "forbidden" || NETWORK_KEY === null) throw new Error("refusing --worker-network: workers cannot be given network access");
      c.workerNetwork = true;
      continue;
    }
    if (flag === "--name-is-a-word") {
      c.nameIsWord = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--clone") c.clone.push(value);
    else if (flag === "--setup") c.setup = value;
    else if (flag === "--shared") c.shared.push(value);
    else if (flag === "--deny") c.deny.push(value);
    else if (flag === "--generator") generators.push(value);
    else if (flag === "--worker-add-dir") c.workerAddDirs.push(workerAddDir(value));
    else throw new Error(`unknown project setup flag: ${flag}`);
  }
  // Checked after every flag is read, so each --deny applies whatever the order.
  c.clone = checkClonePaths(c.clone, c.deny);
  const byPath = new Map<string, string[]>(); // fromEntries keeps a path named __proto__ an ordinary key
  for (const g of generators) {
    const eq = g.indexOf("=");
    const key = eq > 0 ? checkClonePath(g.slice(0, eq), c.deny) : "";
    if (!c.clone.includes(key) || eq === g.length - 1) throw new Error(`refusing --generator ${g}: expected <clone path>=<glob> naming a --clone path`);
    byPath.set(key, [...(byPath.get(key) ?? []), g.slice(eq + 1)]);
  }
  c.generators = Object.fromEntries(byPath);
  saveProjectConfig(id, c);
  return c;
}

class UsageError extends Error {}

// --flag value pairs. A flag listed in many may repeat; any other may appear once.
function flags(args: string[], one: string[], many: string[] = []): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (!one.includes(flag) && !many.includes(flag)) throw new UsageError(`unknown option: ${flag}`);
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    if (one.includes(flag) && out.has(flag)) throw new UsageError(`${flag} may be given once`);
    out.set(flag, [...(out.get(flag) ?? []), value]);
  }
  return out;
}

function required(f: Map<string, string[]>, flag: string): string {
  const v = f.get(flag)?.[0];
  if (v === undefined) throw new UsageError(`${flag} is required`);
  return v;
}

const optional = (f: Map<string, string[]>, flag: string) => f.get(flag)?.[0] ?? null;

// A scope entry with no glob character and no file extension names a directory (src, src/, .github), which covers
// everything under it; as a bare path it would match only itself and flag every file inside as out of scope. An
// extension is a dot after another character of the last segment: the leading dot of .github or .vscode is none.
function scopeGlob(entry: string): string {
  const plain = entry.replace(/\/+$/, "");
  return plain === "" || /[*?[]/.test(plain) || /[^/.]\.[^/]*$/.test(plain) ? entry : `${plain}/**`;
}

// The lead's commands; each returns what is printed as JSON. Imported on use, like the commands above.
async function leadCommand(argv: string[]): Promise<unknown> {
  const cwd = process.cwd();
  const [cmd, sub, ...rest] = argv;
  const tasks = () => import("./tasks.ts");
  if (cmd === "scratch" && argv.length <= 2) return { dir: scratchDir((await tasks()).resolveProject(cwd).id, sub ?? "default") };
  if (cmd === "goal" && sub === "start" && rest.length % 2 === 1) {
    return (await tasks()).goalStart(cwd, rest[0], optional(flags(rest.slice(1), ["--from"]), "--from"));
  }
  if (cmd === "plan" && sub === "set") {
    const f = flags(rest, ["--goal", "--file", "--description"]);
    return (await tasks()).planSet(cwd, required(f, "--goal"), required(f, "--file"), required(f, "--description"));
  }
  if (cmd === "dispatch") {
    const f = flags(argv.slice(1), ["--goal", "--task", "--tier", "--brief", "--use", "--after"], ["--scope"]);
    const tier = tierName(required(f, "--tier")) as Tier;
    if (!TIER_ORDER.includes(tier)) throw new UsageError(`--tier must be one of ${TIER_ORDER.join(", ")}`);
    const use = optional(f, "--use");
    return (await tasks()).dispatch(cwd, {
      goal: required(f, "--goal"), slug: required(f, "--task"), tier, briefFile: required(f, "--brief"),
      scope: (f.get("--scope") ?? []).map(scopeGlob), use: use === null ? null : parseCandidate(use), after: optional(f, "--after"),
    });
  }
  if (cmd === "wait") {
    const f = flags(argv.slice(1), ["--since", "--timeout"]);
    const since = required(f, "--since");
    const timeout = optional(f, "--timeout");
    if (!/^\d+$/.test(since)) throw new UsageError("--since needs the cursor an earlier command printed");
    if (timeout !== null && !(Number(timeout) > 0)) throw new UsageError("--timeout needs a number of seconds above 0");
    const { waitForNext } = await import("./wait.ts");
    return waitForNext(cwd, { since: Number(since), timeoutMs: timeout === null ? null : Number(timeout) * 1000 });
  }
  if (cmd === "verdict" && sub !== undefined && rest[0] === "accept") {
    const f = flags(rest.slice(1), ["--evidence-file", "--message-file"]);
    return (await tasks()).verdictAccept(cwd, sub, required(f, "--evidence-file"), required(f, "--message-file"));
  }
  if (cmd === "verdict" && sub !== undefined && rest[0] === "fix") {
    const f = flags(rest.slice(1), ["--notes"]);
    return (await tasks()).verdictFix(cwd, sub, required(f, "--notes"));
  }
  if (cmd === "verdict" && sub !== undefined && rest[0] === "takeover") {
    const [, flag, extra] = rest;
    if (extra !== undefined || (flag !== undefined && flag !== "--approved")) throw new UsageError(`unknown option: ${extra ?? flag}`);
    return (await tasks()).takeover(cwd, sub, flag !== undefined);
  }
  if (cmd === "confirm" && sub !== undefined) {
    const f = flags(rest, ["--evidence-file"]);
    return (await tasks()).confirm(cwd, sub, required(f, "--evidence-file"));
  }
  if (cmd === "drop" && sub !== undefined) {
    const f = flags(rest, ["--notes"]);
    return (await tasks()).drop(cwd, sub, required(f, "--notes"));
  }
  if (cmd === "reassign" && sub !== undefined && rest.length === 0) return (await tasks()).reassign(cwd, sub);
  if (cmd === "ready" && sub !== undefined && rest.length === 0) return (await tasks()).ready(sub as ToolName);
  if (cmd === "cancel" && sub !== undefined && rest.length === 0) return (await tasks()).cancel(cwd, sub);
  if (cmd === "review" && sub !== undefined && rest.length === 0) return (await import("./review.ts")).reviewPack(cwd, sub);
  throw new UsageError(`unknown command: ${argv.join(" ")}; see mandor --help`);
}

// One line per command, in the two groups the README lists them in. The runner and the hooks are the tool's own.
const USAGE = `mandor <command>

You run:
  init                          create the home and its config, read the model list, print warnings
  models [--refresh] [--json]   list the models the enabled tools offer
  login zcode [zai|bigmodel] [--api-key]
                                sign the zcode worker in under a home of its own: in a browser, or with a
                                Coding Plan API key piped in
  project setup [--clone <path>]... [--setup <command>] [--shared <glob>]... [--deny <glob>]...
                [--generator <clone path>=<glob>]... [--worker-network] [--worker-add-dir <dir>]...
                [--name-is-a-word]
  status [--json]               goals, tasks, jobs and exhausted tools of this repository
  show <slug>                   a task's outcome, its jobs with the usage of each run, and its round files
  logs <slug>                   the paths of a task's job logs
  --version
  --help

The lead runs:
  scratch [name]                print the directory for briefs, plans, notes and evidence files
  goal start <branch> [--from <ref>]
  plan set --goal <branch> --file <plan file> --description <one line>
  dispatch --goal <branch> --task <slug> --tier <${TIER_ORDER.join("|")}> --brief <file>
           [--scope <glob>]... [--use <tool:model@effort>] [--after <slug>]
  wait --since <cursor> [--timeout <seconds>]
  review <slug>
  verdict <slug> accept --evidence-file <file> --message-file <file>
  verdict <slug> fix --notes <file>
  verdict <slug> takeover [--approved]
  confirm <slug> --evidence-file <file>
  drop <slug> --notes <file>
  reassign <slug>
  ready <tool>
  cancel <slug>`;

export async function main(argv: string[]): Promise<number> {
  // Every Claude Code session runs this, in every directory, so nothing that goes wrong here may reach the session.
  if (argv[0] === "hook") {
    try {
      const { runHook } = await import("./hooks.ts");
      await runHook(argv.slice(1));
    } catch (e) {
      // Its own try, so a home that cannot be written stays silent too.
      try {
        const [{ appendFileSync }, { join }, { mandorHome }, { clampDetail, ensureDir }] = await Promise.all([
          import("node:fs"), import("node:path"), import("./home.ts"), import("./store.ts"),
        ]);
        const logs = join(mandorHome(), "logs");
        ensureDir(logs);
        appendFileSync(join(logs, "hooks.log"), `${new Date().toISOString()} ${clampDetail(`${argv.join(" ")}: ${(e as Error).message}`)}\n`, { mode: 0o600 });
      } catch {}
    }
    return 0;
  }
  // Hidden: the detached runner that spawnRunner launches for one job.
  if (argv[0] === "_run") {
    if (argv.length !== 2 || !/^j-\d{14}-[0-9a-f]{4}$/.test(argv[1])) {
      console.error("mandor: usage: _run <jobId>");
      return 2;
    }
    const { logRunner, runJob } = await import("./runner.ts");
    try {
      await runJob(argv[1]);
      return 0;
    } catch (e) {
      // A detached runner's stdio goes nowhere, so the log is its only trace of a failure.
      logRunner(`job ${argv[1]}: ${(e as Error).message}`);
      console.error(`mandor: ${(e as Error).message}`);
      return 1;
    }
  }
  // Also after a command, where a lead looks for that command's options.
  if (argv.length === 0 || argv[0] === "--help" || argv.slice(1).includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === "models" || argv[0] === "init") {
    // Imported on use, so other commands, the hooks above all, never load the vendor adapter.
    const [{ join }, { loadConfig }, { confineProblem }, { mandorHome }, { modelsReport }, { tierWarnings }] = await Promise.all([
      import("node:path"), import("./config.ts"), import("./git.ts"), import("./home.ts"), import("./adapters/index.ts"), import("./routing.ts"),
    ]);
    const init = argv[0] === "init";
    const bad = argv.slice(1).find((a) => init || (a !== "--refresh" && a !== "--json"));
    if (bad !== undefined) {
      console.error(`mandor: unknown option for ${argv[0]}: ${bad}`);
      return 2;
    }
    try {
      const cfg = loadConfig();
      const r = modelsReport(cfg, init || argv.includes("--refresh"));
      r.warnings.push(...tierWarnings(cfg, r.models));
      const confine = init ? confineProblem() : null;
      if (confine !== null) r.warnings.push(confine);
      const home = mandorHome();
      if (init) console.log(JSON.stringify({ home, config: join(home, "config.json"), codexVersion: r.codexVersion, models: r.models.length, warnings: r.warnings }, null, 2));
      else if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
      else {
        for (const m of r.models) console.log(`${m.model} ${m.efforts.join(",")} default ${m.defaultEffort ?? "none"}${m.hidden ? " hidden" : ""}`);
        for (const w of r.warnings) console.log(`warning: ${w}`);
      }
      return 0;
    } catch (e) {
      console.error(`mandor: ${(e as Error).message}`);
      return 1;
    }
  }
  if (argv[0] === "login") {
    const tool = argv[1];
    const withKey = argv.filter((a) => a === "--api-key").length;
    const [provider = "zai", extra] = argv.slice(2).filter((a) => a !== "--api-key");
    if (tool !== "zcode" || extra !== undefined || withKey > 1 || (provider !== "zai" && provider !== "bigmodel")) {
      console.error("mandor: usage: login zcode [zai|bigmodel] [--api-key]");
      return 2;
    }
    try {
      const [{ loadConfig }, { zcodeLogin, zcodeUseApiKey }] = await Promise.all([import("./config.ts"), import("./adapters/zcode.ts")]);
      if (withKey === 0) {
        console.log(JSON.stringify(zcodeLogin(loadConfig(), provider), null, 2));
        return 0;
      }
      // From a pipe only: typed at a terminal the key would show on the screen, and as an argument in every process list.
      const key = process.stdin.isTTY ? "" : readFileSync(0, "utf8").trim();
      const how = "then run `pbpaste | mandor login zcode --api-key`";
      if (key === "") throw new Error(`no API key on stdin: copy the key, ${how}`);
      // Copying the command after the key leaves the command on the clipboard. What came is never quoted back.
      if (/\s/.test(key)) throw new Error(`the text on stdin is not an API key: it holds spaces or line breaks. Copy the key alone, as the last thing copied, ${how}`);
      console.log(JSON.stringify(zcodeUseApiKey(provider, key), null, 2));
      return 0;
    } catch (e) {
      console.error(`mandor: ${(e as Error).message}`);
      return 1;
    }
  }
  if (argv[0] === "--version") {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return 0;
  }
  if (argv[0] === "project" && argv[1] === "setup") {
    try {
      const { recordRoot, resolveProject } = await import("./tasks.ts");
      const { root, id } = resolveProject(process.cwd());
      const c = projectSetup(id, argv.slice(2));
      recordRoot(id, root);
      console.log(JSON.stringify(c, null, 2));
      return 0;
    } catch (e) {
      console.error(`mandor: ${(e as Error).message}`);
      return 1;
    }
  }
  // Plain text, not the JSON the lead's commands print.
  if (argv[0] === "status" || argv[0] === "show" || argv[0] === "logs") return (await import("./status.ts")).viewMain(argv);
  try {
    console.log(JSON.stringify(await leadCommand(argv), null, 2));
    return 0;
  } catch (e) {
    console.error(`mandor: ${(e as Error).message}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
