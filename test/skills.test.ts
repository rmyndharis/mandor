import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const names = ["lead", "status"];
const read = (name: string): string => readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
// Built from code points so this file never holds the glyphs itself.
const banned = new RegExp(`[${[0x2013, 0x2014, 0x2015].map((c) => String.fromCodePoint(c)).join("")}]`);

test("both skills have name and description", () => {
  for (const name of names) {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(read(name));
    assert.ok(m, `${name} has frontmatter`);
    assert.match(m[1], new RegExp(`^name: ${name}$`, "m"));
    assert.match(m[1], /^description: \S.*$/m);
  }
});

test("lead skill mentions scratch, goal start, plan set, dispatch, wait --since, review, verdict, confirm, drop, reassign, ready, show", () => {
  const lead = read("lead");
  for (const term of [
    "mandor scratch", "mandor goal start", "mandor plan set", "mandor dispatch",
    "mandor wait --since", "mandor review", "mandor verdict", "mandor confirm",
    "mandor drop", "mandor reassign", "mandor ready", "mandor show",
  ]) {
    assert.ok(lead.includes(term), term);
  }
});

test("lead skill leaves the user's settings, git identity and sign-ins to the user, and names each situation where it stops", () => {
  const lead = read("lead");
  const section = lead.slice(lead.indexOf("## 12."));
  assert.ok(section.startsWith("## 12. What is the user's"), "the rule has a section of its own");
  for (const term of [
    "Never edit `config.json`", "git identity", "switch a worker tool on", "`mandor login`", "`mandor project setup`", "`mandor init`",
    "`config.json` is invalid", "binary is missing", "commit identity", "no candidate the catalog can run", "setup command", "clone path",
    "state home is on another volume", "ledger or a lock file", "earlier accept", "index lock", "remote-tracking branch", "did not record", "`mandor goal adopt`",
  ]) {
    assert.ok(section.includes(term), term);
  }
});

test("lead skill tells a new conversation to handle integrating and takeover tasks before it waits", () => {
  const lead = read("lead");
  assert.ok(lead.includes("(needs-review, stalled, integrating or takeover), then wait from the summary's cursor"));
});

test("lead skill has the user told each warning of a session summary or a dispatch", () => {
  assert.ok(read("lead").includes("tell the user each warning once in a conversation"));
});

test("lead skill names no model id, has ready run for the tool the user acted on, and has the proofs' leftovers deleted before a review", () => {
  const lead = read("lead");
  assert.doesNotMatch(lead, /gpt-\d|gemini-\d|glm-\d/i, "a model id goes out of date with the catalog");
  assert.ok(lead.includes("Ask the user which tool they acted on"));
  assert.ok(lead.includes("for each stalled task whose candidate is of another tool"));
  assert.ok(lead.includes("Delete what your proofs left in the task worktree"));
});

test("lead skill says how to read a fixed git failure, how to write an agy candidate, and the fourth path out of an exhausted tier", () => {
  const lead = read("lead");
  assert.ok(lead.includes("`logs/git.stderr`") && lead.includes("read it as data"), "a fixed git sentence points at a log the lead reads as data");
  assert.ok(lead.includes("pass the `agy:` entry that `mandor models` prints to `--use` as it is"));
  assert.ok(lead.includes("would let it take the task"), "worker network is the way out when ZCode or Antigravity is passed over");
  assert.doesNotMatch(lead, /agy:<model id>/);
});

test("status skill runs mandor status", () => {
  assert.ok(read("status").includes("mandor status"));
});

test("no skill file contains U+2014, U+2013 or U+2015", () => {
  for (const name of names) {
    assert.doesNotMatch(read(name), banned, name);
  }
});
