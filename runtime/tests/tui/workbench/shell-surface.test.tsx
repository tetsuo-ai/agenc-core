import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/utils/fsOperations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/utils/fsOperations.js")>()),
  tailFile: vi.fn(async () => ({ content: "" })),
}));

vi.mock("../../../src/utils/task/diskOutput.js", () => ({
  getTaskOutputPath: (taskId: string) => `/tmp/${taskId}.log`,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: () => {},
}));

import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { ShellSurface } from "../../../src/tui/workbench/surfaces/ShellSurface.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("ShellSurface", () => {
  it("ignores stale selected ids that point at non-shell tasks", async () => {
    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
            "agent-1": {
              id: "agent-1",
              type: "local_agent",
              status: "running",
              description: "agent work",
              startTime: 1_000,
              outputFile: "urn:agenc:task:agent-1:output",
              outputOffset: 0,
              notified: false,
            } as any,
            "shell-1": {
              id: "shell-1",
              type: "local_bash",
              status: "completed",
              description: "npm test",
              command: "npm test",
              startTime: 1_000,
              outputFile: "urn:agenc:task:shell-1:output",
              outputOffset: 0,
              notified: false,
            } as any,
          },
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "shell",
            selectedShellTaskId: "agent-1",
          },
        }}
      >
        <ShellSurface focused={true} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("SHELL - completed - npm test");
    expect(output).not.toContain("agent work");
  });

  it("shows an empty shell state instead of rendering a selected agent task", async () => {
    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
            "agent-1": {
              id: "agent-1",
              type: "local_agent",
              status: "running",
              description: "agent work",
              startTime: 1_000,
              outputFile: "urn:agenc:task:agent-1:output",
              outputOffset: 0,
              notified: false,
            } as any,
          },
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "shell",
            selectedShellTaskId: "agent-1",
          },
        }}
      >
        <ShellSurface focused={true} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("No shell task selected");
    expect(output).not.toContain("agent work");
  });
});
