import React from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  ProjectTreeGitBranch,
  ProjectTreeSnapshot,
} from "../../../../src/tui/workbench/types.js";

const harness = vi.hoisted(() => ({
  snapshot: null as ProjectTreeSnapshot | null,
  store: {
    setActivePath: () => {},
    setAttachedPaths: () => {},
    setViewportRows: () => {},
    setInFlightPaths: () => {},
    getFilePaths: () => [],
  },
}));

vi.mock("../../../../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 120, rows: 24 }),
}));

vi.mock("../../../../src/tui/keybindings/useKeybinding.js", () => ({
  useInputCapture: () => {},
  useKeybinding: () => {},
  useKeybindings: () => {},
}));

vi.mock("../../../../src/tui/components/TextInput.js", async () => {
  const ReactModule = await import("react");
  return { default: () => ReactModule.createElement(ReactModule.Fragment) };
});

vi.mock("../../../../src/tui/workbench/project-tree/useProjectTree.js", () => ({
  useProjectTree: () => harness.snapshot,
}));

vi.mock("../../../../src/tui/workbench/project-tree/ProjectTreeStore.js", () => ({
  getProjectTreeStore: () => harness.store,
}));

import {
  AppStateProvider,
  getDefaultAppState,
} from "../../../../src/tui/state/AppState.js";
import { buildProjectTreeRows } from "../../../../src/tui/workbench/project-tree/buildTree.js";
import { ProjectExplorer } from "../../../../src/tui/workbench/project-tree/ProjectExplorer.js";
import { renderToString } from "../../../../src/utils/staticRender.js";

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
  harness.snapshot = value;
  return renderToString(
    <AppStateProvider initialState={getDefaultAppState()}>
      <ProjectExplorer focused={false} width={50} />
    </AppStateProvider>,
    { columns: 120, rows: 24 },
  );
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
