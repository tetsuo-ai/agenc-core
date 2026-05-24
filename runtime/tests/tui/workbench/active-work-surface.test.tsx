import React from "react";
import { describe, expect, it, vi } from "vitest";

const activeSurfaceHarness = vi.hoisted(() => ({
  keybindingCalls: [] as Array<{
    handlers: Record<string, () => void>;
    options?: Record<string, unknown>;
  }>,
  renderCalls: [] as Array<{
    name: string;
    props: Record<string, unknown>;
  }>,
}));

function surfaceMock(name: string): (props: Record<string, unknown>) => React.ReactElement {
  return (props) => {
    activeSurfaceHarness.renderCalls.push({ name, props });
    return React.createElement(React.Fragment);
  };
}

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (
    handlers: Record<string, () => void>,
    options?: Record<string, unknown>,
  ) => {
    activeSurfaceHarness.keybindingCalls.push({ handlers, options });
  },
}));

vi.mock("../../../src/tui/workbench/surfaces/AgentSurface.js", () => ({
  AgentSurface: surfaceMock("agent"),
}));

vi.mock("../../../src/tui/workbench/surfaces/BufferSurface.js", () => ({
  BufferSurface: surfaceMock("buffer"),
}));

vi.mock("../../../src/tui/workbench/surfaces/DiffSurface.js", () => ({
  DiffSurface: surfaceMock("diff"),
}));

vi.mock("../../../src/tui/workbench/surfaces/PreviewSurface.js", () => ({
  PreviewSurface: surfaceMock("preview"),
}));

vi.mock("../../../src/tui/workbench/surfaces/SearchSurface.js", () => ({
  SearchSurface: surfaceMock("search"),
}));

vi.mock("../../../src/tui/workbench/surfaces/ShellSurface.js", () => ({
  ShellSurface: surfaceMock("shell"),
}));

vi.mock("../../../src/tui/workbench/surfaces/TestSurface.js", () => ({
  TestSurface: surfaceMock("test"),
}));

vi.mock("../../../src/tui/workbench/surfaces/TranscriptSurface.js", () => ({
  TranscriptSurface: ({ children }: { readonly children: React.ReactNode }) => {
    activeSurfaceHarness.renderCalls.push({ name: "transcript", props: {} });
    return React.createElement(React.Fragment, null, children);
  },
}));

import { Text } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState, type AppState } from "../../../src/tui/state/AppState.js";
import {
  ActiveWorkSurface,
  descriptorForSurface,
  footerHintsForSurface,
  WORKBENCH_SURFACES,
} from "../../../src/tui/workbench/surfaces/ActiveWorkSurface.js";
import type { ActiveSurfaceMode } from "../../../src/tui/workbench/types.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("ActiveWorkSurface", () => {
  it.each([
    "transcript",
    "preview",
    "buffer",
    "diff",
    "shell",
    "test",
    "search",
    "agent",
  ] as const)("routes %s mode to its surface renderer", async (mode) => {
    activeSurfaceHarness.keybindingCalls = [];
    activeSurfaceHarness.renderCalls = [];
    const pendingApproval = { id: "approval-1" };

    await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: mode,
            activeFilePath: "src/app.ts",
          },
        }}
      >
        <ActiveWorkSurface
          focused={true}
          transcript={<Text>transcript body</Text>}
          pendingApproval={pendingApproval as never}
        />
      </AppStateProvider>,
      100,
    );

    expect(activeSurfaceHarness.renderCalls.at(-1)?.name).toBe(mode);
    if (mode !== "transcript") {
      expect(activeSurfaceHarness.renderCalls.at(-1)?.props).toMatchObject({
        focused: true,
      });
    }
    if (mode === "diff") {
      expect(activeSurfaceHarness.renderCalls.at(-1)?.props).toMatchObject({
        pendingApproval,
      });
    }
  });

  it("closes non-buffer surfaces through the surface close keybinding", async () => {
    activeSurfaceHarness.keybindingCalls = [];
    const changes: AppState[] = [];

    await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "preview",
            focusedPane: "surface",
          },
        }}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <ActiveWorkSurface focused={true} transcript={<Text>transcript body</Text>} />
      </AppStateProvider>,
      100,
    );

    const surfaceKeybindings = activeSurfaceHarness.keybindingCalls.find(
      (call) => call.options?.context === "Surface",
    );

    expect(surfaceKeybindings?.options).toMatchObject({
      context: "Surface",
      isActive: true,
    });

    surfaceKeybindings?.handlers["workbench:closeSurface"]?.();

    expect(changes.at(-1)?.workbench).toMatchObject({
      activeSurfaceMode: "transcript",
      focusedPane: "surface",
    });
  });

  it("leaves parent surface close keybindings inactive for buffer mode", async () => {
    activeSurfaceHarness.keybindingCalls = [];

    await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "buffer",
            focusedPane: "surface",
          },
        }}
      >
        <ActiveWorkSurface focused={true} transcript={<Text>transcript body</Text>} />
      </AppStateProvider>,
      100,
    );

    expect(activeSurfaceHarness.keybindingCalls.find(
      (call) => call.options?.context === "Surface",
    )?.options).toMatchObject({
      context: "Surface",
      isActive: false,
    });
  });

  it("keeps descriptor titles and fallback surface routing explicit", () => {
    const state = getDefaultAppState().workbench;

    expect(WORKBENCH_SURFACES.map((surface) => surface.title(state))).toEqual([
      "TRANSCRIPT",
      "PREVIEW",
      "BUFFER",
      "DIFF",
      "SHELL",
      "TEST",
      "SEARCH",
      "AGENT",
    ]);
    expect(descriptorForSurface("preview").title({
      ...state,
      activeFilePath: "src/app.ts",
    })).toBe("src/app.ts");
    expect(descriptorForSurface("buffer").title({
      ...state,
      activeFilePath: "src/app.ts",
    })).toBe("src/app.ts");
    expect(descriptorForSurface("unknown" as ActiveSurfaceMode).mode).toBe("transcript");
    expect(footerHintsForSurface("unknown" as ActiveSurfaceMode)).toBe(WORKBENCH_SURFACES[0]?.footerHints);
  });
});
