import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../../ink/root.js";
import { TeammateSpinnerTree } from "./TeammateSpinnerTree.js";

const appStateMock = vi.hoisted(() => ({
  state: {
    showTeammateMessagePreview: true,
    tasks: {} as Record<string, unknown>,
    viewingAgentTaskId: undefined as string | undefined,
  },
}));

vi.mock("../../state/AppState.js", () => ({
  useAppState: (selector: (state: typeof appStateMock.state) => unknown) =>
    selector(appStateMock.state),
}));

function makeTeammateTask(
  overrides: Partial<Record<string, unknown>> & {
    id: string;
    agentName: string;
  },
) {
  return {
    awaitingPlanApproval: false,
    id: overrides.id,
    identity: {
      agentId: `${overrides.agentName}@alpha`,
      agentName: overrides.agentName,
      parentSessionId: "leader-session",
      planModeRequired: false,
      teamName: "alpha",
    },
    isIdle: false,
    messages: [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: `recent ${overrides.agentName} work`,
            },
          ],
        },
      },
    ],
    pendingUserMessages: [],
    permissionMode: "acceptEdits",
    progress: {
      lastActivity: {
        activityDescription: `Working as ${overrides.agentName}`,
      },
      tokenCount: 1234,
      toolUseCount: 1,
    },
    prompt: "do the work",
    shutdownRequested: false,
    spinnerVerb: `Thinking as ${overrides.agentName}`,
    startTime: Date.now() - 5_000,
    status: "running",
    totalPausedMs: 0,
    type: "in_process_teammate",
    ...overrides,
  };
}

async function renderTreeToText(node: React.ReactNode): Promise<string> {
  let output = "";
  const stdout = new PassThrough();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 120;

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  try {
    root.render(node);
    await new Promise(resolve => setTimeout(resolve, 30));
    return stripAnsi(output);
  } finally {
    root.unmount();
    stdin.end();
  }
}

describe("TeammateSpinnerTree rendering", () => {
  beforeEach(() => {
    appStateMock.state.viewingAgentTaskId = undefined;
    appStateMock.state.showTeammateMessagePreview = true;
    appStateMock.state.tasks = {
      beta: makeTeammateTask({ id: "beta", agentName: "Beta" }),
      alpha: makeTeammateTask({ id: "alpha", agentName: "Alpha" }),
    };
  });

  test("renders the leader, sorted teammates, previews, stats, and hide row", async () => {
    const output = await renderTreeToText(
      <TeammateSpinnerTree
        isInSelectionMode
        selectedIndex={2}
        leaderTokenCount={26_000}
        leaderVerb="coordinating"
      />,
    );

    expect(output).toContain("team-lead");
    expect(output).toContain("26.0k tokens");
    expect(output.indexOf("@Alpha")).toBeLessThan(output.indexOf("@Beta"));
    expect(output).toContain("Working as Alpha");
    expect(output).toContain("recent Alpha work");
    expect(output).toContain("1 tool use");
    expect(output).toContain("1.2k tokens");
    expect(output).toContain("hide");
    expect(output).toContain("enter to collapse");
  });

  test("renders foregrounded and all-idle states", async () => {
    appStateMock.state.viewingAgentTaskId = "other";
    appStateMock.state.tasks = {
      alpha: makeTeammateTask({
        id: "alpha",
        agentName: "Alpha",
        isIdle: true,
        pastTenseVerb: "worked",
      }),
    };

    const output = await renderTreeToText(
      <TeammateSpinnerTree
        allIdle
        isInSelectionMode
        leaderIdleText="Idle for 3s"
        selectedIndex={0}
      />,
    );

    expect(output).toContain("team-lead");
    expect(output).toContain("Idle for 3s");
    expect(output).toContain("@Alpha");
    expect(output).toContain("worked for");
    expect(output).toContain("shift +");
    expect(output).toContain("enter to view");
  });

  test("renders nothing when there are no running teammates", async () => {
    appStateMock.state.tasks = {};

    const output = await renderTreeToText(<TeammateSpinnerTree />);

    expect(output).toBe("");
  });
});
