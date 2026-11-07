/**
 * The switch for waiting while a command is busy.
 *
 * In a Light session, an exec_command whose yield passes while the command's
 * processes are still using CPU, and an empty write_stdin poll in the same
 * state, keep waiting until the command exits, stops using CPU, its time
 * limit passes, or 240 s have passed since the call started (unified-exec
 * `waitWhileBusy`). The model then gets the result in one call instead of a
 * session_id it polls with further model calls, each of which resends the
 * whole conversation. `AGENC_EXEC_WAIT_WHILE_BUSY=0` in the session
 * environment returns every wait to its yield. On by default; Standard
 * sessions never wait past their yield.
 *
 * @module
 */

import { isEnvDefinedFalsy } from "../../utils/envBoolean.js";

export const EXEC_WAIT_WHILE_BUSY_ENV = "AGENC_EXEC_WAIT_WHILE_BUSY";

export function execWaitWhileBusyEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return !isEnvDefinedFalsy(env[EXEC_WAIT_WHILE_BUSY_ENV]);
}
