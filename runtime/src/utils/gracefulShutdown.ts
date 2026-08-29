import chalk from "chalk";
import { writeSync } from "fs";
import memoize from "lodash-es/memoize.js";
import type { ExitReason } from "src/entrypoints/sdk/coreTypes.generated.js";
import {
  getIsInteractive,
  getSessionId,
  isSessionPersistenceDisabled,
} from "../bootstrap/state.js";
import instances from "../tui/ink/instances.js";
import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
} from "../tui/ink/termio/csi.js";
import {
  DBP,
  DFE,
  DISABLE_MOUSE_TRACKING,
  EXIT_ALT_SCREEN,
  SHOW_CURSOR,
} from "../tui/ink/termio/dec.js";
import {
  CLEAR_ITERM2_PROGRESS,
  CLEAR_TAB_STATUS,
  CLEAR_TERMINAL_TITLE,
  supportsTabStatus,
  wrapForMultiplexer,
} from "../tui/ink/termio/osc.js";
import type { AppState } from "../tui/state/AppState.js";
import { runCleanupFunctions } from "./cleanupRegistry.js";
import { logForDebugging } from "src/utils/debug.js";
import { logForDiagnosticsNoPII } from "./diagLogs.js";
import { isEnvTruthy } from "./envUtils.js";
import { toError } from "./errors.js";
import { logError } from "./log.js";
import { getCurrentSessionTitle, sessionIdExists } from "./sessionStorage.js";

/**
 * Clean up terminal modes synchronously before process exit.
 * This ensures terminal escape sequences (Kitty keyboard, focus reporting, etc.)
 * are properly disabled even if React's componentWillUnmount doesn't run in time.
 * Uses writeSync to ensure writes complete before exit.
 *
 * We unconditionally send all disable sequences because:
 * 1. Terminal detection may not always work correctly (e.g., in tmux, screen)
 * 2. These sequences are no-ops on terminals that don't support them
 * 3. Failing to disable leaves the terminal in a broken state
 */
/* eslint-disable custom-rules/no-sync-fs -- must be sync to flush before process.exit */
function cleanupTerminalModes(skipUnmount: boolean = false): void {
  if (!process.stdout.isTTY) {
    return;
  }

  try {
    // Disable mouse tracking FIRST, before the React unmount tree-walk.
    // The terminal needs a round-trip to process this and stop sending
    // events; doing it now (not after unmount) gives that time while
    // we're busy unmounting. Otherwise events arrive during cooked-mode
    // cleanup and either echo to the screen or leak to the shell.
    writeSync(1, DISABLE_MOUSE_TRACKING);
    // Exit alt screen FIRST so printResumeHint() (and all sequences below)
    // land on the main buffer.
    //
    // Unmount Ink directly rather than writing EXIT_ALT_SCREEN ourselves.
    // Ink registered its unmount with signal-exit, so it will otherwise run
    // AGAIN inside forceExit() → process.exit(). Two problems with letting
    // that happen:
    //   1. If we write 1049l here and unmount writes it again later, the
    //      second one triggers another DECRC — the cursor jumps back over
    //      the resume hint and the shell prompt lands on the wrong line.
    //   2. unmount()'s onRender() must run with altScreenActive=true (alt-
    //      screen cursor math) AND on the alt buffer. Exiting alt-screen
    //      here first makes onRender() scribble a REPL frame onto main.
    // Calling unmount() now does the final render on the alt buffer,
    // unsubscribes from signal-exit, and writes 1049l exactly once.
    const inst = instances.get(process.stdout);
    if (!skipUnmount && inst?.isAltScreenActive) {
      try {
        inst.unmount();
      } catch {
        // Reconciler/render threw — fall back to manual alt-screen exit
        // so printResumeHint still hits the main buffer.
        writeSync(1, EXIT_ALT_SCREEN);
      }
    } else if (skipUnmount && inst?.isAltScreenActive) {
      // We already unmounted asynchronously in gracefulShutdown, but if we
      // fallback to manual alt-screen exit here just in case Ink didn't write it or is dead.
      // Actually, AlternateScreen unmount writes EXIT_ALT_SCREEN, so if we awaited unmount,
      // we shouldn't emit it again. So we just do nothing here.
    }
    // Catches events that arrived during the unmount tree-walk.
    // detachForShutdown() below also drains.
    inst?.drainStdin();
    // Mark the Ink instance unmounted so signal-exit's deferred ink.unmount()
    // early-returns instead of sending redundant EXIT_ALT_SCREEN sequences
    // (from its writeSync cleanup block + AlternateScreen's unmount cleanup).
    // Those redundant sequences land AFTER printResumeHint() and clobber the
    // resume hint on tmux (and possibly other terminals) by restoring the
    // saved cursor position. Safe to skip full unmount: this function already
    // sends all the terminal-reset sequences, and the process is exiting.
    inst?.detachForShutdown();
    // Disable extended key reporting — always send both since terminals
    // silently ignore whichever they don't implement
    writeSync(1, DISABLE_MODIFY_OTHER_KEYS);
    writeSync(1, DISABLE_KITTY_KEYBOARD);
    // Disable focus events (DECSET 1004)
    writeSync(1, DFE);
    // Disable bracketed paste mode
    writeSync(1, DBP);
    // Show cursor
    writeSync(1, SHOW_CURSOR);
    // Clear iTerm2 progress bar - prevents lingering progress indicator
    // that can cause bell sounds when returning to the terminal tab
    writeSync(1, CLEAR_ITERM2_PROGRESS);
    // Clear tab status (OSC 21337) so a stale dot doesn't linger
    if (supportsTabStatus()) writeSync(1, wrapForMultiplexer(CLEAR_TAB_STATUS));
    // Clear terminal title so the tab doesn't show stale session info.
    // Respect AGENC_DISABLE_TERMINAL_TITLE — if the user opted out of
    // title changes, don't clear their existing title on exit either.
    if (!isEnvTruthy(process.env.AGENC_DISABLE_TERMINAL_TITLE)) {
      if (process.platform === "win32") {
        process.title = "";
      } else {
        writeSync(1, CLEAR_TERMINAL_TITLE);
      }
    }
  } catch {
    // Terminal may already be gone (e.g., SIGHUP after terminal close).
    // Ignore write errors since we're exiting anyway.
  }
}

let resumeHintPrinted = false;

/**
 * Print a hint about how to resume the session.
 * Only shown for interactive sessions with persistence enabled.
 */
function printResumeHint(): void {
  // Only print once (failsafe timer may call this again after normal shutdown)
  if (resumeHintPrinted) {
    return;
  }
  // Only show with TTY, interactive sessions, and persistence
  if (
    process.stdout.isTTY &&
    getIsInteractive() &&
    !isSessionPersistenceDisabled()
  ) {
    try {
      const sessionId = getSessionId();
      // Don't show resume hint if no session file exists (e.g., subcommands like `agenc update`)
      if (!sessionIdExists(sessionId)) {
        return;
      }
      const customTitle = getCurrentSessionTitle(sessionId);

      // Use custom title if available, otherwise fall back to session ID
      let resumeArg: string;
      if (customTitle) {
        // Wrap in double quotes, escape backslashes first then quotes
        const escaped = customTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        resumeArg = `"${escaped}"`;
      } else {
        resumeArg = sessionId;
      }

      writeSync(
        1,
        chalk.dim(`\nResume this session with:\nagenc --resume ${resumeArg}\n`),
      );
      resumeHintPrinted = true;
    } catch {
      // Ignore write errors
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */

/**
 * Force process exit, handling the case where the terminal is gone.
 * When the terminal/PTY is closed (e.g., SIGHUP), process.exit() can throw
 * EIO errors because Bun tries to flush stdout to a dead file descriptor.
 * In that case, fall back to SIGKILL which always works.
 */
function forceExit(exitCode: number): never {
  // Clear failsafe timer since we're exiting now
  if (failsafeTimer !== undefined) {
    clearTimeout(failsafeTimer);
    failsafeTimer = undefined;
  }
  // Drain stdin LAST, right before exit. cleanupTerminalModes() sent
  // DISABLE_MOUSE_TRACKING early, but the terminal round-trip plus any
  // events already in flight means bytes can arrive during the seconds
  // of async cleanup between then and now. Draining here catches them.
  // Use the Ink class method (not the standalone drainStdin()) so we
  // drain the instance's stdin — when process.stdin is piped,
  // getStdinOverride() opens /dev/tty as the real input stream and the
  // class method knows about it; the standalone function defaults to
  // process.stdin which would early-return on isTTY=false.
  try {
    instances.get(process.stdout)?.drainStdin();
  } catch {
    // Terminal may be gone (SIGHUP). Ignore — we are about to exit.
  }
  try {
    process.exit(exitCode);
  } catch (e) {
    // process.exit() threw. In tests, it's mocked to throw - re-throw so test sees it.
    // In production, it's likely EIO from dead terminal - use SIGKILL.
    if ((process.env.NODE_ENV as string) === "test") {
      throw e;
    }
    // Fall back to SIGKILL which doesn't try to flush anything.
    process.kill(process.pid, "SIGKILL");
  }
  // In tests, process.exit may be mocked to return instead of exiting.
  // In production, we should never reach here.
  if ((process.env.NODE_ENV as string) !== "test") {
    throw new Error("unreachable");
  }
  // TypeScript trick: cast to never since we know this only happens in tests
  // where the mock returns instead of exiting
  return undefined as never;
}

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

export function gracefulShutdownSync(
  exitCode = 0,
  reason: ExitReason = "other",
  options?: {
    getAppState?: () => AppState;
    setAppState?: (f: (prev: AppState) => AppState) => void;
  },
): void {
  // Set the exit code that will be used when process naturally exits. Note that we do it
  // here inside the sync version too so that it is possible to determine if
  // gracefulShutdownSync was called by checking process.exitCode.
  process.exitCode = exitCode;

  pendingShutdown = gracefulShutdown(exitCode, reason, options)
    .catch((error) => {
      logForDebugging(`Graceful shutdown failed: ${error}`, { level: "error" });
      cleanupTerminalModes();
      printResumeHint();
      forceExit(exitCode);
    })
    // Prevent unhandled rejection: forceExit re-throws in test mode,
    // which would escape the .catch() handler above as a new rejection.
    .catch(() => {});
}

let shutdownInProgress = false;
let failsafeTimer: ReturnType<typeof setTimeout> | undefined;
let pendingShutdown: Promise<void> | undefined;

/** Check if graceful shutdown is in progress */
export function isShuttingDown(): boolean {
  return shutdownInProgress;
}

/** Reset shutdown state - only for use in tests */
export function resetShutdownState(): void {
  shutdownInProgress = false;
  resumeHintPrinted = false;
  if (failsafeTimer !== undefined) {
    clearTimeout(failsafeTimer);
    failsafeTimer = undefined;
  }
  pendingShutdown = undefined;
}

/**
 * Returns the in-flight shutdown promise, if any. Only for use in tests
 * to await completion before restoring mocks.
 */
export function getPendingShutdownForTesting(): Promise<void> | undefined {
  return pendingShutdown;
}

// Graceful shutdown function that drains the event loop
export async function gracefulShutdown(
  exitCode = 0,
  reason: ExitReason = "other",
  options?: {
    getAppState?: () => AppState;
    setAppState?: (f: (prev: AppState) => AppState) => void;
    /** Printed to stderr after alt-screen exit, before forceExit. */
    finalMessage?: string;
    /**
     * Daemon-backed TUIs own lifecycle hooks in the daemon session. Their
     * foreground process must not execute a second, potentially unmatched
     * legacy SessionEnd hook ladder.
     */
    skipSessionEndHooks?: boolean;
  },
): Promise<void> {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;

  // Resolve the SessionEnd hook budget before arming the failsafe so the
  // failsafe can scale with it. Without this, a user-configured 10s hook
  // budget is silently truncated by the 5s failsafe (gh-32712 follow-up).
  const { executeSessionEndHooks, getSessionEndHookTimeoutMs } =
    await import("./hooks.js");
  const sessionEndTimeoutMs = getSessionEndHookTimeoutMs();

  // Await one tick so React can flush pending updates from commands (e.g. hiding
  // the autocomplete menu on /exit) before we detach Ink. This lets log-update
  // erase floating UI elements from the terminal so they don't linger after exit.
  await new Promise((r) => setTimeout(r, 20));

  // Failsafe: guarantee process exits even if cleanup hangs (e.g., MCP connections).
  // Runs cleanupTerminalModes first so a hung cleanup doesn't leave the terminal dirty.
  // Budget = max(5s, hook budget + 3.5s headroom for cleanup).
  failsafeTimer = setTimeout(
    (code) => {
      cleanupTerminalModes(true);
      printResumeHint();
      forceExit(code);
    },
    Math.max(5000, sessionEndTimeoutMs + 3500),
    exitCode,
  );
  failsafeTimer.unref();

  // Set the exit code that will be used when process naturally exits
  process.exitCode = exitCode;

  // Exit alt screen and print resume hint FIRST, before any async operations.
  // This ensures the hint is visible even if the process is killed during
  // cleanup (e.g., SIGKILL during macOS reboot). Without this, the resume
  // hint would only appear after cleanup functions and hooks
  // flush — which can take several seconds.
  cleanupTerminalModes(true);
  printResumeHint();

  // Flush session data first — this is the most critical cleanup. If the
  // terminal is dead (SIGHUP, SSH disconnect), hooks may hang
  // on I/O to a dead TTY or unreachable network, eating into the
  // failsafe budget. Session persistence must complete before anything else.
  let cleanupTimeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const cleanupPromise = (async () => {
      try {
        await runCleanupFunctions();
      } catch {
        // Silently ignore cleanup errors
      }
    })();

    await Promise.race([
      cleanupPromise,
      new Promise((_, reject) => {
        cleanupTimeoutId = setTimeout(
          (rej) => rej(new CleanupTimeoutError()),
          2000,
          reject,
        );
      }),
    ]);
    clearTimeout(cleanupTimeoutId);
  } catch {
    // Silently handle timeout and other errors
    clearTimeout(cleanupTimeoutId);
  }

  // Execute SessionEnd hooks. Bound both the per-hook default timeout and the
  // overall execution via a single budget (AGENC_SESSIONEND_HOOKS_TIMEOUT_MS,
  // default 1.5s). hook.timeout in settings is respected up to this cap.
  if (options?.skipSessionEndHooks !== true) {
    try {
      await executeSessionEndHooks(reason, {
        ...options,
        signal: AbortSignal.timeout(sessionEndTimeoutMs),
        timeoutMs: sessionEndTimeoutMs,
      });
    } catch {
      // Ignore SessionEnd hook exceptions (including AbortError on timeout)
    }
  }

  if (options?.finalMessage) {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- must flush before forceExit
      writeSync(2, options.finalMessage + "\n");
    } catch {
      // stderr may be closed (e.g., SSH disconnect). Ignore write errors.
    }
  }

  forceExit(exitCode);
}

class CleanupTimeoutError extends Error {
  constructor() {
    super("Cleanup timeout");
  }
}
