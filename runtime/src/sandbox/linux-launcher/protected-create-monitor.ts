import fs from "node:fs";

/** How often a running command's protected-create targets are rechecked. */
export const PROTECTED_CREATE_POLL_MS = 100;

export interface ProtectedCreateMonitor {
  /** Final check: removes any target that exists and reports whether one ever did. */
  readonly stop: () => boolean;
}

/**
 * Created-path monitor for missing protected metadata paths that bubblewrap
 * cannot mount a placeholder over (a missing `.agenc`, `.agents` or `.git`
 * whose ancestor has one, or a narrowed `.git` carve-out). A target that
 * exists at start, at any poll or at stop is removed, and the command that
 * ran under the monitor fails. Shared by the per-command Node launcher and
 * the persistent session sandbox so both enforce the same rule.
 */
export function startProtectedCreateMonitor(
  targets: readonly string[],
): ProtectedCreateMonitor {
  if (targets.length === 0) return { stop() { return false; } };
  let violation = false;
  const scan = () => {
    for (const target of targets) {
      if (fs.existsSync(target)) {
        violation = true;
      }
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup for protected metadata created during launch.
      }
    }
  };
  scan();
  const interval = setInterval(scan, PROTECTED_CREATE_POLL_MS);
  // The watched command keeps its owner alive; the poll itself never should.
  interval.unref?.();
  return {
    stop(): boolean {
      clearInterval(interval);
      scan();
      return violation;
    },
  };
}

/** A clean exit becomes a failure when the command created a protected path. */
export function protectedCreateExitCode(exitCode: number, violation: boolean): number {
  return violation && exitCode === 0 ? 1 : exitCode;
}

/**
 * Monitors started by an in-process launcher (session sandbox, direct
 * bubblewrap) for the command a child handle represents. The owner of the
 * handle stops it only after the command's whole process tree is gone, so
 * the final check sees everything the command could have created.
 */
const attachedMonitors = new WeakMap<object, ProtectedCreateMonitor>();

export function attachProtectedCreateMonitor(
  child: object,
  monitor: ProtectedCreateMonitor,
): void {
  attachedMonitors.set(child, monitor);
}

/** Idempotent: false when no monitor is attached or it was already stopped. */
export function stopAttachedProtectedCreateMonitor(child: object): boolean {
  const monitor = attachedMonitors.get(child);
  if (monitor === undefined) return false;
  attachedMonitors.delete(child);
  return monitor.stop();
}
