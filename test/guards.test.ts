import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  AGENT_PATHS, ATTRIBUTION_VENDORS, attributionHints, checkCommitMessage, checkDiff, checkName, foldPath, isAgentPath, matchesGlob,
  NAME_TOKENS, type Violation,
} from "../src/guards.ts";
import { DEFAULT_DENY } from "../src/provision.ts";
import { TOOL_COMMANDS, TOOL_VARS, toolTrace } from "../src/toolname.ts";
import { tempRepo } from "./helpers.ts";

const [emDash, enDash, bar] = [0x2014, 0x2013, 0x2015].map((c) => String.fromCharCode(c));
const robot = String.fromCodePoint(0x1f916);
// Attribution samples are assembled at runtime, so no tracked file holds one literally.
const say = (...words: string[]) => words.join(" ");
const coAuthor = ["Co", "Authored", "By"].join("-");
// The tool's name too, so its forms (its home directory, variables, commands and skill ids) are assembled the same way.
const tool = ["man", "dor"].join("");
const TOOL = tool.toUpperCase();
const kinds = (v: Violation[]) => v.map((x) => x.kind);
const flagged = (line: string) => kinds(checkDiff(added("NOTES.md", [line]), [])).includes("attribution");
const credited = (msg: string) => checkCommitMessage(msg, []).some((v) => v.kind === "message" && v.detail.startsWith("attribution: "));

// A new file (a symlink with mode 120000) in the shape git diff-index prints it.
function added(path: string, lines: string[], mode = "100644"): string {
  return [`diff --git a/${path} b/${path}`, `new file mode ${mode}`, "index 0000000..1111111", "--- /dev/null", `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ""].join("\n");
}

function modified(path: string, minus: string[], plus: string[]): string {
  return [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`,
    `@@ -1,${minus.length} +1,${plus.length} @@`, ...minus.map((l) => `-${l}`), ...plus.map((l) => `+${l}`), ""].join("\n");
}

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });

// What the accept step reads: everything staged, compared without rename detection.
function stagedDiff(repo: string, ...flags: string[]): string {
  git(repo, "add", "-A");
  return git(repo, "diff-index", "--cached", "--no-renames", "--binary", ...flags, "HEAD", "--");
}

// Importing the helpers is enough: a test file that never makes a temp home still runs git without the developer's
// global and system config, whose hooks path, rerere or drivers would otherwise change what these tests see.
test("tempRepo sees no global or system git config", () => {
  const origins = git(tempRepo(), "config", "--show-origin", "--list").trim().split("\n").map((l) => l.split("\t")[0]);
  assert.deepEqual([...new Set(origins)], ["file:.git/config"]);
});

// A test process started by a git hook inherits GIT_DIR, GIT_WORK_TREE and GIT_CONFIG_* for the hook's repository;
// the helpers drop them when they load, or tempRepo would init, configure and commit in that repository.
test("the helpers drop git's location and config variables, so tempRepo leaves a decoy repository alone", () => {
  const decoy = tempRepo();
  const state = () => [git(decoy, "rev-parse", "HEAD"), git(decoy, "config", "--list", "--local"), git(decoy, "status", "--porcelain")];
  const before = state();
  const script = `import { execFileSync } from "node:child_process"; import { tempRepo } from ${JSON.stringify(join(import.meta.dirname, "helpers.ts"))};
    process.stdout.write(execFileSync("git", ["log", "--format=%s %ae", "-1"], { cwd: tempRepo(), encoding: "utf8" }));`;
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env, GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: join(decoy, ".git", "index"),
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.email", GIT_CONFIG_VALUE_0: "decoy@example.invalid", GIT_CONFIG_PARAMETERS: "'user.name=Decoy'",
    },
  });
  assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: "Initial commit test@example.invalid\n", stderr: "" });
  assert.deepEqual(state(), before, "the decoy is untouched");
});

for (const path of ["AGENTS.md", "claude.md", "CLAUDE.local.md", "AGENTS.override.md", "a/b/.claude/x", ".agent/rules/x.md",
  ".cursor/rules/style.mdc", ".github/instructions/a.instructions.md", ".windsurfrules", ".clinerules"]) {
  test(`agent path ${path} is blocked`, () => {
    assert.deepEqual(checkDiff(added(path, ["x"]), []), [{ kind: "agent-path", detail: path }]);
  });
}

test("signing.properties is blocked", () => {
  assert.deepEqual(checkDiff(added("signing.properties", ["storePassword=x"]), ["**/signing.properties"]),
    [{ kind: "denied-path", detail: "signing.properties" }]);
});

const credits: [string, string][] = [
  ["a co-author trailer", `${coAuthor}: Someone <someone@example.invalid>`],
  ["a phrase crediting Claude", say("Generated", "by", "Claude")],
  ["a trailer crediting Codex", `${["Assisted", "by"].join("-")}: Codex`],
  ["a phrase crediting a GPT model", say("Generated", "with", "GPT-6.1-Sol")],
];
for (const [name, line] of credits) {
  test(`${name} is blocked in a diff and in a commit message`, () => {
    assert.ok(flagged(line));
    assert.ok(credited(`Fix login\n\n${line}\n`));
  });
}

test("a phrase crediting protoc is allowed", () => {
  const line = say("Generated", "with", "protoc");
  assert.deepEqual(checkDiff(added("gen/Model.java", [`// ${line}`]), []), []);
  assert.deepEqual(checkCommitMessage(`Regenerate models\n\n${line}\n`, []), []);
});

test("keeping an existing em dash passes", () => {
  assert.deepEqual(checkDiff(modified("README.md", [`Setup ${emDash} old`], [`Setup ${emDash} new`]), []), []);
});

test("adding a new em dash is blocked", () => {
  assert.deepEqual(kinds(checkDiff(modified("README.md", ["Setup - old"], [`Setup ${emDash} new`]), [])), ["dash"]);
});

test("a --no-renames rename of a file that contains an em dash passes", () => {
  const repo = tempRepo();
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "old.md"), `Intro ${emDash} details\n`);
  git(repo, "add", "docs/old.md");
  git(repo, "commit", "-qm", "Add docs");
  renameSync(join(repo, "docs", "old.md"), join(repo, "docs", "new.md"));
  const diff = stagedDiff(repo);
  assert.match(diff, /^deleted file mode /m);
  assert.match(diff, /^new file mode /m);
  assert.deepEqual(checkDiff(diff, []), []);
});

test("a commit message holding one of the tool's forms is refused, one with the bare name passes", () => {
  assert.deepEqual(checkCommitMessage(`Fix it via ${tool} wait`, []), [{ kind: "message", detail: `names the tool (${tool} wait)` }]);
  assert.deepEqual(checkCommitMessage(`Read ~/.${tool}/logs`, []), [{ kind: "message", detail: `names the tool (.${tool})` }]);
  // Case and a line break between the name and the command hide nothing.
  assert.deepEqual(checkCommitMessage(`Wire ${"Man"}${"Dor"}\n  ${"Dispatch"} into the build`, []), [{ kind: "message", detail: `names the tool (${"Man"}${"Dor"} ${"Dispatch"})` }]);
  assert.deepEqual(checkCommitMessage(`Add ${tool} role to the staff form`, []), []);
});

test("a commit message naming AGENTS.md is blocked", () => {
  assert.deepEqual(kinds(checkCommitMessage("Update AGENTS.md wording", [])), ["message"]);
});

for (const name of ["fix/claude-login", "feat/ai-search", "fix/claudeLogin", "fix/gpt5-support", "fix/GPTClient", "fix/claudelogin",
  "feat/openaiclient", "feat/chatgpt-import"]) {
  test(`checkName rejects ${name}`, () => {
    assert.deepEqual(kinds(checkName(name)), ["name"]);
  });
}

// One of the tool's own forms is refused in a branch or a task slug as in a diff.
test("checkName refuses a name that holds one of the tool's forms", () => {
  assert.deepEqual(checkName(`fix/${TOOL}_JOB`), [{ kind: "name", detail: `fix/${TOOL}_JOB names the tool (${TOOL}_JOB)` }]);
});

// The tool's name is an ordinary word (a foreman), so a branch or a task slug may hold it.
for (const name of ["fix/cursor-blink", "fix/rotation-caret", "fix/aiohttp-retry", "feat/philanthropic-donors", "fix/encodexml",
  `feat/${tool}-role`, `${tool}-role`, `fix/${tool}_home-env`]) {
  test(`checkName accepts ${name}`, () => {
    assert.deepEqual(checkName(name), []);
  });
}

test("matchesGlob: _docs matches **/_docs/**", () => {
  assert.equal(matchesGlob("_docs", "**/_docs/**"), true);
});

test("checkDiff uses only the deny list it is given", () => {
  assert.deepEqual(checkDiff(added("signing.properties", ["storePassword=x"]), []), []);
});

test("matchesGlob ignores case", () => {
  assert.equal(matchesGlob("docs/claude.md", "**/CLAUDE.md"), true);
  assert.equal(matchesGlob("App/Release.JKS", "**/*.jks"), true);
});

test("matchesGlob keeps * inside one segment and lets a leading **/ match no segments", () => {
  assert.equal(matchesGlob("debug.keystore", "*.keystore"), true);
  assert.equal(matchesGlob("app/debug.keystore", "*.keystore"), false);
  assert.equal(matchesGlob("app/debug.keystore", "**/*.keystore"), true);
  assert.equal(matchesGlob(".env", "**/.env"), true);
  assert.equal(matchesGlob("a/b/.env.local", "**/.env.*"), true);
  assert.equal(matchesGlob("a/b.env", "**/.env"), false);
});

test("a glob ending in /** matches the directory itself and everything below it", () => {
  assert.equal(matchesGlob("a/.claude", "**/.claude/**"), true);
  assert.equal(matchesGlob("a/.claude/x/y", "**/.claude/**"), true);
  assert.equal(matchesGlob("build", "build/**"), true);
  assert.equal(matchesGlob("x_docs/y", "**/_docs/**"), false);
  assert.equal(matchesGlob("_docsx", "**/_docs/**"), false);
  assert.equal(matchesGlob("build/x", "build"), false);
});

test("matchesGlob treats regex characters in a glob literally", () => {
  assert.equal(matchesGlob("a+b (1).txt", "a+b (1).txt"), true);
  assert.equal(matchesGlob("aab 1xtxt", "a+b (1).txt"), false);
});

test("checkName ignores case and rejects names unsafe as a git ref or a path segment", () => {
  assert.deepEqual(kinds(checkName("feat/AI-search")), ["name"]);
  for (const name of ["", "fix/a b", "fix/caf\u00e9", "fix/a~b", "fix/a:b", "/fix", "fix/", "fix//a", "..", "fix/../x", "fix/.hidden",
    ".fix", "-fix", "fix/-x", "fix.lock", "fix/x.lock", "fix/x.lock/y", "fix/a..b", "fix/x."]) {
    assert.deepEqual(kinds(checkName(name)), ["name"], JSON.stringify(name));
  }
  assert.deepEqual(checkName("release/1.2_rc-3"), []);
});

test("a commit message naming a deny-glob path is refused, unless the glob is one of a secret file", () => {
  assert.deepEqual(kinds(checkCommitMessage("Document the notes.private keys", ["**/notes.private"])), ["message"]);
  assert.deepEqual(kinds(checkCommitMessage("Mention (`app/vault.properties`).", ["**/vault.properties"])), ["message"]);
  assert.deepEqual(checkCommitMessage("Rotate the vault setup", ["**/vault.properties"]), []);
  // A message that names a secret file gives nothing away, and the diff is where such a file is kept out.
  assert.deepEqual(checkCommitMessage("Document the .env.local keys", ["**/.env.*"]), []);
  assert.deepEqual(checkCommitMessage("Mention (`app/signing.properties`).", ["**/signing.properties"]), []);
});

test("the templates of a .env file pass the default deny list, every other .env file stays denied", () => {
  const deny = [...DEFAULT_DENY];
  for (const p of [".env.example", "api/.env.sample", ".env.template", "deploy/.env.dist", "api/.ENV.Example"]) {
    assert.deepEqual(checkDiff(added(p, ["KEY="]), deny), [], p);
    assert.deepEqual(checkCommitMessage(`Add ${p} template`, deny), [], p);
  }
  for (const p of [".env", ".env.production", "api/.env.local", ".env.example.bak", "x/.env.sample.local"]) {
    assert.deepEqual(checkDiff(added(p, ["KEY=1"]), deny), [{ kind: "denied-path", detail: p }], p);
    // Only a diff keeps the file out: a message may name it.
    assert.deepEqual(checkCommitMessage(`Document the ${p} keys`, deny), [], p);
  }
  // Another glob that matches a template still denies it.
  assert.deepEqual(checkDiff(added("secret/.env.example", ["KEY="]), [...deny, "secret/**"]), [{ kind: "denied-path", detail: "secret/.env.example" }]);
  assert.deepEqual(checkDiff(added(".env.example", ["KEY="]), [...deny, "**/.env.example"]), [{ kind: "denied-path", detail: ".env.example" }]);
});

test("a basename starting with claude., agents. or gemini. is an agent path only when it ends in .md", () => {
  for (const p of ["src/api/claude.ts", "agents.py", "lib/Agents.swift", "lib/gemini.kt", "claude.json", "GEMINI.toml"]) {
    assert.equal(isAgentPath(p), false, p);
    assert.deepEqual(checkDiff(added(p, ["x"]), [...DEFAULT_DENY]), [], p);
  }
  for (const p of ["CLAUDE.md", "claude.local.md", "agents.override.md", "docs/gemini.md", "a/Claude.v2.MD", "gemini.md"]) {
    assert.equal(isAgentPath(p), true, p);
    assert.deepEqual(checkDiff(added(p, ["x"]), [...DEFAULT_DENY]), [{ kind: "agent-path", detail: p }], p);
  }
});

test("no tracked guard file holds an attribution sample, the robot emoji or a dash glyph", () => {
  const needles = [coAuthor, say("Generated", "by"), say("Generated", "with"), ["Assisted", "by"].join("-"), say("Generated", "using"),
    say("Made", "with"), say("Built", "with"), ["AI", "generated"].join("-"), ["Claude", "generated"].join("-"), `:${"robot"}:`,
    ["ai", "generated"].join("_"), robot, emDash, enDash, bar];
  for (const file of [join(import.meta.dirname, "..", "src", "guards.ts"), join(import.meta.dirname, "..", "src", "toolname.ts"), import.meta.filename]) {
    const text = readFileSync(file, "utf8").toLowerCase();
    needles.forEach((n, i) => assert.ok(!text.includes(n.toLowerCase()), `${file} holds needle ${i}`));
  }
});

// The guard and the module that knows the tool's forms build those forms at runtime, so each passes the diff check it
// implements.
test("src/guards.ts and src/toolname.ts each pass the diff check as an added file", () => {
  for (const name of ["guards.ts", "toolname.ts"]) {
    const lines = readFileSync(join(import.meta.dirname, "..", "src", name), "utf8").replace(/\n$/, "").split("\n");
    assert.deepEqual(checkDiff(added(`src/${name}`, lines), [...DEFAULT_DENY]), [], name);
  }
});

test("a hunk line starting with +++ or --- is content, not a file header", () => {
  // An added "++ x" prints as "+++ x" and a removed "-- y" as "--- y".
  assert.deepEqual(kinds(checkDiff(modified("a.md", ["old"], [`++ new ${emDash}`]), [])), ["dash"]);
  assert.deepEqual(kinds(checkDiff(modified("a.md", ["old"], [`++ ${say("Generated", "by", "Claude")}`]), [])), ["attribution"]);
  assert.deepEqual(checkDiff(modified("a.md", [`-- old ${emDash}`], [`new ${emDash}`]), []), []);
});

test("binary patch lines never count", () => {
  const binary = ["diff --git a/logo.png b/logo.png", "index 1111111..2222222 100644", "GIT binary patch", "literal 3",
    `-${emDash}`, "", "literal 3", `+${say("Generated", "by", "Claude")}`, ""].join("\n");
  // Counted, the binary lines would pay for the added dash and flag the phrase.
  assert.deepEqual(kinds(checkDiff(binary + modified("a.md", ["old"], [`new ${emDash}`]), [])), ["dash"]);
});

test("details name the path or the text, cut to 300 characters, with no dash glyph", () => {
  const long = `${"deep/".repeat(80)}CLAUDE.md`;
  const [v] = checkDiff(added(long, ["x"]), []);
  assert.equal(v.kind, "agent-path");
  assert.ok(v.detail.length <= 300 && long.startsWith(v.detail));
  assert.deepEqual(checkDiff(added("a.md", [`x ${emDash} y`]), []), [{ kind: "dash", detail: "U+2014 added 1, removed 0: a.md" }]);
  assert.deepEqual(checkDiff(added("NOTES.md", [say("Generated", "by", "Claude")]), []),
    [{ kind: "attribution", detail: `NOTES.md: ${say("generated", "by", "claude")}` }]);
});

test("the guard lists are the agreed values", () => {
  assert.deepEqual([...AGENT_PATHS], ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", "copilot-instructions.md",
    ".claude/", ".codex/", ".gemini/", ".agents/", ".agent/", ".zcode/", ".cursor/", ".github/instructions/", "zcode.json",
    ".windsurfrules", ".clinerules"]);
  assert.deepEqual([...NAME_TOKENS], ["claude", "codex", "gpt", "chatgpt", "gemini", "glm", "zcode", "agy", "antigravity", "openai",
    "anthropic", "ai"]);
  assert.deepEqual([...ATTRIBUTION_VENDORS], ["claude", "codex", "gpt", "gemini", "glm", "zcode", "agy", "antigravity", "openai",
    "anthropic", "chatgpt", "copilot", "cursor", "llm", "genai", "ai"]);
});

test("each glyph is counted on its own, summed over the whole diff", () => {
  assert.deepEqual(kinds(checkDiff(modified("a.md", ["x"], [`1${enDash}2`]), [])), ["dash"]);
  assert.deepEqual(kinds(checkDiff(modified("a.md", ["x"], [`${bar} quote`]), [])), ["dash"]);
  // Removing an em dash does not pay for adding an en dash.
  assert.deepEqual(kinds(checkDiff(modified("a.md", [`a ${emDash} b`], [`a ${enDash} b`]), [])), ["dash"]);
  assert.deepEqual(checkDiff(modified("a.md", [`a ${emDash} b`], ["a b"]) + modified("b.md", ["c d"], [`c ${emDash} d`]), []), []);
});

test("a new file whose name holds an em dash is blocked", () => {
  const repo = tempRepo();
  writeFileSync(join(repo, `notes ${emDash} draft.md`), "plain text\n");
  assert.deepEqual(kinds(checkDiff(stagedDiff(repo), [])), ["dash"]);
});

test("renaming a file whose name holds an em dash passes", () => {
  const repo = tempRepo();
  writeFileSync(join(repo, `a ${emDash} b.md`), "plain text\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "Add notes");
  renameSync(join(repo, `a ${emDash} b.md`), join(repo, `c ${emDash} d.md`));
  assert.deepEqual(checkDiff(stagedDiff(repo), []), []);
});

test("a symlink to an agent file or a denied path is blocked, new or retargeted", () => {
  assert.deepEqual(checkDiff(added("docs/guide.md", ["../CLAUDE.md"], "120000"), []),
    [{ kind: "agent-path", detail: "docs/guide.md -> ../CLAUDE.md" }]);
  const retarget = ["diff --git a/link b/link", "index 1111111..2222222 120000", "--- a/link", "+++ b/link", "@@ -1 +1 @@",
    "-README.md", "\\ No newline at end of file", "+_docs/plan.md", "\\ No newline at end of file", ""].join("\n");
  assert.deepEqual(checkDiff(retarget, ["**/_docs/**"]), [{ kind: "denied-path", detail: "link -> _docs/plan.md" }]);
  // In a regular file the same text is not a path.
  assert.deepEqual(checkDiff(added("docs/guide.md", ["../CLAUDE.md"]), []), []);
});

test("a symlink named like an agent directory is blocked", () => {
  assert.deepEqual(checkDiff(added(".claude", ["/tmp/elsewhere"], "120000"), []), [{ kind: "agent-path", detail: ".claude" }]);
});

test("case folding, invisible characters and padding do not hide an agent path", () => {
  const zw = String.fromCharCode(0x200b);
  // APFS opens the long s as s and the Kelvin sign as k.
  for (const p of [`AGENT${String.fromCharCode(0x17f)}.md`, `CLAUDE${zw}.md`, ".cursorrules ", `src/.Co${zw}dex/config.toml`, "\uff23LAUDE.md"]) {
    assert.equal(isAgentPath(p), true, p);
  }
  assert.equal(matchesGlob(`debug.${String.fromCharCode(0x212a)}eystore`, "**/*.keystore"), true);
  assert.equal(isAgentPath(`src/${tool}/cli.ts`), false);
  // A two-segment entry needs both segments, next to each other.
  assert.equal(isAgentPath("a/.github/instructions"), true);
  assert.equal(isAgentPath(".github/workflows/ci.yml"), false);
  assert.equal(isAgentPath("docs/instructions/setup.md"), false);
});

test("spacing, wrapping and invisible characters do not hide attribution", () => {
  const zw = String.fromCharCode(0x200b);
  const lines = [
    say("Generated ", " by ", " Claude"),
    ["Generated", "by", "Claude"].join("\t"),
    ["Generated", "by", "Claude"].join(String.fromCharCode(0xa0)),
    say(`Gener${zw}ated`, "by", "Claude"),
    say("Written", "by", "\uff23laude"),
    `**${"Generated"}** with Claude`,
    `${coAuthor} : Someone`,
    `**${coAuthor}**: Someone`,
    `${["Co", "authored", "by"].join(" ")}: Someone`,
    `${["Signed", "off", "by"].join("-")}: Claude`,
    `**${["Assisted", "by"].join("-")}**: Codex`,
  ];
  for (const line of lines) assert.ok(kinds(checkDiff(added("NOTES.md", [line]), [])).includes("attribution"), JSON.stringify(line));
  const opening = say("This guide was", "generated", "with");
  assert.ok(kinds(checkDiff(added("README.md", [opening, "Claude Code and reviewed."]), [])).includes("attribution"));
  assert.ok(credited(`Add guide\n\n${opening}\nClaude Code.\n`));
  assert.ok(kinds(checkDiff(added(`docs/${["generated", "by", "claude"].join("-")}.md`, ["x"]), [])).includes("attribution"));
});

// One hunk whose lines carry their own sign, so context and removed lines can sit between added ones.
function hunk(path: string, lines: string[]): string {
  const minus = lines.filter((l) => l[0] !== "+").length, plus = lines.filter((l) => l[0] !== "-").length;
  return [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`, `@@ -1,${minus} +1,${plus} @@`, ...lines, ""].join("\n");
}

test("a credit on one added line and a vendor on the next tie only when the credit ends the line and the vendor opens the next", () => {
  // A generated-file header, then the package line of an ordinary source file: the header ends in prose.
  const header = [`// Code ${say("generated", "by")} Fern. DO NOT EDIT.`, "package llmconnections"];
  assert.deepEqual(checkDiff(added("client.go", header), []), []);
  // A connector that is no credit, and a next line that opens with a word.
  assert.deepEqual(checkDiff(added("NOTES.md", ["Sorted by", "name and date."]), []), []);
  assert.deepEqual(checkDiff(added("NOTES.md", [say("This guide was", "generated", "with"), "care by the team, then Claude Code reviewed it."]), []), []);
  // A wrapped credit, with punctuation at the break too.
  const opening = say("This guide was", "generated", "with");
  assert.deepEqual(checkDiff(added("README.md", [opening, "Claude Code and reviewed."]), []), [{ kind: "attribution", detail: `README.md: ${say("generated", "with", "claude")}` }]);
  assert.ok(kinds(checkDiff(added("README.md", [`${opening}:`, `  *Claude Code*.`]), [])).includes("attribution"));
  // A context line, a removed line or a hunk header between the two lines breaks the pair.
  assert.deepEqual(checkDiff(hunk("README.md", [`+${opening}`, " a line kept", "+Claude Code."]), []), []);
  assert.deepEqual(checkDiff(hunk("README.md", [`+${opening}`, "-an old line", "+Claude Code."]), []), []);
  assert.deepEqual(checkDiff(hunk("README.md", [`+${opening}`]) + "@@ -9,0 +9,1 @@\n+Claude Code.\n", []), []);
  // On one line the same words still block, as does a snake_case key.
  assert.ok(flagged(say("This guide was", "generated", "with", "Claude Code.")));
  assert.ok(flagged(`${["generated", "by", "claude"].join("_")}: true`));
});

test("a snake_case key that ends an added line does not pair with the next line, while a prose credit does", () => {
  const flaggedLines = (lines: string[]) => kinds(checkDiff(added("src/q.py", lines), [])).includes("attribution");
  const snake = (...words: string[]) => words.join("_");
  // The next line of a SQL, Python or YAML block holds a column or value of its own.
  const keyed: [string, string][] = [
    [`SELECT id, ${snake("created", "by")}`, "     , gpt_model FROM runs"],
    [`${snake("built", "with")} = (`, "  'gpt-4o'"],
    [`${snake("reviewed", "by")}:`, "gemini: true"],
  ];
  for (const pair of keyed) assert.equal(flaggedLines(pair), false, pair.join(" / "));
  // A prose credit that ends the line still ties to the vendor that opens the next.
  assert.ok(flaggedLines([`# ${say("reviewed", "by")}:`, 'claude_model = "x"']));
  assert.ok(flagged(`# ${say("reviewed", "by")}: claude_model = "x"`));
  // The pair verdict is the one-line verdict of the two lines joined by a space, wherever one line alone says nothing.
  const invariant: [string, string][] = [
    ...keyed.slice(0, 2),
    [say("This guide was", "generated", "with"), "Claude Code and reviewed."],
    ["Sorted by", "name and date."],
    [`# ${say("reviewed", "by")}:`, 'claude_model = "x"'],
    [say("Rows", "created", "by"), "the cursor"],
  ];
  for (const [a, b] of invariant) {
    assert.equal(flaggedLines([a]) || flaggedLines([b]), false, `${a} / ${b}: one line alone says nothing`);
    assert.equal(flaggedLines([a, b]), flagged(`${a} ${b}`), `${a} / ${b}`);
  }
  // Two shapes where the one-line rules say more than the pair: the 40-character window reaches the vendor behind a
  // generator notice's prose, and a snake_case key followed directly by a vendor is a credit on one line.
  const header = [`// Code ${say("generated", "by")} Fern. DO NOT EDIT.`, "package llmconnections"];
  assert.deepEqual([flaggedLines(header), flagged(header.join(" "))], [false, true]);
  assert.deepEqual([flaggedLines(keyed[2]), flagged(keyed[2].join(" "))], [false, true]);
});

test("a snake_case audit key ties to a vendor only right after its connector", () => {
  for (const line of [
    `    ${["created", "by"].join("_")}=request.user, model="gpt-4o",`,
    `  ${["reviewed", "by"].join("_")}: current_user, provider: "openai"`,
    `SELECT ${["generated", "by"].join("_")}, llm_model FROM runs`,
    `{ "${["edited", "by"].join("_")}": "jane", "engine": "claude" }`,
  ]) {
    assert.deepEqual(checkDiff(added("src/audit.py", [line]), []), [], line);
  }
  for (const line of [`${["generated", "by", "claude"].join("_")}: true`, `${["generated", "by"].join("_")}: claude`, `"${["created", "by"].join("_")}": "gpt-4o"`,
    `${["generated", "by"].join("_")}=codex`]) {
    assert.ok(flagged(line), line);
  }
});

test("the robot emoji is blocked in a diff and in a commit message", () => {
  assert.deepEqual(kinds(checkDiff(added("NOTES.md", [`${robot} done`]), [])), ["attribution"]);
  assert.deepEqual(kinds(checkCommitMessage(`Fix login ${robot}`, [])), ["message"]);
});

test("a commit message with a dash glyph or an agent path inside other text is refused", () => {
  assert.deepEqual(checkCommitMessage(`Fix caret ${enDash} rotation`, []), [{ kind: "message", detail: "dash: U+2013" }]);
  assert.deepEqual(checkCommitMessage("Drop **AGENTS.md** and x.CLAUDE.md mentions", []),
    [{ kind: "message", detail: "agent path: agents.md" }, { kind: "message", detail: "agent path: claude.md" }]);
  assert.deepEqual(checkCommitMessage("Fix rotation caret drift\n\nThe caret moved after a rotation; see docs/editor.md.", ["**/.env"]), []);
});

test("credit phrases with made, built, using or via and a vendor within 40 characters are blocked", () => {
  for (const line of [
    say("Made", "with", "Claude"),
    say("Built", "with", "Claude", "Code"),
    say("Generated", "using", "Claude"),
    say("Written", "via", "Codex"),
    say("Generated", "with", "x".repeat(38), "Claude"),
  ]) {
    assert.ok(flagged(line), line);
    assert.ok(credited(`Add notes\n\n${line}\n`), line);
  }
  // 41 characters between the connector and the vendor no longer tie them together.
  assert.deepEqual(checkDiff(added("NOTES.md", [say("Generated", "with", "x".repeat(39), "Claude")]), []), []);
  // from is too weak a connector to block (built from the cursor), so it only hints.
  const weak = added("NOTES.md", [say("Created", "from", "a", "GPT", "draft")]);
  assert.deepEqual(checkDiff(weak, []), []);
  assert.equal(attributionHints(weak).length, 1);
});

test("ai standing alone right before a credit word is blocked, underscores included", () => {
  for (const word of ["generated", "assisted", "written", "authored"]) {
    for (const sep of ["-", " ", "_"]) {
      const line = `Some ${["AI", word].join(sep)} code`;
      assert.ok(kinds(checkDiff(added("NOTES.md", [line]), [])).includes("attribution"), line);
    }
  }
  const snake = (...words: string[]) => words.join("_");
  for (const line of [`${snake("ai", "generated")}: true`, `${snake("AI", "GENERATED")} = True`, `${snake("ai", "assisted")}: true`,
    `  "${snake("ai", "generated")}": true,`, `${snake("generated", "by", "ai")}: true`, `${snake("generated", "with", "ai")}: true`,
    `${snake("is", "ai", "generated")}: true`]) {
    assert.ok(flagged(line), line);
    assert.ok(credited(`Update flags\n\n${line}\n`), line);
  }
  // Inside a longer word ai is no credit.
  for (const line of [`A ${["detail", "generated"].join("-")} report`, say("Generated", "by", "aiohttp_client"), say("Built", "from", "mai_tai")]) {
    assert.deepEqual(checkDiff(added("NOTES.md", [line]), []), [], line);
  }
});

test("dash counts skip a file whose changed lines hold a NUL byte, the other checks still apply to it", () => {
  const nul = String.fromCharCode(0);
  const repo = tempRepo();
  mkdirSync(join(repo, ".claude"));
  // A binary file whose bytes happen to decode to an em dash in the text view.
  writeFileSync(join(repo, "blob.bin"), `PK${nul}${nul}x${emDash}y\n`);
  writeFileSync(join(repo, "notes.bin"), `MZ${nul}${nul}\n${say("Generated", "by", "Claude")}\n`);
  writeFileSync(join(repo, ".claude", "cache.bin"), `${nul}${nul}\n`);
  writeFileSync(join(repo, "release.keystore"), `${nul}${nul}\n`);
  const diff = stagedDiff(repo, "--text");
  assert.ok(diff.includes(nul) && diff.includes(emDash));
  assert.deepEqual(checkDiff(diff, ["**/*.keystore"]), [
    { kind: "agent-path", detail: ".claude/cache.bin" },
    { kind: "denied-path", detail: "release.keystore" },
    { kind: "attribution", detail: `notes.bin: ${say("generated", "by", "claude")}` },
  ]);
  // The skip is per file: a text file's new dash in the same diff still counts.
  assert.deepEqual(checkDiff(added("blob.bin", [`PK${nul}x${emDash}`]) + added("a.md", [`x ${emDash} y`]), []),
    [{ kind: "dash", detail: "U+2014 added 1, removed 0: a.md" }]);
});

test("a by: key and a vendor word far apart on one long line pass, a trailer naming a vendor does not", () => {
  const bundle = `{updated_by:e,${"x=1,".repeat(100)}cursor:t,strategy:s}`;
  assert.deepEqual(checkDiff(added("dist/app.min.js", [bundle]), []), []);
  const trailer = `${["Signed", "off", "by"].join("-")}: Claude <someone@example.invalid>`;
  assert.deepEqual(checkDiff(added("NOTES.md", [trailer]), []), [{ kind: "attribution", detail: `NOTES.md: ${trailer.toLowerCase()}` }]);
});

test("long lines are scanned in linear time", () => {
  const lines = ["order_by:x,".repeat(30000), "a-".repeat(150000), "f0".repeat(150000), ` ${" ".repeat(300000)}by`,
    "claude ".repeat(40000), "gpt-4 ".repeat(40000), "claude 1.2 ".repeat(30000), "author:".repeat(40000),
    `${say("generated", "by")} <`.repeat(20000), "x-by: ".repeat(40000), `${tool} `.repeat(40000), `${tool}${" ".repeat(300000)}x`];
  const start = Date.now();
  checkDiff(added("dist/app.min.js", lines), []);
  checkCommitMessage(lines.join("\n"), []);
  attributionHints(added("dist/app.min.js", lines));
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
});

test("a vendor must start a word: ordinary words and surnames that hold one pass", () => {
  for (const line of [
    say("Orders are", "created", "by", "the fulfillment worker"),
    say("A grant", "made", "by", "a philanthropic foundation"),
    say("Index", "built", "from", "a precursor table"),
    say("// Buffer", "built", "from", "msgPtr"),
    say("//  Created", "by", "Peter Nagy on 3/4/21."),
    `${["Signed", "off", "by"].join("-")}: Peter Nagy <peter@example.invalid>`,
  ]) {
    assert.deepEqual(checkDiff(added("NOTES.md", [line]), []), [], line);
    assert.deepEqual(checkCommitMessage(`Update notes\n\n${line}\n`, []), [], line);
  }
});

test("a vendor glued to a version, a product word or a plural still counts", () => {
  for (const vendor of ["ChatGPT", "Claude3", "ClaudeCode", "LLMs", "GPT-6.1-Sol", "gpt4o"]) {
    const line = say("Generated", "with", vendor);
    assert.ok(flagged(line), line);
    assert.ok(credited(`Update notes\n\n${line}\n`), line);
  }
});

test("Unicode hyphens and the banned dashes act as hyphens in every rule", () => {
  const [nbHyphen, hyphen, minus] = [0x2011, 0x2010, 0x2212].map((c) => String.fromCharCode(c));
  for (const line of [`Some ${["AI", "generated"].join(nbHyphen)} code`, `Some ${["AI", "generated"].join(hyphen)} code`,
    `${["Co", "authored", "by"].join(nbHyphen)}: Claude <noreply@example.invalid>`, `${["Assisted", "by"].join(minus)}: Codex`]) {
    assert.ok(flagged(line), line);
  }
  // Removing two en dashes elsewhere pays for the glyphs, not for the trailer they spell.
  const v = checkDiff(added("NOTES.md", [`${["Co", "Authored", "By"].join(enDash)}: Claude <noreply@example.invalid>`]) +
    modified("old.md", [`a ${enDash} b ${enDash} c`], ["a b c"]), []);
  assert.ok(kinds(v).includes("attribution") && !kinds(v).includes("dash"));
  assert.equal(isAgentPath(`.github/copilot${nbHyphen}instructions.md`), true);
});

test("a vendor right before a credit word is blocked", () => {
  for (const vendor of ["Claude", "GPT", "LLM", "Copilot", "Codex", "ChatGPT", "Gemini"]) {
    const line = `Some ${[vendor, "generated"].join("-")} tests`;
    assert.ok(flagged(line), line);
  }
  assert.ok(flagged(say("Some", "Claude", "assisted", "refactor")));
});

test("underscores around the connector still tie a credit verb to a vendor", () => {
  const key = ["generated", "by", "claude"].join("_");
  assert.ok(flagged(`${key}: true`));
  assert.ok(kinds(checkDiff(added(`docs/${key}.md`, ["x"]), [])).includes("attribution"));
  // The connector must still end there: bytes is not by.
  assert.deepEqual(checkDiff(added("NOTES.md", [say("The", "generated", "bytes", "feed", "claude_parser")]), []), []);
});

test("only a hyphen before by makes a trailer, so keys and prose pass", () => {
  for (const line of ["  orders(order_by: {cursor: asc}) { id }", "Sort by: cursor position", "  group_by: :fulfillment_status"]) {
    assert.deepEqual(checkDiff(added("q.graphql", [line]), []), [], line);
  }
  assert.ok(flagged(`${["Helped", "by"].join("-")}: Copilot`));
});

test("commit-message paths are found inside emphasis marks and before a possessive", () => {
  const deny = ["**/vault.properties", "**/.vault", "**/_docs/**"];
  for (const msg of ["Remove **vault.properties** from the build", "Remove *app/vault.properties* from the build",
    "Explain vault.properties's keys", "Drop the ~~.vault~~ file", "Move notes into _docs/plan.md"]) {
    assert.ok(checkCommitMessage(msg, deny).some((v) => v.detail.startsWith("denied path: ")), msg);
  }
});

test("a commit message may name a secret file, but not a private path or one the project denies", () => {
  const deny = [...DEFAULT_DENY, "secret/**"];
  for (const msg of ["Document the .env variables", "Load .env.local in development", "Read release.keystore from the CI secret",
    "Move signing.properties handling to Gradle", "Keep upload.jks out of the build", "Fix keystore path lookup"]) {
    assert.deepEqual(checkCommitMessage(msg, deny), [], msg);
  }
  for (const msg of ["Move notes into _docs/plan.md", "Add secret/key.txt", "Edit CLAUDE.md", "Add notes to .claude/settings.json"]) {
    assert.ok(checkCommitMessage(msg, deny).length > 0, msg);
  }
});

test("more credit forms are blocked: developed, produced, drafted, author tags and the robot shortcode", () => {
  for (const line of [
    say("Developed", "with", "Claude", "Code"),
    say("Produced", "with", "ChatGPT"),
    say("Drafted", "by", "Claude"),
    say(" * @author", "Claude"),
    say("Author:", "Claude"),
    `  "author": "${"Claude"} <noreply@example.invalid>",`,
    `:${"robot"}: done`,
  ]) {
    assert.ok(flagged(line), line);
    assert.ok(credited(`Update notes\n\n${line}\n`), line);
  }
  assert.deepEqual(checkDiff(added("NOTES.md", [say(" * @author", "Jane Doe")]), []), []);
});

// Each form of the tool's name, with the trace it reports: its home directory as a path component, each of its
// variables, each of its commands (also through a path to the launcher and in capitals) and each skill id.
const traces: [string, string][] = [
  ...[`See /home/dev/.${tool}/worktrees/app/task-login/src/app.ts`, `cd ~/.${tool}`, `.${tool}/notes.md`, `$HOME/.${tool}`,
    `\${HOME}/.${tool}/config.json`, `/Users/x/.${tool}`, `../../.${tool}`, `C:\\Users\\x\\.${tool}\\w`,
    // At the end of a sentence or inside punctuation.
    `State lives in ~/.${tool}.`, `see ~/.${tool}...`, `~/.${tool},`, `(~/.${tool})`].map((t): [string, string] => [t, `.${tool}`]),
  ...["HOME", "CODEX_BIN", "JOB"].map((v): [string, string] => [`export ${TOOL}_${v}=/tmp/x`, `${TOOL}_${v}`]),
  ...TOOL_COMMANDS.map((c): [string, string] => [`then run ${tool} ${c} once`, `${tool} ${c}`]),
  [`bin/${tool} wait --since 3`, `${tool} wait`],
  [`./${tool} wait`, `${tool} wait`],
  [`Run ${TOOL} VERDICT a accept`, `${TOOL} VERDICT`],
  [`/${tool}:status`, `/${tool}:status`],
  [`see ${tool}:lead`, `${tool}:lead`],
  // A closing quote or backtick after a launcher path, escaped too as inside a JSON string.
  [`"\${CLAUDE_PLUGIN_ROOT}/bin/${tool}" hook session-start`, `${tool}" hook`],
  [`"/opt/x/bin/${tool}" dispatch --goal x`, `${tool}" dispatch`],
  [`'/opt/x/bin/${tool}' dispatch --goal x`, `${tool}' dispatch`],
  // A quoted command word, which a shell runs as the word itself.
  [`${tool} "wait"`, `${tool} "wait`],
  [`run ${tool} 'dispatch' --goal x`, `${tool} 'dispatch`],
  [`"command": "\\"\${CLAUDE_PLUGIN_ROOT}/bin/${tool}\\" hook stop"`, `${tool}\\" hook`],
  [`sh -c "/opt/x/bin/${tool}\\" dispatch --goal x"`, `${tool}\\" dispatch`],
  // In source text a backslash escape before the name or between it and the command is a line break or a tab.
  [`const usage = "Usage:\\n${tool} wait --since N";`, `${tool} wait`],
  [`printf 'x\\n${tool} wait'`, `${tool} wait`],
  [`echo -e "a\\t${tool} dispatch --goal x"`, `${tool} dispatch`],
  [`{"cmd": "${tool}\\nwait"}`, `${tool}\\nwait`],
  [`printf "x\\n${TOOL}_HOME=/tmp"`, `${TOOL}_HOME`],
  [`"a\\r${tool}:lead"`, `${tool}:lead`],
  [`"a\\n.${tool}/x"`, `.${tool}`],
];

test("each of the tool's forms is blocked in an added line, in a path and in a commit message, with the form in the detail", () => {
  for (const [text, form] of traces) {
    assert.deepEqual(checkDiff(added("NOTES.md", [text]), []), [{ kind: "attribution", detail: `NOTES.md: names the tool (${form})` }], text);
    // A directory of the path, as a home form must sit next to a separator.
    const path = `docs/${text}/x.md`;
    assert.deepEqual(checkDiff(added(path, ["x"]), []), [{ kind: "attribution", detail: `${path}: names the tool (${form})` }], path);
    assert.deepEqual(checkCommitMessage(`Fix it\n\n${text}\n`, []), [{ kind: "message", detail: `names the tool (${form})` }], text);
  }
});

test("the bare name and near misses of the tool's forms pass in an added line, a path and a commit message", () => {
  const capital = `${TOOL[0]}${tool.slice(1)}`;
  for (const text of [`foo.${tool}`, `docs/${tool}-notes.md`, `com${tool} wait`, `${tool}_id integer`, `${TOOL}_ID`, `${TOOL}_HOME_DIR`,
    `MY_${TOOL}_JOB`, `class ${capital} extends Pekerja`, `// ${tool} memeriksa laporan harian`, `Add ${tool} role to the staff form`,
    `${tool}:other`, `${tool}:leader`, `${tool} waiting`, `${tool} statuses`, `${tool}-wait`, `${tool}wait`,
    // A property, a selector, a class or a relative import of that name is no home directory: no separator is next to it.
    `const nama = pekerja?.${tool}?.nama;`, `getProyek().${tool}`, `rows[0].${tool}`, `data["proyek"].${tool}`, `$.${tool}.nama`,
    `SELECT "proyek".${tool}`, `.${tool} { color: red; }`, `.card .${tool}-badge {`, `document.querySelector(".${tool}")`,
    `from .${tool} import ${capital}`, `/x/.${tool}.json`, `from ..${tool} import x`, `~/.${tool}.json`, `/x/.${tool}.bak`, `/x/.${tool}.x`,
    // A backslash that escapes no line break or tab, a letter after an escape, or two quotes, are no boundary.
    `"\\nx${tool} wait"`, `${tool}\\x wait`, `"${tool}"" wait`,
    // A quoted bare name is no launcher path, so a closing quote after it ends the command form.
    `SELECT '${tool}' status FROM t`, `value="${tool}" show`, `the word "${tool}" project`, `jabatan '${tool}' review`, `\`${tool}\` wait`]) {
    assert.deepEqual(checkDiff(added("NOTES.md", [text]), []), [], text);
    // Not right after the separator: a component that starts with the home form is one.
    assert.deepEqual(checkDiff(added(`docs/x ${text}.md`, ["x"]), []), [], text);
    assert.deepEqual(checkCommitMessage(`Fix it\n\n${text}\n`, []), [], text);
  }
  assert.equal(toolTrace(tool), null);
});

// Where the repository's own subject uses the name, a foreman's status, plan or review is ordinary prose. What only the
// tool writes stays a trace: its home, its variables, its skill ids, a command no sentence holds, a path to the
// launcher, and any command with an option after it.
test("with the name a word of the repository's own, the name before an ordinary word passes and an invocation does not", () => {
  const prose = [`update ${tool} status when the shift ends`, `// ${tool} review harian`, `const label = "${tool} project";`, `the ${tool} goal for this week`,
    `${tool} dispatch jadwal`, `${tool} ready codex`];
  for (const text of prose) {
    assert.ok(flagged(text), text);
    assert.deepEqual(checkDiff(added("NOTES.md", [text]), [], true), [], text);
    assert.deepEqual(checkCommitMessage(`Fix it\n\n${text}\n`, [], true), [], text);
  }
  const invoked: [string, string][] = [
    [`${tool} status --json`, `${tool} status`], [`run ${tool} wait --since 120`, `${tool} wait`], [`bin/${tool} status`, `${tool} status`],
    [`${tool} verdict x accept`, `${tool} verdict`], [`${tool} reassign t`, `${tool} reassign`], [`${tool} scratch`, `${tool} scratch`],
    [`${tool} --help`, `${tool} --help`], [`cd ~/.${tool}`, `.${tool}`], [`export ${TOOL}_JOB=1`, `${TOOL}_JOB`], [`/${tool}:lead`, `/${tool}:lead`],
  ];
  for (const [text, form] of invoked) {
    assert.deepEqual(checkDiff(added("NOTES.md", [text]), [], true), [{ kind: "attribution", detail: `NOTES.md: names the tool (${form})` }], text);
    assert.deepEqual(checkCommitMessage(`Fix it\n\n${text}\n`, [], true), [{ kind: "message", detail: `names the tool (${form})` }], text);
  }
  // A command split over two added lines counts only for a command no sentence holds.
  assert.deepEqual(checkDiff(added("run.sh", [`run ${tool}`, "status now"]), [], true), []);
  assert.deepEqual(kinds(checkDiff(added("run.sh", [`run ${tool}`, "verdict x accept"]), [], true)), ["attribution"]);
});

// A shell variable is case-sensitive, and a foreman's job (mandor_job) is an ordinary column or table name.
test("the tool's variables count in upper case only, a fullwidth spelling included", () => {
  const wide = (t: string) => [...t].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
  const capital = `${TOOL[0]}${tool.slice(1)}`;
  for (const text of [`${tool}_job`, `${tool}_home = "x"`, `CREATE TABLE ${tool}_job (id int)`, `${capital}_Home`, `${TOOL}_ID`]) {
    assert.deepEqual(checkDiff(added("NOTES.md", [text]), []), [], text);
    assert.deepEqual(checkDiff(added(`docs/x ${text}.md`, ["x"]), []), [], text);
    assert.deepEqual(checkCommitMessage(`Fix it\n\n${text}\n`, []), [], text);
  }
  for (const [text, form] of [[`${TOOL}_JOB`, `${TOOL}_JOB`], [`export ${TOOL}_HOME=/x`, `${TOOL}_HOME`], [`\${${TOOL}_HOME}`, `${TOOL}_HOME`],
    [`$${TOOL}_CODEX_BIN`, `${TOOL}_CODEX_BIN`], [wide(`${TOOL}_HOME`), `${TOOL}_HOME`]]) {
    assert.deepEqual(checkDiff(added("NOTES.md", [text]), []), [{ kind: "attribution", detail: `NOTES.md: names the tool (${form})` }], text);
    const path = `docs/x ${text}.md`;
    assert.deepEqual(checkDiff(added(path, ["x"]), []), [{ kind: "attribution", detail: `${path}: names the tool (${form})` }], text);
    assert.deepEqual(checkCommitMessage(`Fix it\n\n${text}\n`, []), [{ kind: "message", detail: `names the tool (${form})` }], text);
  }
});

// A foreman-domain app's seed data, translations, config and CSV: a command word followed by a key-value or list
// separator is a key or a field, quoted or not, on one line or on the next.
test("a command word before a key-value or list separator is data, on one line or across two added lines", () => {
  const capital = `${TOOL[0]}${tool.slice(1)}`;
  const pairs = [[`  jabatan: ${tool}`, "  status: aktif"], [`foreman: ${capital}`, "status: Status"], [`foreman: ${capital}`, "review: Tinjau"],
    [`jabatan = "${tool}"`, 'status = "aktif"'], [`ROLE="${tool}"`, 'status="ok"'], [`3,Budi,${tool}`, "project,Alpha,x"],
    [`3,"Budi","${tool}"`, '"project","Alpha"'], [`jabatan: "${tool}"`, '"status": aktif']];
  for (const lines of pairs) {
    assert.deepEqual(checkDiff(added("seed.yml", lines), []), [], lines.join(" / "));
    // A commit message is one text, read by the one-line rule, where a bare comma no longer ends a command word: the
    // CSV rows pass only as two added lines.
    if (lines[0] !== `3,Budi,${tool}`) assert.deepEqual(checkCommitMessage(`Add seed data\n\n${lines.join("\n")}\n`, []), [], lines.join(" / "));
  }
  for (const text of [`const s = "Jabatan: ${tool}\\nStatus: aktif";`, `printf 'Nama: Budi\\nJabatan: ${tool}\\nStatus: aktif\\n'`,
    `${capital} Status: aktif`, `${tool} review = 3`, `"${capital} Status": "Status ${capital}",`,
    // A known limit: an unquoted colon after a command word reads as a key, as Mandor Status: aktif needs, so prose
    // that introduces a command with a colon passes.
    `First run ${tool} init: it creates the home.`]) {
    assert.deepEqual(checkDiff(added("NOTES.md", [text]), []), [], text);
    assert.deepEqual(checkDiff(added(`docs/x ${text}.md`, ["x"]), []), [], text);
    assert.deepEqual(checkCommitMessage(`Fix it\n\n${text}\n`, []), [], text);
  }
  // Any other character after the command word leaves it a command, a comma included.
  for (const text of [`${tool} wait.`, `${tool} wait;`, `${tool} wait | tee log`, `(${tool} wait)`, `run ${tool} wait`, `Run ${tool} wait, then review.`]) {
    assert.deepEqual(checkDiff(added("NOTES.md", [text]), []), [{ kind: "attribution", detail: `NOTES.md: names the tool (${tool} wait)` }], text);
    assert.deepEqual(checkCommitMessage(`Fix it\n\n${text}\n`, []), [{ kind: "message", detail: `names the tool (${tool} wait)` }], text);
  }
});

// How commands are mentioned: in backticks, in a call, in a script, in a JSON value, or before a comma. A closing quote
// before a key separator ("Status": ...) is a key, a backtick before one is not.
test("a command in backticks, a call or a script, or before a comma, is a trace even before a separator", () => {
  for (const [text, form] of [[`Run \`${tool} status\`, then read the output.`, `${tool} status`], [`First run \`${tool} init\`: it creates the home.`, `${tool} init`],
    [`- \`${tool} wait\`: returns when a task needs the lead`, `${tool} wait`], [`subprocess.run("${tool} wait", shell=True)`, `${tool} wait`],
    [`execSync("${tool} status", { stdio: "inherit" })`, `${tool} status`], [`"lead:status": "${tool} status",`, `${tool} status`],
    [`{"cmd": "${tool} dispatch", "args": []}`, `${tool} dispatch`], [`${tool} --version, 0.1.0`, `${tool} --version`], [`${tool} drop, x`, `${tool} drop`],
    [`${tool} review, lalu periksa laporan`, `${tool} review`]]) {
    assert.deepEqual(checkDiff(added("NOTES.md", [text]), []), [{ kind: "attribution", detail: `NOTES.md: names the tool (${form})` }], text);
    const path = `docs/x ${text}.md`;
    assert.deepEqual(checkDiff(added(path, ["x"]), []), [{ kind: "attribution", detail: `${path}: names the tool (${form})` }], text);
    assert.deepEqual(checkCommitMessage(`Fix it\n\n${text}\n`, []), [{ kind: "message", detail: `names the tool (${form})` }], text);
  }
});

test("a command split over two added lines is one trace, reported once, and list prose or a line between makes none", () => {
  const traced = (path: string, form: string) => [{ kind: "attribution", detail: `${path}: names the tool (${form})` }];
  for (const [lines, form] of [
    [[`${tool} \\`, "  dispatch --goal x --task y"], `${tool} dispatch`],
    [[`Then run ${tool}`, "dispatch for each task."], `${tool} dispatch`],
    [[`exec "/opt/x/bin/${tool}" \\`, "  wait --since 3"], `${tool} wait`],
    [[`run ${tool}`, `  "verdict" a accept`], `${tool} verdict`],
  ] as [string[], string][]) {
    assert.deepEqual(checkDiff(added("run.sh", lines), []), traced("run.sh", form), lines.join(" / "));
  }
  // A line that is a trace on its own is reported for itself only.
  assert.deepEqual(checkDiff(added("run.sh", [`${tool} wait`, "dispatch x"]), []), traced("run.sh", `${tool} wait`));
  assert.deepEqual(checkDiff(added("run.sh", [`run ${tool}`, `dispatch then ${tool} wait`]), []), traced("run.sh", `${tool} wait`));
  for (const lines of [[`- seorang ${tool}`, "- review laporan"], [`value="${tool}"`, "show x"], [`the word '${tool}'`, "project x"], [`run ${tool} now`, "dispatch x"], [`run ${tool}`, "dispatcher x"],
    [`run com${tool}`, "dispatch x"]]) {
    assert.deepEqual(checkDiff(added("NOTES.md", lines), []), [], lines.join(" / "));
  }
  // A context line, a removed line or a hunk header between the two lines breaks the pair.
  assert.deepEqual(checkDiff(hunk("run.sh", [`+run ${tool}`, " kept", "+dispatch x"]), []), []);
  assert.deepEqual(checkDiff(hunk("run.sh", [`+run ${tool}`, "-old", "+dispatch x"]), []), []);
  assert.deepEqual(checkDiff(hunk("run.sh", [`+run ${tool}`]) + "@@ -9,0 +9,1 @@\n+dispatch x\n", []), []);
});

test("invisible characters, NBSP, NUL bytes and compatibility forms do not hide one of the tool's forms", () => {
  const [zw, nbsp, nul] = [0x200b, 0xa0, 0].map((c) => String.fromCharCode(c));
  const split = (s: string) => `${s.slice(0, 3)}${zw}${s.slice(3)}`;
  const spread = (s: string) => [...s].join(nul);
  const wide = [...tool].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
  for (const [text, form] of [
    [`${tool}${nbsp}wait`, `${tool} wait`], [`${tool}${zw} wait`, `${tool} wait`], [`${tool} ${zw}wait`, `${tool} wait`],
    [`${split(tool)} dispatch`, `${tool} dispatch`], [`${wide} wait`, `${tool} wait`], [`~/.${split(tool)}/logs`, `.${tool}`],
    [`~/${zw}.${tool}/logs`, `.${tool}`], [`${TOOL}_${zw}HOME`, `${TOOL}_HOME`], [`/${tool}:${zw}lead`, `/${tool}:lead`],
    [spread(`${tool} dispatch`), `${tool} dispatch`], [spread(`~/.${tool}/x`), `.${tool}`],
  ]) {
    assert.deepEqual(checkDiff(added("NOTES.md", [text]), []), [{ kind: "attribution", detail: `NOTES.md: names the tool (${form})` }], JSON.stringify(text));
    assert.deepEqual(checkCommitMessage(text, []), [{ kind: "message", detail: `names the tool (${form})` }], JSON.stringify(text));
  }
});

const SRC = join(import.meta.dirname, "..", "src");

// The closed lists cannot drift from the code: a variable the tool reads or sets, or a command it runs, that the list
// left out would pass the guard.
test("the tool's variable list is every one of its variables that src/ names", () => {
  const text = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(SRC, f), "utf8")).join("\n");
  assert.deepEqual([...new Set(text.match(new RegExp(`\\b${TOOL}_[A-Z_]+`, "g")))].sort(), [...TOOL_VARS].sort());
});

test("the tool's command list is every command src/cli.ts and src/status.ts dispatch on", () => {
  const text = ["cli.ts", "status.ts"].map((f) => readFileSync(join(SRC, f), "utf8")).join("\n");
  const dispatched = new Set([...text.matchAll(/\b(?:cmd|argv\[0\]) === "([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...dispatched].sort(), [...TOOL_COMMANDS].sort());
});

test("every command the README and the skills show is one the guard flags", () => {
  const root = join(import.meta.dirname, "..");
  const docs = ["README.md", ...readdirSync(join(root, "skills")).map((s) => join("skills", s, "SKILL.md"))];
  // A placeholder (<command>) stands for any of them.
  const spans = docs.flatMap((f) => [...readFileSync(join(root, f), "utf8").matchAll(/`([^`\n]+)`/g)].map((m) => m[1]))
    .filter((s) => s.startsWith(`${tool} `) && !s.startsWith(`${tool} <`));
  assert.ok(spans.length > 0);
  for (const span of spans) assert.notEqual(toolTrace(foldPath(span)), null, span);
});

test("only versions with a digit and known product words fit between a vendor and a credit word", () => {
  for (const line of [say("GPT-4", "generated", "code"), `${["GPT-4", "generated"].join("-")} code`,
    `${[say("Claude", "Code"), "generated"].join("-")} tests`, `${["Claude3", "generated"].join("-")} tests`,
    `${["gpt4o", "assisted"].join("-")} edit`, say("Claude", "3.5", "Sonnet", "generated"), say("Claude", "Code", "generated", "tests"),
    say("Claude", "Opus", "4.1", "generated")]) {
    assert.ok(flagged(line), line);
  }
  for (const line of [say("The", "OpenAI", "key", "is", "written", "to", "the", "keychain"), say("Gemini", "output", "was", "generated"),
    say("Copilot", "suggestions", "are", "written", "to", "the", "log"), say("OpenAI embeddings", "generated", "by", "the batch job"),
    say("LLM tokens", "generated", "per second"), "ai_summary_generated_at TIMESTAMP",
    say("We use OpenAI. Code", "generated", "by", "the team is reviewed.")]) {
    assert.deepEqual(checkDiff(added("NOTES.md", [line]), []), [], line);
  }
});

test("gpt, glm, copilot, openai and gemini also count at the end of a compound name", () => {
  // A lowercase glm after a credit verb is an ordinary word, so chatglm in lowercase is not among these.
  for (const name of ["ChatGLM", "ChatGLM3", "AutoGPT", "AgentGPT", "GitHubCopilot", "AzureOpenAI", "GoogleGemini", "autogpt",
    "githubcopilot", "azureopenai", "googlegemini"]) {
    assert.ok(flagged(say("Generated", "by", name)), name);
  }
});

test("cursor and glm block only in forms that ordinary prose does not take", () => {
  for (const line of [say("Returns a cursor", "generated", "by the query planner."), say("GLM", "generated", "predictions match the baseline"),
    say("next_cursor", "generated", "by the server"), say("The cursor", "written", "to the buffer is flushed."),
    say("Rows", "created", "by", "the cursor"), say("Generated", "with", "glm")]) {
    assert.deepEqual(checkDiff(added("NOTES.md", [line]), []), [], line);
  }
  for (const line of [`Some ${["cursor", "generated"].join("-")} code`, `${["glm", "generated"].join("_")}: true`,
    say("GLM-4", "generated", "code"), say("Generated", "by", "Cursor"), say("Generated", "with", "GLM-4")]) {
    assert.ok(flagged(line), line);
  }
});

test("attribution hints report what the blocking rules leave out, and never block", () => {
  for (const line of [`${["generated", "By", "Claude"].join("")}: true`, `${["Claude", "Generated"].join("")} flag`,
    say("Claude Code has", "generated", "the tests"), say("Claude's", "generated", "code")]) {
    const diff = added("NOTES.md", [line]);
    assert.deepEqual(checkDiff(diff, []), [], line);
    assert.equal(attributionHints(diff).length, 1, line);
  }
  const path = `docs/${["generated", "By", "Claude"].join("")}.md`;
  assert.deepEqual(attributionHints(added(path, ["x"])), [{ path, detail: say("generated", "by", "claude") }]);
  assert.deepEqual(attributionHints(added("NOTES.md", ["Rotate the signing key"])), []);
});

test("a capital inside a vendor's name does not hide it", () => {
  for (const line of [say("Generated", "with", "CoPilot"), `${["Assisted", "by"].join("-")}: CoPilot`, say(" * @author", "CoPilot"),
    say("Generated", "by", "CodeX"), say("Generated", "by", "AntiGravity"), say("Generated", "by", "zCode"),
    say("Generated", "by", "OpenAICodex")]) {
    assert.ok(flagged(line), line);
  }
});

test("camelCase audit keys and identifier tails are not credits", () => {
  for (const line of ["const row = { createdBy: req.user.id, cursor: page.cursor };", "{ createdBy: userId, provider: 'openai' }",
    "const { editedBy, reviewedBy, generatedBy } = audit;", "const next = nextCursor ?? dbCursor; const s = aiScore + llmModel.weight;"]) {
    assert.deepEqual(checkDiff(added("src/audit.ts", [line]), []), [], line);
  }
});

test("a trailer's address cannot supply the vendor, its name still can", () => {
  for (const line of [`${["Signed", "off", "by"].join("-")}: Ann <ann@mistral.ai>`, `${["Reviewed", "by"].join("-")}: John Smith <john@acme.ai>`]) {
    assert.deepEqual(checkDiff(added("NOTES.md", [line]), []), [], line);
    assert.deepEqual(checkCommitMessage(`Fix login\n\n${line}\n`, []), [], line);
  }
  assert.ok(flagged(`${coAuthor}: Claude <noreply@example.invalid>`));
  assert.ok(flagged(`${["Signed", "off", "by"].join("-")}: Claude <noreply@example.invalid>`));
  // An HTML tag is no address: the window still reaches the vendor behind it.
  assert.ok(flagged(`${say("Generated", "with")} <a href="https://x.invalid">Claude Code</a>`));
});

test("reviewed, edited, refactored and suggested are credit verbs, and genai is a vendor", () => {
  for (const line of [say("Reviewed", "by", "Claude", "Code"), say("Edited", "with", "ChatGPT"), say("Refactored", "by", "Codex"),
    say("Suggested", "by", "Copilot"), say("Generated", "with", "GenAI"), say("Generated", "with", "genai")]) {
    assert.ok(flagged(line), line);
    assert.ok(credited(`Update notes\n\n${line}\n`), line);
  }
});

test("commit-message words with long runs of trailing marks are stripped in linear time", () => {
  const n = 40000;
  const start = Date.now();
  for (const word of [`a${"*".repeat(n)}x`, `a${"~".repeat(n)}x`, `a${"'s".repeat(n / 2)}x`, `a${".".repeat(n)}x`, `a.md${"*".repeat(n)}`,
    `a.md${"'s".repeat(n / 2)}`]) {
    checkCommitMessage(`Fix ${word}`, []);
  }
  assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
  assert.deepEqual(checkCommitMessage(`Drop a.env${"*".repeat(n)}`, ["**/a.env"]), [{ kind: "message", detail: "denied path: a.env" }]);
});

test("a NUL byte on the line cannot hide attribution from a credit, a trailer or a form of the tool's name", () => {
  const nul = String.fromCharCode(0);
  const spread = (s: string) => [...s].join(nul);
  const lines = [`Co${nul}-Authored-By: Someone`, spread(`${coAuthor}: Someone`), say("Generated", `${nul}with`, `${nul}Claude`, `${nul}Code`), `${nul}${say("Generated", "with", "Claude")}`];
  for (const line of lines) {
    assert.ok(flagged(line), JSON.stringify(line));
    assert.ok(credited(line), JSON.stringify(line));
  }
  assert.deepEqual(checkDiff(added("NOTES.md", [spread(`${tool} wait`)]), []), [{ kind: "attribution", detail: `NOTES.md: names the tool (${tool} wait)` }]);
  assert.deepEqual(checkDiff(added("NOTES.md", [spread(tool)]), []), []);
  assert.deepEqual(attributionHints(added("NOTES.md", [spread(say("Claude", "wrote", "and", "generated", "this"))])).length, 1);
});

test("UTF-16 text is read for attribution, whichever way its bytes split into lines", () => {
  const text = `Notes\n${coAuthor}: Someone\n${say("Generated", "with", "Claude")}\n`;
  for (const encoded of [Buffer.from(text, "utf16le"), Buffer.from(text, "utf16le").swap16()]) {
    const lines = Buffer.concat([Buffer.from([0xff, 0xfe]), encoded]).toString().split("\n");
    const found = checkDiff(added("notes.txt", lines), []).filter((v) => v.kind === "attribution").map((v) => v.detail);
    assert.equal(found.length, 2, found.join("; "));
  }
});

test("dash counts still read the raw text beside a NUL byte", () => {
  const nul = String.fromCharCode(0);
  // Stripping the NUL for matching leaves the rule alone: a changed line holding one adds no count.
  assert.deepEqual(checkDiff(added("data.bin", [`a${nul}${emDash}`]), []), []);
  assert.deepEqual(kinds(checkDiff(added("text.md", [`a${emDash}`]), [])), ["dash"]);
  // A commit message has no binary excuse.
  assert.ok(checkCommitMessage(`Add${nul} ${emDash} x`, []).some((v) => v.detail.startsWith("dash:")));
});

test("a symlink target is judged where it leads, from the directory that holds the link", () => {
  const deny = ["a/b/c", "a/b/c/**", "a/b", "a"];
  const denied = (path: string, target: string) => checkDiff(added(path, [target], "120000"), deny);
  assert.deepEqual(denied("sub/l", "../a/b/c/gen.txt"), [{ kind: "denied-path", detail: "sub/l -> ../a/b/c/gen.txt" }]);
  assert.deepEqual(denied("x/y/l", "../../a/b/c"), [{ kind: "denied-path", detail: "x/y/l -> ../../a/b/c" }]);
  assert.deepEqual(denied("l", "./a/./b/c/../c/gen.txt"), [{ kind: "denied-path", detail: "l -> ./a/./b/c/../c/gen.txt" }]);
  assert.deepEqual(denied("a2/l", "../../CLAUDE.md"), [{ kind: "agent-path", detail: "a2/l -> ../../CLAUDE.md" }]);
  assert.deepEqual(checkDiff(added("sub/l", ["../.env"], "120000"), ["**/.env"]), [{ kind: "denied-path", detail: "sub/l -> ../.env" }]);
  // A trailing slash names the same directory, so it hits the same exact entry.
  assert.deepEqual(denied("sub/l", "../a/b/"), [{ kind: "denied-path", detail: "sub/l -> ../a/b/" }]);
  assert.deepEqual(denied("l", "a/b//"), [{ kind: "denied-path", detail: "l -> a/b//" }]);
  assert.deepEqual(denied("l", "./"), []);
  assert.deepEqual(denied("l", "/"), []);
  // Only a directory on the way is exact: its other files stay linkable, and a same-named target elsewhere is not it.
  assert.deepEqual(denied("sub/l", "../a/other.txt"), []);
  assert.deepEqual(denied("sub/l", "a/b/c/gen.txt"), []);
  assert.deepEqual(denied("l", "/elsewhere/a/b/c"), []);
});
