import { describe, expect, test } from "vitest";

import type { AppState } from "./AppStateStore.js";
import {
  getActiveAgentForInput,
  getViewedTeammateTask,
} from "./selectors.js";

function makeState(
  viewingAgentTaskId: string | undefined,
  tasks: AppState["tasks"] = {},
): AppState {
  return {
    viewingAgentTaskId,
    tasks,
  } as AppState;
}

function makeTask(id: string, type: string): AppState["tasks"][string] {
  return {
    id,
    type,
    status: "running",
    description: id,
    startTime: 1,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
  } as AppState["tasks"][string];
}

describe("state selectors coverage", () => {
  test("routes input to the viewed teammate, named local agent, or leader fallback", () => {
    const teammateTask = makeTask("teammate-1", "in_process_teammate");
    const localAgentTask = makeTask("agent-1", "local_agent");
    const shellTask = makeTask("shell-1", "local_bash");

    expect(getViewedTeammateTask(makeState(undefined))).toBeUndefined();
    expect(getViewedTeammateTask(makeState("missing"))).toBeUndefined();
    expect(
      getViewedTeammateTask(makeState("agent-1", { "agent-1": localAgentTask })),
    ).toBeUndefined();
    expect(
      getViewedTeammateTask(
        makeState("teammate-1", { "teammate-1": teammateTask }),
      ),
    ).toBe(teammateTask);

    expect(
      getActiveAgentForInput(
        makeState("teammate-1", { "teammate-1": teammateTask }),
      ),
    ).toEqual({ type: "viewed", task: teammateTask });
    expect(
      getActiveAgentForInput(makeState("agent-1", { "agent-1": localAgentTask })),
    ).toEqual({ type: "named_agent", task: localAgentTask });
    expect(
      getActiveAgentForInput(makeState("shell-1", { "shell-1": shellTask })),
    ).toEqual({ type: "leader" });
    expect(getActiveAgentForInput(makeState(undefined))).toEqual({
      type: "leader",
    });
  });
});
