import { describe, expect, it } from "vitest";

import { getPillLabel } from "./pillLabel.js";
import {
  createTaskStateBase,
  type BackgroundTaskState,
  type InProcessTeammateTaskState,
  type LocalShellTaskState,
} from "./types.js";

function shell(
  id: string,
  kind?: LocalShellTaskState["kind"],
): LocalShellTaskState {
  return {
    ...createTaskStateBase(id, "local_bash", id),
    status: "running",
    command: id,
    isBackgrounded: true,
    ...(kind !== undefined ? { kind } : {}),
  };
}

function teammate(
  id: string,
  teamName: string,
): InProcessTeammateTaskState {
  return {
    ...createTaskStateBase(id, "in_process_teammate", id),
    status: "running",
    identity: {
      agentId: id,
      agentName: id,
      teamName,
      planModeRequired: false,
      parentSessionId: "parent",
    },
    prompt: "help",
    awaitingPlanApproval: false,
    permissionMode: "default",
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  };
}

describe("getPillLabel", () => {
  it("labels shell and monitor groups", () => {
    expect(getPillLabel([shell("one")])).toBe("1 shell");
    expect(getPillLabel([shell("one"), shell("two")])).toBe("2 shells");
    expect(getPillLabel([shell("one", "monitor")])).toBe("1 monitor");
    expect(getPillLabel([shell("one"), shell("two", "monitor")])).toBe(
      "1 shell, 1 monitor",
    );
  });

  it("labels teams, local agents, and mixed tasks", () => {
    expect(getPillLabel([teammate("agent-1", "alpha")])).toBe("1 team");
    expect(
      getPillLabel([teammate("agent-1", "alpha"), teammate("agent-2", "beta")]),
    ).toBe("2 teams");
    expect(
      getPillLabel([
        {
          ...createTaskStateBase("agent-1", "local_agent", "inspect"),
          status: "running",
          agentId: "agent-1",
          prompt: "inspect",
          agentType: "default",
          retrieved: false,
          lastReportedToolCount: 0,
          lastReportedTokenCount: 0,
          pendingMessages: [],
          retain: false,
          diskLoaded: false,
        },
      ]),
    ).toBe("1 local agent");
    expect(
      getPillLabel([teammate("agent-1", "alpha"), shell("shell-1")] as BackgroundTaskState[]),
    ).toBe("2 background tasks");
    expect(getPillLabel([])).toBe("0 background tasks");
  });
});
