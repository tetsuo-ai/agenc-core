import React from "react";
import { describe, expect, it, vi } from "vitest";

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
import { AgentsRail } from "../../../src/tui/workbench/agents/AgentsRail.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("AgentsRail", () => {
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

  it("opens the running newest agent before older completed agents after stale selection", async () => {
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
      selectedAgentTaskId: "agent-new",
    });
  });
});
