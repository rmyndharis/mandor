import { appendFileSync } from "node:fs";
import { withProjectLock } from "../../src/store.ts";

// Usage: lock.ts <projectId> <marker file> <rounds> <hold ms> <goAt epoch ms>
// Each round takes the project lock and writes "<pid> enter" and "<pid> exit" around a pause.
const [id, markers, rounds, holdMs, goAt] = process.argv.slice(2);
const pause = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number) => Atomics.wait(pause, 0, 0, Math.max(0, ms));

// Every process starts at goAt, so they really contend for the lock.
sleep(Number(goAt) - Date.now());
for (let i = 0; i < Number(rounds); i++) {
  withProjectLock(id, () => {
    appendFileSync(markers, `${process.pid} enter\n`);
    sleep(Number(holdMs));
    appendFileSync(markers, `${process.pid} exit\n`);
  }, { maxWaitMs: 10_000 });
}
