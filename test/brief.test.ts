import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BRIEF_HEADER_LINES, REPORT_SCHEMA, askOf, loadRounds, parseReport, renderAnswerMessage, renderBrief, renderConflictMessage, renderFixMessage, renderHandoff, roundReport, saveRoundFile } from "../src/brief.ts";
import type { WorkerReport } from "../src/contracts.ts";
import { mandorHome, roundDir } from "../src/home.ts";
import { tempHome } from "./helpers.ts";

const dashes = [0x2014, 0x2013, 0x2015].map((c) => String.fromCharCode(c));
const mode = (p: string) => statSync(p).mode & 0o777;
const CONTINUE = "Continue the task from the current state of the files.";

const report = (over: Partial<WorkerReport> = {}): WorkerReport => ({
  status: "done", summary: "Added the parser", files_changed: ["src/a.ts"],
  commands_run: [{ command: "npm test", exit_code: 0, summary: "all green" }],
  tests: { ran: true, passed: 4, failed: 0, notes: "unit only" },
  open_issues: [], questions_for_lead: [], ...over,
});

const HEADER = `You are a worker running non-interactively for a lead engineer. No human can answer questions.
1. Do not ask questions. Do not start brainstorming, planning, or question-asking skills or modes.
2. Work only inside the current directory, and only on files within this scope: SCOPE.
3. Do not commit, push, create branches, or change git configuration. Do not run git commands that write.
4. Do not create or modify AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules, .windsurfrules, .clinerules, copilot-instructions.md, .claude/, .codex/, .gemini/, .agents/, .agent/, .zcode/, .cursor/, .github/instructions/, or zcode.json.
5. Do not add AI attribution anywhere, such as Co-Authored-By lines or "Generated with" lines.
6. Never write the characters U+2014, U+2013, or U+2015.
7. Do not modify these shared files unless the task says so: SHARED.
8. If you cannot finish, stop and report status "blocked" with the reason.
9. End with a final message that is only the JSON report described by the output schema.`;

test("header substitution", () => {
  const out = renderBrief({ shared: ["package.json", "tsconfig.json"], scope: ["src/a.ts", "src/b.ts"], taskBody: "Do the thing." });
  assert.equal(out, `${HEADER.replace("SCOPE", "src/a.ts, src/b.ts").replace("SHARED", "package.json, tsconfig.json")}\n\nDo the thing.`);

  const none = renderBrief({ shared: [], scope: [], taskBody: "x" });
  assert.ok(none.includes("within this scope: none.\n"));
  assert.ok(none.includes("unless the task says so: none.\n"));
  assert.ok(!/\{(scope|shared)\}/.test(none));

  // Replacement patterns and placeholders inside a value stay literal.
  const odd = renderBrief({ shared: ["z"], scope: ["a$&b", "{shared}"], taskBody: "x" });
  assert.ok(odd.includes("scope: a$&b, {shared}."));
  assert.ok(odd.includes("says so: z."));
  assert.equal(BRIEF_HEADER_LINES.length, 10);
});

test("no message, header or schema carries a dash glyph", () => {
  const all = [
    BRIEF_HEADER_LINES.join("\n"), JSON.stringify(REPORT_SCHEMA), renderFixMessage("fix it"),
    renderConflictMessage("goal/x", ["a.ts"]), renderHandoff({ originalBrief: "b", rounds: [{ seq: 1, report: report(), notes: "n" }], diffStat: "d" }),
    readFileSync(join(import.meta.dirname, "..", "src", "brief.ts"), "utf8"),
  ].join("\n");
  for (const d of dashes) assert.ok(!all.includes(d), `U+${d.charCodeAt(0).toString(16)}`);
});

test("strict schema recursively", () => {
  let objects = 0;
  const walk = (node: any, at: string): void => {
    if (node.type === "object") {
      objects++;
      assert.equal(node.additionalProperties, false, `${at} additionalProperties`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${at} required`);
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${at}.${k}`);
    } else if (node.type === "array") {
      walk(node.items, `${at}[]`);
    } else {
      assert.ok(["string", "integer", "boolean"].includes(node.type), `${at} type`);
    }
  };
  walk(REPORT_SCHEMA, "report");
  assert.equal(objects, 3); // report, commands_run item, tests
  assert.deepEqual([...REPORT_SCHEMA.required].sort(), Object.keys(report()).sort());
});

test("parseReport valid and invalid", () => {
  const r = report({ status: "partial", open_issues: ["flaky"], questions_for_lead: ["which one?"] });
  assert.deepEqual(parseReport(JSON.stringify(r)), r);
  assert.deepEqual(parseReport(`\n  ${JSON.stringify(r, null, 2)}  \n`), r);
  for (const status of ["done", "blocked", "partial"] as const) assert.equal(parseReport(JSON.stringify(report({ status })))?.status, status);

  const bad: unknown[] = [
    "", "not json", "{", "null", "[]", "42", '"done"', "{}",
    { ...report(), status: "finished" },
    { ...report(), summary: 3 },
    { ...report(), files_changed: "src/a.ts" },
    { ...report(), files_changed: [1] },
    { ...report(), commands_run: [{ command: "x", exit_code: "0", summary: "s" }] },
    { ...report(), commands_run: [{ command: "x", summary: "s" }] },
    { ...report(), commands_run: [null] },
    { ...report(), tests: { ran: "yes", passed: 1, failed: 0, notes: "" } },
    { ...report(), tests: { ran: true, passed: 1, failed: 0 } },
    { ...report(), tests: null },
    { ...report(), open_issues: [null] },
    { ...report(), questions_for_lead: undefined },
  ];
  for (const b of bad) assert.equal(parseReport(typeof b === "string" ? b : JSON.stringify(b)), null, JSON.stringify(b));
  // A worker that adds a key still yields a usable report.
  assert.equal(parseReport(JSON.stringify({ ...r, extra: "x" }))?.summary, r.summary);
  const { summary: _gone, ...noSummary } = report();
  assert.equal(parseReport(JSON.stringify(noSummary)), null);
  assert.equal(parseReport(undefined as unknown as string), null);
});

test("fix and conflict messages", () => {
  const notes = "1. Rename `foo`.\n2. Add a test for $& and {scope}.";
  const fix = renderFixMessage(notes);
  assert.ok(fix.includes(notes));
  assert.ok(/reviewed/.test(fix));
  assert.ok(fix.includes("JSON report"));

  const conflict = renderConflictMessage("goal/login", ["src/a.ts", "src/b.ts"]);
  assert.ok(conflict.includes("goal/login"));
  assert.ok(conflict.includes("src/a.ts") && conflict.includes("src/b.ts"));
  assert.ok(conflict.includes("Resolve the conflict markers in these files by editing them. Do not run git."));
  assert.ok(conflict.includes("JSON report"));
});

test("handoff covers every round in seq order and ends with the continue line", () => {
  const brief = renderBrief({ shared: [], scope: ["src/"], taskBody: "ORIGINAL TASK BODY" });
  const out = renderHandoff({
    originalBrief: brief,
    rounds: [
      { seq: 10, report: report({ summary: "SUMMARY-TEN", open_issues: ["ISSUE-TEN"] }), notes: "NOTES-TEN" },
      { seq: 2, report: report({ summary: "SUMMARY-TWO", files_changed: ["src/two.ts"], commands_run: [{ command: "make two", exit_code: 3, summary: "failed twice" }] }), notes: "NOTES-TWO" },
      { seq: 9, report: null, notes: null },
    ],
    diffStat: " src/two.ts | 4 ++--\n 1 file changed",
  });
  assert.ok(out.startsWith(brief));
  assert.equal(out.split("You are a worker running non-interactively").length, 2, "no second header");
  const at = ["ORIGINAL TASK BODY", "SUMMARY-TWO", "NOTES-TWO", "make two", "src/two.ts", "SUMMARY-TEN", "NOTES-TEN", "ISSUE-TEN", "1 file changed"].map((s) => out.indexOf(s));
  assert.ok(at.every((i) => i >= 0), at.join());
  // Round 2, then 9, then 10, by number and not by text.
  const [r2, r9, r10] = ["Round 2", "Round 9", "Round 10"].map((s) => out.indexOf(s));
  assert.ok(0 < r2 && r2 < r9 && r9 < r10, [r2, r9, r10].join());
  assert.ok(out.indexOf("SUMMARY-TWO") < out.indexOf("SUMMARY-TEN"));
  assert.ok(out.indexOf("SUMMARY-TEN") < out.indexOf("1 file changed"));
  assert.ok(out.includes("exit 3"));
  assert.ok(out.includes("Files changed: src/two.ts\n"));
  assert.ok(out.includes("Tests: ran, 4 passed, 0 failed. unit only\n"));
  // The stat keeps its leading spaces; a report without test notes leaves no trailing space.
  assert.ok(out.includes("files now\n src/two.ts | 4 ++--\n 1 file changed\n\n"));
  const quiet = renderHandoff({ originalBrief: brief, rounds: [{ seq: 1, report: report({ tests: { ran: false, passed: 0, failed: 0, notes: "" } }), notes: null }], diffStat: "" });
  assert.ok(quiet.includes("Tests: not run.\n"));
  assert.ok(quiet.includes("files now\nno changes\n\n"));
  assert.equal(out.split("\n").at(-1), CONTINUE);
  assert.ok(out.endsWith(CONTINUE));

  const bare = renderHandoff({ originalBrief: brief, rounds: [], diffStat: "" });
  assert.ok(bare.startsWith(brief) && bare.endsWith(CONTINUE));
});

test("round files of different seq never overwrite each other", () => {
  tempHome();
  const a = saveRoundFile("p-1", "t1", 1, "notes.md", "first");
  const b = saveRoundFile("p-1", "t1", 2, "notes.md", "second");
  assert.notEqual(a.path, b.path);
  assert.equal(a.path, join(roundDir("p-1", "t1", 1), "notes.md"));
  assert.equal(readFileSync(a.path, "utf8"), "first");
  assert.equal(readFileSync(b.path, "utf8"), "second");
  assert.equal(a.excerpt, "first");
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.equal(mode(a.path), 0o600);
  assert.equal(mode(roundDir("p-1", "t1", 1)), 0o700);
  for (const name of ["report.json", "handoff.md", "conflict.patch"] as const) assert.equal(readFileSync(saveRoundFile("p-1", "t1", 3, name, name).path, "utf8"), name);
  assert.throws(() => saveRoundFile("p-1", "t1", 1, "../escape.md" as "notes.md", "x"));
  assert.throws(() => saveRoundFile("p-1", "t1", 1, "other.md" as "notes.md", "x"));
});

test("accept and confirm evidence are separate files", () => {
  tempHome();
  const accept = saveRoundFile("p-1", "t1", 1, "evidence-accept.md", "accept evidence");
  const confirm = saveRoundFile("p-1", "t1", 1, "evidence-confirm.md", "confirm evidence");
  assert.notEqual(accept.path, confirm.path);
  assert.equal(readFileSync(accept.path, "utf8"), "accept evidence");
  assert.equal(readFileSync(confirm.path, "utf8"), "confirm evidence");
  assert.notEqual(accept.sha256, confirm.sha256);
});

test("askOf names what a report asks of the lead, and is null for a report that asks nothing", () => {
  assert.equal(askOf(null), null);
  assert.equal(askOf(report()), null);
  assert.equal(askOf(report({ status: "blocked" })), "the report says blocked");
  assert.equal(askOf(report({ status: "partial" })), "the report says partial");
  assert.equal(askOf(report({ questions_for_lead: ["Which port?"] })), "the report asks 1 question");
  assert.equal(askOf(report({ questions_for_lead: ["a?", "b?"] })), "the report asks 2 questions");
  assert.equal(askOf(report({ status: "blocked", questions_for_lead: ["a?", "b?"] })), "the report says blocked and asks 2 questions");
  assert.equal(askOf(report({ status: "partial", questions_for_lead: ["a?"] })), "the report says partial and asks 1 question");
  assert.equal(askOf(report({ questions_for_lead: ["", "  "] })), null, "a blank question asks nothing");
});

test("renderAnswerMessage says the notes answer the report, and ends with the report reminder", () => {
  const m = renderAnswerMessage("Use port 8080.\n");
  assert.ok(m.startsWith("The lead read your report and answers it. The lead's notes:\n\nUse port 8080."), m);
  assert.ok(m.endsWith("End with a final message that is only the JSON report described by the output schema."), m);
  assert.ok(!m.includes("found problems to fix"), m);
});

test("roundReport reads the report of one round, and is null for a round with none or one that does not parse", () => {
  tempHome();
  const r = report({ status: "blocked", questions_for_lead: ["Which port?"] });
  saveRoundFile("p-1", "t1", 1, "report.json", JSON.stringify(r));
  saveRoundFile("p-1", "t1", 2, "notes.md", "only notes");
  saveRoundFile("p-1", "t1", 3, "report.json", "{ not json");
  assert.deepEqual(roundReport("p-1", "t1", 1), r);
  assert.equal(roundReport("p-1", "t1", 2), null);
  assert.equal(roundReport("p-1", "t1", 3), null);
  assert.equal(roundReport("p-1", "t1", 4), null);
  assert.equal(roundReport("p-1", "none", 1), null);
  assert.throws(() => roundReport("p-1", "../escape", 1), /outside/);
});

test("loadRounds returns every round in numeric order", () => {
  tempHome();
  assert.deepEqual(loadRounds("p-1", "none"), []);
  for (const seq of [10, 2, 9]) saveRoundFile("p-1", "t1", seq, "notes.md", `notes ${seq}`);
  saveRoundFile("p-1", "t1", 2, "report.json", JSON.stringify(report({ summary: "two" })));
  saveRoundFile("p-1", "t1", 9, "report.json", "{ broken");
  const stray = join(roundDir("p-1", "t1", 1), "..");
  mkdirSync(join(stray, "007"));
  mkdirSync(join(stray, "extra"));
  writeFileSync(join(stray, "11"), "a file, not a round");
  saveRoundFile("p-1", "t1", 12, "handoff.md", "no notes or report here");

  const rounds = loadRounds("p-1", "t1");
  assert.deepEqual(rounds.map((r) => r.seq), [2, 9, 10, 12]);
  assert.deepEqual(rounds.map((r) => r.dir), [2, 9, 10, 12].map((s) => roundDir("p-1", "t1", s)));
  assert.equal(rounds[0].report?.summary, "two");
  assert.equal(rounds[0].notes, "notes 2");
  assert.equal(rounds[1].report, null);
  assert.equal(rounds[2].report, null);
  assert.equal(rounds[2].notes, "notes 10");
  assert.deepEqual([rounds[3].report, rounds[3].notes], [null, null]);
  renderHandoff({ originalBrief: "b", rounds, diffStat: "" });
});

test("round paths stay inside the task directory", () => {
  const home = tempHome();
  const tag = `escape-${process.pid}`;
  const outside = [join(dirname(home), tag), join(home, tag)];
  try {
    for (const slug of [`../../../../${tag}`, "..", "a/../.."]) {
      assert.throws(() => saveRoundFile("p-1", slug, 1, "notes.md", "x"), /outside/, slug);
      assert.throws(() => loadRounds("p-1", slug), /outside/, slug);
    }
    for (const id of [`../${tag}`, `../../${tag}`, ".."]) {
      assert.throws(() => saveRoundFile(id, "t1", 1, "notes.md", "x"), /outside/, id);
      assert.throws(() => loadRounds(id, "t1"), /outside/, id);
    }
    assert.deepEqual(outside.map(existsSync), [false, false]);
    assert.ok(!existsSync(join(mandorHome(), "projects", "p-1", "rounds")));
  } finally {
    for (const p of outside) rmSync(p, { recursive: true, force: true });
  }
  // A slug with a slash still lands under the tasks directory.
  const ref = saveRoundFile("p-1", "feat/x", 1, "notes.md", "nested");
  assert.equal(ref.path, join(roundDir("p-1", "feat/x", 1), "notes.md"));
  assert.deepEqual(loadRounds("p-1", "feat/x").map((r) => r.notes), ["nested"]);
});

test("a round number must be a non-negative safe integer", () => {
  tempHome();
  for (const seq of [-1, 1.5, Number.NaN, Infinity, -Infinity, 2 ** 53]) {
    assert.throws(() => saveRoundFile("p-1", "t1", seq, "notes.md", "x"), /round/, String(seq));
  }
  assert.deepEqual(loadRounds("p-1", "t1"), []);
  saveRoundFile("p-1", "t1", 0, "notes.md", "zero");
  // A name that is all digits but not a safe integer is not a round.
  mkdirSync(join(roundDir("p-1", "t1", 0), "..", "99999999999999999999999"));
  assert.deepEqual(loadRounds("p-1", "t1").map((r) => r.seq), [0]);
});
