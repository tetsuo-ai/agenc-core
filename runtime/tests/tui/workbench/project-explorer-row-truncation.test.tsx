import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render the WORKSPACE project-tree pane and assert its rows do not pick up a
// spurious truncation ellipsis. Two regressions are guarded here:
//   1. Off-by-one row width — the container reserves paddingX(2) + borderRight(1)
//      = 3 columns of chrome, so a short filename row that obviously fits must
//      NOT be stamped with a trailing "…" by Ink's wrap="truncate-end".
//   2. Doubled ellipsis — a too-long filename must end in exactly ONE "…", not
//      the "..…" produced when a hardcoded "..." suffix collided with the
//      truncation marker.

const harness = vi.hoisted(() => {
  const state: { snapshot: Record<string, unknown>; store: Record<string, unknown> } = {
    snapshot: {},
    store: {},
  };
  state.store = {
    setActivePath: () => {},
    setAttachedPaths: () => {},
    setViewportRows: () => {},
    setInFlightPaths: () => {},
    move: () => {},
    movePage: () => {},
    moveToStart: () => {},
    moveToEnd: () => {},
    expand: () => {},
    collapse: () => {},
    reveal: () => {},
    toggle: () => {},
    getCursorRow: () => null,
    createFile: async () => ({ ok: true, path: "" }),
    renamePath: async () => ({ ok: true, path: "" }),
    deletePath: async () => ({ ok: true, path: "" }),
  };
  return state;
});

vi.mock("../../../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 120, rows: 24 }),
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: () => {},
}));

vi.mock("../../../src/tui/components/TextInput.js", async () => {
  const ReactModule = await import("react");
  return { default: () => ReactModule.createElement(ReactModule.Fragment) };
});

vi.mock("../../../src/tui/workbench/project-tree/useProjectTree.js", () => ({
  useProjectTree: () => harness.snapshot,
}));

vi.mock("../../../src/tui/workbench/project-tree/ProjectTreeStore.js", () => ({
  getProjectTreeStore: () => harness.store,
}));

vi.mock("../../../src/utils/log.js", () => ({ logError: () => {} }));

import { renderToString } from "../../../src/utils/staticRender.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { ProjectExplorer } from "../../../src/tui/workbench/project-tree/ProjectExplorer.js";

function fileRow(path: string, label: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: path,
    path,
    label,
    kind: "file",
    depth: 1,
    expanded: false,
    selected: false,
    focused: false,
    active: false,
    attached: false,
    searchHit: false,
    inFlight: false,
    ...overrides,
  };
}

async function renderTree(width: number): Promise<string[]> {
  const output = await renderToString(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        workbench: {
          ...getDefaultAppState().workbench,
          focusedPane: "explorer",
        },
      }}
    >
      <ProjectExplorer focused={false} width={width} />
    </AppStateProvider>,
    { columns: 200, rows: 24 },
  );
  return output.split("\n");
}

const previousGlyphMode = process.env.AGENC_TUI_GLYPHS;

describe("ProjectExplorer row truncation", () => {
  beforeEach(() => {
    // Force unicode glyphs so the ellipsis marker is the single-cell "…".
    delete process.env.AGENC_TUI_GLYPHS;
  });

  afterEach(() => {
    if (previousGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS;
    } else {
      process.env.AGENC_TUI_GLYPHS = previousGlyphMode;
    }
  });

  it("does not stamp a trailing ellipsis on short filename rows that fit", async () => {
    harness.snapshot = {
      cwd: "/repo",
      loading: false,
      error: null,
      cursorPath: null,
      activePath: null,
      expandedPaths: [],
      rows: [
        fileRow("LICENSE", "LICENSE"),
        fileRow("tsconfig.json", "tsconfig.json"),
      ],
    };

    const lines = await renderTree(40);
    const licenseLine = lines.find((line) => line.includes("LICENSE"));
    const tsconfigLine = lines.find((line) => line.includes("tsconfig.json"));

    expect(licenseLine).toBeDefined();
    expect(tsconfigLine).toBeDefined();
    // A name that clearly fits must render without any truncation marker.
    expect(licenseLine).not.toContain("…");
    expect(licenseLine).not.toContain("...");
    expect(tsconfigLine).not.toContain("…");
    expect(tsconfigLine).not.toContain("...");
  });

  it("truncates a long filename with exactly one ellipsis, never a doubled marker", async () => {
    const longLabel = ".typecheck-baseline-really-long-overflowing-filename.json";
    harness.snapshot = {
      cwd: "/repo",
      loading: false,
      error: null,
      cursorPath: null,
      activePath: null,
      expandedPaths: [],
      rows: [fileRow(longLabel, longLabel)],
    };

    const lines = await renderTree(28);
    const longLine = lines.find((line) => line.includes(".typecheck"));

    expect(longLine).toBeDefined();
    const line = longLine ?? "";
    // The name overflows, so it must be truncated — exactly one ellipsis.
    expect(line).toContain("…");
    expect((line.match(/…/gu) ?? []).length).toBe(1);
    // The doubled-ellipsis regression rendered "..…"; that must never appear.
    expect(line).not.toContain("..…");
    expect(line).not.toContain("...");
  });
});
