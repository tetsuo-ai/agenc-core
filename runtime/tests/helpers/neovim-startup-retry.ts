import {
  NeovimStartupCleanupError,
  type EmbeddedNeovimSession,
  type StartEmbeddedNeovimOptions,
} from "../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";

export type EmbeddedNeovimStartAttempt = (
  options: StartEmbeddedNeovimOptions,
) => Promise<EmbeddedNeovimSession>;

type StartupAttemptPhase = "pending" | "committed" | "discarded";

type StartupAttemptCallbacks = {
  readonly options: StartEmbeddedNeovimOptions;
  commit(): void;
  discard(): void;
};

export const MAX_BUFFERED_NEOVIM_STARTUP_EVENTS = 64;
export const MAX_BUFFERED_NEOVIM_STARTUP_TERMINAL_EVENTS = 16;

type PendingNotification = () => void;

type StartupAttemptState = {
  phase: StartupAttemptPhase;
  latestSnapshot?: PendingNotification;
  latestDirtyChange?: PendingNotification;
  pendingWorkspaceChange?: PendingNotification;
  readonly events: PendingNotification[];
  readonly terminalEvents: PendingNotification[];
};

function proxyLatestCallback<Arguments extends unknown[]>(
  callback: ((...args: Arguments) => void) | undefined,
  state: StartupAttemptState,
  savePending: (
    state: StartupAttemptState,
    notification: PendingNotification,
  ) => void,
): ((...args: Arguments) => void) | undefined {
  if (callback === undefined) return undefined;
  return (...args: Arguments): void => {
    if (state.phase === "committed") {
      callback(...args);
    } else if (state.phase === "pending") {
      savePending(state, () => callback(...args));
    }
  };
}

function proxyBoundedCallback<Arguments extends unknown[]>(
  callback: ((...args: Arguments) => void) | undefined,
  state: StartupAttemptState,
  pending: PendingNotification[],
  limit: number,
): ((...args: Arguments) => void) | undefined {
  if (callback === undefined) return undefined;
  return (...args: Arguments): void => {
    if (state.phase === "committed") {
      callback(...args);
    } else if (state.phase === "pending") {
      if (pending.length === limit) pending.shift();
      pending.push(() => callback(...args));
    }
  };
}

function safelyNotify(notification: PendingNotification): void {
  try {
    notification();
  } catch {
    // NeovimRpc contains observer failures during live delivery. Queued startup
    // replay must preserve that boundary instead of changing session ownership.
  }
}

function createStartupAttemptCallbacks(
  options: StartEmbeddedNeovimOptions,
): StartupAttemptCallbacks {
  const state: StartupAttemptState = {
    phase: "pending",
    events: [],
    terminalEvents: [],
  };
  const onSnapshot = proxyLatestCallback(
    options.onSnapshot,
    state,
    (current, notification) => {
      current.latestSnapshot = notification;
    },
  );
  const onError = proxyBoundedCallback(
    options.onError,
    state,
    state.terminalEvents,
    MAX_BUFFERED_NEOVIM_STARTUP_TERMINAL_EVENTS,
  );
  const onExit = proxyBoundedCallback(
    options.onExit,
    state,
    state.terminalEvents,
    MAX_BUFFERED_NEOVIM_STARTUP_TERMINAL_EVENTS,
  );
  if (
    onSnapshot === undefined ||
    onError === undefined ||
    onExit === undefined
  ) {
    throw new Error("embedded Neovim startup callbacks are incomplete");
  }

  return {
    options: {
      ...options,
      onSnapshot,
      onDirtyChange: proxyLatestCallback(
        options.onDirtyChange,
        state,
        (current, notification) => {
          current.latestDirtyChange = notification;
        },
      ),
      onWorkspaceChange: proxyLatestCallback(
        options.onWorkspaceChange,
        state,
        (current, notification) => {
          current.pendingWorkspaceChange = notification;
        },
      ),
      onIntegrationIntent: proxyBoundedCallback(
        options.onIntegrationIntent,
        state,
        state.events,
        MAX_BUFFERED_NEOVIM_STARTUP_EVENTS,
      ),
      onCodePredictionFeedback: proxyBoundedCallback(
        options.onCodePredictionFeedback,
        state,
        state.events,
        MAX_BUFFERED_NEOVIM_STARTUP_EVENTS,
      ),
      onRecoveryDetected: proxyBoundedCallback(
        options.onRecoveryDetected,
        state,
        state.events,
        MAX_BUFFERED_NEOVIM_STARTUP_EVENTS,
      ),
      onFatalError: proxyBoundedCallback(
        options.onFatalError,
        state,
        state.terminalEvents,
        MAX_BUFFERED_NEOVIM_STARTUP_TERMINAL_EVENTS,
      ),
      onError,
      onExit,
    },
    commit(): void {
      if (state.phase !== "pending") return;
      state.phase = "committed";
      // State callbacks are latest-only. Ordinary and terminal events retain
      // their newest bounded FIFO window, with terminal delivery last.
      const pending = [
        state.latestSnapshot,
        state.latestDirtyChange,
        state.pendingWorkspaceChange,
        ...state.events.splice(0),
        ...state.terminalEvents.splice(0),
      ];
      state.latestSnapshot = undefined;
      state.latestDirtyChange = undefined;
      state.pendingWorkspaceChange = undefined;
      for (const notify of pending) {
        if (notify !== undefined) safelyNotify(notify);
      }
    },
    discard(): void {
      if (state.phase !== "pending") return;
      state.phase = "discarded";
      state.latestSnapshot = undefined;
      state.latestDirtyChange = undefined;
      state.pendingWorkspaceChange = undefined;
      state.events.length = 0;
      state.terminalEvents.length = 0;
    },
  };
}

function isRetryableStartupTimeout(error: unknown): boolean {
  return (
    !(error instanceof NeovimStartupCleanupError) &&
    /startup timed out/iu.test(String(error))
  );
}

/**
 * Retry one fully-cleaned startup timeout without exposing the superseded
 * process as the caller's logical editor session.
 */
export async function retryTimedOutEmbeddedNeovimStartup(
  options: StartEmbeddedNeovimOptions,
  startAttempt: EmbeddedNeovimStartAttempt,
): Promise<EmbeddedNeovimSession> {
  const first = createStartupAttemptCallbacks(options);
  let firstFailure: unknown;
  try {
    const session = await startAttempt(first.options);
    first.commit();
    return session;
  } catch (error) {
    firstFailure = error;
  }

  if (!isRetryableStartupTimeout(firstFailure)) {
    first.commit();
    throw firstFailure;
  }
  first.discard();

  const retry = createStartupAttemptCallbacks(options);
  try {
    const session = await startAttempt(retry.options);
    retry.commit();
    return session;
  } catch (error) {
    retry.commit();
    throw error;
  }
}
