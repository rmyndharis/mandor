// The forms of the tool's name that only the tool puts into text: its home directory as a path component, its
// environment variables, its commands and its skill ids. The bare name is an ordinary word (Indonesian for a foreman),
// so it alone is no trace. Every form is joined at runtime, so this file and the guards pass the diff check they make.
const NAME = ["man", "dor"].join("");

export const TOOL_VARS: readonly string[] = ["HOME", "CODEX_BIN", "JOB"].map((v) => `${NAME.toUpperCase()}_${v}`);
// The top-level commands src/cli.ts and src/status.ts dispatch on.
export const TOOL_COMMANDS: readonly string[] = ["_run", "--version", "cancel", "confirm", "dispatch", "drop", "goal", "hook", "init",
  "logs", "models", "plan", "project", "ready", "reassign", "review", "scratch", "show", "status", "verdict", "wait"];
const SKILLS = ["lead", "status"];

// A letter, a digit, an underscore or a hyphen next to a command or a skill id makes it part of another word.
const WORD_CHARS = "\\p{L}\\p{N}_-";
const WORD = `[${WORD_CHARS}]`;
// The literal lit, not right after one of chars. In source text a backslash escape (\n, \r, \t) stands for a line break
// or a tab, so the letter that ends it is no word letter. The literal comes first and the lookbehind after it, so a
// scan finds the literal at native speed rather than trying the lookbehind at every position.
const after = (chars: string, lit: string, behind = lit) => `${lit}(?<=(?:^|\\\\[nrt]|[^${chars}])${behind})`;
const QUOTE = "[\"'`]";
// What ends a command word on a line: no word character, and no key separator, bare (Status: aktif, review = 3) or
// after the closing quote of a key ("Status": ..., 'review' = ...). A comma still ends a command, and so does a colon
// after a backtick or a quote before a comma, as commands are mentioned in prose, in calls and in scripts.
const COMMAND_END = `(?!${WORD}|\\s*[:=]|["']\\s*[:=])`;
// What ends a command word that opens a line: also no list separator, quoted or not, as a CSV row has (project,Alpha).
const ROW_END = `(?!${WORD}|${QUOTE}?\\s*[:=,])`;
// A closing quote or backtick (escaped too, as inside a JSON string) after the name of a quoted launcher path: the
// name right after a path separator. After a bare name it ends the command form, so the name as a quoted word passes.
const LAUNCHER_QUOTE = `(?:(?<=[/\\\\]${NAME})\\\\?${QUOTE})?`;
// Whitespace between the name and the command, a line break or its escape too, and an opening quote before a quoted
// command word, which a shell runs as the word. A path to the launcher (bin/, ./) runs it as well.
const command = (commands: readonly string[]) =>
  `${after(WORD_CHARS, NAME)}${LAUNCHER_QUOTE}(?:\\s|\\\\[nrt])+${QUOTE}?(?:${commands.join("|")})${COMMAND_END}`;
const TRACE = [
  // The home directory is a path component, so a separator sits next to it: after one, it ends the path or the
  // component (a full stop may end the sentence); or it opens a relative path. A property, a selector or a file name
  // (foo., .json) is none.
  `\\.${NAME}(?<=[/\\\\]\\.${NAME})(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`,
  `${after("\\p{L}\\p{N}", `\\.${NAME}`)}(?=[/\\\\])`,
  command(TOOL_COMMANDS),
  `(?:${after(WORD_CHARS, `/${NAME}`)}|${after(WORD_CHARS, NAME)}):(?:${SKILLS.join("|")})(?!${WORD})`,
].join("|");
// The variables count in upper case only: a shell variable is case-sensitive, and the name with a suffix in lower case
// (a foreman's job) is an ordinary identifier. Every other form counts in any case.
const VARS = `${after("\\p{L}\\p{N}_", `(?:${TOOL_VARS.join("|")})`)}(?![\\p{L}\\p{N}_])`;
const FIRST = [new RegExp(TRACE, "iu"), new RegExp(VARS, "u")];
const EVERY = [new RegExp(TRACE, "giu"), new RegExp(VARS, "gu")];

// The first trace, as written, in text read as the guards read it (invisible characters dropped, NFKC, not
// lowercased), or null.
export function toolTrace(text: string): string | null {
  const found = FIRST.map((re) => re.exec(text)).filter((m) => m !== null);
  return found.length === 0 ? null : found.reduce((a, b) => (b.index < a.index ? b : a))[0];
}

// Every trace replaced.
export const replaceTraces = (text: string, by: string): string => EVERY.reduce((t, re) => t.replace(re, by), text);

// A command split over two lines, read as the guards read text: the name ends the first, maybe with the closing quote
// of a launcher path and a line continuation after it, and a command opens the second, maybe after an opening quote.
// The name and the command as written, or null. A list marker or any other word between them is no command.
const ENDS = new RegExp(`${after(WORD_CHARS, `(${NAME})`, NAME)}${LAUNCHER_QUOTE}$`, "iu");
const OPENS = new RegExp(`^\\s*${QUOTE}?(${TOOL_COMMANDS.join("|")})${ROW_END}`, "iu");
export function splitCommand(first: string, second: string): string | null {
  const end = first.trimEnd();
  const name = ENDS.exec(end.endsWith("\\") ? end.slice(0, -1).trimEnd() : end);
  const open = name === null ? null : OPENS.exec(second);
  return open === null ? null : `${name![1]} ${open[1]}`;
}

// Whether text holds one of commands, as a trace's command form reads it, starting exactly at index at. Text with
// every trace replaced holds none.
export function commandAt(commands: readonly string[]): (text: string, at: number) => boolean {
  const re = new RegExp(command(commands), "iuy");
  return (text, at) => {
    re.lastIndex = at;
    return re.test(text);
  };
}

// Whether text holds one of commands anywhere, as a trace's command form reads it.
export function commandIn(commands: readonly string[]): (text: string) => boolean {
  const re = new RegExp(command(commands), "iu");
  return (text) => re.test(text);
}

// Where one of commands may start in JSON text whose escapes are not decoded yet and whose compatibility forms are not
// unified: the name and a gap of whitespace, quotes, the escapes that decode to them or to a backslash, and an escaped
// backslash before n, r or t (an escape written as text, which the command form reads as whitespace), then a command
// as a whole ASCII word, or within a command's length a \u escape or a character beyond ASCII that is no whitespace
// (the gap reads that), which mayStart judges. Every place commandAt accepts in the decoded text starts with one of
// these, so a scan decodes only around them. No u flag, so the scan for the name runs at native speed.
export function looseCommand(commands: readonly string[]): RegExp {
  const longest = Math.max(...commands.map((c) => c.length));
  const gap = `(?:\\s|${QUOTE}|\\\\\\\\[nrt]|\\\\[nrtbf"\\\\/])*`;
  const beyond = "\\\\u([0-9a-fA-F]{4})|([\\ud800-\\udbff][\\udc00-\\udfff]|(?!\\s)[\\u0080-\\uffff])";
  return new RegExp(`${NAME}${gap}(?:(?:${commands.join("|")})(?![a-z0-9_-])|[a-z0-9_-]{0,${longest}}(?:${beyond}))`, "gi");
}

// A character the reading may turn into whitespace, nothing, part of an ASCII word, or a mark that composes with one.
const CHANGES = /^[\p{White_Space}\p{Changes_When_NFKC_Casefolded}\p{M}]/u;
// Whether a match of looseCommand may start a command: a whole command word may, and an escaped or beyond-ASCII
// character only if it may read as whitespace, nothing or a letter. Any other one (a check mark, a box-drawing
// character, a terminal colour code) is neither whitespace nor a command's letter, so the command form stops there.
export function mayStart(m: RegExpExecArray): boolean {
  const [, hex, char] = m;
  if (hex !== undefined) {
    const c = String.fromCharCode(parseInt(hex, 16));
    return /[\s\0!-~\ud800-\udfff]/.test(c) || CHANGES.test(c);
  }
  return char === undefined || CHANGES.test(char);
}

// After the name the command form reads an optional closing quote, a gap, a word and, after it, an optional quote and
// whitespace; text that ends inside them may end before what decides. The steps are sticky and separate, so a long run
// of spaces is read once.
const GAP_Y = new RegExp(`(?:\\s|\\\\[nrt]?|${QUOTE})*`, "y");
const WORD_Y = new RegExp(`${WORD}{0,${Math.max(...TOOL_COMMANDS.map((c) => c.length))}}`, "uy");
const SPACE_Y = new RegExp(`${QUOTE}?\\s*`, "y");
export function endsOpen(text: string, at: number): boolean {
  let j = at + NAME.length;
  for (const re of [GAP_Y, WORD_Y, SPACE_Y]) {
    re.lastIndex = j;
    re.test(text);
    j = re.lastIndex;
    if (j >= text.length) return true;
  }
  return false;
}
