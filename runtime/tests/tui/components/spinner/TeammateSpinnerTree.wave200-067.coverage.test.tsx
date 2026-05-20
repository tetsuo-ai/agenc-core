import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../../utils/staticRender.js";
import { TeammateSpinnerTree } from "./TeammateSpinnerTree.js";

const harness = vi.hoisted(() => ({
  state: {
    showTeammateMessagePreview: false,
    tasks: {} as Record<string, unknown>,
    viewingAgentTaskId: "beta" as string | undefined,
  },
}));

vi.mock("../../state/AppState.js", () => ({
  useAppState: (selector: (state: typeof harness.state) => unknown) =>
    selector(harness.state),
}));

function makeTeammateTask(id: string, agentName: string) {
  return {
    awaitingPlanApproval: false,
    id,
    identity: {
      agentId: `${agentName}@alpha`,
      agentName,
      parentSessionId: "leader-session",
      planModeRequired: false,
      teamName: "alpha",
    },
    isIdle: false,
    lastReportedTokenCount: 0,
    lastReportedToolCount: 0,
    messages: [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: `recent ${agentName} work` }],
        },
      },
    ],
    pendingUserMessages: [],
    permissionMode: "acceptEdits",
    progress: {
      lastActivity: {
        activityDescription: `Working as ${agentName}`,
      },
      tokenCount: 1234,
      toolUseCount: 1,
    },
    prompt: "do the work",
    shutdownRequested: false,
    spinnerVerb: `Thinking as ${agentName}`,
    startTime: Date.now() - 5_000,
    status: "running",
    totalPausedMs: 0,
    type: "in_process_teammate",
  };
}

describe("TeammateSpinnerTree wave 200 coverage", () => {
  beforeEach(() => {
    harness.state = {
      showTeammateMessagePreview: false,
      tasks: {
        alpha: makeTeammateTask("alpha", "Alpha"),
        beta: makeTeammateTask("beta", "Beta"),
      },
      viewingAgentTaskId: "beta",
    };
  });

  test("renders a selected background leader while keeping the hide row unselected", async () => {
    const output = await renderToString(
      <TeammateSpinnerTree
        isInSelectionMode={true}
        leaderTokenCount={0}
        leaderVerb="coordinating"
        selectedIndex={-1}
      />,
      120,
    );

    expect(output).toContain("team-lead: coordinating");
    expect(output).toContain("enter to view");
    expect(output).toContain("hide");
    expect(output).not.toContain("enter to collapse");
    expect(output).not.toContain("0 tokens");
    expect(output).toContain("@Alpha");
    expect(output).toContain("Working as Alpha");
    expect(output).toContain("@Beta");
    expect(output.indexOf("@Alpha")).toBeLessThan(output.indexOf("@Beta"));
    expect(output).not.toContain("recent Alpha work");
  });
});
