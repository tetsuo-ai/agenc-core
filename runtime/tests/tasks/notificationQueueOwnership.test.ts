import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppState } from "../../src/tui/state/AppState.js";
import type { ShellCommand } from "../../src/utils/ShellCommand.js";

vi.mock("bun:bundle", () => ({ feature: () => false }));
vi.mock("../../src/services/PromptSuggestion/speculation.js", () => ({
  abortSpeculation: vi.fn(),
}));

const { getSessionId, switchSession } =
  await import("../../src/bootstrap/state.js");
const { getCommandQueueSnapshot, queuedCommandOwnedByConversation, resetCommandQueueForTesting } =
  await import("../../src/utils/messageQueueManager.js");
const { spawnShellTask } =
  await import("../../src/tasks/LocalShellTask/LocalShellTask.js");
const { completeMainSessionTask } =
  await import("../../src/tasks/LocalMainSessionTask.js");

const SESSION_A = "00000000-0000-4000-8000-0000000000aa";
const SESSION_B = "00000000-0000-4000-8000-0000000000bb";
const OWNER_A = Object.freeze({
  kind: "session" as const,
  conversationId: SESSION_A,
});

function mutableState(initialTasks: Record<string, unknown> = {}): {
  getState: () => AppState;
  setAppState: (updater: (prev: AppState) => AppState) => void;
} {
  let state = { tasks: initialTasks } as unknown as AppState;
  return {
    getState: () => state,
    setAppState(updater) {
      state = updater(state);
    },
  };
}

afterEach(() => {
  resetCommandQueueForTesting();
  vi.restoreAllMocks();
});

describe("background notification queue ownership", () => {
  test("a shell result completing after a session switch retains its creation owner", async () => {
    const originalSessionId = getSessionId();
    let resolveResult:
      ((value: { code: number; interrupted: boolean }) => void) | undefined;
    const result = new Promise<{ code: number; interrupted: boolean }>(
      (resolve) => {
        resolveResult = resolve;
      },
    );
    const shellCommand = {
      background: vi.fn(() => true),
      cleanup: vi.fn(),
      result,
      taskOutput: {
        taskId: "bowner001",
        flush: vi.fn(async () => undefined),
      },
    } as unknown as ShellCommand;
    const state = mutableState();

    try {
      const handle = await spawnShellTask(
        {
          command: "echo done",
          description: "origin-owned shell",
          queueOwner: OWNER_A,
          shellCommand,
        },
        {
          abortController: new AbortController(),
          getAppState: state.getState,
          setAppState: state.setAppState,
        },
      );

      switchSession(SESSION_B as never, null);
      resolveResult?.({ code: 0, interrupted: false });

      await vi.waitFor(() => {
        expect(getCommandQueueSnapshot()).toHaveLength(1);
      });

      const [notification] = getCommandQueueSnapshot();
      expect(notification?.queueOwner).toEqual(OWNER_A);
      expect(queuedCommandOwnedByConversation(notification!, SESSION_A)).toBe(
        true,
      );
      expect(queuedCommandOwnedByConversation(notification!, SESSION_B)).toBe(
        false,
      );
      handle.cleanup?.();
    } finally {
      switchSession(originalSessionId, null);
    }
  });

  test("a main-session completion uses the parent owner stored on the task", () => {
    const originalSessionId = getSessionId();
    const state = mutableState({
      smain0001: {
        id: "smain0001",
        type: "local_agent",
        status: "running",
        description: "background session",
        notified: false,
        isBackgrounded: true,
        queueOwner: OWNER_A,
      },
    });

    try {
      switchSession(SESSION_B as never, null);
      completeMainSessionTask("smain0001", true, state.setAppState);

      const [notification] = getCommandQueueSnapshot();
      expect(notification?.queueOwner).toEqual(OWNER_A);
      expect(queuedCommandOwnedByConversation(notification!, SESSION_A)).toBe(
        true,
      );
      expect(queuedCommandOwnedByConversation(notification!, SESSION_B)).toBe(
        false,
      );
    } finally {
      switchSession(originalSessionId, null);
    }
  });
});
