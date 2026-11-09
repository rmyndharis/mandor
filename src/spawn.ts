import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "cli.ts");

// Runs in a short-lived Node process that exits as soon as the runner is started, so the runner is
// reparented to PID 1 at once. Claude Code kills its whole process tree by parent pid when it quits,
// setsid children included, so a runner must never stay the child of a live process. stdio "ignore"
// keeps the runner off the launcher's stdout pipe, which would hold spawnSync (and the caller's
// locks) for the whole job.
const LAUNCHER = `
const [cli, jobId] = process.argv.slice(1);
const { spawn } = process.getBuiltinModule("node:child_process");
const runner = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "_run", jobId], { detached: true, stdio: "ignore" });
runner.unref();
process.stdout.write(String(runner.pid));
`;

export function spawnRunner(jobId: string): void {
  const r = spawnSync(process.execPath, ["-e", LAUNCHER, CLI, jobId], { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, encoding: "utf8" });
  if (r.error !== undefined || r.status !== 0 || !/^[1-9]\d*$/.test(r.stdout)) {
    throw new Error(`runner launch failed: ${r.error?.message ?? (r.status === 0 ? "no runner pid printed" : `exit ${r.status ?? r.signal}`)}`);
  }
}
