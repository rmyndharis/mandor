import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { mandorHome } from "../home.ts";
import { ensureDir } from "../store.ts";

// Vendor CLIs have printed OAuth tokens on stderr, so it goes only to a private log, never to output.
export function keepVendorStderr(tool: string, args: string[], r: { stderr?: string | null; error?: Error }): void {
  if (!r.stderr && !r.error) return;
  const logs = join(mandorHome(), "logs");
  ensureDir(logs);
  const head = `${new Date().toISOString()} ${tool} ${args.join(" ")}${r.error ? `: ${r.error.message}` : ""}`;
  appendFileSync(join(logs, "vendor.stderr"), `${head}\n${(r.stderr ?? "").replace(/\n?$/, "\n")}`, { mode: 0o600 });
}
