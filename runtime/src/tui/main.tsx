/**
 * Ink bootstrap entrypoint for the AgenC TUI.
 *
 * Wave 2 scope: mount the `App` tree on the real Ink root, wire enough
 * stdin lifecycle handling that a lost terminal aborts the active turn,
 * and arrange terminal-restoration on process exit.
 *
 * Wave 5-B (this change) elevates the stdin-loss path to the full I-19
 * protocol:
 *   1. `session.abortTerminal('stdin_lost')` aborts the active turn.
 *   2. Await a flush barrier — `session.flushEventLog?.()` if provided,
 *      else a 200ms grace (hard-capped at 2s when `flushEventLog` is
 *      present but hangs).
 *   3. Emit `warning:stdin_lost` via `session.emit?.(...)` if available.
 *   4. Unmount the Ink tree gracefully.
 *   5. `process.exit(130)` (matches SIGINT convention).
 *
 * Each step is wrapped in try/catch; any failure falls through to
 * `process.exit(130)`.
 */

import { onExit } from "signal-exit";

// The Ink render API lives in `./ink/root.js` (default export mirrors the
// public `render()` surface — async, returns an `Instance`). `./ink/ink.js`
// exports the `Ink` class itself as default; we prefer `root.js` here so
// the boot path matches the top-level documented contract.
import renderInk from "./ink/root.js";
import { DISABLE_MOUSE_TRACKING, EXIT_ALT_SCREEN, SHOW_CURSOR } from "./ink/termio/dec.js";
import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
} from "./ink/termio/csi.js";
import {
  createTuiFrameMonitor,
  frameMonitorOptionsFromEnv,
} from "./diagnostics/frame-monitor.js";

import { App, type AppProps } from "./App.js";
import type { Event } from "../session/event-log.js";
import type { ConfigStoreLike, SessionLike } from "./state/AppState.js";

/**
 * Narrow, loose shape of the hooks `bootTUI` / `handleStdinLoss` consume
 * from the runtime session. Keeping this structural (not a hard import
 * of `Session`) means tests can hand in stub sessions and the Wave 2
 * contract stays the same.
 *
 * `emit` is intentionally permissive — Wave 2 treats it as optional,
 * and I-19 just wants a `warning:stdin_lost` signal. Real Sessions
 * accept a typed Event; tests pass through a vi.fn() mock.
 */
export interface StdinLossSession extends SessionLike {
  readonly abortTerminal?: (reason: string) => void;
  readonly flushEventLog?: () => Promise<void> | void;
  readonly emit?: (event: Event | {
    readonly kind: string;
    readonly cause?: string;
    readonly timestamp?: number;
    readonly [key: string]: unknown;
  }) => void;
  nextInternalSubId?(): string;
}

export interface BootTUIOptions {
  readonly session: StdinLossSession;
  readonly configStore: ConfigStoreLike;
  /** Optional overrides for the Ink `render()` streams (tests). */
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  /** Forwarded through to `<App>` — lets the caller drive the banner label. */
  readonly model?: AppProps["model"];
  readonly bindings?: AppProps["bindings"];
  /**
   * Optional pre-populated composer text. Wave 5-B accepts the prop so
   * `bin/agenc.ts` can forward an argv-provided prompt into the TUI. The
   * live App tree auto-submits it once on boot so CLI/TUI routing shares
   * the same first-turn behavior.
   */
  readonly initialPrompt?: string;
  readonly initialUserMessages?: AppProps["initialUserMessages"];
  /** Optional startup draft captured before Ink mounted; not auto-submitted. */
  readonly initialComposerText?: string;
}

/**
 * Handle returned from `bootTUI` so the caller can unmount the Ink tree
 * (e.g. from a top-level signal handler) without re-entering the render
 * path. `waitUntilExit` resolves once the tree is torn down by any route
 * (manual unmount, stdin loss, signal-exit restore).
 */
export interface BootTUIHandle {
  readonly unmount: () => void;
  readonly waitUntilExit: () => Promise<void>;
}

/**
 * Upper bound for `flushEventLog` when it's wired but misbehaves. I-19
 * wants the flush barrier bounded so a wedged sidecar can't keep the
 * process alive past the terminal-lost event.
 */
export const STDIN_LOSS_FLUSH_HARD_CAP_MS = 2_000;

/**
 * Fallback grace window when no `flushEventLog` hook is available. Gives
 * any already-scheduled fsync from recent emits a moment to complete
 * before the process exits.
 */
export const STDIN_LOSS_FLUSH_FALLBACK_MS = 200;

/**
 * Best-effort terminal restoration. Called from `signal-exit` and from
 * stdin-death handlers. Writes are wrapped in try/catch because stdout
 * may itself be half-dead at this point.
 */
function restoreTerminal(stdout: NodeJS.WriteStream): void {
  try {
    stdout.write(EXIT_ALT_SCREEN);
    stdout.write(DISABLE_MOUSE_TRACKING);
    stdout.write(DISABLE_KITTY_KEYBOARD);
    stdout.write(DISABLE_MODIFY_OTHER_KEYS);
    stdout.write(SHOW_CURSOR);
  } catch {
    // stdout is gone — nothing useful we can do here.
  }
}

type RawCapableStdin = NodeJS.ReadStream & {
  setRawMode?: (mode: boolean) => void;
};

function claimStartupRawMode(stdin: NodeJS.ReadStream): (() => void) | null {
  const rawStdin = stdin as RawCapableStdin;
  if (!stdin.isTTY || typeof rawStdin.setRawMode !== "function") {
    return null;
  }

  try {
    rawStdin.setRawMode(true);
  } catch {
    return null;
  }

  return () => {
    try {
      rawStdin.setRawMode?.(false);
    } catch {
      // Best-effort boot cleanup.
    }
  };
}

function emitSessionWarning(
  session: StdinLossSession,
  cause: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  const nextInternalSubId =
    typeof session.nextInternalSubId === "function"
      ? session.nextInternalSubId.bind(session)
      : null;
  if (typeof session.emit !== "function" || nextInternalSubId === null) {
    session.emit?.({
      kind: `warning:${cause}`,
      cause,
      message,
      ...extra,
    });
    return;
  }
  session.emit({
    id: nextInternalSubId(),
    msg: {
      type: "warning",
      payload: {
        cause,
        message,
        ...extra,
      },
    },
  });
}

/**
 * I-19 stdin-loss protocol. Exported so tests can drive each step in
 * isolation with fake timers + process.exit stubs.
 *
 * Sequence (every step wrapped in try/catch so a single failure still
 * reaches the exit):
 *
 *   1. `session.abortTerminal('stdin_lost')` — aborts the active turn.
 *   2. Flush barrier:
 *        - when `session.flushEventLog` exists, await it with a
 *          `STDIN_LOSS_FLUSH_HARD_CAP_MS` race so a hung sidecar
 *          doesn't block shutdown.
 *        - otherwise sleep `STDIN_LOSS_FLUSH_FALLBACK_MS` as a grace
 *          window for any already-scheduled fsync.
 *   3. Emit `warning:stdin_lost` through `session.emit` if present.
 *   4. Unmount the Ink tree.
 *   5. `process.exit(130)` — the SIGINT conventional exit code.
 */
export async function handleStdinLoss(
  session: StdinLossSession,
  unmountInk: () => void,
  deps?: {
    readonly exit?: (code: number) => never;
    readonly setTimeoutFn?: typeof setTimeout;
  },
): Promise<never> {
  const exit = deps?.exit ?? ((code: number) => process.exit(code));
  const setTimeoutFn = deps?.setTimeoutFn ?? setTimeout;

  // 1. Abort active turn.
  try {
    session.abortTerminal?.("stdin_lost");
  } catch {
    // Abort is best-effort.
  }

  // 2. Flush barrier.
  try {
    if (typeof session.flushEventLog === "function") {
      const flushResult = session.flushEventLog();
      const flushPromise =
        flushResult instanceof Promise ? flushResult : Promise.resolve();
      await Promise.race([
        flushPromise,
        new Promise<void>((resolve) => {
          const handle = setTimeoutFn(resolve, STDIN_LOSS_FLUSH_HARD_CAP_MS);
          // Don't keep the loop alive just for the safety timer.
          (handle as { unref?: () => void }).unref?.();
        }),
      ]);
    } else {
      await new Promise<void>((resolve) => {
        const handle = setTimeoutFn(resolve, STDIN_LOSS_FLUSH_FALLBACK_MS);
        (handle as { unref?: () => void }).unref?.();
      });
    }
  } catch {
    // Flushing is best-effort.
  }

  // 3. Warning emission.
  try {
    emitSessionWarning(
      session,
      "stdin_lost",
      "stdin was lost while the TUI was active; aborting the session",
      { timestamp: Date.now() },
    );
  } catch {
    // Emit is best-effort.
  }

  // 4. Unmount Ink.
  try {
    unmountInk();
  } catch {
    // Unmount is best-effort.
  }

  // 5. Exit.
  return exit(130) as never;
}

/**
 * Mount the AgenC TUI and return a handle the caller can use to unmount
 * the tree or await tear-down. The promise resolves once the first
 * render has completed; the caller is responsible for keeping the
 * process alive (e.g. via `handle.waitUntilExit()` or the session's own
 * lifecycle).
 */
export async function bootTUI(options: BootTUIOptions): Promise<BootTUIHandle> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const releaseStartupRawMode = claimStartupRawMode(stdin);

  // signal-exit restores the terminal on any exit route (SIGINT,
  // SIGTERM, normal exit, etc.). Wave 5-B uses this alongside the
  // explicit I-19 path — the two are complementary, not competing.
  const unsubscribeExit = onExit(() => {
    restoreTerminal(stdout);
  });

  // Forward declaration so the stdin-loss handler can see the unmount
  // closure even though the Ink instance is created below.
  let unmountRef: (() => void) | null = null;
  let firedStdinLoss = false;

  const onStdinLoss = (): void => {
    if (firedStdinLoss) return;
    firedStdinLoss = true;
    // Fire-and-forget — the handler ends with process.exit(130). We
    // cannot await it here because listeners are sync; storing the
    // promise just lets a test-mode exit stub observe completion.
    void handleStdinLoss(options.session, () => {
      try {
        unmountRef?.();
      } catch {
        // Unmount is best-effort during stdin death.
      }
    });
  };

  // Register exactly once per bootTUI invocation — `.once()` guarantees
  // the listener is stripped after firing so a subsequent boot attempt
  // doesn't accumulate duplicates.
  stdin.once("close", onStdinLoss);
  stdin.once("end", onStdinLoss);
  stdin.once("error", onStdinLoss);

  let instance: Awaited<ReturnType<typeof renderInk>>;
  const frameMonitor = createTuiFrameMonitor(
    frameMonitorOptionsFromEnv(process.env),
  );
  try {
    instance = await renderInk(
      <App
        session={options.session}
        configStore={options.configStore}
        model={options.model}
        bindings={options.bindings}
        initialPrompt={options.initialPrompt}
        initialUserMessages={options.initialUserMessages}
        initialComposerText={options.initialComposerText}
      />,
      {
        stdin,
        stdout,
        stderr,
        patchConsole: true,
        exitOnCtrlC: false,
        ...(frameMonitor
          ? {
              onFrame: frameMonitor.onFrame,
              onInputActivity: frameMonitor.noteInput,
            }
          : {}),
      },
    );
  } catch (err) {
    releaseStartupRawMode?.();
    stdin.removeListener("close", onStdinLoss);
    stdin.removeListener("end", onStdinLoss);
    stdin.removeListener("error", onStdinLoss);
    unsubscribeExit();
    restoreTerminal(stdout);
    throw err;
  }

  unmountRef = () => {
    try {
      instance.unmount();
    } catch {
      // Ink may have torn itself down already.
    }
  };

  return {
    unmount: unmountRef,
    waitUntilExit: () => instance.waitUntilExit(),
  };
}

export default bootTUI;
