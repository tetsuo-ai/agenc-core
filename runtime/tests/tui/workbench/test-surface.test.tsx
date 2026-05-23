import React from "react";
import { describe, expect, it, vi } from "vitest";

const keybindingHarness = vi.hoisted(() => ({
  handlers: {} as Record<string, () => void>,
}));

vi.mock("../../../src/utils/fsOperations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/utils/fsOperations.js")>()),
  tailFile: vi.fn(async () => ({
    content: [
      "FAIL first failure",
      "src/first.ts:4:1",
      "first message",
      "FAIL second failure",
      "src/second.ts:9:1",
      "second message",
    ].join("\n"),
  })),
}));

vi.mock("../../../src/utils/task/diskOutput.js", () => ({
  getTaskOutputPath: (taskId: string) => `/tmp/${taskId}.log`,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => void>) => {
    keybindingHarness.handlers = handlers;
  },
}));

import { AppStateProvider, getDefaultAppState, type AppState } from "../../../src/tui/state/AppState.js";
import { TestSurface, TestSurfaceView } from "../../../src/tui/workbench/surfaces/TestSurface.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("TestSurface", () => {
  it("clamps stale selection to the last parsed failure", async () => {
    const output = await renderToString(
      <TestSurfaceView
        failures={[
          {
            id: "first",
            name: "first failure",
            location: { file: "src/first.ts", line: 4 },
            message: "first message",
          },
          {
            id: "second",
            name: "second failure",
            location: { file: "src/second.ts", line: 9 },
            message: "second message",
          },
        ]}
        selected={99}
        focused={true}
      />,
      80,
    );

    expect(output).toContain("second failure");
    expect(output).toContain("second message");
  });

  it("keeps top navigation separate from opening the selected failure", async () => {
    const changes: AppState[] = [];
    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
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
            activeSurfaceMode: "test",
            selectedShellTaskId: "shell-1",
          },
        }}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <TestSurface focused={true} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("first failure");

    keybindingHarness.handlers["surface:top"]?.();

    expect(changes).toHaveLength(0);

    keybindingHarness.handlers["surface:open"]?.();

    expect(changes.at(-1)?.workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      activeFilePath: "src/first.ts",
      activeFileLine: 4,
      focusedPane: "surface",
    });
  });
});
