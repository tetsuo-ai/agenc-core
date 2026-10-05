import { tokenizeCliOptionRegion } from "./cli-option-region.js";
import { isDirectInvocation, shouldUseDetachedDaemonEntry } from "./daemon-entry-policy.js";
import { startupShortCircuitFlag } from "./startup-preflight.js";

export type AgenCCliEntry = "main" | "print" | "detached-daemon";

/** Shared by the launcher and the deferred main module's automatic-entry guard. */
export function selectAgenCCliEntry(
  argv: readonly string[] = process.argv,
  env: Readonly<Record<string, string | undefined>> = process.env,
  hasParentIpc = typeof process.send === "function",
): AgenCCliEntry {
  if (shouldUseDetachedDaemonEntry(argv, env, hasParentIpc)) return "detached-daemon";
  if (!isDirectInvocation(argv, env)) return "main";
  const args = argv.slice(2);
  if (args[0] !== "-p" && args[0] !== "--print") return "main";
  if (startupShortCircuitFlag(args) !== null) return "main";
  const { optionArgs } = tokenizeCliOptionRegion(args);
  if (optionArgs.some((arg) => ["--resume", "-r", "--continue", "-c"].some(
    (flag) => arg === flag || arg.startsWith(`${flag}=`),
  ))) return "main";
  return "print";
}
