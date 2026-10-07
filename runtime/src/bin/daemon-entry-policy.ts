import {
  AGENC_DAEMON_STARTUP_GUARD_ENV,
  isAgenCDaemonStartupGuardToken,
} from "../app-server/daemon-startup-guard.js";
import type { AgenCDaemonCliAction } from "../app-server/daemon-control.js";

/** Route eligibility only; authority still requires the existing daemon handshake. */
function isGuardedDetachedDaemonChild(
  env: Readonly<Record<string, string | undefined>>,
  hasParentIpc: boolean,
): boolean {
  return env.AGENC_DAEMON_RUN === "1" && hasParentIpc &&
    isAgenCDaemonStartupGuardToken(env[AGENC_DAEMON_STARTUP_GUARD_ENV]);
}

export function shouldRunDaemonStartupSecurityAudit(
  action: AgenCDaemonCliAction,
  env: Readonly<Record<string, string | undefined>> = process.env,
  hasParentIpc = typeof process.send === "function",
): boolean {
  if (action !== "start" && action !== "run" && action !== "restart") {
    return false;
  }
  return !(action === "run" && isGuardedDetachedDaemonChild(env, hasParentIpc));
}


export function isDirectInvocation(
  argv: readonly string[] = process.argv,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  // Env opt-out: tests can force the IIFE off even on odd harnesses.
  if (env.AGENC_CLI_ENTRY_DISABLE === "1") return false;
  const argv1 = argv[1];
  if (!argv1) return false;
  // The CLI binary resolves to `<prefix>/bin/agenc.js` (or `.mjs`) and
  // the `agenc` shim in `package.json.bin` symlinks to this script.
  // Match the tail of the entry path so both `node .../agenc.js` and
  // the installed `agenc` CLI pass the check.
  return /[\\/]bin[\\/]agenc(?:\.[mc]?js)?$/.test(argv1);
}


export function shouldUseDetachedDaemonEntry(
  argv: readonly string[] = process.argv,
  env: Readonly<Record<string, string | undefined>> = process.env,
  hasParentIpc = typeof process.send === "function",
): boolean {
  return isDirectInvocation(argv, env) &&
    argv.length === 5 && argv[2] === "daemon" &&
    argv[3] === "start" && argv[4] === "--foreground" &&
    isGuardedDetachedDaemonChild(env, hasParentIpc);
}
