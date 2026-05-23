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
import { AgentSurface, canEnterAgentTranscript } from "../../../src/tui/workbench/surfaces/AgentSurface.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("AgentSurface", () => {
  it("falls back to the running newest agent when the selected agent id is stale", async () => {
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

    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
            [oldAgent.id]: oldAgent,
            [newAgent.id]: newAgent,
          },
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "agent",
            selectedAgentTaskId: "agent-gone",
          },
        }}
      >
        <AgentSurface focused={true} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("AGENT - running - new running agent");
    expect(output).not.toContain("old completed agent");
  });

  it("opens in-process teammate transcripts from the agent surface", async () => {
    const changes: AppState[] = [];
    const teammateTask = {
      id: "teammate-1",
      type: "in_process_teammate",
      status: "running",
      description: "reviewing",
      startTime: 1_000,
      outputFile: "urn:agenc:task:teammate-1:output",
      outputOffset: 0,
      notified: false,
      identity: {
        agentId: "agent-1",
        agentName: "Reviewer",
        teamName: "audit",
      },
    } as any;

    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: { [teammateTask.id]: teammateTask },
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "agent",
            selectedAgentTaskId: teammateTask.id,
          },
        }}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <AgentSurface focused={true} />
      </AppStateProvider>,
      80,
    );

    expect(output).toContain("enter transcript");

    keybindingHarness.handlers["surface:open"]?.();

    expect(changes.at(-1)).toMatchObject({
      viewingAgentTaskId: teammateTask.id,
      viewSelectionMode: "viewing-agent",
    });
  });

  it("limits transcript entry to locally viewable agent task types", () => {
    expect(canEnterAgentTranscript({ id: "local", type: "local_agent" })).toBe(true);
    expect(canEnterAgentTranscript({ id: "team", type: "in_process_teammate" })).toBe(true);
    expect(canEnterAgentTranscript({ id: "remote", type: "remote_agent" })).toBe(false);
    expect(canEnterAgentTranscript({ type: "local_agent" })).toBe(false);
    expect(canEnterAgentTranscript(null)).toBe(false);
  });
});
