import type { ChildProcess } from "node:child_process";

import { isSignalablePid } from "../utils/child-signal.js";
import { signalProcessTree } from "../utils/supervisedProcess.js";
import type { IPty } from "./loadPty.js";

/**
 * What signalProcessTree needs from a PTY. exitCode is set once node-pty has
 * reported the exit, which it does after reaping the child: from then on the
 * pid may belong to an unrelated process, and signalProcessTree only
 * signals what it can still prove is the PTY's.
 */
type ProcessTreeHandle = Pick<ChildProcess, "pid" | "kill"> & {
  exitCode: number | null;
  readonly signalCode: null;
};

/**
 * signalProcessTree records the descendants it has seen per handle object,
 * so a PTY keeps one handle for its SIGTERM and the SIGKILL that may follow.
 */
const handles = new WeakMap<IPty, ProcessTreeHandle>();

function processTreeHandle(pty: IPty): ProcessTreeHandle {
  let handle = handles.get(pty);
  if (handle === undefined) {
    const pid = pty.pid;
    handle = {
      pid,
      exitCode: null,
      signalCode: null,
      kill: (signal?: NodeJS.Signals | number): boolean => {
        pty.kill(typeof signal === "string" ? signal : undefined);
        return true;
      },
    };
    handles.set(pty, handle);
  }
  return handle;
}

/**
 * Signal a PTY's whole process tree: the descendants seen in the process
 * table, then its process group (a PTY child leads its own session).
 *
 * This replaces tree-kill, which spawned pgrep or ps without an error
 * listener and rethrew EPERM from any one descendant: a missing ps, a full
 * process table, or a root-owned child crashed the daemon and left the tree
 * running. Returns false, without signalling anything, when the PTY has no
 * pid above 1: node-pty's kill() is process.kill(pid), and pid 0, -1 or 1
 * would reach the caller's own group, every process of the user, or init.
 *
 * `exited` says node-pty already reported the PTY's exit. Its pid is then
 * never signalled directly, and its group only while no other process has
 * taken the pid (see signalProcessTree).
 */
export function signalPtyProcessTree(
  pty: IPty,
  signal: "SIGTERM" | "SIGKILL",
  options: { readonly exited: boolean },
): boolean {
  if (!isSignalablePid(pty.pid)) return false;
  const handle = processTreeHandle(pty);
  if (options.exited) handle.exitCode ??= 0;
  try {
    signalProcessTree(handle, signal);
  } catch {
    if (options.exited) return true;
    try {
      pty.kill(signal);
    } catch {
      // Best effort: the caller's exit handling decides what happens next.
    }
  }
  return true;
}
