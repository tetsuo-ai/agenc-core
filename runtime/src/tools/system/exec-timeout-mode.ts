/**
 * The switch back to the hard timeout.
 *
 * Since 0.19.26 a command that reaches exec_command's `timeoutMs` keeps
 * running as a tracked session (unified-exec `onTimeout: "background"`).
 * config.toml `exec_hard_timeout = true`, or `AGENC_EXEC_HARD_TIMEOUT=1` in
 * the session environment, restores the earlier behavior: the command is
 * stopped at its timeout and the result says `timed_out=true`. Off by
 * default; the session environment overrides config.toml, as for the other
 * session switches (`AGENC_DEFER_RARE_TOOLS`, `AGENC_LEAN_SYSTEM_PROMPT`).
 *
 * @module
 */

import { isEnvDefinedFalsy, isEnvTruthy } from "../../utils/envBoolean.js";

export const EXEC_HARD_TIMEOUT_ENV = "AGENC_EXEC_HARD_TIMEOUT";

export function execHardTimeoutEnabled(
  env: Readonly<Record<string, string | undefined>>,
  /** config.toml `exec_hard_timeout`; the session environment overrides it. */
  configured?: boolean,
): boolean {
  const value = env[EXEC_HARD_TIMEOUT_ENV];
  if (isEnvDefinedFalsy(value)) return false;
  if (isEnvTruthy(value)) return true;
  return configured === true;
}
