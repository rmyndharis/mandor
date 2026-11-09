import { appendJsonl } from "../../src/store.ts";

// Usage: append.ts <file> <writer> <count> <goAt epoch ms>
const [file, writer, count, goAt] = process.argv.slice(2);
// Every writer starts at goAt, so the appends really overlap.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(goAt) - Date.now()));
// Lines of about 3 KB would interleave visibly if appends were not atomic.
const pad = "x".repeat(3000);
for (let i = 0; i < Number(count); i++) appendJsonl(file, { w: Number(writer), i, pad });
