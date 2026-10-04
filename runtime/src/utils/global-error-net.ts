import memoize from "lodash-es/memoize.js";
import { logForDiagnosticsNoPII } from "./diagLogs.js";
import { toError } from "./errors.js";
import { logError } from "./log.js";

/**
 * Re-entrancy guard for the crash sink. If persisting a crash itself throws and
 * that throw re-enters the uncaughtException handler, we must not recurse into
 * the sink again — that loops the process to death. One in-flight persist at a
 * time; anything that arrives while we're already persisting is dropped on the
 * floor (it has already been captured by the no-PII diagnostics path above).
 */
let persistingCrash = false;

/**
 * Persist a fatal uncaught error LOCALLY, independent of the no-PII container
 * diagnostics file (AGENC_DIAGNOSTICS_FILE), so local daemon/TUI crashes are
 * captured instead of silently swallowed.
 *
 * Routes through:
 *  - logError(): the in-memory + persisted error-log sink (~/.agenc/errors),
 *    the same channel feature code uses for non-fatal errors.
 *  - console.error(): only when running as the detached daemon
 *    (AGENC_DAEMON_RUN=1), where console output is redirected into the
 *    size-capped rotating daemon.log sink (installAgenCDaemonLogSink). On a
 *    foreground TUI this would scribble on the alt-screen, so it is gated.
 *
 * Best-effort and self-guarded: a failure here must never escalate the crash.
 */
function persistCrashLocally(error: unknown): void {
  if (persistingCrash) {
    return;
  }
  persistingCrash = true;
  try {
    const err = toError(error);
    // In-memory + persisted local error log (independent of the diag file).
    logError(err);
    // Detached daemon: console.* is wired to the rotating daemon.log sink, so
    // this is how a daemon crash lands on disk for a local user.
    if (process.env.AGENC_DAEMON_RUN === "1") {
      // biome-ignore lint/suspicious/noConsole: routed into the daemon.log sink
      console.error(err.stack ?? err.message);
    }
  } catch {
    // Never let crash-persistence throw — that would re-enter this handler.
  } finally {
    persistingCrash = false;
  }
}

/**
 * Install the process-global error net: log uncaught exceptions and unhandled
 * promise rejections through the no-PII diagnostics channel AND the persisted
 * local error-log sink instead of letting an unhandled rejection vanish
 * silently or an uncaught exception crash the process with a raw stack.
 * Idempotent (memoized) — safe to call from multiple entrypoints; handlers
 * register once per process.
 *
 * Intentionally NON-exiting: a long-lived daemon / TUI should survive a stray
 * async error. The TUI render loop self-heals per frame (see ink.tsx onRender),
 * and orderly signal shutdown is owned separately by entrypoint lifecycle
 * handlers.
 *
 * `proc` is injectable for tests so they can assert registration + handler
 * behavior against a fake emitter without touching the real process (which
 * would swallow vitest's own rejection detection).
 */
export const installGlobalErrorNet = memoize(
  (proc: Pick<NodeJS.Process, "on"> = process): void => {
    // Log uncaught exceptions for container observability.
    // Error names (e.g., "TypeError") are not sensitive - safe to log.
    proc.on("uncaughtException", (error) => {
      logForDiagnosticsNoPII("error", "uncaught_exception", {
        error_name: error?.name ?? "Error",
        error_message: String(error?.message ?? error).slice(0, 2000),
      });
      // ALSO persist locally so the crash isn't lost when no container diag
      // file is set (the common local daemon/TUI case).
      persistCrashLocally(error);
    });
    // Log unhandled promise rejections for container observability.
    proc.on("unhandledRejection", (reason) => {
      const errorInfo =
        reason instanceof Error
          ? {
              error_name: reason.name,
              error_message: reason.message.slice(0, 2000),
              error_stack: reason.stack?.slice(0, 4000),
            }
          : { error_message: String(reason).slice(0, 2000) };
      logForDiagnosticsNoPII("error", "unhandled_rejection", errorInfo);
      // ALSO persist locally (see uncaughtException above).
      persistCrashLocally(reason);
    });
  },
);
