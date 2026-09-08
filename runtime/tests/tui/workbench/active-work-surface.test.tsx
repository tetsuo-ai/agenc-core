import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const activeSurfaceHarness = vi.hoisted(() => ({
  terminalUi: false,
  dirty: false,
  keybindingCalls: [] as Array<{
    handlers: Record<string, () => void>;
    options?: Record<string, unknown>;
  }>,
  renderCalls: [] as Array<{
    name: string;
    props: Record<string, unknown>;
  }>,
}));

vi.mock("../../../src/tui/workbench/buffer/providers/BufferProviderController.js", () => ({
  getWorkbenchBufferProviderController: () => ({
    getSnapshot: () => ({ dirty: activeSurfaceHarness.dirty }),
  }),
}));

vi.mock("../../../src/tui/workbench/buffer/useBufferStore.js", () => ({
  useBufferStore: () => ({
    filePath: "target.ts",
    provider: { capabilities: { terminalUi: activeSurfaceHarness.terminalUi } },
  }),
}));

function surfaceMock(
  name: string,
): (props: Record<string, unknown>) => React.ReactElement {
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
  AgentSurface: surfaceMock("task-detail"),
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
  TranscriptSurface: ({
    children,
    scrollRef,
  }: {
    readonly children: React.ReactNode;
    readonly scrollRef?: unknown;
  }) => {
    activeSurfaceHarness.renderCalls.push({
      name: "transcript",
      props: { scrollRef },
    });
    return React.createElement(React.Fragment, null, children);
  },
}));

import { Text } from "../../../src/tui/ink.js";
import {
  AppStateProvider,
  getDefaultAppState,
  type AppState,
} from "../../../src/tui/state/AppState.js";
import {
  ActiveWorkSurface,
  descriptorForSurface,
  footerHintsForSurface,
  WORKBENCH_SURFACES,
} from "../../../src/tui/workbench/surfaces/ActiveWorkSurface.js";
import type { ActiveSurfaceMode } from "../../../src/tui/workbench/types.js";
import { renderToString } from "../../../src/utils/staticRender.js";

beforeEach(() => {
  activeSurfaceHarness.terminalUi = false;
  activeSurfaceHarness.dirty = false;
  activeSurfaceHarness.keybindingCalls = [];
  activeSurfaceHarness.renderCalls = [];
});

describe("ActiveWorkSurface", () => {
  it.each([
    "transcript",
    "preview",
    "buffer",
    "diff",
    "shell",
    "test",
    "search",
    "task-detail",
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
          scrollRef={{ current: null }}
        />
      </AppStateProvider>,
      100,
    );

    expect(activeSurfaceHarness.renderCalls.at(-1)?.name).toBe(mode);
    if (mode === "transcript") {
      expect(activeSurfaceHarness.renderCalls.at(-1)?.props).toEqual({
        scrollRef: { current: null },
      });
    }
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

  it.each(["transcript", "preview", "diff", "shell", "test", "search", "task-detail"] as const)("closes %s through the parent surface close keybinding", async (mode) => {
    activeSurfaceHarness.keybindingCalls = [];
    const changes: AppState[] = [];

    await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: mode,
            focusedPane: "surface",
          },
        }}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <ActiveWorkSurface
          focused={true}
          transcript={<Text>transcript body</Text>}
        />
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
      focusedPane: "composer",
    });
  });

  it.each([
    [false, "Buffer", "buffer:close", false],
    [false, "Buffer", "buffer:closeDiscard", false],
    [true, "BufferHost", "buffer:close", false],
    [true, "BufferHost", "buffer:closeDiscard", false],
    [false, "Buffer", "buffer:close", true],
    [false, "Buffer", "buffer:closeDiscard", true],
    [true, "BufferHost", "buffer:close", true],
    [true, "BufferHost", "buffer:closeDiscard", true],
  ] as const)("owns buffer close with terminalUi=%s in %s for %s and dirty=%s", async (terminalUi, context, action, dirty) => {
    activeSurfaceHarness.keybindingCalls = [];
    activeSurfaceHarness.terminalUi = terminalUi;
    activeSurfaceHarness.dirty = dirty;
    const changes: AppState[] = [];
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
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <ActiveWorkSurface focused transcript={<Text>transcript</Text>} />
      </AppStateProvider>,
      100,
    );
    const owners = activeSurfaceHarness.keybindingCalls.filter(
      (call) => call.options?.isActive && call.handlers[action] !== undefined,
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]?.options?.context).toBe(context);
    owners[0]?.handlers[action]?.();
    expect(changes).toHaveLength(1);
    expect(changes[0]?.workbench.activeSurfaceMode).toBe(dirty ? "buffer" : "transcript");
    if (dirty) {
      expect(changes[0]?.workbench.pendingBlockedOverlay?.deferredCommand).toEqual({
        type: "closeSurface",
      });
    } else {
      expect(changes[0]?.workbench.pendingBlockedOverlay).toBeNull();
    }
  });

  it.each(["preview", "buffer"] as const)("does not register active close handlers for unfocused %s", async (mode) => {
    await renderToString(
      <AppStateProvider initialState={{
        ...getDefaultAppState(),
        workbench: { ...getDefaultAppState().workbench, activeSurfaceMode: mode },
      }}>
        <ActiveWorkSurface focused={false} transcript={<Text>transcript</Text>} />
      </AppStateProvider>,
      100,
    );
    expect(activeSurfaceHarness.keybindingCalls.every(
      (call) => call.options?.isActive === false,
    )).toBe(true);
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
        <ActiveWorkSurface
          focused={true}
          transcript={<Text>transcript body</Text>}
        />
      </AppStateProvider>,
      100,
    );

    expect(
      activeSurfaceHarness.keybindingCalls.find(
        (call) => call.options?.context === "Surface",
      )?.options,
    ).toMatchObject({
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
    expect(
      descriptorForSurface("preview").title({
        ...state,
        activeFilePath: "src/app.ts",
      }),
    ).toBe("src/app.ts");
    expect(
      descriptorForSurface("buffer").title({
        ...state,
        activeFilePath: "src/app.ts",
      }),
    ).toBe("src/app.ts");
    expect(descriptorForSurface("unknown" as ActiveSurfaceMode).mode).toBe(
      "transcript",
    );
    expect(footerHintsForSurface("unknown" as ActiveSurfaceMode)).toBe(
      WORKBENCH_SURFACES[0]?.footerHints,
    );
  });
});
