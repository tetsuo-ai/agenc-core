import { describe, expect, test } from "vitest";

import type { AppState } from "./AppState.js";
import {
  getActiveAgentForInput,
  getViewedTeammateTask,
} from "./selectors.js";

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tasks: {},
    viewingAgentTaskId: undefined,
    ...overrides,
  } as AppState;
}

describe("state selectors", () => {
  describe("getViewedTeammateTask", () => {
    test("returns undefined when no teammate is selected", () => {
      expect(getViewedTeammateTask(makeState())).toBeUndefined();
    });

    test("returns undefined when the selected task id is missing", () => {
      expect(
        getViewedTeammateTask(makeState({ viewingAgentTaskId: "missing" })),
      ).toBeUndefined();
    });

    test("returns undefined when the selected task is not an in-process teammate", () => {
      const task = { id: "agent-1", type: "local_agent" };

      expect(
        getViewedTeammateTask(
          makeState({
            viewingAgentTaskId: "agent-1",
            tasks: { "agent-1": task },
          }),
        ),
      ).toBeUndefined();
    });

    test("returns the selected in-process teammate task", () => {
      const task = { id: "teammate-1", type: "in_process_teammate" };

      expect(
        getViewedTeammateTask(
          makeState({
            viewingAgentTaskId: "teammate-1",
            tasks: { "teammate-1": task },
          }),
        ),
      ).toBe(task);
    });
  });

  describe("getActiveAgentForInput", () => {
    test("routes input to the viewed in-process teammate", () => {
      const task = { id: "teammate-1", type: "in_process_teammate" };

      expect(
        getActiveAgentForInput(
          makeState({
            viewingAgentTaskId: "teammate-1",
            tasks: { "teammate-1": task },
          }),
        ),
      ).toEqual({ type: "viewed", task });
    });

    test("routes input to a selected named local agent", () => {
      const task = { id: "agent-1", type: "local_agent" };

      expect(
        getActiveAgentForInput(
          makeState({
            viewingAgentTaskId: "agent-1",
            tasks: { "agent-1": task },
          }),
        ),
      ).toEqual({ type: "named_agent", task });
    });

    test("routes input to the leader when nothing is selected", () => {
      expect(getActiveAgentForInput(makeState())).toEqual({ type: "leader" });
    });

    test("routes input to the leader when the selected task is unavailable", () => {
      expect(
        getActiveAgentForInput(
          makeState({ viewingAgentTaskId: "missing" }),
        ),
      ).toEqual({ type: "leader" });
    });

    test("routes input to the leader for unsupported selected task types", () => {
      expect(
        getActiveAgentForInput(
          makeState({
            viewingAgentTaskId: "background-1",
            tasks: {
              "background-1": { id: "background-1", type: "background_task" },
            },
          }),
        ),
      ).toEqual({ type: "leader" });
    });
  });
});
