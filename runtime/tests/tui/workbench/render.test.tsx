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
import { ProjectExplorerRow } from "../../../src/tui/workbench/project-tree/ProjectExplorer.js";
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

  it("defines the surface descriptor contract for every live workbench surface", () => {
    expect(WORKBENCH_SURFACES.map((surface) => surface.mode)).toEqual([
      "transcript",
      "preview",
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
