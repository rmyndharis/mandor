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
    "state home is on another volume", "ledger or a lock file", "earlier accept", "index lock", "remote-tracking branch",
  ]) {
    assert.ok(section.includes(term), term);
  }
});

test("status skill runs mandor status", () => {
  assert.ok(read("status").includes("mandor status"));
});

test("no skill file contains U+2014, U+2013 or U+2015", () => {
  for (const name of names) {
    assert.doesNotMatch(read(name), banned, name);
  }
});
