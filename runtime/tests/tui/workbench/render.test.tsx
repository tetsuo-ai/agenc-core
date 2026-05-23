import React from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: () => {},
}));

import { PromptOverlayProvider, useSetPromptOverlay, useSetPromptOverlayDialog } from "../../../src/tui/context/promptOverlayContext.js";
import { Text } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { ProjectExplorerRow, projectTreeViewport } from "../../../src/tui/workbench/project-tree/ProjectExplorer.js";
import { useWorkbenchComposerFocus } from "../../../src/tui/workbench/composerFocusContext.js";
import { WORKBENCH_SURFACES } from "../../../src/tui/workbench/surfaces/ActiveWorkSurface.js";
import { TranscriptSurface } from "../../../src/tui/workbench/surfaces/TranscriptSurface.js";
import { WorkbenchFooter } from "../../../src/tui/workbench/WorkbenchFooter.js";
import { layoutSizeForColumns, WorkbenchLayout } from "../../../src/tui/workbench/WorkbenchLayout.js";
import { renderToString } from "../../../src/utils/staticRender.js";

function SuggestionsWriter(): React.ReactNode {
  useSetPromptOverlay({
    suggestions: [
      {
        id: "command-help",
        displayText: "/help",
        description: "show commands",
      },
      {
        id: "command-status",
        displayText: "/status",
        description: "show status",
      },
    ],
    selectedSuggestion: 1,
    maxColumnWidth: 16,
    suggestionType: "command",
  });

  return <Text>composer body</Text>;
}

function DialogWriter(): React.ReactNode {
  useSetPromptOverlayDialog(<Text>floating dialog marker</Text>);
  return <Text>composer body</Text>;
}

function ComposerFocusProbe(): React.ReactNode {
  const active = useWorkbenchComposerFocus();
  return <Text>{active ? "composer-active" : "composer-inactive"}</Text>;
}

describe("workbench render contract", () => {
  it.each([28, 30, 44])("renders explorer rows within %i columns", async (width) => {
    const output = await renderToString(
      <ProjectExplorerRow
        width={width}
        row={{
          id: "src/components/really-long-file-name.tsx",
          path: "src/components/really-long-file-name.tsx",
          label: "really-long-file-name.tsx",
          kind: "file",
          depth: 2,
          expanded: false,
          selected: true,
          focused: width !== 30,
          active: true,
          attached: true,
          searchHit: true,
          inFlight: true,
          gitState: "modified",
          ancestorLast: [false],
          isLast: true,
          hasChildren: false,
        }}
      />,
      width,
    );

    for (const line of output.split(/\r?\n/u)) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
    expect(output).toContain("@");
    expect(output).toContain("~");
  });

  it("renders deep explorer rows without connector rails that imply offscreen parents", async () => {
    const output = await renderToString(
      <ProjectExplorerRow
        width={32}
        row={{
          id: "runtime/src",
          path: "runtime/src",
          label: "src",
          kind: "directory",
          depth: 2,
          expanded: true,
          selected: false,
          focused: false,
          active: false,
          attached: false,
          searchHit: false,
          inFlight: false,
          ancestorLast: [false],
          isLast: true,
          hasChildren: true,
        }}
      />,
      32,
    );

    expect(output).toContain("src");
    expect(output).not.toContain("│");
    expect(output).not.toContain("├");
    expect(output).not.toContain("└");
  });

  it("keeps the selected explorer row inside the viewport", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      id: `file-${index}`,
      path: `file-${index}.ts`,
      label: `file-${index}.ts`,
      kind: "file" as const,
      depth: 1,
      expanded: false,
      selected: index === 15,
      focused: index === 15,
      active: false,
      attached: false,
      searchHit: false,
      inFlight: false,
    }));

    const viewport = projectTreeViewport(rows, 6);

    expect(viewport.rows.some((row) => row.selected)).toBe(true);
    expect(viewport.above).toBeGreaterThan(0);
    expect(viewport.below).toBeGreaterThan(0);
  });

  it("keeps expanded explorer rows in source order while clipping deep trees", () => {
    const rows = [
      row("", "agenc-core", "root", 0),
      row(".githooks", ".githooks", "directory", 1),
      row("docs", "docs", "directory", 1),
      row("packages", "packages", "directory", 1),
      row("packaging", "packaging", "directory", 1),
      row("runtime", "runtime", "directory", 1),
      row("runtime/scripts", "scripts", "directory", 2),
      row("runtime/src", "src", "directory", 2, true),
      row("runtime/src/agents", "agents", "directory", 3),
      row("runtime/src/auth", "auth", "directory", 3),
      row("runtime/src/bin", "bin", "directory", 3),
      row("runtime/src/bootstrap.ts", "bootstrap.ts", "file", 3),
      row("runtime/src/build", "build", "directory", 3),
    ];

    const viewport = projectTreeViewport(rows, 10);
    const paths = viewport.rows.map((item) => item.path);

    expect(paths).toEqual(rows.slice(0, 10).map((item) => item.path));
    expect(paths).toContain("runtime/src");
    expect(viewport.below).toBeGreaterThan(0);
  });

  it("keeps the selected explorer row inside a contiguous viewport", () => {
    const rows = [
      row("", "agenc-core", "root", 0),
      row("runtime", "runtime", "directory", 1),
      row("runtime/src", "src", "directory", 2),
      ...Array.from({ length: 18 }, (_, index) =>
        row(`runtime/src/child-${index}`, `child-${index}`, "directory", 3, index === 10),
      ),
    ];

    const viewport = projectTreeViewport(rows, 6);
    const paths = viewport.rows.map((item) => item.path);
    const indexes = viewport.rows.map((item) => rows.findIndex((row) => row.path === item.path));

    expect(paths).toContain("runtime/src/child-10");
    expect(indexes).toEqual([10, 11, 12, 13, 14, 15]);
    expect(viewport.above).toBe(10);
    expect(viewport.below).toBeGreaterThan(0);
  });

  it("changes footer hints and displays composer attachment context", async () => {
    const state = {
      ...getDefaultAppState(),
      workbench: {
        ...getDefaultAppState().workbench,
        focusedPane: "surface" as const,
        activeSurfaceMode: "preview" as const,
        attachments: [{
          id: "file:src/app.ts",
          kind: "file" as const,
          label: "src/app.ts",
          path: "src/app.ts",
        }],
        composerAttachmentIds: ["file:src/app.ts"],
      },
    };

    const output = await renderToString(
      <AppStateProvider initialState={state}>
        <WorkbenchFooter />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("Preview:");
    expect(output).toContain("context src/app.ts");
  });

  it.each([
    [148, "wide"],
    [120, "medium"],
    [80, "narrow"],
  ] as const)("classifies %i columns as %s layout", (columns, size) => {
    expect(layoutSizeForColumns(columns)).toBe(size);
  });

  it("keeps transcript content inside the active work surface", async () => {
    const output = await renderToString(
      <TranscriptSurface>
        <Text>hello transcript</Text>
      </TranscriptSurface>,
      { columns: 120, rows: 30 },
    );

    expect(output).toContain("TRANSCRIPT");
    expect(output).toContain("hello transcript");
  });

  it("renders fullscreen slash-command suggestions from the composer overlay portal", async () => {
    const output = await renderToString(
      <PromptOverlayProvider>
        <AppStateProvider initialState={getDefaultAppState()}>
          <WorkbenchLayout
            transcript={<Text>scroll body</Text>}
            composer={<SuggestionsWriter />}
          />
        </AppStateProvider>
      </PromptOverlayProvider>,
      { columns: 120, rows: 30 },
    );
    const compactOutput = output.replace(/\s+/gu, "");

    expect(compactOutput).toContain("SLASHCOMMANDS");
    expect(compactOutput).toContain("/statusshowstatus");
  });

  it("renders prompt dialogs over the workbench surface", async () => {
    const output = await renderToString(
      <PromptOverlayProvider>
        <AppStateProvider initialState={getDefaultAppState()}>
          <WorkbenchLayout
            transcript={<Text>scroll body</Text>}
            composer={<DialogWriter />}
          />
        </AppStateProvider>
      </PromptOverlayProvider>,
      { columns: 120, rows: 30 },
    );

    expect(output.replace(/\s+/gu, "")).toContain("dialogmarker");
  });

  it("exposes composer focus only when the workbench composer pane is focused", async () => {
    const inactiveOutput = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          workbench: {
            ...getDefaultAppState().workbench,
            focusedPane: "surface",
          },
        }}
      >
        <WorkbenchLayout transcript={<Text>scroll body</Text>} composer={<ComposerFocusProbe />} />
      </AppStateProvider>,
      { columns: 120, rows: 30 },
    );

    const activeOutput = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          workbench: {
            ...getDefaultAppState().workbench,
            focusedPane: "composer",
          },
        }}
      >
        <WorkbenchLayout transcript={<Text>scroll body</Text>} composer={<ComposerFocusProbe />} />
      </AppStateProvider>,
      { columns: 120, rows: 30 },
    );

    expect(inactiveOutput).toContain("composer-inactive");
    expect(activeOutput).toContain("composer-active");
  });

  it("defines the surface descriptor contract for every live workbench surface", () => {
    expect(WORKBENCH_SURFACES.map((surface) => surface.mode)).toEqual([
      "transcript",
      "preview",
      "buffer",
      "diff",
      "shell",
      "test",
      "search",
      "agent",
    ]);
    for (const surface of WORKBENCH_SURFACES) {
      expect(surface.footerHints.length).toBeGreaterThan(0);
      expect(surface.keybindings.length).toBeGreaterThan(0);
      expect(typeof surface.renderBody).toBe("function");
    }
  });

  it("keeps deprecated project-tree render code out of FullscreenLayout", () => {
    const source = readFileSync("src/tui/components/FullscreenLayout.tsx", "utf8");

    expect(source).not.toMatch(/readdirSync|getWorkspaceFileTreeRows|WorkspaceFileTreeGutter/u);
  });
});

function row(
  path: string,
  label: string,
  kind: "root" | "directory" | "file",
  depth: number,
  selected = false,
) {
  return {
    id: path || "root",
    path,
    label,
    kind,
    depth,
    expanded: kind !== "file",
    selected,
    focused: selected,
    active: false,
    attached: false,
    searchHit: false,
    inFlight: false,
  };
}
