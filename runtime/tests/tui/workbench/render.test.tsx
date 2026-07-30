import React from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const projectExplorerHarness = vi.hoisted(() => ({
  textInputProps: [] as Array<Record<string, unknown>>,
  keybindingCalls: [] as Array<{
    handlers: Record<string, () => void>;
    options?: Record<string, unknown>;
  }>,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useInputCapture: () => {},
  useKeybinding: () => {},
  useKeybindings: (
    handlers: Record<string, () => void>,
    options?: Record<string, unknown>,
  ) => {
    projectExplorerHarness.keybindingCalls.push({ handlers, options });
  },
}));

vi.mock("../../../src/tui/components/TextInput.js", async () => {
  const ReactModule = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      projectExplorerHarness.textInputProps.push(props);
      return ReactModule.createElement(ReactModule.Fragment);
    },
  };
});

import {
  PromptOverlayProvider,
  useSetPromptOverlay,
  useSetPromptOverlayDialog,
} from "../../../src/tui/context/promptOverlayContext.js";
import { useContentWidth } from "../../../src/tui/context/contentWidthContext.js";
import { Box, Text } from "../../../src/tui/ink.js";
import type { ScrollBoxHandle } from "../../../src/tui/ink/components/ScrollBox.js";
import {
  AGENC_LOGO_MARK_COMPACT_LINES,
  WelcomeColdPanel,
} from "../../../src/tui/components/v2/primitives.js";
import {
  AppStateProvider,
  getDefaultAppState,
} from "../../../src/tui/state/AppState.js";
import {
  ProjectExplorerRow,
  ProjectFileActionPrompt,
  projectTreeViewport,
} from "../../../src/tui/workbench/project-tree/ProjectExplorer.js";
import { useWorkbenchComposerFocus } from "../../../src/tui/workbench/composerFocusContext.js";
import { WORKBENCH_SURFACES } from "../../../src/tui/workbench/surfaces/ActiveWorkSurface.js";
import { TranscriptSurface } from "../../../src/tui/workbench/surfaces/TranscriptSurface.js";
import { WorkbenchFooter } from "../../../src/tui/workbench/WorkbenchFooter.js";
import { WorkbenchStatusBar } from "../../../src/tui/workbench/WorkbenchStatusBar.js";
import {
  layoutSizeForColumns,
  WorkbenchLayout,
} from "../../../src/tui/workbench/WorkbenchLayout.js";
import {
  clearEditorProposalRecords,
  stageEditorProposalRecord,
} from "../../../src/tui/workbench/editorProposalStore.js";
import { workbenchReducer } from "../../../src/tui/workbench/reducer.js";
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

function ManySuggestionsWriter(): React.ReactNode {
  useSetPromptOverlay({
    suggestions: Array.from({ length: 10 }, (_, index) => ({
      id: `command-${index}`,
      displayText: `/command-${index}`,
      description: `run command ${index}`,
    })),
    selectedSuggestion: 8,
    maxColumnWidth: 18,
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

function ComposerWidthProbe(): React.ReactNode {
  const width = useContentWidth();
  return <Text>{`composer-width:${width ?? "none"}`}</Text>;
}

describe("workbench render contract", () => {
  it.each([28, 30, 44])(
    "renders explorer rows within %i columns",
    async (width) => {
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
    },
  );

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

  it.each([
    ["modified", "M"],
    ["added", "A"],
    ["deleted", "D"],
    ["renamed", "R"],
    ["unmerged", "U"],
    ["untracked", "new"],
    ["ignored", "!"],
  ] as const)(
    "renders explorer git state %s with its badge",
    async (gitState, marker) => {
      const output = await renderToString(
        <ProjectExplorerRow
          width={18}
          row={{
            ...row(`src/${gitState}.ts`, "clean", "file", 1),
            gitState,
          }}
        />,
        18,
      );

      expect(output).toContain(marker);
      expect(output).toContain("clean");
    },
  );

  it("keeps file-state badges beside the filename instead of pinning them to the pane edge", async () => {
    const output = await renderToString(
      <ProjectExplorerRow
        width={32}
        row={{
          ...row("src/game.cpp", "game.cpp", "file", 1),
          gitState: "untracked",
        }}
      />,
      32,
    );

    const rowLine = output
      .split(/\r?\n/u)
      .find((line) => line.includes("game.cpp"));
    expect(rowLine).toBeDefined();
    expect(rowLine).toMatch(/game\.cpp {2}new/u);
    expect(rowLine).not.toMatch(/game\.cpp {3,}new/u);
  });

  it("renders the empty-workspace row without the '!' error marker", async () => {
    // An empty workspace on cold start is a normal state, so its row must NOT
    // carry the "!" glyph the tree reserves for genuine errors — that would make
    // a fresh project look broken on first impression. Revert-sensitive:
    // restoring kind:"error" on the empty row re-introduces the "!" and fails
    // the negative assertion.
    const output = await renderToString(
      <ProjectExplorerRow
        width={48}
        row={{
          ...row("", "No files yet", "file", 1),
          id: "loading-empty",
          kind: "empty" as never,
        }}
      />,
      48,
    );

    expect(output).toContain("No files yet");
    // The label intentionally contains no "!" so any "!" must be the marker.
    expect(output).not.toContain("!");
  });

  it("renders the empty-workspace label whole in the narrow column (no mid-word truncation)", async () => {
    // BUG A regression: in production the empty row renders at depth:1 (4-space
    // indent) in the narrow WORKSPACE column (ProjectExplorer passes width-3,
    // ~17-22 cols, truncate-end). The old long copy "No files yet — describe a
    // task to get started" chopped to "No files yet — de…" — a dangling em-dash
    // + half-word that reads as a glitch. The short label must render whole with
    // NO trailing ellipsis at a realistic column width.
    const output = await renderToString(
      <ProjectExplorerRow
        width={20}
        row={{
          ...row("", "No files yet", "file", 1),
          id: "loading-empty",
          kind: "empty" as never,
        }}
      />,
      20,
    );

    // Full label present, intact.
    expect(output).toContain("No files yet");
    // No ellipsis glyph (unicode "…" or ASCII "...") — the label was not chopped.
    // Revert-sensitivity: the old 47-col label overflows width=20 and trim()
    // appends the ellipsis, so both assertions fail against the long string.
    expect(output).not.toContain("…");
    expect(output).not.toContain("...");
    // And no severed em-dash tail from the old copy.
    expect(output).not.toContain("—");
  });

  it("renders loading rows, active rows, and one-column label trims", async () => {
    const loadingOutput = await renderToString(
      <ProjectExplorerRow
        width={12}
        row={{
          ...row("loading", "loading", "file", 0),
          kind: "loading" as never,
        }}
      />,
      12,
    );
    const activeOutput = await renderToString(
      <ProjectExplorerRow
        width={12}
        row={{
          ...row("src/active.ts", "active", "file", 0),
          active: true,
        }}
      />,
      12,
    );
    const narrowOutput = await renderToString(
      <ProjectExplorerRow
        width={1}
        row={row("src/abcdef.ts", "abcdef", "file", 0)}
      />,
      8,
    );

    expect(loadingOutput).toContain("loading");
    expect(activeOutput).toContain("active");
    expect(narrowOutput).toContain("a");
  });

  it("renders collapsed root rows", async () => {
    const output = await renderToString(
      <ProjectExplorerRow
        width={18}
        row={{
          ...row("", "agenc-core", "root", 0),
          expanded: false,
        }}
      />,
      18,
    );

    expect(output).toContain("agenc-core");
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

  it("falls back to the first explorer row when no row is selected", () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      row(`file-${index}.ts`, `file-${index}.ts`, "file", 1),
    );

    const viewport = projectTreeViewport(rows, 3);

    expect(viewport.rows.map((item) => item.path)).toEqual([
      "file-0.ts",
      "file-1.ts",
      "file-2.ts",
    ]);
    expect(viewport.above).toBe(0);
    expect(viewport.below).toBe(5);
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

  it("wires cursor state into explorer add and rename prompts", async () => {
    projectExplorerHarness.textInputProps = [];

    await renderToString(
      <ProjectFileActionPrompt
        action={{
          kind: "rename",
          path: "src/old.ts",
          value: "src/old.ts",
          busy: false,
          error: null,
        }}
        width={40}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onConfirmDelete={vi.fn()}
        onCancel={vi.fn()}
      />,
      80,
    );

    const props = projectExplorerHarness.textInputProps.at(-1);

    expect(props).toMatchObject({
      value: "src/old.ts",
      cursorOffset: "src/old.ts".length,
      columns: 38,
      focus: true,
      multiline: false,
    });
    expect(props?.onChangeCursorOffset).toEqual(expect.any(Function));
  });

  it("disables explorer file-action text input when the explorer is unfocused", async () => {
    projectExplorerHarness.textInputProps = [];

    await renderToString(
      <ProjectFileActionPrompt
        focused={false}
        action={{
          kind: "rename",
          path: "src/old.ts",
          value: "src/old.ts",
          busy: false,
          error: null,
        }}
        width={40}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onConfirmDelete={vi.fn()}
        onCancel={vi.fn()}
      />,
      80,
    );

    expect(projectExplorerHarness.textInputProps.at(-1)).toMatchObject({
      focus: false,
    });
  });

  it("lets escape cancel explorer file-action text input through the input filter", async () => {
    const onCancel = vi.fn();
    projectExplorerHarness.textInputProps = [];

    await renderToString(
      <ProjectFileActionPrompt
        action={{
          kind: "create",
          value: "src/new.ts",
          busy: false,
          error: null,
        }}
        width={40}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onConfirmDelete={vi.fn()}
        onCancel={onCancel}
      />,
      80,
    );

    const inputFilter = projectExplorerHarness.textInputProps.at(-1)
      ?.inputFilter as (
      input: string,
      key: { readonly escape?: boolean },
    ) => string;

    expect(inputFilter("x", {})).toBe("x");
    expect(inputFilter("x", { escape: true })).toBe("");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders busy explorer file-action prompts as unfocused working prompts", async () => {
    projectExplorerHarness.textInputProps = [];

    const output = await renderToString(
      <ProjectFileActionPrompt
        action={{
          kind: "create",
          value: "src/new.ts",
          busy: true,
          error: null,
        }}
        width={40}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onConfirmDelete={vi.fn()}
        onCancel={vi.fn()}
      />,
      80,
    );

    expect(projectExplorerHarness.textInputProps.at(-1)?.focus).toBe(false);
    expect(output).toContain("working...");
  });

  it("disables explorer delete confirmations when the explorer is unfocused", async () => {
    projectExplorerHarness.keybindingCalls = [];

    await renderToString(
      <ProjectFileActionPrompt
        focused={false}
        action={{
          kind: "delete",
          path: "src/old.ts",
          label: "old.ts",
          rowKind: "file",
          busy: false,
          error: null,
        }}
        width={40}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onConfirmDelete={vi.fn()}
        onCancel={vi.fn()}
      />,
      80,
    );

    expect(
      projectExplorerHarness.keybindingCalls.at(-1)?.options,
    ).toMatchObject({
      context: "Confirmation",
      isActive: false,
    });
  });

  it("keeps the selected explorer row inside a contiguous viewport", () => {
    const rows = [
      row("", "agenc-core", "root", 0),
      row("runtime", "runtime", "directory", 1),
      row("runtime/src", "src", "directory", 2),
      ...Array.from({ length: 18 }, (_, index) =>
        row(
          `runtime/src/child-${index}`,
          `child-${index}`,
          "directory",
          3,
          index === 10,
        ),
      ),
    ];

    const viewport = projectTreeViewport(rows, 6);
    const paths = viewport.rows.map((item) => item.path);
    const indexes = viewport.rows.map((item) =>
      rows.findIndex((row) => row.path === item.path),
    );

    expect(paths).toContain("runtime/src/child-10");
    expect(indexes).toEqual([10, 11, 12, 13, 14, 15]);
    expect(viewport.above).toBe(10);
    expect(viewport.below).toBeGreaterThan(0);
  });

  it("renders a monochrome discoverability footer independent of surface mode", async () => {
    // WorkbenchFooter is no longer a surface-specific hint strip ("Preview:",
    // attachment context). The monochrome redesign keeps a stable global
    // shortcut bar so / and @ stay discoverable without competing with
    // pane-local chrome.
    const state = {
      ...getDefaultAppState(),
      workbench: {
        ...getDefaultAppState().workbench,
        focusedPane: "surface" as const,
        activeSurfaceMode: "preview" as const,
        attachments: [
          {
            id: "file:src/app.ts",
            kind: "file" as const,
            label: "src/app.ts",
            path: "src/app.ts",
          },
          {
            id: "file:src/stale.ts",
            kind: "file" as const,
            label: "src/stale.ts",
            path: "src/stale.ts",
          },
        ],
        composerAttachmentIds: ["file:src/app.ts"],
      },
    };

    const output = await renderToString(
      <AppStateProvider initialState={state}>
        <WorkbenchFooter />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("/ commands");
    expect(output).toContain("@ attach");
    expect(output).toContain("? shortcuts");
    expect(output).not.toContain("Preview:");
    expect(output).not.toContain("src/app.ts");
    expect(output).not.toContain("src/stale.ts");
  });

  it("gives the composer footer a readable hint that advertises / and @", async () => {
    // Stable monochrome footer: advertise the two highest-value composer
    // affordances plus mode/transcript/shortcut chords. Revert-sensitive:
    // restoring the old "Composer: write prompt … ctrl+w k surface" string
    // fails the assertions below.
    const state = {
      ...getDefaultAppState(),
      workbench: {
        ...getDefaultAppState().workbench,
        focusedPane: "composer" as const,
      },
    };
    const output = await renderToString(
      <AppStateProvider initialState={state}>
        <WorkbenchFooter />
      </AppStateProvider>,
      120,
    );

    const hintLine = output
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .find((line) => line.includes("/ commands") && line.includes("@ attach"));
    expect(hintLine).toBeDefined();
    expect(hintLine).toContain("/ commands");
    expect(hintLine).toContain("@ attach");
    expect(hintLine).toContain("shift+tab mode");
    expect(hintLine).toContain("ctrl+o transcript");
    expect(hintLine).toContain("? shortcuts");
    expect(hintLine).not.toContain("Composer: write prompt");
    expect(hintLine).not.toContain("ctrl+w k surface");
  });

  it("keeps the monochrome footer stable while a file surface is open", async () => {
    // Buffer-context shortcuts are inactive while the composer owns focus.
    // Keep the global composer strip visible even though the file surface
    // remains open behind it.
    const state = {
      ...getDefaultAppState(),
      workbench: {
        ...getDefaultAppState().workbench,
        focusedPane: "composer" as const,
        activeSurfaceMode: "buffer" as const,
      },
    };
    const output = await renderToString(
      <AppStateProvider initialState={state}>
        <WorkbenchFooter />
      </AppStateProvider>,
      120,
    );

    const hintLine = output
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .find((line) => line.includes("/ commands") && line.includes("@ attach"));
    expect(hintLine).toBeDefined();
    expect(hintLine).toContain("/ commands");
    expect(hintLine).toContain("@ attach");
    expect(hintLine).not.toContain("Composer: write prompt");
  });

  it("shows BUFFER actions only while the file surface owns the keys", async () => {
    const state = {
      ...getDefaultAppState(),
      workbench: {
        ...getDefaultAppState().workbench,
        focusedPane: "surface" as const,
        activeSurfaceMode: "buffer" as const,
      },
    };
    const output = await renderToString(
      <AppStateProvider initialState={state}>
        <WorkbenchFooter />
      </AppStateProvider>,
      120,
    );

    const hintLine = output
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .find((line) => line.includes("BUFFER:"));
    expect(hintLine).toBeDefined();
    expect(hintLine).toContain("ctrl+s save");
    expect(hintLine).toContain("ctrl+x y redo");
    expect(hintLine).toContain("shift+tab composer");
    expect(hintLine).toContain("ctrl+x z maximize");
    expect(hintLine).toContain("ctrl+x q hide");
    expect(hintLine).not.toContain("/ commands");
  });

  it("indents the monochrome footer line to match the composer chrome", async () => {
    // PromptInputFooter uses paddingX={2}. WorkbenchFooter shares that inset
    // so the stacked chrome lines align. Revert-sensitive: dropping
    // paddingX={2} from WorkbenchFooter makes the leading-space assertion fail.
    const output = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        <WorkbenchFooter />
      </AppStateProvider>,
      120,
    );

    const hintLine = output
      .split(/\r?\n/u)
      .find((line) => line.includes("/ commands") && line.includes("@ attach"));

    expect(hintLine).toBeDefined();
    expect(hintLine).toMatch(/^ {2}\S/u);
    expect(hintLine?.startsWith("/")).toBe(false);
  });

  it("keeps the global shortcut footer visible when the transcript exceeds the viewport", async () => {
    const scrollRef = React.createRef<ScrollBoxHandle>();
    const longTranscript = (
      <Box flexDirection="column">
        {Array.from({ length: 80 }, (_, index) => (
          <Text key={index}>long transcript line {index}</Text>
        ))}
      </Box>
    );
    const output = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        <WorkbenchLayout
          transcript={longTranscript}
          composer={
            <Box flexDirection="column" flexGrow={1}>
              <Text>composer-anchor</Text>
            </Box>
          }
          scrollRef={scrollRef}
        />
      </AppStateProvider>,
      { columns: 120, rows: 24 },
    );

    expect(output).toContain("composer-anchor");
    expect(output).toContain("/ commands");
    expect(output).toContain("@ attach");
    expect(output).toContain("? shortcuts");
    expect(output.split(/\r?\n/u).length).toBeLessThanOrEqual(24);
  });

  it.each([
    [148, "wide"],
    [120, "medium"],
    [80, "narrow"],
  ] as const)("classifies %i columns as %s layout", (columns, size) => {
    expect(layoutSizeForColumns(columns)).toBe(size);
  });

  it("keeps workspace tab bindings registered when short-terminal chrome is hidden", async () => {
    projectExplorerHarness.keybindingCalls = [];
    const changes: Array<ReturnType<typeof getDefaultAppState>> = [];

    const output = await renderToString(
      <AppStateProvider
        initialState={getDefaultAppState()}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <WorkbenchLayout
          transcript={<Text>short transcript</Text>}
          composer={<ComposerFocusProbe />}
        />
      </AppStateProvider>,
      { columns: 80, rows: 6 },
    );

    expect(output).not.toContain("1 Agent");
    expect(output).not.toContain("2 Editor");
    const tabHandlers = projectExplorerHarness.keybindingCalls.find(
      (call) => call.options?.context === "WorkspaceTabs",
    )?.handlers;
    expect(tabHandlers).toBeDefined();

    tabHandlers?.["workspace:switchEditor"]?.();
    expect(changes.at(-1)?.workbench.activeWorkspaceView).toBe("editor");
    tabHandlers?.["workspace:switchAgent"]?.();
    expect(changes.at(-1)?.workbench.activeWorkspaceView).toBe("agent");
    tabHandlers?.["workspace:cycleView"]?.();
    expect(changes.at(-1)?.workbench.activeWorkspaceView).toBe("editor");
  });

  it.each([148, 120, 80])(
    "keeps the open Editor panel focusable at %i columns",
    async (columns) => {
      projectExplorerHarness.keybindingCalls = [];
      const changes: Array<ReturnType<typeof getDefaultAppState>> = [];
      const defaults = getDefaultAppState();
      const editor = workbenchReducer(defaults.workbench, {
        type: "switchWorkspaceView",
        view: "editor",
      });
      const withPanel = workbenchReducer(editor, {
        type: "setRail",
        rail: { kind: "transcript" },
      });

      const output = await renderToString(
        <AppStateProvider
          initialState={{ ...defaults, workbench: withPanel }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <WorkbenchLayout
            transcript={<Text>editor answer</Text>}
            composer={<ComposerFocusProbe />}
          />
        </AppStateProvider>,
        { columns, rows: 30 },
      );

      if (columns >= 148) {
        expect(output).toContain("AI · Alt+L focus and scroll");
      } else {
        expect(output).not.toContain("AI · Alt+L focus and scroll");
        expect(output).toContain("composer-inactive");
      }
      const workbenchHandlers = projectExplorerHarness.keybindingCalls.find(
        (call) => call.options?.context === "Workbench",
      )?.handlers;
      workbenchHandlers?.["workbench:focusNext"]?.();

      expect(changes.at(-1)?.workbench).toMatchObject({
        activeWorkspaceView: "editor",
        focusedPane: "rail",
        rail: { kind: "transcript" },
      });
    },
  );

  it.each([120, 80])(
    "keeps a compact Editor transcript rail off the focused composer at %i columns",
    async (columns) => {
      const defaults = getDefaultAppState();
      const withPanel = workbenchReducer(
        workbenchReducer(
          workbenchReducer(defaults.workbench, {
            type: "switchWorkspaceView",
            view: "editor",
          }),
          { type: "setRail", rail: { kind: "transcript" } },
        ),
        { type: "focus", pane: "composer" },
      );
      const output = await renderToString(
        <AppStateProvider initialState={{ ...defaults, workbench: withPanel }}>
          <WorkbenchLayout
            transcript={<Text>compact-editor-answer</Text>}
            composer={<ComposerFocusProbe />}
          />
        </AppStateProvider>,
        { columns, rows: 30 },
      );

      expect(output).toContain("composer-active");
      expect(output).not.toContain("compact-editor-answer");
    },
  );

  it.each([120, 80])(
    "shows a compact Editor proposal only while its rail owns focus at %i columns",
    async (columns) => {
      clearEditorProposalRecords();
      const record = stageEditorProposalRecord({
        version: 1,
        interaction_id: `compact-proposal-${columns}`,
        path: "src/value.ts",
        buffer_handle: 1,
        base_changedtick: 7,
        base_content_sha256: "a".repeat(64),
        summary: "Replace the value",
        edits: [
          {
            id: "replace-value",
            start_line: 1,
            start_column: 0,
            end_line: 1,
            end_column: 5,
            old_text: "value",
            new_text: "answer",
          },
        ],
      });
      const defaults = getDefaultAppState();
      const withProposal = workbenchReducer(
        workbenchReducer(
          workbenchReducer(defaults.workbench, {
            type: "switchWorkspaceView",
            view: "editor",
          }),
          {
            type: "setRail",
            rail: {
              kind: "editor-proposal",
              proposalId: record.id,
            },
          },
        ),
        { type: "focus", pane: "surface" },
      );

      try {
        const surfaceOutput = await renderToString(
          <AppStateProvider
            initialState={{ ...defaults, workbench: withProposal }}
          >
            <WorkbenchLayout
              transcript={<Text>unused transcript</Text>}
              composer={<ComposerFocusProbe />}
            />
          </AppStateProvider>,
          { columns, rows: 30 },
        );
        expect(surfaceOutput).not.toContain("EDITOR PROPOSAL");

        const railFocused = workbenchReducer(withProposal, {
          type: "focus",
          pane: "rail",
        });
        const railOutput = await renderToString(
          <AppStateProvider
            initialState={{ ...defaults, workbench: railFocused }}
          >
            <WorkbenchLayout
              transcript={<Text>unused transcript</Text>}
              composer={<ComposerFocusProbe />}
            />
          </AppStateProvider>,
          { columns, rows: 30 },
        );
        expect(railOutput).toContain("EDITOR PROPOSAL");
      } finally {
        clearEditorProposalRecords();
      }
    },
  );

  it.each([
    {
      name: "focuses the explorer",
      initialPane: "composer" as const,
      action: "workbench:focusExplorer",
      expected: { focusedPane: "explorer" as const },
    },
    {
      name: "moves from the surface to the agents rail when it is visible",
      initialPane: "surface" as const,
      action: "workbench:focusSurface",
      expected: { focusedPane: "agents" as const },
    },
    {
      name: "moves from the composer up to the surface",
      initialPane: "composer" as const,
      action: "workbench:focusSurface",
      expected: { focusedPane: "surface" as const },
    },
    {
      name: "focuses the agents rail",
      initialPane: "composer" as const,
      action: "workbench:focusAgents",
      expected: { focusedPane: "agents" as const },
    },
    {
      name: "focuses the composer",
      initialPane: "surface" as const,
      action: "workbench:focusComposer",
      expected: { focusedPane: "composer" as const },
    },
    {
      name: "moves focus up to the surface",
      initialPane: "composer" as const,
      action: "workbench:focusUp",
      expected: { focusedPane: "surface" as const },
    },
    {
      name: "cycles to the next visible pane",
      initialPane: "explorer" as const,
      action: "workbench:focusNext",
      expected: { focusedPane: "surface" as const },
    },
    {
      name: "opens the diff surface",
      initialPane: "composer" as const,
      action: "workbench:openDiff",
      expected: {
        activeSurfaceMode: "diff" as const,
        focusedPane: "surface" as const,
      },
    },
    {
      name: "opens the search surface",
      initialPane: "composer" as const,
      action: "workbench:openSearch",
      expected: {
        activeSurfaceMode: "search" as const,
        focusedPane: "surface" as const,
      },
    },
  ])(
    "wires WorkbenchLayout keybinding handler: $name",
    async ({ initialPane, action, expected }) => {
      projectExplorerHarness.keybindingCalls = [];
      const changes: Array<ReturnType<typeof getDefaultAppState>> = [];

      await renderToString(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              focusedPane: initialPane,
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <WorkbenchLayout
            transcript={<Text>scroll body</Text>}
            composer={<ComposerFocusProbe />}
          />
        </AppStateProvider>,
        { columns: 148, rows: 30 },
      );

      const workbenchHandlers = projectExplorerHarness.keybindingCalls.find(
        (call) => call.options?.context === "Workbench",
      )?.handlers;

      expect(workbenchHandlers).toBeDefined();
      workbenchHandlers?.[action]?.();

      expect(changes.at(-1)?.workbench).toMatchObject(expected);
    },
  );

  it("moves a file surface into the review rail in one ctrl+r transition", async () => {
    projectExplorerHarness.keybindingCalls = [];
    const changes: Array<ReturnType<typeof getDefaultAppState>> = [];

    await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "preview",
            activeFilePath: "src/index.ts",
            focusedPane: "surface",
            surfaceMaximized: true,
          },
        }}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <WorkbenchLayout
          transcript={<Text>scroll body</Text>}
          composer={<ComposerFocusProbe />}
        />
      </AppStateProvider>,
      { columns: 148, rows: 30 },
    );

    const workbenchHandlers = projectExplorerHarness.keybindingCalls.find(
      (call) => call.options?.context === "Workbench",
    )?.handlers;
    const changesBeforeHandoff = changes.length;
    workbenchHandlers?.["workbench:toggleFileRail"]?.();

    expect(changes).toHaveLength(changesBeforeHandoff + 1);
    expect(changes.at(-1)?.workbench).toMatchObject({
      activeSurfaceMode: "transcript",
      focusedPane: "composer",
      rail: { kind: "file", path: "src/index.ts" },
      surfaceMaximized: false,
    });
  });

  it("renders the transcript once after closing BUFFER with a transcript rail", async () => {
    const buffer = workbenchReducer(undefined, {
      type: "openBuffer",
      path: "src/index.ts",
    });
    const handoff = workbenchReducer(buffer, {
      type: "handoffToComposer",
      attachment: {
        id: "editor-selection:src/index.ts:1",
        kind: "editor-selection",
        label: "src/index.ts:1",
      },
    });
    const closed = workbenchReducer(handoff, { type: "closeSurface" });
    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          workbench: closed,
        }}
      >
        <WorkbenchLayout
          transcript={<Text>unique transcript marker</Text>}
          composer={<ComposerFocusProbe />}
        />
      </AppStateProvider>,
      { columns: 148, rows: 30 },
    );

    expect(output.match(/unique transcript marker/gu)).toHaveLength(1);
  });

  it("keeps transcript content inside the active work surface", async () => {
    const output = await renderToString(
      <TranscriptSurface>
        <Text>hello transcript</Text>
      </TranscriptSurface>,
      { columns: 120, rows: 30 },
    );

    // The surface no longer prints its own TRANSCRIPT header — the workbench
    // status bar announces the active surface one row above, and the duplicate
    // label was the same word twice in the top three rows of the screen.
    expect(output).not.toContain("TRANSCRIPT");
    expect(output).toContain("hello transcript");
  });

  it("keeps the welcome hero on screen at 80 cols when the transcript is at cold start", async () => {
    // The cold-start clip lived in the sticky-bottom ScrollBox pinning the
    // welcome panel to the bottom on a short viewport, scrolling the official
    // brand mark off the top. The behaviour-determining wiring (the
    // stickyScroll prop) is asserted in the dedicated revert-sensitive spec
    // (TranscriptSurface.welcome.test.tsx); this smoke check just confirms the
    // hero still renders through the surface at 80 cols.
    const scrollRef = React.createRef<ScrollBoxHandle>();
    const output = await renderToString(
      <TranscriptSurface scrollRef={scrollRef} atWelcome>
        <WelcomeColdPanel />
      </TranscriptSurface>,
      { columns: 80, rows: 14 },
    );

    expect(output).toContain(AGENC_LOGO_MARK_COMPACT_LINES[0]);
    expect(output).not.toContain("a netrunner with hands on every file");
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

  it("keeps the selected suggestion visible inside a 14-row workbench", async () => {
    const output = await renderToString(
      <PromptOverlayProvider>
        <AppStateProvider initialState={getDefaultAppState()}>
          <WorkbenchLayout
            transcript={<Text>scroll body</Text>}
            composer={<ManySuggestionsWriter />}
          />
        </AppStateProvider>
      </PromptOverlayProvider>,
      { columns: 120, rows: 14 },
    );
    const compactOutput = output.replace(/\s+/gu, "");

    expect(output.split("\n")).toHaveLength(14);
    expect(compactOutput).toContain("/command-8runcommand8");
    expect(compactOutput).not.toContain("/command-0");
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
        <WorkbenchLayout
          transcript={<Text>scroll body</Text>}
          composer={<ComposerFocusProbe />}
        />
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
        <WorkbenchLayout
          transcript={<Text>scroll body</Text>}
          composer={<ComposerFocusProbe />}
        />
      </AppStateProvider>,
      { columns: 120, rows: 30 },
    );

    expect(inactiveOutput).toContain("composer-inactive");
    expect(activeOutput).toContain("composer-active");
  });

  it("publishes the inner frame width to the workbench composer", async () => {
    const output = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        <WorkbenchLayout
          transcript={<Text>scroll body</Text>}
          composer={<ComposerWidthProbe />}
        />
      </AppStateProvider>,
      { columns: 140, rows: 30 },
    );

    expect(output).toContain("composer-width:136");
  });

  it("renders Agent and Editor as top-level views of one workbench", async () => {
    const defaults = getDefaultAppState();
    const editorState = workbenchReducer(defaults.workbench, {
      type: "switchWorkspaceView",
      view: "editor",
    });
    const agentOutput = await renderToString(
      <AppStateProvider initialState={defaults}>
        <WorkbenchLayout
          transcript={<Text>agent-transcript</Text>}
          composer={<Text>shared-composer</Text>}
        />
      </AppStateProvider>,
      { columns: 120, rows: 30 },
    );
    const editorOutput = await renderToString(
      <AppStateProvider
        initialState={{
          ...defaults,
          workbench: editorState,
        }}
      >
        <WorkbenchLayout
          transcript={<Text>editor-panel</Text>}
          composer={<Text>shared-composer</Text>}
        />
      </AppStateProvider>,
      { columns: 120, rows: 30 },
    );

    expect(agentOutput).toContain("1 Agent");
    expect(agentOutput).toContain("2 Editor");
    expect(agentOutput).toContain("agent-transcript");
    expect(editorOutput).toContain("1 Agent");
    expect(editorOutput).toContain("2 Editor");
    expect(editorOutput).toContain("No file selected");
    expect(editorOutput).toContain("shared-composer");
  });

  it("does not render compact pane overlays when their panes are hidden", async () => {
    const hiddenAgentsOutput = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          workbench: {
            ...getDefaultAppState().workbench,
            focusedPane: "agents",
            agentsVisible: false,
          },
        }}
      >
        <WorkbenchLayout
          transcript={<Text>scroll body</Text>}
          composer={<ComposerFocusProbe />}
        />
      </AppStateProvider>,
      { columns: 120, rows: 30 },
    );

    const hiddenExplorerOutput = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          workbench: {
            ...getDefaultAppState().workbench,
            focusedPane: "explorer",
            explorerVisible: false,
          },
        }}
      >
        <WorkbenchLayout
          transcript={<Text>scroll body</Text>}
          composer={<ComposerFocusProbe />}
        />
      </AppStateProvider>,
      { columns: 80, rows: 30 },
    );

    expect(hiddenAgentsOutput).not.toContain("Agents");
    expect(hiddenExplorerOutput).not.toContain("WORKSPACE");
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
      "task-detail",
    ]);
    for (const surface of WORKBENCH_SURFACES) {
      expect(surface.footerHints.length).toBeGreaterThan(0);
      expect(surface.keybindings.length).toBeGreaterThan(0);
      expect(typeof surface.renderBody).toBe("function");
    }
  });

  it("keeps deprecated project-tree render code out of FullscreenLayout", () => {
    const source = readFileSync(
      "src/tui/components/FullscreenLayout.tsx",
      "utf8",
    );

    expect(source).not.toMatch(
      /readdirSync|getWorkspaceFileTreeRows|WorkspaceFileTreeGutter/u,
    );
  });

  it("renders the workbench title bar without leaking the viewport column count", async () => {
    const output = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        <WorkbenchStatusBar />
      </AppStateProvider>,
      120,
    );

    // Monochrome title bar: product mark + WORKBENCH mode chip, model, and
    // runtime version. Surface mode labels live in pane chrome, not here.
    expect(output).toMatch(/agenc\s+\/\s+WORKBENCH/u);
    expect(output).not.toContain("AgenC Workbench");
    expect(output).not.toContain("| transcript");
    // ...but must NOT surface the live terminal width as a debug-style segment.
    expect(output).not.toMatch(/\d+\s+cols/u);
    expect(output).not.toContain("cols");
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
