/**
 * Ports the donor signal-listener shape onto AgenC process shutdown handling.
 *
 * Why this lives here:
 *   - Daemon and CLI entrypoints need a shared, testable SIGINT/SIGTERM/SIGHUP
 *     adapter that funnels every signal through the same cleanup registry.
 *
 * Cross-cuts deliberately NOT carried:
 *   - UI-specific display from the donor shutdown message component; this
 *     module emits structured shutdown signals and leaves rendering to callers.
 */

import type { AgenCCleanupContext } from "./cleanup-registry.js";

export type AgenCShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface AgenCShutdownSignalEvent extends AgenCCleanupContext {
  readonly reason: "signal";
  readonly signal: AgenCShutdownSignal;
  readonly exitCode: number;
}

export interface AgenCShutdownSignalHandle {
  readonly completed: Promise<AgenCShutdownSignalEvent>;
  dispose(): void;
}

export interface AgenCSignalProcess {
  on(signal: AgenCShutdownSignal, listener: () => void): unknown;
  removeListener(signal: AgenCShutdownSignal, listener: () => void): unknown;
}

export function installAgenCShutdownSignalHandlers(
  onSignal: (event: AgenCShutdownSignalEvent) => void | Promise<void>,
  proc: AgenCSignalProcess = process,
): AgenCShutdownSignalHandle {
  let settled = false;
  let resolveCompleted!: (event: AgenCShutdownSignalEvent) => void;
  const completed = new Promise<AgenCShutdownSignalEvent>((resolve) => {
    resolveCompleted = resolve;
  });
  const listeners = new Map<AgenCShutdownSignal, () => void>();

  const dispose = (): void => {
    for (const [signal, listener] of listeners) {
      proc.removeListener(signal, listener);
    }
    listeners.clear();
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const listener = (): void => {
      if (settled) return;
      settled = true;
      const event: AgenCShutdownSignalEvent = {
        reason: "signal",
        signal,
        exitCode: exitCodeForSignal(signal),
      };
      void (async () => {
        try {
          await onSignal(event);
        } catch {
          /* Cleanup errors are reported by the cleanup registry caller. */
        } finally {
          resolveCompleted(event);
        }
      })();
    };
    listeners.set(signal, listener);
    // Keep ownership until the caller finishes cleanup. Removing our listener
    // during delivery lets signal-exit treat this signal as unhandled and
    // re-raise it before asynchronous cleanup can finish.
    proc.on(signal, listener);
  }

  return { completed, dispose };
}

export function exitCodeForSignal(signal: AgenCShutdownSignal): number {
  return signal === "SIGTERM" ? 0 : 130;
}
