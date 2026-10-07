import "../bootstrap/node-env.js";
import { parseAgenCDaemonCliArgs, runAgenCDaemonCli } from "../app-server/daemon-control.js";
import { prepareCliRuntime } from "./cli-runtime.js";
import { runCliProcessMain } from "./cli-process-main.js";

/** The existing guarded child command, using the canonical daemon implementation. */
export async function detachedDaemonMain(): Promise<number> {
  const ingressExitCode = prepareCliRuntime();
  if (ingressExitCode !== null) return ingressExitCode;
  const command = parseAgenCDaemonCliArgs(process.argv.slice(2));
  if (command === null) throw new Error("invalid detached daemon command");
  return runAgenCDaemonCli(command, { enterDaemonHome: true });
}

export function runDetachedDaemonChildEntry(): Promise<void> {
  return runCliProcessMain(detachedDaemonMain);
}
