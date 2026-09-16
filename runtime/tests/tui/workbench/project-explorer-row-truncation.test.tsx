import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProjectTreeGitBranch,
  ProjectTreeSnapshot,
} from "../../../src/tui/workbench/types.js";
import { buildProjectTreeRows } from "../../../src/tui/workbench/project-tree/buildTree.js";

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
    getFilePaths: () => [],
    hasInFlightPathWithin: () => false,
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
  useInputCapture: () => {},
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

  it("labels the scroll overflow indicators with a position sense (N above / N below)", async () => {
    // useTerminalSize is mocked to 24 rows, so maxTreeRows = 24 - 8 = 16. A
    // longer list with a selection mid-window forces both an above- and a
    // below-overflow indicator. They now read "N above" / "N below" — a
    // position relative to each end — instead of the prior ambiguous "N more".
    // Revert-sensitive: restoring the "N more" wording fails the assertions.
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 40; i++) {
      rows.push(fileRow(`file-${i}.ts`, `file-${i}.ts`, { selected: i === 20 }));
    }
    harness.snapshot = {
      cwd: "/repo",
      loading: false,
      error: null,
      cursorPath: null,
      activePath: "file-20.ts",
      expandedPaths: [],
      rows,
    };

    const output = (await renderTree(40)).join("\n");

    expect(output).toMatch(/\d+ above/u);
    expect(output).toMatch(/\d+ below/u);
    // The old ambiguous "N more" wording must be gone.
    expect(output).not.toContain("more");
  });

  it("keeps the WORKSPACE header label whole when count metadata exactly fills the pane", async () => {
    harness.snapshot = {
      cwd: "/repo",
      loading: false,
      error: null,
      cursorPath: null,
      activePath: null,
      expandedPaths: [],
      fileCount: 380,
      git: { branch: "main", head: null, dirtyCount: 7 },
      rows: Array.from({ length: 7 }, (_, index) =>
        fileRow(`dirty-${index}.ts`, `dirty-${index}.ts`, {
          gitState: "modified",
        }),
      ),
    };

    const lines = await renderTree(26);
    const headerLine = lines.find((line) => line.includes("WORK"));

    expect(headerLine).toBeDefined();
    expect(headerLine).toContain("WORKSPACE");
    expect(headerLine).toContain("380 7 changed");
    expect(headerLine).not.toContain("WORKSPAC ");
  });
});

const paths = ["src/nested/first.ts", "src/nested/second.ts"];
const gitStatus = new Map([
  ["src/nested/first.ts", "modified" as const],
  ["src/nested/second.ts", "modified" as const],
]);
const dirtyGit: ProjectTreeGitBranch = {
  branch: "main",
  head: "abc1234",
  dirtyCount: 2,
};

function snapshot(
  expandedPaths: readonly string[],
  git: ProjectTreeGitBranch | null | undefined,
): ProjectTreeSnapshot {
  return {
    cwd: "/repo",
    loading: false,
    error: null,
    cursorPath: null,
    activePath: null,
    expandedPaths,
    fileCount: paths.length,
    directoryCount: 2,
    git,
    rows: buildProjectTreeRows({
      cwd: "/repo",
      paths,
      expandedPaths: new Set(expandedPaths),
      cursorPath: null,
      activePath: null,
      gitStatus,
    }),
  };
}

async function renderSnapshot(value: ProjectTreeSnapshot): Promise<string> {
  harness.snapshot = { ...value };
  return (await renderTree(50)).join("\n");
}

function header(output: string): string | undefined {
  return output.split("\n").find((line) => line.includes("WORKSPACE"));
}

describe("ProjectExplorer changed-file count", () => {
  it("keeps the header and branch footer in agreement while nested files are collapsed and expanded", async () => {
    const expandedPaths = ["src", "src/nested"];
    const expanded = await renderSnapshot(snapshot(expandedPaths, dirtyGit));
    const collapsed = await renderSnapshot(snapshot(["src"], dirtyGit));
    const reexpanded = await renderSnapshot(snapshot(expandedPaths, dirtyGit));

    expect(expanded).toContain("first.ts");
    expect(expanded).toContain("second.ts");
    expect(collapsed).not.toContain("first.ts");
    expect(collapsed).not.toContain("second.ts");
    expect(reexpanded).toContain("first.ts");
    for (const output of [expanded, collapsed, reexpanded]) {
      expect(header(output)).toMatch(/WORKSPACE\s+2 2 changed/u);
      expect(output).toMatch(/main\s+2\*/u);
    }
  });

  it.each([null, undefined])(
    "omits changed-file metadata when the Git snapshot is %s",
    async (git) => {
      const output = await renderSnapshot(snapshot(["src", "src/nested"], git));

      expect(header(output)).toMatch(/WORKSPACE\s+2/u);
      expect(header(output)).not.toContain("changed");
      expect(output).not.toContain("main");
      expect(output).not.toContain("2*");
    },
  );
});
