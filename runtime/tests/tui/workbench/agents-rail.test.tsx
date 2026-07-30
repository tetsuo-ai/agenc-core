import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const keybindingHarness = vi.hoisted(() => ({
  handlers: {} as Record<string, () => void>,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => void>) => {
    keybindingHarness.handlers = handlers;
  },
}));

import {
  AppStateProvider,
  getDefaultAppState,
  type AppState,
} from "../../../src/tui/state/AppState.js";
import { syncCollabAgentEventToAppState } from "../../../src/tui/state/collabAgentTaskSync.js";
import { AgentsRail } from "../../../src/tui/workbench/agents/AgentsRail.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("AgentsRail", () => {
  beforeEach(() => {
    keybindingHarness.handlers = {};
  });

  it("renders remote task counts and empty local task states", async () => {
    const remoteOnly = await renderAgentsRail({
      remoteBackgroundTaskCount: 3,
    });
    const emptyFocusedOut = await renderAgentsRail({
      focused: false,
      width: 32,
    });

    expect(remoteOnly.output).toContain("3 REMOTE");
    expect(remoteOnly.output).toContain("Waiting for agent details");
    expect(emptyFocusedOut.output).toContain("Delegate work");
    expect(emptyFocusedOut.output).toContain("progress here.");
  });

  it("routes focus, selection, open, and stop keybindings through workbench state", async () => {
    const runningNewest = agentTask("agent-new", "running", {
      description: "new running agent",
      startTime: 2_000,
    });
    const runningOldest = agentTask("agent-old", "running", {
      description: "old running agent",
      startTime: 1_000,
    });
    const completed = agentTask("agent-done", "completed", {
      description: "done agent",
      startTime: 3_000,
    });
    const { changes } = await renderAgentsRail({
      tasks: [runningOldest, runningNewest, completed],
      selectedAgentTaskId: "agent-new",
    });

    keybindingHarness.handlers["workbench:focusSurface"]?.();
    expect(changes.at(-1)?.workbench.focusedPane).toBe("surface");

    keybindingHarness.handlers["agents:down"]?.();
    expect(changes.at(-1)?.workbench.selectedAgentTaskId).toBe("agent-done");

    keybindingHarness.handlers["agents:up"]?.();
    expect(changes.at(-1)?.workbench.selectedAgentTaskId).toBe("agent-old");

    keybindingHarness.handlers["agents:open"]?.();
    expect(changes.at(-1)?.workbench).toMatchObject({
      activeSurfaceMode: "task-detail",
      focusedPane: "surface",
      selectedAgentTaskId: "agent-new",
    });

    keybindingHarness.handlers["agents:stop"]?.();
    expect(changes.at(-1)?.tasks["agent-new"]).toMatchObject({
      status: "killed",
    });
  });

  it("wraps agent rail navigation across completed agents in first-seen order", async () => {
    const runningOldest = agentTask("agent-old", "running", {
      description: "old running agent",
      startTime: 1_000,
    });
    const runningNewest = agentTask("agent-new", "running", {
      description: "new running agent",
      startTime: 2_000,
    });
    const completed = agentTask("agent-done", "completed", {
      description: "done agent",
      startTime: 3_000,
    });
    const { changes } = await renderAgentsRail({
      tasks: [runningOldest, runningNewest, completed],
      selectedAgentTaskId: "agent-old",
    });

    keybindingHarness.handlers["agents:up"]?.();
    expect(changes.at(-1)?.workbench.selectedAgentTaskId).toBe("agent-done");

    keybindingHarness.handlers["agents:down"]?.();
    expect(changes.at(-1)?.workbench.selectedAgentTaskId).toBe("agent-new");
  });

  it("ignores navigation, open, and stop keybindings when there is no selected task", async () => {
    const { changes } = await renderAgentsRail();

    keybindingHarness.handlers["agents:up"]?.();
    keybindingHarness.handlers["agents:down"]?.();
    keybindingHarness.handlers["agents:open"]?.();
    keybindingHarness.handlers["agents:stop"]?.();

    expect(changes).toHaveLength(0);
  });

  it("treats missing task dictionaries as empty", async () => {
    const { output } = await renderAgentsRail({
      rawTasks: undefined,
    });

    expect(output).toContain("Delegate work to track progress");
  });

  it("renders stable rows, selection, activity copy, and resilient text fallbacks", async () => {
    const output = (
      await renderAgentsRail({
        tasks: [
          agentTask("agent-blank", "", {
            description: " ",
            progress: {
              lastActivity: {
                activityDescription: "",
                toolName: "",
              },
            },
            startTime: 5_000,
          }),
          agentTask("", "failed", {
            description: " ",
            startTime: 4_500,
          }),
          agentTask("agent-pending", "pending", {
            description: "pending agent",
            progress: {
              toolUseCount: 2,
              tokenCount: 120,
              diffCount: 3,
              lastActivity: { toolName: "edit" },
            },
            pendingApproval: true,
            startTime: 4_000,
          }),
          agentTask("agent-failed", "failed", {
            description: "failed agent",
            diffCount: 1,
            startTime: 3_000,
          }),
          agentTask("agent-complete", "completed", {
            description: "completed agent",
            startTime: 2_000,
          }),
          agentTask("agent-killed", "killed", {
            description: "killed agent",
            startTime: 1_000,
          }),
          {
            ...agentTask("shell-hidden", "running", {
              description: "hidden shell",
            }),
            type: "local_bash",
          },
        ],
        selectedAgentTaskId: "agent-pending",
        width: 90,
      })
    ).output;

    expect(output).not.toContain("Agent Swarm");
    expect(output).toContain("› pending agent");
    expect(output).toContain("unknown");
    expect(output).toContain("pending agent");
    expect(output).toContain("queued · edit");
    expect(output).toContain("failed agent");
    expect(output).toContain("completed agent");
    expect(output).toContain("killed agent");
    expect(output).not.toContain("hidden shell");
  });

  it("renders the real per-agent tool/token counts for a daemon-spawned collab agent", async () => {
    // Build the task the same way the live daemon path does: a collab_agent_status
    // event carrying nonzero tool-use + token counts flows through the sync layer.
    let synced: AppState = { tasks: {} } as AppState;
    syncCollabAgentEventToAppState(
      {
        type: "collab_agent_spawn_end",
        payload: {
          newThreadId: "fleet-agent",
          newAgentNickname: "Compiler",
          prompt: "compile and run the CLI",
          status: { status: "running" },
        },
      },
      (updater) => {
        synced = updater(synced as never) as AppState;
      },
    );
    syncCollabAgentEventToAppState(
      {
        type: "collab_agent_status",
        payload: {
          callId: "c1",
          senderThreadId: "root",
          threadId: "fleet-agent",
          status: "running",
          toolUseCount: 9,
          tokenCount: 73210,
        },
      },
      (updater) => {
        synced = updater(synced as never) as AppState;
      },
    );

    const railTask = (synced.tasks as Record<string, any>)["fleet-agent"];
    const output = (
      await renderAgentsRail({
        tasks: [railTask],
        selectedAgentTaskId: "fleet-agent",
        width: 90,
      })
    ).output;

    expect(output).toContain("9 tools · 73.2k tok");
    expect(output).not.toContain("0 tools · 0 tok");
  });

  it("does not advertise stop shortcuts for stale task kinds without a stop action", async () => {
    // "remote_agent" was deleted as an unshipped scaffold; a stale record with
    // that kind must render view-only instead of advertising a fake stop.
    const output = (
      await renderAgentsRail({
        tasks: [
          {
            ...agentTask("stale-running", "running", {
              description: "stale running",
            }),
            type: "remote_agent",
          },
        ],
      })
    ).output;

    expect(output).toContain("› stale running");
    expect(output).toContain("running");
    expect(output).toMatch(/[◆◇]/u);
    expect(output).not.toContain("x stop");
  });

  it("opens the first live agent when the selected agent id is stale", async () => {
    const changes: AppState[] = [];
    const liveAgent = {
      id: "agent-live",
      type: "local_agent",
      status: "running",
      description: "live agent",
      startTime: 1_000,
      outputFile: "urn:agenc:task:agent-live:output",
      outputOffset: 0,
      notified: false,
    } as any;

    await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: { [liveAgent.id]: liveAgent },
          workbench: {
            ...getDefaultAppState().workbench,
            selectedAgentTaskId: "agent-gone",
          },
        }}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <AgentsRail focused={true} width={40} />
      </AppStateProvider>,
      80,
    );

    keybindingHarness.handlers["agents:open"]?.();

    expect(changes.at(-1)?.workbench).toMatchObject({
      activeSurfaceMode: "task-detail",
      focusedPane: "surface",
      selectedAgentTaskId: "agent-live",
    });
  });

  it("opens the first observed agent after stale selection", async () => {
    const changes: AppState[] = [];
    const oldAgent = {
      id: "agent-old",
      type: "local_agent",
      status: "completed",
      description: "old completed agent",
      startTime: 1_000,
      outputFile: "urn:agenc:task:agent-old:output",
      outputOffset: 0,
      notified: false,
    } as any;
    const newAgent = {
      id: "agent-new",
      type: "local_agent",
      status: "running",
      description: "new running agent",
      startTime: 2_000,
      outputFile: "urn:agenc:task:agent-new:output",
      outputOffset: 0,
      notified: false,
    } as any;

    await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
            [oldAgent.id]: oldAgent,
            [newAgent.id]: newAgent,
          },
          workbench: {
            ...getDefaultAppState().workbench,
            selectedAgentTaskId: "agent-gone",
          },
        }}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <AgentsRail focused={true} width={40} />
      </AppStateProvider>,
      100,
    );

    keybindingHarness.handlers["agents:open"]?.();

    expect(changes.at(-1)?.workbench).toMatchObject({
      activeSurfaceMode: "task-detail",
      focusedPane: "surface",
      selectedAgentTaskId: "agent-old",
    });
  });
});

describe("AgentsRail lifecycle legibility", () => {
  it("uses explicit lifecycle copy and one visible selection gutter", async () => {
    const output = (
      await renderAgentsRail({
        tasks: [
          agentTask("agent-run", "running", {
            description: "scanning",
            startTime: Date.now(),
          }),
          agentTask("agent-ok", "completed", {
            description: "wrote tests",
            startTime: Date.now(),
          }),
          agentTask("agent-bad", "failed", {
            description: "crashed",
            startTime: Date.now(),
          }),
        ],
        selectedAgentTaskId: "agent-ok",
        width: 48,
      })
    ).output;

    expect(output).toContain("running");
    expect(output).toContain("completed");
    expect(output).toContain("failed");
    expect(output).toContain("› wrote tests");
    expect(output.match(/›/gu) ?? []).toHaveLength(1);
  });

  it("surfaces approval as 'needs you' and pauses the activity scan", async () => {
    const output = (
      await renderAgentsRail({
        tasks: [
          agentTask("agent-wait", "running", {
            description: "awaiting decision",
            pendingApproval: true,
            startTime: Date.now(),
          }),
        ],
        width: 48,
      })
    ).output;

    expect(output).toContain("needs you");
    expect(output).not.toMatch(/[◆◇]/u);
  });

  it("labels rows with the friendly title (+ role), never the raw prompt", async () => {
    const out = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
            nova: agentTask("nova", "running", {
              description: "Nova",
              agentType: "Scanner",
              prompt:
                "You are a research agent. Investigate the entire authentication subsystem and report every call site in exhaustive detail.",
              startTime: 1_000,
            }),
          },
          workbench: {
            ...getDefaultAppState().workbench,
            selectedAgentTaskId: null,
          },
        }}
      >
        <AgentsRail focused={true} width={60} />
      </AppStateProvider>,
      { columns: 72, rows: 24 },
    );

    // Friendly nickname + role, not the raw multi-sentence spawn prompt.
    expect(out).toContain("Nova · Scanner");
    expect(out).not.toContain("You are a research agent");
  });
});

function agentTask(
  id: string,
  status: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    id,
    type: "local_agent",
    status,
    description: id,
    startTime: 1_000,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
    retain: true,
    ...overrides,
  };
}

async function renderAgentsRail(
  options: {
    readonly tasks?: readonly any[];
    readonly rawTasks?: Record<string, any> | undefined;
    readonly selectedAgentTaskId?: string | null;
    readonly remoteBackgroundTaskCount?: number;
    readonly focused?: boolean;
    readonly width?: number;
  } = {},
): Promise<{
  readonly output: string;
  readonly changes: AppState[];
}> {
  const changes: AppState[] = [];
  const tasks = Object.prototype.hasOwnProperty.call(options, "rawTasks")
    ? options.rawTasks
    : Object.fromEntries((options.tasks ?? []).map((task) => [task.id, task]));
  const output = await renderToString(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        tasks: tasks as any,
        remoteBackgroundTaskCount: options.remoteBackgroundTaskCount ?? 0,
        workbench: {
          ...getDefaultAppState().workbench,
          selectedAgentTaskId: options.selectedAgentTaskId ?? null,
        },
      }}
      onChangeAppState={({ newState }) => changes.push(newState)}
    >
      <AgentsRail
        focused={options.focused ?? true}
        width={options.width ?? 40}
      />
    </AppStateProvider>,
    100,
  );

  return { output, changes };
}
