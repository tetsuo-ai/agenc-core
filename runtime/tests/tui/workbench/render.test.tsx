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

import { PromptOverlayProvider, useSetPromptOverlay, useSetPromptOverlayDialog } from "../../../src/tui/context/promptOverlayContext.js";
import { Text } from "../../../src/tui/ink.js";
import type { ScrollBoxHandle } from "../../../src/tui/ink/components/ScrollBox.js";
import { WelcomeColdPanel } from "../../../src/tui/components/v2/primitives.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { ProjectExplorerRow, ProjectFileActionPrompt, projectTreeViewport } from "../../../src/tui/workbench/project-tree/ProjectExplorer.js";
import { useWorkbenchComposerFocus } from "../../../src/tui/workbench/composerFocusContext.js";
import { WORKBENCH_SURFACES } from "../../../src/tui/workbench/surfaces/ActiveWorkSurface.js";
import { TranscriptSurface } from "../../../src/tui/workbench/surfaces/TranscriptSurface.js";
import { WorkbenchFooter } from "../../../src/tui/workbench/WorkbenchFooter.js";
import { WorkbenchStatusBar } from "../../../src/tui/workbench/WorkbenchStatusBar.js";
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

  it.each([
    ["modified", "M"],
    ["added", "A"],
    ["deleted", "D"],
    ["renamed", "R"],
    ["unmerged", "U"],
    ["untracked", "?"],
    ["ignored", "!"],
  ] as const)("renders explorer git state %s with its badge", async (gitState, marker) => {
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

    const inputFilter = projectExplorerHarness.textInputProps.at(-1)?.inputFilter as (
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

    expect(projectExplorerHarness.keybindingCalls.at(-1)?.options).toMatchObject({
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
        }, {
          id: "file:src/stale.ts",
          kind: "file" as const,
          label: "src/stale.ts",
          path: "src/stale.ts",
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
    expect(output).not.toContain("src/stale.ts");
  });

  it("gives the composer footer a readable hint that advertises / and @ and explains the surface chord", async () => {
    // The composer-pane footer used to read "Composer: write prompt  ctrl+w k
    // surface" — the trailing "ctrl+w k surface" was opaque (what is a
    // surface?) and the line advertised neither the `/` command nor the `@`
    // attach affordance. It now glosses the chord ("focus transcript") and
    // surfaces both discoverability hints. Revert-sensitive: restoring the old
    // string (no "/ commands", no "@ attach file", bare "ctrl+w k surface")
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
      .find((line) => line.includes("Composer: write prompt"));
    expect(hintLine).toBeDefined();
    // Discoverability: `/` opens commands and `@` attaches a file, advertised
    // where the user types.
    expect(hintLine).toContain("/ commands");
    expect(hintLine).toContain("@ attach file");
    // The surface chord is glossed instead of left as a bare token.
    expect(hintLine).toContain("ctrl+w k focus transcript");
    expect(hintLine).not.toContain("ctrl+w k surface");
  });

  it("advertises ctrl+r rail in the composer footer while a file surface is open", async () => {
    // The rail toggle is global, but buffer/preview hints only render when
    // those panes are focused. With a file open and the composer focused
    // (the moment the user wants to rail the file), the toggle must still be
    // discoverable — the composer footer gains "ctrl+r rail" then.
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
      .find((line) => line.includes("Composer: write prompt"));
    expect(hintLine).toBeDefined();
    expect(hintLine).toContain("ctrl+r rail");
  });

  it("indents the surface-hint footer line to match the composer footer", async () => {
    // The composer's own "? for shortcuts" hint is rendered inside a
    // paddingX={2} box (PromptInputFooter). The workbench surface-hint line
    // used to render flush at column 0, so the two stacked footer lines had
    // mismatched left margins. WorkbenchFooter now shares the same 2-column
    // inset. Revert-sensitive: dropping paddingX={2} from WorkbenchFooter makes
    // the leading-space assertion fail.
    const output = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        <WorkbenchFooter />
      </AppStateProvider>,
      120,
    );

    const hintLine = output
      .split(/\r?\n/u)
      .find((line) => line.includes("Composer: write prompt"));

    expect(hintLine).toBeDefined();
    expect(hintLine).toMatch(/^ {2}\S/u);
    expect(hintLine?.startsWith("Composer:")).toBe(false);
  });

  it.each([
    [148, "wide"],
    [120, "medium"],
    [80, "narrow"],
  ] as const)("classifies %i columns as %s layout", (columns, size) => {
    expect(layoutSizeForColumns(columns)).toBe(size);
  });

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
      expected: { activeSurfaceMode: "diff" as const, focusedPane: "surface" as const },
    },
    {
      name: "opens the search surface",
      initialPane: "composer" as const,
      action: "workbench:openSearch",
      expected: { activeSurfaceMode: "search" as const, focusedPane: "surface" as const },
    },
  ])("wires WorkbenchLayout keybinding handler: $name", async ({ initialPane, action, expected }) => {
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
        <WorkbenchLayout transcript={<Text>scroll body</Text>} composer={<ComposerFocusProbe />} />
      </AppStateProvider>,
      { columns: 148, rows: 30 },
    );

    const workbenchHandlers = projectExplorerHarness.keybindingCalls.find(
      (call) => call.options?.context === "Workbench",
    )?.handlers;

    expect(workbenchHandlers).toBeDefined();
    workbenchHandlers?.[action]?.();

    expect(changes.at(-1)?.workbench).toMatchObject(expected);
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
    // welcome panel to the bottom on a short viewport, scrolling the `agenc.`
    // brand line off the top. The behaviour-determining wiring (the
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

    expect(output).toContain("agenc.");
    expect(output).toContain("a netrunner with hands on every file");
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
        <WorkbenchLayout transcript={<Text>scroll body</Text>} composer={<ComposerFocusProbe />} />
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
        <WorkbenchLayout transcript={<Text>scroll body</Text>} composer={<ComposerFocusProbe />} />
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

  it("renders the workbench title bar without leaking the viewport column count", async () => {
    const output = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        <WorkbenchStatusBar />
      </AppStateProvider>,
      120,
    );

    // Title bar shows the product name and active surface. The surface label
    // uses the same uppercase casing as the pane header ("TRANSCRIPT"), not the
    // lowercase surface-mode id, so the two render sites stay consistent.
    expect(output).toContain("AgenC Workbench");
    expect(output).toContain("TRANSCRIPT");
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
