import { describe, expect, it } from "vitest";

import {
  previewFileRevisionKey,
  previewTaskEpoch,
} from "../../../src/tui/workbench/previewInvalidation.js";
import type { TaskState } from "../../../src/tasks/types.js";

function agentTask(
  overrides: Partial<TaskState> & Pick<TaskState, "id" | "status">,
): TaskState {
  return {
    type: "local_agent",
    description: "editing target.ts",
    startTime: 0,
    outputFile: "",
    outputOffset: 0,
    notified: false,
    agentId: "agent",
    prompt: "target.ts",
    agentType: "general",
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  } as TaskState;
}

describe("previewTaskEpoch", () => {
  it("ignores tasks that do not reference the selected path", () => {
    const tasks = {
      "agent-other": agentTask({
        id: "agent-other",
        status: "running",
        description: "editing other.ts",
        prompt: "other.ts",
      }),
    };

    expect(previewTaskEpoch(tasks, "target.ts")).toBe("");
  });

  it("changes when a referencing task starts or completes", () => {
    const running = {
      "agent-1": agentTask({
        id: "agent-1",
        status: "running",
        description: "editing target.ts",
      }),
    };
    const completed = {
      "agent-1": agentTask({
        id: "agent-1",
        status: "completed",
        description: "editing target.ts",
        endTime: 12,
      }),
    };

    const runningEpoch = previewTaskEpoch(running, "target.ts");
    const completedEpoch = previewTaskEpoch(completed, "target.ts");

    expect(runningEpoch).toContain("agent-1:running:");
    expect(completedEpoch).toBe("agent-1:completed:12");
    expect(completedEpoch).not.toBe(runningEpoch);
  });

  it("does not change when only progress chatter updates", () => {
    const before = {
      "agent-1": agentTask({
        id: "agent-1",
        status: "running",
        description: "editing target.ts",
      }),
    };
    const after = {
      "agent-1": agentTask({
        id: "agent-1",
        status: "running",
        description: "editing target.ts",
        lastReportedTokenCount: 99,
        progress: {
          lastActivity: { activityDescription: "still editing target.ts" },
        },
      }),
    };

    expect(previewTaskEpoch(after, "target.ts")).toBe(
      previewTaskEpoch(before, "target.ts"),
    );
  });

  it("returns an empty epoch when no path is selected", () => {
    const tasks = {
      "agent-1": agentTask({
        id: "agent-1",
        status: "running",
        description: "editing target.ts",
      }),
    };

    expect(previewTaskEpoch(tasks, null)).toBe("");
  });
});

describe("previewFileRevisionKey", () => {
  it("identifies missing files separately from a disk revision", () => {
    expect(previewFileRevisionKey(null)).toBe("missing");
    expect(
      previewFileRevisionKey({ mtimeMs: 10, size: 4, ino: 7 }),
    ).toBe("10:4:7");
  });
});
