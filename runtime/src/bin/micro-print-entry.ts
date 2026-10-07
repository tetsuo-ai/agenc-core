import "../bootstrap/node-env.js";
import { appendFileSync } from "node:fs";
/** Separately emitted leaf bundle: a resident print request never imports the app bundle. */
import { prepareCliRuntime } from "./cli-runtime.js";
import { runCliProcessMain } from "./cli-process-main.js";
import { installGlobalErrorNet } from "../utils/global-error-net.js";
import { userRuntimeEnvironment } from "../utils/runtimeEnvironment.js";
import { resolveRuntimePackageRootFromUrl } from "../app-server/daemon-runtime-info.js";
import { tryMicroPrint } from "./micro-print-client.js";

/** True means the invocation has finished; false permits the canonical route. */
export async function runMicroPrintEntry(): Promise<boolean> {
  installGlobalErrorNet();
  const ingressExitCode = prepareCliRuntime();
  if (ingressExitCode !== null) {
    await runCliProcessMain(async () => ingressExitCode);
    return true;
  }
  let cwd: string;
  try { cwd = process.cwd(); } catch { return false; }
  const runtimeRoot = resolveRuntimePackageRootFromUrl(import.meta.url);
  if (runtimeRoot === null) return false;
  const result = await tryMicroPrint({
    argv: process.argv.slice(2), cwd, env: userRuntimeEnvironment(process.env),
    caller: { pid: process.pid, stdinIsTTY: process.stdin.isTTY === true,
      stdoutIsTTY: process.stdout.isTTY === true, stderrIsTTY: process.stderr.isTTY === true },
  }, runtimeRoot);
  // Optional payload-free acquisition witness, after the invocation completes.
  // A successful micro run writes this after its provider request and output.
  const receiptPath = process.env.AGENC_MICRO_PRINT_RECEIPT;
  if (receiptPath) {
    try { appendFileSync(receiptPath, JSON.stringify({ version: 1, pid: process.pid,
      route: result === null ? "fallback" : "micro", exitCode: result }) + "\n", { mode: 0o600 }); } catch { /* optional diagnostics */ }
  }
  if (result === null) return false;
  await runCliProcessMain(async () => result);
  return true;
}
