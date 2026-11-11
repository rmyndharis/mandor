import { posix } from "node:path";
import { changedPaths } from "./git.ts";
import { clampDetail } from "./store.ts";
import { splitCommand, toolTrace } from "./toolname.ts";

export interface Violation { kind: "agent-path" | "denied-path" | "attribution" | "dash" | "message" | "name"; detail: string }

export const AGENT_PATHS: readonly string[] = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", "copilot-instructions.md",
  ".claude/", ".codex/", ".gemini/", ".agents/", ".agent/", ".zcode/", ".cursor/", ".github/instructions/", "zcode.json",
  ".windsurfrules", ".clinerules"];
export const NAME_TOKENS: readonly string[] = ["claude", "codex", "gpt", "chatgpt", "gemini", "glm", "zcode", "agy", "antigravity",
  "openai", "anthropic", "ai"];
export const ATTRIBUTION_VENDORS: readonly string[] = ["claude", "codex", "gpt", "gemini", "glm", "zcode", "agy", "antigravity",
  "openai", "anthropic", "chatgpt", "copilot", "cursor", "llm", "genai", "ai"];

const DASH_CODES = [0x2014, 0x2013, 0x2015];
const DASHES = DASH_CODES.map((c) => String.fromCharCode(c));
const dashName = (k: number) => `U+${DASH_CODES[k].toString(16).toUpperCase()}`;
const ROBOT = String.fromCodePoint(0x1f916);
// Every dash punctuation character and the minus sign, so no Unicode hyphen can stand in for "-" in a match.
const HYPHENS = new RegExp(`[\\p{Pd}${String.fromCharCode(0x2212)}]`, "gu");

// Invisible characters and NUL bytes are dropped, compatibility forms unified and hyphens made ASCII: UTF-16 text reads
// as NUL-spread letters in a diff, so no pattern would match it otherwise. NFKC also turns the long s and the Kelvin sign
// into s and K, the letters APFS takes them for when it looks up a name.
const unify = (s: string) => s.replace(/[\p{Default_Ignorable_Code_Point}\0]/gu, "").normalize("NFKC").replace(HYPHENS, "-");
const fold = (s: string) => unify(s).toLowerCase();
// A path as APFS compares it: case folded and normalized, so two spellings of one directory compare equal.
export const foldPath = (path: string): string => fold(path);
// cursor and glm are ordinary words in lowercase (a database cursor, a glm model), so where only a capital marks the
// vendor (Cursor, GLM), a lowercase one is masked out before lowercasing.
const maskLower = (s: string) => s.replace(/cursor|glm/gi, (w) => (/[A-Z]/.test(w[0]) ? w : "#".repeat(w.length)));
// Advisory reading only: a camelCase hump also splits words, as in a JSON or YAML key. The blocking rules never split,
// as a capital inside a vendor's name (CoPilot, CodeX) would break the name apart.
const splitHumps = (s: string) => s.replace(/(?<=[a-z])(?=[A-Z])/g, " ");

const AGENT_NAMES = AGENT_PATHS.map((p) => fold(p.replace(/\/$/, "")));

// Every segment counts, the last one too, so a file or symlink named like an agent directory is caught.
// A two-segment entry (.github/instructions) must appear as consecutive segments. A variant of an instruction file
// (claude.local.md, agents.override.md) is one that starts like it and ends in .md; claude.ts or agents.py is code.
export function isAgentPath(path: string): boolean {
  const segments = fold(path).split("/").map((s) => s.trim());
  const joined = `/${segments.join("/")}/`;
  return AGENT_NAMES.some((n) => joined.includes(`/${n}/`)) || segments.some((s) => /^(claude|agents|gemini)\.(?:.*\.)?md$/.test(s));
}

const GLOB: Record<string, string> = { "**/": "(?:.*/)?", "/**": "(?:/.*)?", "**": ".*", "*": "[^/]*" };

// Both sides are folded, so matching is as case-insensitive as APFS. dotAll, because a decoded path can hold a newline.
export function matchesGlob(path: string, glob: string): boolean {
  const body = fold(glob).replace(/\*\*\/|\/\*\*$|\*\*|\*|[.+?^${}()|[\]\\]/g, (t) => GLOB[t] ?? `\\${t}`);
  return new RegExp(`^${body}$`, "s").test(fold(path));
}

// The default glob for .env files. The templates of one (.env.example, .env.sample, .env.template, .env.dist) hold no
// secrets, so that glob alone leaves them alone; any other deny glob that matches one still denies it.
export const ENV_GLOB = "**/.env.*";
const ENV_TEMPLATE = /(?:^|\/)\.env\.(?:example|sample|template|dist)$/;
// An entry that ends in a slash names a directory, as in an ignore file.
export function isDenied(path: string, deny: readonly string[]): boolean {
  return deny.some((g) => matchesGlob(path, g.replace(/\/+$/, "")) && !(g === ENV_GLOB && ENV_TEMPLATE.test(fold(path))));
}

// A glob that matches a directory covers everything under it, as an ignore pattern would: the path itself and each
// directory above it are tried.
export const isCovered = (path: string, deny: readonly string[]): boolean =>
  path.split("/").some((_, i, parts) => isDenied(parts.slice(0, i + 1).join("/"), deny));

// The files that hold secrets. A commit message that only names one (a note about .env variables) gives nothing away, so
// these bind diffs and clone paths alone. Every other deny glob, a private directory such as _docs/ and a project's own
// among them, also binds messages.
export const SECRET_FILE_GLOBS: readonly string[] = ["**/signing.properties", "**/*.keystore", "**/*.jks", "**/.env", ENV_GLOB];

// A vendor starts a word, as anthropic, cursor, agy and llm also end ordinary words (philanthropic, precursor, Nagy,
// fulfillment). gpt, glm, copilot, openai and gemini may instead end one (ChatGLM, AutoGPT, AzureOpenAI). ai stands
// alone, and an underscore next to it counts as a separator, as in a snake_case key.
const WORD_END = new Set(["gpt", "glm", "copilot", "openai", "gemini"]);
const vendor = (v: string) =>
  v === "ai" ? "(?<![a-z0-9])ai(?![a-z0-9])" : WORD_END.has(v) ? `(?<![a-z])${v}|${v}(?![a-z])` : `(?<![a-z])${v}`;
const VENDOR = ATTRIBUTION_VENDORS.map(vendor).join("|");
// cursor and glm are ordinary words too (a database cursor, glm models), so they get stricter rules below.
const STRICT = ["cursor", "glm"];
const LOOSE_VENDOR = ATTRIBUTION_VENDORS.filter((v) => !STRICT.includes(v)).map(vendor).join("|");
const STRICT_VENDOR = STRICT.map(vendor).join("|");
// Between the words: spaces, hyphens, underscores, and markdown emphasis or code marks.
const GAP = "[\\s*_~`-]";
const VERBS = "generated|created|written|assisted|authored|developed|produced|drafted|made|built|reviewed|edited|refactored|suggested";
const CREDIT_WORD = "(?:generated|assisted|written|authored)";
// What may stand between a vendor and a credit word: a version, which holds a digit (4, 3.5, 4o, o3), or a product
// word (Claude Code, Claude 3.5 Sonnet). A glued one starts with a digit, or a dot and a digit (Claude3, gpt4o).
const DIGITAL = "(?=[a-z.]{0,11}[0-9])[a-z0-9.]{1,12}";
const GLUED = "\\.?[0-9][a-z0-9.]{0,11}";
const MODEL = `(?:${GLUED})?(?:${GAP}+(?:${DIGITAL}|code|cli|chat|sonnet|opus|haiku|pro|flash|mini|turbo|max|ultra)){0,3}`;
const STRICT_MODEL = `(?:${GLUED}(?:${GAP}+${DIGITAL}){0,2}|(?:${GAP}+${DIGITAL}){1,3})`;
const CONNECTOR = "(?:with|by|using|via)(?![a-z0-9])";
// A credit verb, then a connector, then a vendor within 40 characters; the window never enters an <email>, so an
// address (john@acme.ai) cannot supply the vendor. In a snake_case key (created_by, reviewed_by) the vendor must come
// right after the connector (generated_by_<vendor>): the next column or value of a SQL, Python or JSON line otherwise
// sits inside the window.
const CREDITED = new RegExp(
  `(?:${VERBS})(?:${GAP.replace("_", "")}+${CONNECTOR}(?:[^<]|<(?![^>\\s]{0,64}@)){0,40}?|_+${CONNECTOR}[\\s*_~\`:="'-]*)(?:${VENDOR})`, "g");
const PHRASES = new RegExp([
  // A vendor, ai included, right before a credit word, with version or product words allowed in between.
  `(?:${LOOSE_VENDOR})${MODEL}${GAP}+${CREDIT_WORD}`,
  // cursor or glm needs a - or _ before the credit word, or a version with a digit in between (GLM-4).
  `(?:${STRICT_VENDOR})(?:${STRICT_MODEL}${GAP}+|[_-])${CREDIT_WORD}`,
  // An author tag, key or JSON value that starts with a vendor.
  `(?:@author|\\bauthors?${GAP}*:|"authors?"\\s*:\\s*")${GAP}*(?:${VENDOR})`,
  // The robot emoji's shortcode.
  ":robot(?:_face)?:",
].join("|"), "g");
const CO_AUTHOR = new RegExp(`${["co", "authored", "by"].join(`${GAP}*`)}${GAP}*:`);
// A <word>-by: trailer. With a space or an underscore before by it is prose or a key (sort by:, order_by:).
const BY_TRAILER = new RegExp(`(?<=[a-z0-9])-by${GAP}*:`, "g");
const NAMES_VENDOR = new RegExp(VENDOR);
// Room for a trailer's "Name <email>" value. Searching the whole rest of the line would flag a minified bundle
// whose early by: key is followed, anywhere later, by a word such as cursor.
const TRAILER_VALUE = 100;

// The trailer check is a plain scan plus a bounded window per anchor, in linear time: one pattern spanning the
// anchor and the vendor backtracks quadratically on long lines. cased is raw as unify reads it.
function attribution(raw: string, cased = unify(raw)): string[] {
  const text = cased.toLowerCase();
  // After a credit verb only Cursor or GLM count, so rows created by the cursor never block.
  const found = [...maskLower(cased).toLowerCase().matchAll(CREDITED), ...text.matchAll(PHRASES)].map((m) => m[0]);
  for (const line of text.split("\n")) {
    const co = line.match(CO_AUTHOR);
    if (co?.index !== undefined) {
      found.push(line.slice(co.index, co.index + TRAILER_VALUE).trim());
      continue;
    }
    for (const m of line.matchAll(BY_TRAILER)) {
      // Only the name counts, not the address after < (ann@mistral.ai).
      if (!NAMES_VENDOR.test(line.slice(m.index, m.index + TRAILER_VALUE).split("<")[0])) continue;
      found.push(line.slice(Math.max(0, m.index - 30), m.index + TRAILER_VALUE).trim());
      break;
    }
  }
  if (raw.includes(ROBOT)) found.push("U+1F916");
  return [...new Set(found)];
}

// A credit wrapped onto the next added line: a credit verb and its connector end one line, with nothing but whitespace
// or punctuation after them, and a vendor opens the next, with nothing but whitespace or punctuation before it. A
// code-generator notice that goes on in prose after its connector, or a next line that opens with a word, is no pair.
// Nor is a snake_case key (created_by, built_with) that ends a line: the next line of a SQL, Python or YAML block
// starts with a column or value of its own, so the underscore is left out of the gap here. Both lines as unify reads
// them.
const EDGE = "[\\s*_~`:=\"'.,;()\\[\\]-]*";
const CREDIT_END = new RegExp(`(?:${VERBS})${GAP.replace("_", "")}+${CONNECTOR}${EDGE}$`);
const VENDOR_START = new RegExp(`^${EDGE}(?:${VENDOR})`);
function wrappedCredit(prev: string, next: string): string | null {
  const end = CREDIT_END.exec(maskLower(prev).toLowerCase());
  const start = end && VENDOR_START.exec(maskLower(next).toLowerCase());
  return start ? `${end[0].trim()} ${start[0].trim()}` : null;
}

const count = (text: string, k: number) => text.split(DASHES[k]).length - 1;
// Where a link leads from the directory that holds it, as a path the deny globs can match: without a trailing slash,
// which names the same directory.
const linkTarget = (link: string, target: string) => posix.normalize(target.startsWith("/") ? target : posix.join(posix.dirname(link), target)).replace(/(?<=.)\/+$/, "");
const NUL = String.fromCharCode(0);

// Hunk lines only: a content line can itself start with +++ or ---, and header lines (binary patch data
// included) never count. Dashes are summed over the whole diff, so a --no-renames rename stays balanced.
// nameIsWord: the repository's own subject uses the tool's name as a word, so the name before an ordinary word is no
// trace of the tool there.
// deny covers a directory and what is under it; exact names only the path itself.
export function checkDiff(diff: string, deny: string[], nameIsWord = false, exact: string[] = []): Violation[] {
  const out: Violation[] = [];
  const flag = (kind: Violation["kind"], detail: string) => out.push({ kind, detail: clampDetail(detail) });
  const checkPath = (p: string, detail: string) => {
    if (isAgentPath(p)) flag("agent-path", detail);
    else if (isCovered(p, deny) || isDenied(p, exact)) flag("denied-path", detail);
  };
  // A worker that writes a worktree path under the default home, a variable or a command of the tool names the tool,
  // which counts as attribution too. The bare name is an ordinary word and passes. It returns whether the text names
  // the tool, reading it as cased, unified once per line.
  const credit = (text: string, path: string, cased = unify(text)) => {
    for (const m of attribution(text, cased)) flag("attribution", `${path}: ${m}`);
    const trace = toolTrace(cased, nameIsWord);
    if (trace !== null) flag("attribution", `${path}: names the tool (${trace})`);
    return trace !== null;
  };
  const plus = [0, 0, 0], minus = [0, 0, 0], where = DASHES.map(() => new Set<string>());
  const tally = (text: string, sign: string, path: string) => DASHES.forEach((_, k) => {
    const n = count(text, k);
    if (sign === "-") minus[k] += n;
    else if (n) {
      plus[k] += n;
      where[k].add(path);
    }
  });
  const files = changedPaths(diff);
  // A path name is a channel of its own: git prints a non-ASCII one only as octal escapes.
  for (const { path, status } of files) {
    checkPath(path, path);
    if (status === "A") {
      tally(path, "+", path);
      credit(path, path);
    } else if (status === "D") tally(path, "-", path);
  }
  let at = -1, hunk = false, link = false, prev: string | null = null, prevNamed = false, body: [string, string][] = [];
  // A text view of a real binary file can hold the glyph bytes by chance, so a file with a NUL byte in a changed
  // line adds no dash counts. Every other check still applies to it.
  const endFile = () => {
    if (!body.some(([, text]) => text.includes(NUL))) for (const [sign, text] of body) tally(text, sign, files[at].path);
    body = [];
  };
  // Each added line is judged on its own: a credit verb on one line and a vendor on the next (a generated-file
  // header, then a package line) are not one phrase. Only a credit that ends one added line and a vendor that opens
  // the very next added line tie; any other line between them (a header, context, a removal) breaks the pair. A
  // command of the tool split over two added lines ties the same way, unless either line names the tool on its own.
  for (const line of diff.split("\n")) {
    const sign = hunk ? line[0] : "";
    if (sign !== "+") prev = null;
    if (line.startsWith("diff --git ")) {
      endFile();
      [at, hunk, link] = [at + 1, false, false];
    } else if (line.startsWith("@@")) hunk = true;
    // A symlink's content is its target, which must not reach an agent or denied path either.
    else if (!hunk) link ||= /^(?:new (?:file )?mode|index \S+) 120000$/.test(line);
    else if (sign === "+" || sign === "-") {
      const { path } = files[at], text = line.slice(1);
      body.push([sign, text]);
      if (sign === "+") {
        const cased = unify(text);
        const named = credit(text, path, cased);
        const pair = prev === null ? null : wrappedCredit(prev, cased);
        if (pair !== null) flag("attribution", `${path}: ${pair}`);
        const split = prev === null || prevNamed || named ? null : splitCommand(prev, cased, nameIsWord);
        if (split !== null) flag("attribution", `${path}: names the tool (${split})`);
        [prev, prevNamed] = [cased, named];
      }
      if (sign === "+" && link) checkPath(linkTarget(path, text), `${path} -> ${text}`);
    }
  }
  endFile();
  DASHES.forEach((_, k) => {
    if (plus[k] > minus[k]) flag("dash", `${dashName(k)} added ${plus[k]}, removed ${minus[k]}: ${[...where[k]].join(", ")}`);
  });
  return out;
}

const HINT = new RegExp(`(?:${VENDOR})[^\\n]{0,60}?(?:${VERBS})|(?:${VERBS})[^\\n]{0,60}?(?:${VENDOR})`);

// Advisory, never blocking: an added line or path where a vendor and a credit verb sit within 60 characters of each
// other, read as written and with camelCase humps split (a generatedBy key, the tests Claude Code has generated).
// The lead weighs these in the review pack; the blocking rules above stay narrow because accept has no override.
export function attributionHints(diff: string): { path: string; detail: string }[] {
  const files = changedPaths(diff);
  const out: { path: string; detail: string }[] = [];
  const hint = (raw: string, path: string) => {
    const cased = maskLower(unify(raw));
    const m = splitHumps(cased).toLowerCase().match(HINT) ?? cased.toLowerCase().match(HINT);
    if (m) out.push({ path, detail: clampDetail(m[0]) });
  };
  for (const { path, status } of files) if (status === "A") hint(path, path);
  let at = -1, hunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) [at, hunk] = [at + 1, false];
    else if (line.startsWith("@@")) hunk = true;
    else if (hunk && line[0] === "+") hint(line.slice(1), files[at].path);
  }
  return out;
}

// Marks peeled off a word's end one at a time, by index: a regex group retried from every start is quadratic.
const TRAILING = new Set("\"'`)]}>*~.,:;!?\u2019\u201d");
const APOSTROPHES = "'\u2019";
function trimEnd(word: string): string {
  let end = word.length;
  while (end > 0) {
    if (TRAILING.has(word[end - 1])) end--;
    else if (end > 1 && word[end - 1] === "s" && APOSTROPHES.includes(word[end - 2])) end -= 2;
    else break;
  }
  return word.slice(0, end);
}

// Per word, so prose is not matched against globs; only words that look like paths (holding / or .) are checked,
// once quotes, brackets, emphasis marks, trailing punctuation and a possessive 's are stripped.
export function checkCommitMessage(msg: string, deny: string[], nameIsWord = false): Violation[] {
  const text = fold(msg);
  const named = deny.filter((g) => !SECRET_FILE_GLOBS.includes(g));
  const found = attribution(msg).map((m) => `attribution: ${m}`);
  DASHES.forEach((d, k) => { if (msg.includes(d)) found.push(`dash: ${dashName(k)}`); });
  const trace = toolTrace(unify(msg), nameIsWord);
  if (trace !== null) found.push(`names the tool (${trace})`);
  for (const p of AGENT_PATHS) if (text.includes(fold(p))) found.push(`agent path: ${fold(p)}`);
  for (const word of text.split(/\s+/)) {
    const tok = trimEnd(word.replace(/^["'`([{<*~\u2018\u201c]+/, ""));
    if (!/[./]/.test(tok)) continue;
    if (isAgentPath(tok)) found.push(`agent path: ${tok}`);
    else if (isDenied(tok, named)) found.push(`denied path: ${tok}`);
  }
  return [...new Set(found)].map((d) => ({ kind: "message", detail: clampDetail(d) }));
}

// Words end at a separator, at a camelCase hump (claudeLogin, GPTClient) and between letters and digits (gpt5).
const WORDS = /[/._-]|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/;
// A token of five or more letters also counts at the start of a word (claudelogin). Anywhere inside, or shorter, it
// would hit ordinary words (philanthropic, encodexml).
const nameToken = (word: string) => NAME_TOKENS.find((t) => word === t || (t.length >= 5 && word.startsWith(t)));

// Git's ref rules for the allowed characters, so the name works as a branch and as path segments
// that never leave their directory.
export function checkName(name: string): Violation[] {
  const bad = (why: string): Violation[] => [{ kind: "name", detail: clampDetail(`${JSON.stringify(name)} ${why}`) }];
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return bad("may only hold letters, digits, '.', '_', '-' and '/'");
  if (name.includes("..") || name.endsWith(".") || name.split("/").some((s) => s === "" || /^[.-]|\.lock$/.test(s))) {
    return bad("is not a safe git ref or path");
  }
  const out: Violation[] = name.split(WORDS).map((w) => nameToken(w.toLowerCase())).filter((t): t is string => t !== undefined)
    .map((t) => ({ kind: "name", detail: clampDetail(`${name} contains ${t}`) }));
  // The bare name is an ordinary word, but one of the tool's own forms (a variable) is refused as in a diff.
  const trace = toolTrace(unify(name));
  if (trace !== null) out.push({ kind: "name", detail: clampDetail(`${name} names the tool (${trace})`) });
  return out;
}
