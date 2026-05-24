import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  isTeammateHideRowSelected,
  TeammateSpinnerTree,
} from "../../../src/tui/components/spinner/TeammateSpinnerTree.js";
import { renderToString } from "../../../src/utils/staticRender.js";

type AppStateSlice = {
  showTeammateMessagePreview: boolean;
  tasks: Record<string, unknown>;
  viewingAgentTaskId?: string;
};

const harness = vi.hoisted(() => ({
  state: {
    showTeammateMessagePreview: false,
    tasks: {},
    viewingAgentTaskId: undefined,
  } as AppStateSlice,
}));

vi.mock("../../../src/tui/state/AppState.js", () => ({
  useAppState: (selector: (state: AppStateSlice) => unknown) =>
    selector(harness.state),
}));

function makeTeammateTask({
  agentName,
  id,
  ...overrides
}: {
  agentName: string;
  id: string;
  [key: string]: unknown;
}) {
  return {
    awaitingPlanApproval: false,
    description: `${agentName} teammate`,
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
        message: {
          content: [
            {
              text: `recent ${agentName} update`,
              type: "text",
            },
          ],
        },
        type: "assistant",
      },
    ],
    notified: false,
    outputFile: `/tmp/${id}.log`,
    outputOffset: 0,
    pendingUserMessages: [],
    permissionMode: "acceptEdits",
    progress: {
      lastActivity: {
        activityDescription: `Working as ${agentName}`,
      },
      tokenCount: 2400,
      toolUseCount: 2,
    },
    prompt: "do the work",
    shutdownRequested: false,
    spinnerVerb: `Thinking as ${agentName}`,
    startTime: Date.now() - 5000,
    status: "running",
    totalPausedMs: 0,
    type: "in_process_teammate",
    ...overrides,
  };
}

describe("TeammateSpinnerTree coverage swarm row 024", () => {
  beforeEach(() => {
    harness.state = {
      showTeammateMessagePreview: false,
      tasks: {
        worker: makeTeammateTask({ agentName: "Worker", id: "worker" }),
      },
      viewingAgentTaskId: "worker",
    };
  });

  test("renders a backgrounded leader action without selection controls", async () => {
    const output = await renderToString(
      <TeammateSpinnerTree leaderTokenCount={1500} leaderVerb="coordinating" />,
      120,
    );

    expect(output).toContain("team-lead: coordinating");
    expect(output).toContain("1.5k tokens");
    expect(output).toContain("@Worker");
    expect(output).not.toContain("hide");
    expect(output).not.toContain("enter to collapse");
  });

  test("renders backgrounded leader idle text and omits nonpositive token counts", async () => {
    const output = await renderToString(
      <TeammateSpinnerTree leaderIdleText="Idle for 9s" leaderTokenCount={0} />,
      120,
    );

    expect(output).toContain("team-lead: Idle for 9s");
    expect(output).not.toContain("0 tokens");
    expect(output).not.toContain("hide");
  });

  test("renders the selected hide row when selection moves past teammates", async () => {
    const output = await renderToString(
      <TeammateSpinnerTree isInSelectionMode selectedIndex={1} />,
      120,
    );

    expect(output).toContain("team-lead");
    expect(output).toContain("hide");
    expect(output).toContain("enter to collapse");
    expect(output).not.toContain("enter to view");
  });

  test("keeps the hide row selected when a stale selection index is past the final teammate", async () => {
    expect(
      isTeammateHideRowSelected({
        isInSelectionMode: true,
        selectedIndex: 9,
        teammateCount: 1,
      }),
    ).toBe(true);

    const output = await renderToString(
      <TeammateSpinnerTree isInSelectionMode selectedIndex={9} />,
      120,
    );

    expect(output).toContain("hide");
    expect(output).toContain("enter to collapse");
  });

  test("does not select the hide row outside selection mode or without an index", () => {
    expect(
      isTeammateHideRowSelected({
        isInSelectionMode: false,
        selectedIndex: 1,
        teammateCount: 1,
      }),
    ).toBe(false);
    expect(
      isTeammateHideRowSelected({
        isInSelectionMode: true,
        selectedIndex: undefined,
        teammateCount: 1,
      }),
    ).toBe(false);
  });

  test("renders the selected background leader while hide stays unselected", async () => {
    const output = await renderToString(
      <TeammateSpinnerTree
        isInSelectionMode
        leaderVerb="reviewing"
        selectedIndex={-1}
      />,
      120,
    );

    expect(output).toContain("team-lead: reviewing");
    expect(output).toContain("enter to view");
    expect(output).toContain("hide");
    expect(output).not.toContain("enter to collapse");
  });

  test("renders nothing when teammate records are not running", async () => {
    harness.state.tasks = {
      completed: makeTeammateTask({
        agentName: "Completed",
        id: "completed",
        status: "completed",
      }),
      killed: makeTeammateTask({
        agentName: "Killed",
        id: "killed",
        status: "killed",
      }),
    };

    const output = await renderToString(<TeammateSpinnerTree />, 120);

    expect(output.trim()).toBe("");
  });
});
