import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// The message of an error that a command prints says what is wrong and names the next step: something to run, to read or to
// change, or someone to tell. Every `new Error(` of the source is read. A usage error gets its pointer to the help where it
// is printed, and a failed git step is shown as a fixed sentence with the path of its log, so neither is read here.
const root = join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
const isQuote = (c: string | undefined): boolean => c !== undefined && "'\"`".includes(c);

// The end of the quoted text that opens at text[i], with the nesting of a template's substitutions followed.
function literalEnd(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  let depth = 0;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") j += 2;
    else if (depth === 0 && c === quote) return j;
    else {
      if (quote === "`" && c === "$" && text[j + 1] === "{") depth++, (j += 2);
      else {
        if (depth > 0 && c === "}") depth--;
        else if (depth > 0 && c === "{") depth++;
        else if (depth > 0 && isQuote(c)) j = literalEnd(text, j);
        j++;
      }
    }
  }
  throw new Error("an unterminated literal");
}

// The end of the call whose arguments start at text[i], with quoted text skipped.
function argsEnd(text: string, i: number): number {
  let depth = 1;
  for (let j = i; j < text.length; j++) {
    if (isQuote(text[j])) j = literalEnd(text, j);
    else if (text[j] === "(") depth++;
    else if (text[j] === ")" && --depth === 0) return j;
  }
  throw new Error("an unterminated call");
}

// A literal's words: its substitutions are code, so a word inside one is not part of the message.
function plain(body: string): string {
  let out = "";
  for (let j = 0; j < body.length; j++) {
    if (body[j] === "$" && body[j + 1] === "{") {
      let depth = 1;
      for (j += 2; j < body.length && depth > 0; j++) {
        if (isQuote(body[j])) j = literalEnd(body, j);
        else if (body[j] === "{") depth++;
        else if (body[j] === "}") depth--;
      }
      j--;
      out += "_";
    } else out += body[j];
  }
  return out;
}

// The words of every quoted text among the arguments, with the arguments as written.
function wordsOf(args: string): string {
  const pieces: string[] = [];
  for (let j = 0; j < args.length; j++) {
    if (isQuote(args[j])) {
      const end = literalEnd(args, j);
      pieces.push(plain(args.slice(j + 1, end)));
      j = end;
    }
  }
  return pieces.join(" ");
}

interface Found { file: string; line: number; args: string; text: string; quoted: boolean }
function messages(): Found[] {
  const found: Found[] = [];
  for (const file of files(root)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/new Error\(/g)) {
      const i = m.index + m[0].length;
      const args = text.slice(i, argsEnd(text, i));
      found.push({ file: file.slice(root.length + 1), line: text.slice(0, m.index).split("\n").length, args, text: wordsOf(args), quoted: isQuote(args.trimStart()[0]) });
    }
  }
  return found;
}

// What a next step looks like: a clause that opens with something to run, to read or to change, or with someone to tell, or a
// pointer such as "mandor status lists the tasks". A word like "remove" or "read" inside a sentence that only describes ("could
// not remove x") is not one.
const LEAD = "(?:(?:and|then|or|so|first|also|instead|otherwise|now|if [^,;:]*,) *)*";
const STEP = new RegExp(`(?:^|[;:.,(\\n] *)${LEAD}(?:(?:run|retry|try again|see|remove|delete|ask|tell|use|pass|wait|choose|restore|install|write|read|sign in|shorten|set|copy|update|expected)\\b|mandor [a-z-]+(?: [a-z-]+)? (?:lists|prints|shows)\\b)`, "i");

// Messages that name no step of their own, each with the reason it needs none.
const EXEMPT: { file: string; starts: string; why: string }[] = [
  { file: "hooks.ts", starts: "hook input did not end", why: "the hooks are run by Claude Code, whose hook log is where this goes" },
  { file: "hooks.ts", starts: "unknown hook:", why: "the hooks are run by Claude Code, whose hook log is where this goes" },
  { file: "routing.ts", starts: "cannot use _: _", why: "the stall detail of a task that resumes, whose next action the status line names, and dispatch adds its own step in checkUse" },
  { file: "git.ts", starts: "refusing _: its git config defines _; _", why: "ends with PARTIAL_CLONE, which is read below" },
  { file: "tasks.ts", starts: "refusing _: its git config defines _; _", why: "ends with PARTIAL_CLONE, which is read below" },
];

// An error built from a message that is made elsewhere: the call, and the message texts that it can hold, read where they are
// made. A new one of these is not added without its sources.
const PASSTHROUGH: { file: string; arg: string }[] = [
  { file: "runner.ts", arg: "unconfined" },
  { file: "tasks.ts", arg: "why" },
  { file: "tasks.ts", arg: "gap" },
  { file: "tasks.ts", arg: "plantedMessage(task.id, planted, then)" },
];
const MADE: { file: string; starts: string }[] = [
  { file: "git.ts", starts: "cannot confine with sandbox-exec" },
  { file: "git.ts", starts: "a partial clone is not supported" },
  { file: "routing.ts", starts: "no candidate for tier ${tier} can run in this project" },
  { file: "routing.ts", starts: "no candidate for tier ${tier} can run: " },
  { file: "tasks.ts", starts: "the worktree holds agent paths" },
];

// The words of the quoted text at which a made message starts.
function madeWords(m: { file: string; starts: string }): string | null {
  const text = readFileSync(join(root, m.file), "utf8");
  const i = text.indexOf(m.starts);
  return i > 0 && isQuote(text[i - 1]) ? plain(text.slice(i, literalEnd(text, i - 1))) : null;
}
const exempt = (m: Found) => EXEMPT.some((e) => m.file.endsWith(e.file) && m.text.startsWith(e.starts));

test("every message of an error that a command prints names the next step", () => {
  const all = messages().filter((m) => m.quoted);
  assert.ok(all.length > 100, `the scan found ${all.length} messages`);
  const bare = all.filter((m) => !STEP.test(m.text) && !exempt(m));
  assert.deepEqual(bare.map((m) => `${m.file}:${m.line}: ${m.text}`), [], "name the next step in each, or give the reason it needs none in EXEMPT");
});

test("an error built from a message made elsewhere is listed with where it is made, and those messages name the next step", () => {
  const built = messages().filter((m) => !m.quoted);
  assert.deepEqual(built.filter((m) => !PASSTHROUGH.some((p) => m.file.endsWith(p.file) && m.args.trim() === p.arg)).map((m) => `${m.file}:${m.line}: ${m.args}`), [], "list the call in PASSTHROUGH, and the message it can hold in MADE");
  for (const p of PASSTHROUGH) assert.ok(built.some((m) => m.file.endsWith(p.file) && m.args.trim() === p.arg), `${p.file}: ${p.arg}`);
  for (const m of MADE) {
    const words = madeWords(m);
    assert.ok(words !== null, `${m.file}: ${m.starts}`);
    assert.ok(STEP.test(words), `${m.file}: ${words}`);
  }
});

test("the exemptions each match a message, and the scan reads a template by its words, substitutions apart", () => {
  const all = messages();
  for (const e of EXEMPT) assert.ok(all.some((m) => m.file.endsWith(e.file) && m.text.startsWith(e.starts)), `${e.file}: ${e.starts}`);
  assert.ok(all.some((m) => m.text.includes("run mandor show _ to see where it stands")), "a template whose last substitution is followed by text");
  assert.equal(plain("a ${b ? \"tell\" : `run ${c}`} d"), "a _ d");
  assert.equal(wordsOf("`one ${x}` + \"two\", y"), "one _ two");
});
