import { describe, expect, test, vi } from "vitest";
import type { AppState } from "./AppState.js";
import {
  enterTeammateView,
  stopOrDismissAgent,
} from "./teammateViewHelpers.js";

vi.mock("../../services/analytics/index.js", () => ({
  logEvent: vi.fn(),
}));

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

describe("teammateViewHelpers", () => {
  test("enterTeammateView retains the selected local agent row for transcript view", () => {
    const state = makeState({
      tasks: {
        agent_1: makeAgentTask("agent_1"),
      },
    });

    const next = applyUpdate(state, (setAppState) => {
      enterTeammateView("agent_1", setAppState);
    });

    expect(next.viewSelectionMode).toBe("viewing-agent");
    expect(next.viewingAgentTaskId).toBe("agent_1");
    expect(next.tasks.agent_1).toMatchObject({
      retain: true,
      evictAfter: undefined,
    });
  });

  test("stopOrDismissAgent aborts a running selected local agent row", () => {
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, "abort");
    const state = makeState({
      tasks: {
        agent_1: makeAgentTask("agent_1", { abortController }),
      },
    });

    const next = applyUpdate(state, (setAppState) => {
      stopOrDismissAgent("agent_1", setAppState);
    });

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(next).toBe(state);
  });

  test("stopOrDismissAgent immediately hides a terminal selected local agent row", () => {
    const state = makeState({
      viewSelectionMode: "viewing-agent",
      viewingAgentTaskId: "agent_1",
      tasks: {
        agent_1: makeAgentTask("agent_1", {
          status: "completed",
          retain: true,
          diskLoaded: true,
          messages: [{ type: "assistant" }],
        }),
      },
    });

    const next = applyUpdate(state, (setAppState) => {
      stopOrDismissAgent("agent_1", setAppState);
    });

    expect(next.viewSelectionMode).toBe("none");
    expect(next.viewingAgentTaskId).toBeUndefined();
    expect(next.tasks.agent_1).toMatchObject({
      retain: false,
      diskLoaded: false,
      messages: undefined,
      evictAfter: 0,
    });
  });
});
