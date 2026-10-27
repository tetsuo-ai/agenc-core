import { inspectReadOnlyCommand, inspectReadOnlyShellCommand } from "../permissions/readonly-inspection.js";

/**
 * Whether an exec_command call may run alongside the other calls of the same
 * model response: it classifies as read-only for the read-only fast path,
 * either a literal inspection (one command from the fixed inspection table
 * with validated flags) or a read-only command line (pipes, lists and loops of
 * inspection programs). Neither asks for a shell profile, TTY, background run,
 * escalation or detach.
 *
 * Running such calls side by side cannot change a result: the fast path runs
 * them in a no-write, no-network sandbox. When dispatch cannot use that route
 * for one of them, its ordinary run waits until no other call of the batch
 * executes (StreamingToolExecutor runAlone). Every other command stays
 * exclusive: it starts only when nothing else runs and keeps the order the
 * model submitted it in. Results are recorded in submission order either way.
 */
export function execCommandRunsConcurrently(
  args: Readonly<Record<string, unknown>>,
  cwd: string,
): boolean {
  if (args.detach === true || args.dangerouslyDisableSandbox === true) return false;
  return inspectReadOnlyCommand("exec_command", args, cwd, {
    enforceWorkspaceBoundary: false,
  }).allowed || inspectReadOnlyShellCommand(args, cwd).allowed;
}
