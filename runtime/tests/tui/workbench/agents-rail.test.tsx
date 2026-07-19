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

import { AppStateProvider, getDefaultAppState, type AppState } from "../../../src/tui/state/AppState.js";
import { syncCollabAgentEventToAppState } from "../../../src/tui/state/collabAgentTaskSync.js";
import { AgentsRail } from "../../../src/tui/workbench/agents/AgentsRail.js";
import { renderToAnsiString, renderToString } from "../../../src/utils/staticRender.js";
import { ThemeProvider } from "../../../src/tui/components/design-system/ThemeProvider.js";
import { getTheme } from "../../../src/utils/theme.js";

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

    expect(remoteOnly.output).toContain("remote tasks: 3");
    expect(remoteOnly.output).not.toContain("No background agents");
    expect(emptyFocusedOut.output).toContain("No background agents");
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
      activeSurfaceMode: "agent",
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

    expect(output).toContain("No background agents");
  });

  it("renders active/background rows, row badges, and resilient empty text fallbacks", async () => {
    const output = (await renderAgentsRail({
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
    })).output;

    expect(output).toContain("─ Agent Swarm ─");
    // Numbered swarm rows with per-agent status glyphs and stats (Kimi-style
    // fan-out view for 2+ agents).
    expect(output).toContain("001");
    expect(output).toContain("002");
    expect(output).toContain("unknown");
    expect(output).toContain("✗");
    expect(output).toContain("✓");
    expect(output).toContain("pending agent");
    expect(output).toContain("edit");
    expect(output).toContain("2 tools · 120 tok");
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
    const output = (await renderAgentsRail({
      tasks: [railTask],
      selectedAgentTaskId: "fleet-agent",
      width: 90,
    })).output;

    // The exact bug was a frozen `tools 0 tokens 0`; the rail must now show the
    // real values plumbed through the daemon collab status event.
    expect(output).toContain("tools 9 tokens 73210");
    expect(output).not.toContain("tools 0 tokens 0");
  });

  it("does not advertise stop shortcuts for stale task kinds without a stop action", async () => {
    // "remote_agent" was deleted as an unshipped scaffold; a stale record with
    // that kind must render view-only instead of advertising a fake stop.
    const output = (await renderAgentsRail({
      tasks: [{
        ...agentTask("stale-running", "running", {
          description: "stale running",
        }),
        type: "remote_agent",
      }],
    })).output;

    expect(output).toContain("* stale running");
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
      activeSurfaceMode: "agent",
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
      activeSurfaceMode: "agent",
      focusedPane: "surface",
      selectedAgentTaskId: "agent-old",
    });
  });
});

describe("AgentsRail lifecycle legibility (color + friendly label)", () => {
  // Dark is the default render theme (ThemeProvider DEFAULT_THEME); pin it
  // explicitly so the asserted SGR codes never drift with user settings.
  const theme = getTheme("dark");

  // Truecolor foreground SGR for a theme rgb() token, matching what chalk emits
  // at level 3 (renderToAnsiString({ color: true })).
  function fgSgr(rgb: string): string {
    const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(rgb.replaceAll(" ", ""));
    if (m === null) throw new Error(`not an rgb token: ${rgb}`);
    return `[38;2;${m[1]};${m[2]};${m[3]}m`;
  }

  const RUNNING_SGR = fgSgr(theme.worker);
  const COMPLETED_SGR = fgSgr(theme.success);
  const FAILED_SGR = fgSgr(theme.error);
  const KILLED_SGR = fgSgr(theme.muted3);
  const APPROVAL_SGR = fgSgr(theme.warning);

  async function renderRailAnsi(tasks: readonly any[]): Promise<string> {
    return renderToAnsiString(
      <ThemeProvider initialState="dark">
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
            remoteBackgroundTaskCount: 0,
            workbench: {
              ...getDefaultAppState().workbench,
              selectedAgentTaskId: null,
            },
          }}
        >
          <AgentsRail focused={true} width={48} />
        </AppStateProvider>
      </ThemeProvider>,
      { columns: 60, rows: 24, color: true },
    );
  }

  it("color-codes completed vs failed vs running markers distinctly", async () => {
    const out = await renderRailAnsi([
      agentTask("agent-run", "running", { description: "scanning", startTime: 3_000 }),
      agentTask("agent-ok", "completed", { description: "wrote tests", startTime: 2_000 }),
      agentTask("agent-bad", "failed", { description: "crashed", startTime: 1_000 }),
    ]);

    // Each lifecycle state surfaces its own semantic color on the marker.
    expect(out).toContain(RUNNING_SGR);
    expect(out).toContain(COMPLETED_SGR);
    expect(out).toContain(FAILED_SGR);
    // The three colors are genuinely different (legibility at a glance).
    expect(new Set([RUNNING_SGR, COMPLETED_SGR, FAILED_SGR]).size).toBe(3);
  });

  it("colors a stopped agent in the muted/grey state and a needs-approval agent in the warning accent", async () => {
    const killed = await renderRailAnsi([
      agentTask("agent-killed", "killed", { description: "stopped", startTime: 1_000 }),
    ]);
    expect(killed).toContain(KILLED_SGR);

    const approval = await renderRailAnsi([
      agentTask("agent-wait", "running", {
        description: "awaiting decision",
        pendingApproval: true,
        startTime: 1_000,
      }),
    ]);
    // Needs-input/approval overrides the run color with the warning accent so
    // "needs you" stands out from a plain working agent.
    expect(approval).toContain(APPROVAL_SGR);
    expect(approval).not.toContain(RUNNING_SGR);
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

function agentTask(id: string, status: string, overrides: Record<string, unknown> = {}): any {
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

async function renderAgentsRail(options: {
  readonly tasks?: readonly any[];
  readonly rawTasks?: Record<string, any> | undefined;
  readonly selectedAgentTaskId?: string | null;
  readonly remoteBackgroundTaskCount?: number;
  readonly focused?: boolean;
  readonly width?: number;
} = {}): Promise<{
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
      <AgentsRail focused={options.focused ?? true} width={options.width ?? 40} />
    </AppStateProvider>,
    100,
  );

  return { output, changes };
}
