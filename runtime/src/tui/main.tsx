import { onExit } from "signal-exit";

import { render as renderInk } from "./ink.js";
import { DISABLE_MOUSE_TRACKING, EXIT_ALT_SCREEN, SHOW_CURSOR } from "./ink/termio/dec.js";
import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
} from "./ink/termio/csi.js";
import { AgenCTuiApp } from "./components/App.js";
import type {
  AgenCBridgeSession,
  AgenCTuiProps,
  ConfigStoreLike,
} from "./session-types.js";
import type { Event } from "../session/event-log.js";
import { FpsTracker } from "../utils/fpsTracker.js";
import { recordTuiBackpressure } from "./backpressure.js";
import { setIsInteractive } from "../bootstrap/state.js";

export interface StdinLossSession extends AgenCBridgeSession {
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
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly model?: AgenCTuiProps["model"];
  readonly initialPrompt?: string;
  readonly initialUserMessages?: AgenCTuiProps["initialUserMessages"];
  readonly initialComposerText?: string;
}

export interface BootTUIHandle {
  readonly unmount: () => void;
  readonly waitUntilExit: () => Promise<void>;
}

export const STDIN_LOSS_FLUSH_HARD_CAP_MS = 2_000;
export const STDIN_LOSS_FLUSH_FALLBACK_MS = 200;
export const RENDER_BACKPRESSURE_THRESHOLD_MS = 1_000;

function restoreTerminal(stdout: NodeJS.WriteStream): void {
  try {
    stdout.write(EXIT_ALT_SCREEN);
    stdout.write(DISABLE_MOUSE_TRACKING);
    stdout.write(DISABLE_KITTY_KEYBOARD);
    stdout.write(DISABLE_MODIFY_OTHER_KEYS);
    stdout.write(SHOW_CURSOR);
  } catch {
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
  try {
    session.abortTerminal?.("stdin_lost");
  } catch {
  }
  try {
    if (typeof session.flushEventLog === "function") {
      const flushResult = session.flushEventLog();
      const flushPromise =
        flushResult instanceof Promise ? flushResult : Promise.resolve();
      await Promise.race([
        flushPromise,
        new Promise<void>((resolve) => {
          const handle = setTimeoutFn(resolve, STDIN_LOSS_FLUSH_HARD_CAP_MS);
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
  }
  try {
    emitSessionWarning(
      session,
      "stdin_lost",
      "stdin was lost while the TUI was active; aborting the session",
      { timestamp: Date.now() },
    );
  } catch {
  }
  try {
    unmountInk();
  } catch {
  }
  return exit(130) as never;
}

export async function bootTUI(options: BootTUIOptions): Promise<BootTUIHandle> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const releaseStartupRawMode = claimStartupRawMode(stdin);
  const unsubscribeExit = onExit(() => {
    restoreTerminal(stdout);
  });
  let unmountRef: (() => void) | null = null;
  let firedStdinLoss = false;
  const onStdinLoss = (): void => {
    if (firedStdinLoss) return;
    firedStdinLoss = true;
    void handleStdinLoss(options.session, () => {
      try {
        unmountRef?.();
      } catch {
      }
    });
  };
  stdin.once("close", onStdinLoss);
  stdin.once("end", onStdinLoss);
  stdin.once("error", onStdinLoss);

  let instance: Awaited<ReturnType<typeof renderInk>>;
  const fpsTracker = new FpsTracker();
  try {
    // Mark the session interactive for every feature gated on it
    // (isTodoV2Enabled → the todo board): without this, bootstrap state
    // keeps its `isInteractive: false` default forever and the TodoV2 task
    // list silently never renders in the real TUI.
    setIsInteractive(stdin.isTTY === true);
    instance = await renderInk(
      <AgenCTuiApp
        session={options.session}
        configStore={options.configStore}
        isInteractive={stdin.isTTY === true}
        model={options.model}
        initialPrompt={options.initialPrompt}
        initialUserMessages={options.initialUserMessages}
        initialComposerText={options.initialComposerText}
        getFpsMetrics={() => fpsTracker.getMetrics()}
      />,
      {
        stdin,
        stdout,
        stderr,
        patchConsole: true,
        exitOnCtrlC: false,
        onFrame: (event) => {
          fpsTracker.record(event.durationMs);
          if (event.durationMs >= RENDER_BACKPRESSURE_THRESHOLD_MS) {
            recordTuiBackpressure({
              source: "render",
              durationMs: event.durationMs,
            });
          }
        },
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
    }
  };
  return {
    unmount: unmountRef,
    waitUntilExit: () => instance.waitUntilExit(),
  };
}

export default bootTUI;
