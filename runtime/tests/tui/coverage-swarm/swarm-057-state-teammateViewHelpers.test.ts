import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AppState } from "src/tui/state/AppState.js";
import {
  enterTeammateView,
  exitTeammateView,
  stopOrDismissAgent,
} from "src/tui/state/teammateViewHelpers.js";

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tasks: {},
    viewSelectionMode: "none",
    viewingAgentTaskId: undefined,
    ...overrides,
  } as AppState;
}

function makeAgentTask(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: "local_agent",
    status: "running",
    description: id,
    startTime: 1,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
    agentId: id,
    prompt: "inspect",
    agentType: "worker",
    retrieved: false,
    messages: undefined,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  };
}

function makeShellTask(id: string): Record<string, unknown> {
  return {
    id,
    type: "local_bash",
    status: "completed",
    description: id,
    startTime: 1,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
    command: "true",
  };
}

function applyUpdate(
  initial: AppState,
  action: (setAppState: (updater: (prev: AppState) => AppState) => void) => void,
): AppState {
  let state = initial;
  action((updater) => {
    state = updater(state);
  });
  return state;
}

describe("teammateViewHelpers coverage edges", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("enterTeammateView keeps state identity when the retained agent is already selected", () => {
    const state = makeState({
      viewSelectionMode: "viewing-agent",
      viewingAgentTaskId: "agent_1",
      tasks: {
        agent_1: makeAgentTask("agent_1", {
          retain: true,
          evictAfter: undefined,
        }),
      },
    });

    const next = applyUpdate(state, (setAppState) => {
      enterTeammateView("agent_1", setAppState);
    });

    expect(next).toBe(state);
  });

  test("enterTeammateView releases the previous retained agent and clears the selected agent eviction deadline", () => {
    const previousMessages = [{ type: "assistant", uuid: "msg_1" }];
    const state = makeState({
      viewSelectionMode: "viewing-agent",
      viewingAgentTaskId: "agent_old",
      tasks: {
        agent_old: makeAgentTask("agent_old", {
          status: "completed",
          retain: true,
          diskLoaded: true,
          messages: previousMessages,
        }),
        agent_new: makeAgentTask("agent_new", {
          retain: true,
          evictAfter: 10_000,
        }),
      },
    });

    const next = applyUpdate(state, (setAppState) => {
      enterTeammateView("agent_new", setAppState);
    });

    expect(next.viewSelectionMode).toBe("viewing-agent");
    expect(next.viewingAgentTaskId).toBe("agent_new");
    expect(next.tasks).not.toBe(state.tasks);
    expect(next.tasks.agent_old).toMatchObject({
      retain: false,
      diskLoaded: false,
      messages: undefined,
      // Date.now()(1_000) + PANEL_GRACE_MS(1_800_000) — result-board retention
      evictAfter: 1_801_000,
    });
    expect(next.tasks.agent_new).toMatchObject({
      retain: true,
      evictAfter: undefined,
    });
  });

  test("enterTeammateView can select a missing or non-local task without cloning tasks", () => {
    const state = makeState({
      tasks: {
        shell_1: makeShellTask("shell_1"),
      },
    });

    const missing = applyUpdate(state, (setAppState) => {
      enterTeammateView("missing_agent", setAppState);
    });
    const shell = applyUpdate(state, (setAppState) => {
      enterTeammateView("shell_1", setAppState);
    });

    expect(missing.tasks).toBe(state.tasks);
    expect(missing.viewSelectionMode).toBe("viewing-agent");
    expect(missing.viewingAgentTaskId).toBe("missing_agent");
    expect(shell.tasks).toBe(state.tasks);
    expect(shell.viewingAgentTaskId).toBe("shell_1");
  });

  test("exitTeammateView preserves an idle state and clears a stale selection mode", () => {
    const idle = makeState();
    const stale = makeState({ viewSelectionMode: "viewing-agent" });

    const stillIdle = applyUpdate(idle, (setAppState) => {
      exitTeammateView(setAppState);
    });
    const cleared = applyUpdate(stale, (setAppState) => {
      exitTeammateView(setAppState);
    });

    expect(stillIdle).toBe(idle);
    expect(cleared).toMatchObject({
      viewSelectionMode: "none",
      viewingAgentTaskId: undefined,
    });
  });

  test("exitTeammateView clears view without releasing non-local or non-retained tasks", () => {
    const nonLocal = makeState({
      viewSelectionMode: "viewing-agent",
      viewingAgentTaskId: "shell_1",
      tasks: {
        shell_1: makeShellTask("shell_1"),
      },
    });
    const notRetained = makeState({
      viewSelectionMode: "viewing-agent",
      viewingAgentTaskId: "agent_1",
      tasks: {
        agent_1: makeAgentTask("agent_1", {
          retain: false,
          messages: [{ type: "assistant", uuid: "msg_1" }],
        }),
      },
    });

    const clearedNonLocal = applyUpdate(nonLocal, (setAppState) => {
      exitTeammateView(setAppState);
    });
    const clearedNotRetained = applyUpdate(notRetained, (setAppState) => {
      exitTeammateView(setAppState);
    });

    expect(clearedNonLocal.tasks).toBe(nonLocal.tasks);
    expect(clearedNonLocal.viewSelectionMode).toBe("none");
    expect(clearedNotRetained.tasks).toBe(notRetained.tasks);
    expect(clearedNotRetained.tasks.agent_1).toMatchObject({
      retain: false,
      messages: [{ type: "assistant", uuid: "msg_1" }],
    });
  });

  test("exitTeammateView releases a retained running task without scheduling eviction", () => {
    const state = makeState({
      viewSelectionMode: "viewing-agent",
      viewingAgentTaskId: "agent_1",
      tasks: {
        agent_1: makeAgentTask("agent_1", {
          retain: true,
          diskLoaded: true,
          messages: [{ type: "assistant", uuid: "msg_1" }],
        }),
      },
    });

    const next = applyUpdate(state, (setAppState) => {
      exitTeammateView(setAppState);
    });

    expect(next.viewSelectionMode).toBe("none");
    expect(next.viewingAgentTaskId).toBeUndefined();
    expect(next.tasks.agent_1).toMatchObject({
      retain: false,
      diskLoaded: false,
      messages: undefined,
      evictAfter: undefined,
    });
  });

  test("stopOrDismissAgent ignores non-local and already dismissed tasks", () => {
    const nonLocal = makeState({
      tasks: {
        shell_1: makeShellTask("shell_1"),
      },
    });
    const dismissed = makeState({
      tasks: {
        agent_1: makeAgentTask("agent_1", {
          status: "completed",
          evictAfter: 0,
        }),
      },
    });

    const nonLocalNext = applyUpdate(nonLocal, (setAppState) => {
      stopOrDismissAgent("shell_1", setAppState);
    });
    const dismissedNext = applyUpdate(dismissed, (setAppState) => {
      stopOrDismissAgent("agent_1", setAppState);
    });

    expect(nonLocalNext).toBe(nonLocal);
    expect(dismissedNext).toBe(dismissed);
  });

  test("stopOrDismissAgent dismisses an unviewed terminal agent without clearing the current view", () => {
    const state = makeState({
      viewSelectionMode: "viewing-agent",
      viewingAgentTaskId: "agent_current",
      tasks: {
        agent_current: makeAgentTask("agent_current", { retain: true }),
        agent_done: makeAgentTask("agent_done", {
          status: "failed",
          retain: true,
          diskLoaded: true,
          messages: [{ type: "assistant", uuid: "msg_1" }],
        }),
      },
    });

    const next = applyUpdate(state, (setAppState) => {
      stopOrDismissAgent("agent_done", setAppState);
    });

    expect(next.viewSelectionMode).toBe("viewing-agent");
    expect(next.viewingAgentTaskId).toBe("agent_current");
    expect(next.tasks.agent_done).toMatchObject({
      retain: false,
      diskLoaded: false,
      messages: undefined,
      evictAfter: 0,
    });
  });
});
