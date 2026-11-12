import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FileRef } from "./contracts.ts";
import { mandorHome, processAlive, processStart, projectDir } from "./home.ts";

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true, mode: 0o700 });
}

// Readers see the old file or the new one, never a partial write.
export function writeFileAtomic(p: string, data: string | Uint8Array): void {
  ensureDir(dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, p);
}

export function writeJsonAtomic(p: string, v: unknown): void {
  writeFileAtomic(p, `${JSON.stringify(v, null, 2)}\n`);
}

export function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

// One O_APPEND write of at most 4096 bytes, newline included, so concurrent appenders never interleave.
export function appendJsonl(p: string, v: object): void {
  const line = `${JSON.stringify(v)}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > 4096) throw new Error(`ledger line of ${bytes} bytes exceeds 4096: ${p}; shorten what the command records, or tell the user`);
  ensureDir(dirname(p));
  appendFileSync(p, line, { mode: 0o600 });
}

// A last line without its newline is still being written and waits for the next read.
// A complete line that does not parse is corruption, and must not be skipped silently.
export function readJsonl<T>(p: string, fromByte = 0): { items: T[]; endByte: number } {
  let buf: Buffer;
  try {
    buf = readFileSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { items: [], endByte: fromByte };
    throw e;
  }
  const items: T[] = [];
  let at = fromByte;
  let nl: number;
  while ((nl = buf.indexOf(10, at)) !== -1) {
    try {
      items.push(JSON.parse(buf.toString("utf8", at, nl)));
    } catch {
      throw new Error(`${p}: unparsable line at byte ${at}; the user repairs that file, as it stops every command of the project: tell them`);
    }
    at = nl + 1;
  }
  return { items, endByte: at };
}

export function fileRef(path: string): FileRef {
  const data = readFileSync(path);
  return { path, sha256: createHash("sha256").update(data).digest("hex"), excerpt: clampDetail(data.toString("utf8")) };
}

const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014, 0x2015)}]`, "g");

// Cuts at 300 UTF-16 units and drops a high surrogate the cut would leave alone.
// The control bytes of a worker's file, written as \xNN: printed raw they could rewrite lines already shown on a screen. A
// tab and a line end stay, and so does the carriage return of a CRLF. The marks that make a reader's text run the other way
// (U+202A to U+202E, U+2066 to U+2069) are written as \uNNNN, as they would show a name or a line as it is not.
export const maskControls = (text: string): string =>
  text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]|\r(?!\n)/g, (c) => {
    const code = c.charCodeAt(0);
    return code > 0xff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\x${code.toString(16).padStart(2, "0")}`;
  });

export function clampDetail(s: string): string {
  return s.replace(/\s+/g, " ").replace(DASHES, "-").trim().slice(0, 300).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
}

interface Holder { raw: string; pid: number; start: string | null }

// undefined: no lock file. null: unparsable or unreadable, which counts as held.
function readHolder(lock: string): Holder | null | undefined {
  let raw: string;
  try {
    raw = readFileSync(lock, "utf8");
  } catch (e) {
    const { code } = e as NodeJS.ErrnoException;
    if (code === "ENOENT") return undefined;
    // A holder that cannot be read cannot be shown gone, so it is not broken as stale.
    if (code === "EACCES" || code === "EPERM") return null;
    throw e;
  }
  try {
    const v = JSON.parse(raw);
    if (Number.isSafeInteger(v.pid) && v.pid > 0 && (typeof v.start === "string" || v.start === null)) return { raw, pid: v.pid, start: v.start };
  } catch {}
  return null;
}

// Every attempt writes a new name exclusively (wx), so it never reuses a temp name that a
// killed process left linked to a lock, and never writes through such a name into a lock.
function link(lock: string, body: string): boolean {
  const tmp = `${lock}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600, flag: "wx", flush: true });
    linkSync(tmp, lock);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

let ownStart: string | null = null;

// One attempt, never waiting: true when this process now holds the lock. The few tries
// cover a holder that leaves mid-attempt and a stale lock just broken; after them the
// caller's sleep, deadline and tryOnce apply.
function tryLock(lock: string): boolean {
  ownStart ??= processStart(process.pid);
  for (let tries = 0; tries < 3; tries++) {
    if (link(lock, JSON.stringify({ pid: process.pid, start: ownStart }))) return true;
    const h = readHolder(lock);
    if (h === undefined) continue; // gone before it could be read, or a dangling symlink
    if (h === null || processAlive(h.pid, h.start)) return false;
    // Only the holder of <lock>.break may remove a stale lock, so two breakers never
    // both unlink, and one never removes the lock a faster process just took.
    if (!tryLock(`${lock}.break`)) return false;
    try {
      if (readHolder(lock)?.raw === h.raw) {
        unlinkSync(lock);
        const logs = join(mandorHome(), "logs");
        ensureDir(logs);
        appendFileSync(join(logs, "locks.log"), `${new Date().toISOString()} broke stale lock ${lock} held by pid ${h.pid}\n`, { mode: 0o600 });
      }
    } finally {
      rmSync(`${lock}.break`, { force: true });
    }
  }
  return false;
}

const held = new Set<string>();
const pause = new Int32Array(new SharedArrayBuffer(4));

function withLock<T>(lock: string, busy: string, fn: () => T, maxWaitMs: number | null, tryOnce: boolean): T | null {
  if (held.has(lock)) {
    if (tryOnce) return null;
    throw new Error(`${lock} is already held by this process; the lock is not re-entrant; this is a bug in mandor: tell the user`); // waiting would never end
  }
  ensureDir(dirname(lock));
  const deadline = maxWaitMs === null ? Infinity : Date.now() + maxWaitMs;
  while (!tryLock(lock)) {
    if (tryOnce) return null;
    if (Date.now() >= deadline) throw new Error(`${busy} (${lock}); retry shortly, and if it stays, tell the user: the lock file may be damaged or its holder stuck`);
    Atomics.wait(pause, 0, 0, 50);
  }
  held.add(lock);
  try {
    return fn();
  } finally {
    held.delete(lock);
    // force: a lock that vanished must neither fail a finished fn nor hide the error fn threw.
    rmSync(lock, { force: true });
  }
}

const slotsLock = () => join(mandorHome(), "slots.lock");

// Not re-entrant. Functions named ...Locked expect the caller to hold this lock.
// When both locks are needed, take this one first, then the slots lock.
export function withProjectLock<T>(projectId: string, fn: () => T, opts: { maxWaitMs?: number | null; tryOnce?: boolean } = {}): T | null {
  // The reverse order could deadlock against a process that keeps to this one.
  if (held.has(slotsLock())) throw new Error("lock order: take the project lock before the slots lock; this is a bug in mandor: tell the user");
  const maxWaitMs = opts.maxWaitMs === undefined ? 30_000 : opts.maxWaitMs;
  return withLock(join(projectDir(projectId), "lock"), "project busy", fn, maxWaitMs, opts.tryOnce ?? false);
}

export function withSlotsLock<T>(fn: () => T): T {
  return withLock(slotsLock(), "slots busy", fn, 30_000, false) as T;
}
