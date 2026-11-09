import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const dir = join(import.meta.dirname, "fixtures");
const uuid = /(?<![0-9a-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-z])/gi;
const [emDash, enDash, bar] = [0x2014, 0x2013, 0x2015].map((c) => String.fromCharCode(c));

const forbidden: [string, (s: string) => boolean][] = [
  ["/Users/", (s) => s.includes("/Users/")],
  ["eyJ", (s) => s.includes("eyJ")],
  ["Bearer ", (s) => s.includes("Bearer ")],
  // Token start only, so "task-specific" and "risk-free" stay legal.
  ["sk-", (s) => /(?<![A-Za-z0-9])sk-/.test(s)],
  ["email", (s) => /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(s)],
  // Ids must be fixed fakes: every UUID starts with 00000000-0000-.
  ["real uuid", (s) => (s.match(uuid) ?? []).some((u) => !u.toLowerCase().startsWith("00000000-0000-"))],
  ["org or user id", (s) => /(?<![A-Za-z0-9])(org|user)-[A-Za-z0-9]{20,}/.test(s)],
  ["request id", (s) => /(?<![A-Za-z0-9])req_[A-Za-z0-9]{16,}/.test(s)],
  ["em dash", (s) => s.includes(emDash)],
  ["en dash", (s) => s.includes(enDash)],
  ["horizontal bar", (s) => s.includes(bar)],
];

test("fixtures are scrubbed", () => {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
  assert.notEqual(files.length, 0, "no fixtures found");
  const hits = files.flatMap((f) => {
    const text = readFileSync(f, "utf8");
    return forbidden.filter(([, bad]) => bad(text)).map(([name]) => `${f}: ${name}`);
  });
  assert.deepEqual(hits, []);
});
