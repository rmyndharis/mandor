import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { Candidate } from "../src/contracts.ts";
import { DEFAULT_CONFIG, formatCandidate, loadConfig, parseCandidate, resolveCodexBin, validateConfig } from "../src/config.ts";
import { IGNORE_USER_CONFIG } from "../src/spikes.ts";
import { temp, tempHome } from "./helpers.ts";

const FAKE = join(import.meta.dirname, "fake-bin", "fake-codex.mjs");

// Sets an environment variable for one test; undefined unsets it.
function setEnv(t: TestContext, key: string, value: string | undefined): void {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}

const tempDir = () => temp("mandor-bin-");
function binIn(dir: string, name: string, mode: number): string {
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\n", { mode });
  return p;
}
const clone = () => structuredClone(DEFAULT_CONFIG) as any;

test("DEFAULT_CONFIG tiers equal the spec table", () => {
  assert.deepEqual(DEFAULT_CONFIG.tiers, {
    heavy: ["codex:gpt-6-astra@ultra", "codex:gpt-6.1-sol@max", "zcode:GLM-5.3@max", "agy:gemini-4-argon-high"],
    medium: ["codex:gpt-6.1-sol@high", "zcode:GLM-5.3@high", "agy:gemini-4-argon-medium", "codex:gpt-6-luna@high"],
    light: ["codex:gpt-6-luna@medium", "zcode:GLM-5.3-Flash@high", "agy:gemini-3.8-flash-medium"],
  });
});

test("only codex is enabled", () => {
  const { tools } = DEFAULT_CONFIG;
  assert.deepEqual(Object.keys(tools).sort(), ["agy", "codex", "zcode"]);
  assert.equal(tools.codex.enabled, true);
  assert.equal(tools.zcode.enabled, false);
  assert.equal(tools.agy.enabled, false);
});

test("maxParallel 2, maxFixRounds 3, jobTimeoutMinutes 60", () => {
  assert.equal(DEFAULT_CONFIG.version, 1);
  for (const t of Object.values(DEFAULT_CONFIG.tools)) assert.equal(t.maxParallel, 2);
  assert.equal(DEFAULT_CONFIG.maxFixRounds, 3);
  assert.equal(DEFAULT_CONFIG.jobTimeoutMinutes, 60);
});

test("tool bins default to the tool name and ignoreUserConfig to the spike value", () => {
  for (const [name, t] of Object.entries(DEFAULT_CONFIG.tools)) {
    assert.equal(t.bin, name);
    assert.equal(t.ignoreUserConfig, IGNORE_USER_CONFIG);
  }
});

test("parseCandidate reads tool, model and effort", () => {
  assert.deepEqual(parseCandidate("codex:gpt-6-astra@ultra"), { tool: "codex", model: "gpt-6-astra", effort: "ultra" });
});

test("a candidate without @ has effort empty", () => {
  assert.deepEqual(parseCandidate("agy:gemini-4-argon-high"), { tool: "agy", model: "gemini-4-argon-high", effort: "" });
});

test("the model is everything between the first colon and the last @", () => {
  assert.deepEqual(parseCandidate("zcode:a:b@c@high"), { tool: "zcode", model: "a:b@c", effort: "high" });
});

test("parseCandidate rejects an unknown tool, a missing colon, an empty model and an empty effort", () => {
  for (const bad of ["foo:bar", "codex", "", ":gpt", "codex:", "codex:@high", "codex:gpt@"]) {
    assert.throws(() => parseCandidate(bad), /candidate/, JSON.stringify(bad));
  }
});

test("parseCandidate rejects whitespace around the model or the effort", () => {
  for (const bad of ["codex: gpt", "codex:gpt ", "codex:   ", "codex:gpt@ high", "codex:gpt@high ", "codex:gpt@ ", "codex:gpt @high"]) {
    assert.throws(() => parseCandidate(bad), /candidate/, JSON.stringify(bad));
  }
});

test("formatCandidate inverts parseCandidate for every default candidate", () => {
  for (const list of Object.values(DEFAULT_CONFIG.tiers)) {
    for (const s of list) assert.equal(formatCandidate(parseCandidate(s)), s);
  }
  const c: Candidate = { tool: "agy", model: "m", effort: "" };
  assert.equal(formatCandidate(c), "agy:m");
});

test("validateConfig accepts the default and a fractional timeout", () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  const cfg = clone();
  cfg.jobTimeoutMinutes = 0.05;
  cfg.maxFixRounds = 0;
  assert.deepEqual(validateConfig(cfg), []);
  cfg.jobTimeoutMinutes = 1440; // a day is the cap, far below Node's timer limit
  assert.deepEqual(validateConfig(cfg), []);
});

test("validateConfig rejects an unknown tier and an unknown tool", () => {
  const cfg = clone();
  cfg.tiers.mega = ["codex:x"];
  cfg.tools.gemini = cfg.tools.codex;
  assert.deepEqual(validateConfig(cfg), ["unknown tool: gemini", "unknown tier: mega"]);
});

test("validateConfig rejects a missing tool and a missing tier", () => {
  const cfg = clone();
  delete cfg.tools.zcode;
  delete cfg.tiers.light;
  assert.deepEqual(validateConfig(cfg), ["tools.zcode is missing", "tiers.light is missing"]);
});

test("validateConfig reports one message per bad field", () => {
  const cases: [(c: any) => void, RegExp][] = [
    [(c) => (c.version = 2), /version/],
    [(c) => (c.tools.codex.enabled = "yes"), /tools\.codex\.enabled/],
    [(c) => (c.tools.codex.maxParallel = 0), /tools\.codex\.maxParallel/],
    [(c) => (c.tools.codex.maxParallel = 1.5), /tools\.codex\.maxParallel/],
    [(c) => (c.tools.codex.bin = ""), /tools\.codex\.bin/],
    [(c) => (c.tools.codex.ignoreUserConfig = 1), /tools\.codex\.ignoreUserConfig/],
    [(c) => (c.maxFixRounds = -1), /maxFixRounds/],
    [(c) => (c.maxFixRounds = 1.5), /maxFixRounds/],
    [(c) => (c.jobTimeoutMinutes = 0), /jobTimeoutMinutes/],
    [(c) => (c.jobTimeoutMinutes = Infinity), /jobTimeoutMinutes/],
    [(c) => (c.jobTimeoutMinutes = 1441), /jobTimeoutMinutes/],
    [(c) => (c.tiers.heavy = "codex:x"), /tiers\.heavy/],
    [(c) => (c.tiers.heavy = [3]), /tiers\.heavy/],
    [(c) => (c.tiers.heavy = ["foo:bar"]), /tiers\.heavy.*foo:bar/],
  ];
  for (const [mutate, re] of cases) {
    const cfg = clone();
    mutate(cfg);
    const errs = validateConfig(cfg);
    assert.equal(errs.length, 1, errs.join("; "));
    assert.match(errs[0], re);
  }
  for (const v of [null, "x", [], 7]) assert.equal(validateConfig(v).length, 1);
});

test("loadConfig writes the default once", () => {
  const home = tempHome();
  const file = join(home, "config.json");
  assert.equal(existsSync(file), false);
  assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), DEFAULT_CONFIG);

  // An existing file is the whole config: it is neither rewritten nor merged with defaults.
  const edited = clone();
  edited.tools.zcode.enabled = true;
  edited.maxFixRounds = 5;
  writeFileSync(file, JSON.stringify(edited));
  assert.deepEqual(loadConfig(), edited);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), edited);
});

test("a config file with a tool missing fails instead of being completed from the defaults", () => {
  const home = tempHome();
  const file = join(home, "config.json");
  const partial = clone();
  delete partial.tools.zcode;
  const text = JSON.stringify(partial);
  writeFileSync(file, text);
  assert.throws(() => loadConfig(), /^Error: invalid config: tools\.zcode is missing$/);
  assert.equal(readFileSync(file, "utf8"), text);
});

test("a config file keyed by the Indonesian tier names loads as the tiers they name, and is left as written", () => {
  const home = tempHome();
  const file = join(home, "config.json");
  const { light, medium, heavy } = DEFAULT_CONFIG.tiers;
  const text = JSON.stringify({ ...clone(), tiers: { ringan: light, sedang: medium, berat: heavy } });
  writeFileSync(file, text);
  assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
  assert.equal(readFileSync(file, "utf8"), text);

  // One alias among the present names reads too, and an alias beside its own tier is refused, not merged.
  writeFileSync(file, JSON.stringify({ ...clone(), tiers: { light, sedang: medium, heavy } }));
  assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
  writeFileSync(file, JSON.stringify({ ...clone(), tiers: { light, medium, heavy, ringan: ["codex:x"] } }));
  assert.throws(() => loadConfig(), /^Error: invalid config: unknown tier: ringan$/);
});

test("loadConfig returns a copy, so callers cannot change the defaults", () => {
  tempHome();
  loadConfig().tiers.heavy.length = 0;
  assert.equal(DEFAULT_CONFIG.tiers.heavy.length, 4);
});

test("loadConfig throws on an invalid file and on text that is not JSON", () => {
  const home = tempHome();
  const bad = clone();
  bad.tools.codex.maxParallel = 0;
  bad.tiers.heavy = ["foo:bar"];
  writeFileSync(join(home, "config.json"), JSON.stringify(bad));
  assert.throws(() => loadConfig(), /^Error: invalid config: tools\.codex\.maxParallel .*; tiers\.heavy/);
  writeFileSync(join(home, "config.json"), "{ nope");
  assert.throws(() => loadConfig(), /invalid config: .*config\.json/);
});

test("tempHome({ config: true }) writes a valid config that points codex at the fake", () => {
  const home = tempHome({ config: true });
  const cfg = loadConfig();
  assert.deepEqual(validateConfig(cfg), []);
  assert.equal(cfg.tools.codex.bin, FAKE);
  assert.equal(cfg.tools.codex.enabled, true);
  assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(tempHome(), "config.json")), false);
});

test("resolveCodexBin prefers MANDOR_CODEX_BIN", () => {
  tempHome();
  const cfg = clone();
  cfg.tools.codex.bin = "/somewhere/else/codex";
  assert.equal(process.env.MANDOR_CODEX_BIN, FAKE);
  assert.equal(resolveCodexBin(cfg), FAKE); // the file does not have to exist
});

test("resolveCodexBin makes a relative MANDOR_CODEX_BIN absolute", (t) => {
  setEnv(t, "MANDOR_CODEX_BIN", "rel/codex");
  assert.equal(resolveCodexBin(clone()), resolve("rel/codex"));
});

test("resolveCodexBin returns an absolute configured bin as is", (t) => {
  setEnv(t, "MANDOR_CODEX_BIN", undefined);
  const cfg = clone();
  cfg.tools.codex.bin = "/no/such/dir/codex";
  assert.equal(resolveCodexBin(cfg), "/no/such/dir/codex");
});

test("resolveCodexBin looks a bare name up on PATH and skips what is not executable", (t) => {
  setEnv(t, "MANDOR_CODEX_BIN", undefined);
  const [plain, dir, later] = [tempDir(), tempDir(), tempDir()];
  mkdirSync(join(plain, "codex")); // a directory of that name is not a program
  binIn(dir, "codex", 0o644);
  const want = binIn(later, "codex", 0o755);
  setEnv(t, "PATH", [plain, dir, later].join(":"));
  assert.equal(resolveCodexBin(clone()), want);
});

test("resolveCodexBin never searches the working directory through an empty or relative PATH entry", (t) => {
  setEnv(t, "MANDOR_CODEX_BIN", undefined);
  const cwd = tempDir();
  binIn(cwd, "codex", 0o755); // found by an empty entry
  mkdirSync(join(cwd, "sub"));
  binIn(join(cwd, "sub"), "codex", 0o755); // found by the relative entry "sub"
  const old = process.cwd();
  process.chdir(cwd);
  t.after(() => process.chdir(old));

  setEnv(t, "PATH", ["", "sub", ".", "../" + basename(cwd)].join(":"));
  assert.throws(() => resolveCodexBin(clone()), /^Error: codex not found on PATH$/);

  const abs = tempDir();
  const want = binIn(abs, "codex", 0o755);
  setEnv(t, "PATH", ["", "sub", abs].join(":"));
  const got = resolveCodexBin(clone());
  assert.equal(got, want);
  assert.ok(isAbsolute(got));
});

test("a configured bin with a slash is resolved against the working directory and never searched on PATH", (t) => {
  setEnv(t, "MANDOR_CODEX_BIN", undefined);
  const onPath = tempDir();
  binIn(onPath, "codex", 0o755);
  setEnv(t, "PATH", onPath);
  for (const bin of ["./codex", "../codex", "bin/codex", "sub/../codex"]) {
    const cfg = clone();
    cfg.tools.codex.bin = bin;
    const got = resolveCodexBin(cfg);
    assert.equal(got, resolve(bin), bin);
    assert.notEqual(got, join(onPath, "codex"), bin);
    assert.ok(isAbsolute(got), bin);
  }
});

test("resolveCodexBin throws when the name is not on PATH", (t) => {
  setEnv(t, "MANDOR_CODEX_BIN", undefined);
  setEnv(t, "PATH", tempDir());
  assert.throws(() => resolveCodexBin(clone()), /^Error: codex not found on PATH$/);
});
