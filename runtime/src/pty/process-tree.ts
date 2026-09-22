import type { ChildProcess } from "node:child_process";

import { signalProcessTree } from "../utils/supervisedProcess.js";
import type { IPty } from "./loadPty.js";

type ProcessTreeHandle = Pick<ChildProcess, "pid" | "kill">;

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
 */
export function signalPtyProcessTree(
  pty: IPty,
  signal: "SIGTERM" | "SIGKILL",
): boolean {
  const pid = pty.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    signalProcessTree(processTreeHandle(pty), signal);
  } catch {
    try {
      pty.kill(signal);
    } catch {
      // Best effort: the caller's exit handling decides what happens next.
    }
  }
  return true;
}
