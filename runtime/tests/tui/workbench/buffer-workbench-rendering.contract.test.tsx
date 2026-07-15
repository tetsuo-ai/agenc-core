import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Key } from "../../../src/tui/ink.js";

type CapturedInputEvent = {
  readonly key: Key;
  readonly keypress: {
    readonly raw?: string;
    readonly sequence?: string;
  };
};

type CapturedInputHandler = (
  input: string,
  key: Key,
  event: CapturedInputEvent,
) => boolean;

const renderingHarness = vi.hoisted(() => ({
  inputCapture: null as null | CapturedInputHandler,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useInputCapture: (handler: CapturedInputHandler) => {
    renderingHarness.inputCapture = handler;
  },
  useKeybinding: () => {},
  useKeybindings: () => {},
}));

vi.mock("../../../src/tui/components/TextInput.js", async () => {
  const ReactModule = await import("react");
  return {
    default: () => ReactModule.createElement(ReactModule.Fragment),
  };
});

import { renderToAnsiString, renderToString } from "../../../src/utils/staticRender.js";
import { Box, Text } from "../../../src/tui/ink.js";
import { nodeCache } from "../../../src/tui/ink/node-cache.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { createNeovimRenderSnapshot } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import { BufferLine, NeovimGridView, terminalAnsiLines, truncateByWidth } from "../../../src/tui/workbench/buffer/render.js";
import {
  getWorkbenchBufferProviderController,
  resetWorkbenchBufferProviderControllerForTesting,
} from "../../../src/tui/workbench/buffer/providers/BufferProviderController.js";
import type { BufferEditorProvider, BufferProviderIdentity, BufferProviderSnapshot } from "../../../src/tui/workbench/buffer/providers/types.js";
import { emptyProviderSnapshot, NEOVIM_BUFFER_CAPABILITIES } from "../../../src/tui/workbench/buffer/providers/types.js";
import { useWorkbenchComposerFocus } from "../../../src/tui/workbench/composerFocusContext.js";
import { WORKBENCH_SURFACES } from "../../../src/tui/workbench/surfaces/ActiveWorkSurface.js";
import { wheelInputIsInsideNode } from "../../../src/tui/workbench/surfaces/BufferSurface.js";
import { WorkbenchLayout } from "../../../src/tui/workbench/WorkbenchLayout.js";
import type { WorkbenchBufferSnapshot } from "../../../src/tui/workbench/buffer/BufferStore.js";

afterEach(async () => {
  renderingHarness.inputCapture = null;
  await resetWorkbenchBufferProviderControllerForTesting();
});

describe("BUFFER workbench rendering", () => {
  it("renders an embedded Neovim grid inside the provided width", async () => {
    const terminal = {
      ...createNeovimRenderSnapshot(2, 16),
      lines: ["abcdefghijklmnopqrstuvwxyz", "123456789"],
      cursor: { grid: 1, row: 0, column: 2 },
      messages: ["long warning message"],
      popupMenu: { selected: 0, items: ["first-choice", "second-choice"] },
    };

    const output = await renderToString(
      <Box flexDirection="column" width={16}>
        <NeovimGridView terminal={terminal} focused={true} width={16} />
      </Box>,
    );

    expect(output).toContain("abc");
    expect(output).not.toContain("qrstuvwxyz");
    expect(output).toContain("123");
    expect(output).toContain("long");
    expect(output).toContain("first");
    for (const line of output.split(/\r?\n/u)) {
      expect(line.length).toBeLessThanOrEqual(16);
    }
  });

  it("renders the focused embedded cursor at the Neovim row and column", async () => {
    const terminal = {
      ...createNeovimRenderSnapshot(2, 16),
      lines: ["abcdef", "123456"],
      cursor: { grid: 1, row: 1, column: 3 },
    };

    const output = await renderToAnsiString(
      <Box flexDirection="column" width={16}>
        <NeovimGridView terminal={terminal} focused={true} width={16} />
      </Box>,
      { columns: 16, color: true },
    );

    expect(output).toContain("abc");
    expect(output).toContain("123");
    expect(output).toContain("123\x1B[7m4\x1B[27m56");
    expect(output).not.toContain("abc\x1B[7md\x1B[27mef");
  });

  it("renders Neovim highlight attributes as terminal color instead of dropping them", async () => {
    const terminal = {
      ...createNeovimRenderSnapshot(1, 16),
      lines: ["const x = 1;"],
      cells: [[
        { text: "c", width: 1, highlightId: 3 },
        { text: "o", width: 1, highlightId: 3 },
        { text: "n", width: 1, highlightId: 3 },
        { text: "s", width: 1, highlightId: 3 },
        { text: "t", width: 1, highlightId: 3 },
        { text: " ", width: 1, highlightId: 0 },
        { text: "x", width: 1, highlightId: 4 },
      ]],
      highlights: [
        { id: 3, attributes: { foreground: 0xFF5F87, bold: true } },
        { id: 4, attributes: { foreground: 0x5FD7FF, italic: true, underline: true } },
      ],
    };

    const output = await renderToAnsiString(
      <Box flexDirection="column" width={16}>
        <NeovimGridView terminal={terminal} focused={false} width={16} />
      </Box>,
      { columns: 16, color: true },
    );

    expect(output).toContain("\x1B[38;2;255;95;135m");
    expect(output).toContain("\x1B[38;2;95;215;255m");
    expect(output).toContain("const");
  });

  it("serializes Neovim visual selections into styled terminal rows", () => {
    const text = "alpha beta gamma";
    const terminal = {
      ...createNeovimRenderSnapshot(1, 24),
      lines: [text],
      cells: [[...text].map((cellText, index) => ({
        text: cellText,
        width: 1,
        highlightId: index < "alpha beta".length ? 9 : 0,
      }))],
      highlights: [
        { id: 9, attributes: { reverse: true } },
      ],
      mode: "visual",
    };

    const renderedLine = terminalAnsiLines(terminal, true, 24)[0] ?? "";

    expect(renderedLine).toContain("\x1B[7m");
    expect(renderedLine).toContain("alpha beta");
    expect(renderedLine.indexOf("\x1B[7m")).toBeLessThan(renderedLine.indexOf("alpha"));
    expect(renderedLine).toContain("\x1B[0m gamma");
  });

  it("renders inline buffer cursor and selection boundary cases", async () => {
    const line = { number: 1, text: "abcdef", from: 0, to: 6 };

    const selectedOutside = await renderToString(
      <Box width={12}>
        <BufferLine
          line={line}
          snapshot={snapshot({ selection: { anchor: 10, head: 12 } })}
          width={12}
          focused={true}
        />
      </Box>,
    );
    expect(selectedOutside).toContain("abcdef");

    const cursorAtEnd = await renderToString(
      <Box width={12}>
        <BufferLine
          line={line}
          snapshot={snapshot({ position: { line: 1, column: 6, offset: 6 } })}
          width={12}
          focused={true}
        />
      </Box>,
    );
    expect(cursorAtEnd).toContain("abcdef");

    const cursorOutside = await renderToString(
      <Box width={12}>
        <BufferLine
          line={line}
          snapshot={snapshot({ position: { line: 1, column: 20, offset: 20 } })}
          width={12}
          focused={true}
        />
      </Box>,
    );
    expect(cursorOutside).toContain("abcdef");

    const highlighted = await renderToString(
      <Box width={24}>
        <BufferLine
          line={line}
          snapshot={snapshot({ position: { line: 2, column: 0, offset: 0 } })}
          width={24}
          focused={false}
          highlightedText="\u001b[31mabcdef\u001b[39m"
        />
      </Box>,
    );
    expect(highlighted).toContain("abcdef");
  });

  it("renders terminal cursor fallbacks for tiny widths and end columns", async () => {
    const terminal = {
      ...createNeovimRenderSnapshot(1, 1),
      lines: ["abcdef"],
      cursor: { grid: 1, row: 0, column: 10 },
    };

    const output = await renderToString(
      <Box flexDirection="column" width={1}>
        <NeovimGridView terminal={terminal} focused={true} width={0} />
      </Box>,
    );

    expect(output.split(/\r?\n/u).every((line) => line.length <= 1)).toBe(true);
    expect(truncateByWidth("abcdef", 1)).toBe("a");
    expect(truncateByWidth("abcdef", 0)).toBe("");
  });

  it("clips long command-line text before it can spill into adjacent panes", () => {
    expect(truncateByWidth("set number relativenumber wrapscan ignorecase", 12)).toBe("set number r");
  });

  it("keeps BUFFER isolated inside the full workbench layout", async () => {
    await installRenderedProvider({
      line: `buffer-visible ${"x".repeat(180)} BUFFER_LINE_TAIL_SHOULD_NOT_RENDER`,
      commandLine: `set number ${"z".repeat(240)} COMMAND_TAIL_SHOULD_NOT_RENDER`,
    });

    const output = await renderWorkbench({ columns: 148, rows: 30, focusedPane: "surface" });

    expect(output).toContain("WORKSPACE");
    expect(output).toContain("BUFFER");
    expect(output).toContain("Agents");
    expect(output).toContain("composer-inactive");
    expect(output).toContain("embedded Neovim test");
    expect(output).not.toContain("transcript-anchor");
    expect(output).toContain("buffer-visible");
    expect(output).not.toContain("BUFFER_LINE_TAIL_SHOULD_NOT_RENDER");
    expect(output).not.toContain("COMMAND_TAIL_SHOULD_NOT_RENDER");
    expect(allRenderedLinesFit(output, 148)).toBe(true);
  });

  it("handles narrow and short workbench terminals without overlapping panes", async () => {
    await installRenderedProvider({
      line: "narrow-buffer-line " + "y".repeat(80),
      commandLine: "write " + "z".repeat(80),
    });

    const narrow = await renderWorkbench({ columns: 80, rows: 20, focusedPane: "surface" });
    expect(narrow).toContain("BUFFER");
    expect(narrow).toContain("composer-inactive");
    expect(narrow).not.toContain("Agents");
    expect(allRenderedLinesFit(narrow, 80)).toBe(true);

    const short = await renderWorkbench({ columns: 80, rows: 6, focusedPane: "surface" });
    expect(short).toContain("BUFFER");
    expect(short).toContain("composer-inactive");
    expect(allRenderedLinesFit(short, 80)).toBe(true);
  });

  it("shows inactive BUFFER status while composer focus stays active", async () => {
    const provider = await installRenderedProvider({
      line: "inactive-buffer-line",
      commandLine: null,
    });

    const output = await renderWorkbench({ columns: 120, rows: 24, focusedPane: "composer" });

    expect(output).toContain("BUFFER");
    expect(output).toContain("embedded Neovim test");
    expect(output).toContain("[embedded Neovim test, normal, ready");
    expect(output).toContain("composer-active");
    expect(provider.focus).toHaveBeenCalledWith(false);
    expect(provider.focus).not.toHaveBeenCalledWith(true);
  });

  it("truncates long provider status text inside the BUFFER pane", async () => {
    await installRenderedProvider({
      line: "provider-text-line",
      commandLine: null,
      fallbackReason: `fallback reason ${"f".repeat(180)} FALLBACK_STATUS_TAIL_SHOULD_NOT_RENDER`,
      providerMessage: `provider message ${"m".repeat(180)} PROVIDER_MESSAGE_TAIL_SHOULD_NOT_RENDER`,
      error: `provider error ${"e".repeat(180)} PROVIDER_ERROR_TAIL_SHOULD_NOT_RENDER`,
    });

    const output = await renderWorkbench({ columns: 120, rows: 30, focusedPane: "surface" });

    expect(output).toContain("fallback reason");
    expect(output).toContain("provider message");
    expect(output).toContain("provider error");
    expect(output).not.toContain("FALLBACK_STATUS_TAIL_SHOULD_NOT_RENDER");
    expect(output).not.toContain("PROVIDER_MESSAGE_TAIL_SHOULD_NOT_RENDER");
    expect(output).not.toContain("PROVIDER_ERROR_TAIL_SHOULD_NOT_RENDER");
    expect(output).not.toContain("transcript-anchor");
    expect(allRenderedLinesFit(output, 120)).toBe(true);
  });

  it("uses pointer bounds so editor wheel events do not scroll the project explorer", () => {
    const bufferNode = {} as never;
    nodeCache.set(bufferNode, { x: 30, y: 2, width: 80, height: 18 });
    expect(wheelInputIsInsideNode(wheelEvent(""), bufferNode)).toBe(false);
    expect(wheelInputIsInsideNode({ key: key(), keypress: { raw: "", sequence: "" } } as never, bufferNode)).toBe(true);
    expect(wheelInputIsInsideNode(wheelEvent("\x1B[<65;40;10M"), null)).toBe(false);
    expect(wheelInputIsInsideNode(wheelEvent("\x1B[<65;40;10M"), {} as never)).toBe(false);
    const explorerScroll = vi.fn();
    const bufferScroll = vi.fn();

    function routeWheel(raw: string): void {
      const event = wheelEvent(raw);
      if (wheelInputIsInsideNode(event, bufferNode)) {
        bufferScroll();
        return;
      }
      explorerScroll();
    }

    routeWheel("\x1B[<65;40;10M");
    expect(bufferScroll).toHaveBeenCalledTimes(1);
    expect(explorerScroll).not.toHaveBeenCalled();

    routeWheel("\x1B[M" + String.fromCharCode(64, 73, 43));
    expect(bufferScroll).toHaveBeenCalledTimes(2);
    expect(explorerScroll).not.toHaveBeenCalled();

    routeWheel("\x1B[<65;10;10M");
    expect(explorerScroll).toHaveBeenCalledTimes(1);

    expect(wheelInputIsInsideNode({
      key: key({ wheelDown: true }),
      keypress: { raw: undefined, sequence: "\x1B[<65;40;10M" },
    } as never, bufferNode)).toBe(true);
    expect(wheelInputIsInsideNode({
      key: key({ wheelDown: true }),
      keypress: { raw: undefined, sequence: undefined },
    } as never, bufferNode)).toBe(false);
  });

  it("rejects wheel input capture outside the BUFFER content bounds", async () => {
    const provider = await installRenderedProvider({
      line: "wheel-boundary-line",
      commandLine: null,
    });
    await renderWorkbench({ columns: 120, rows: 24, focusedPane: "surface" });

    const result = renderingHarness.inputCapture?.(
      "",
      key({ wheelDown: true }),
      wheelEvent("\x1B[<65;1;1M"),
    );

    expect(result).toBe(false);
    expect(provider.handleInput).not.toHaveBeenCalled();
  });

  it("keeps BUFFER footer hints focused on embedded provider actions", () => {
    const descriptor = WORKBENCH_SURFACES.find((surface) => surface.mode === "buffer");

    expect(descriptor?.footerHints).toContain("embedded nvim");
    expect(descriptor?.footerHints).toContain("shift+tab composer");
    expect(descriptor?.footerHints).toContain("ctrl+x h explorer");
    expect(descriptor?.footerHints).toContain("ctrl+x ctrl+e external");
    expect(descriptor?.footerHints).toContain("ctrl+x q close");
  });
});

type SnapshotOverrides = { [Key in keyof WorkbenchBufferSnapshot]?: WorkbenchBufferSnapshot[Key] };

function snapshot(overrides: SnapshotOverrides = {}): WorkbenchBufferSnapshot {
  return {
    status: "ready",
    filePath: "target.txt",
    absolutePath: "/workspace/target.txt",
    dirty: false,
    lineCount: 1,
    position: { line: 1, column: 0, offset: 0 },
    selection: { anchor: 0, head: 0 },
    scrollLine: 0,
    viewportRows: 10,
    canUndo: false,
    canRedo: false,
    error: null,
    conflictKind: null,
    encoding: "utf8",
    lineEndings: "LF",
    hoverText: null,
    vimMode: "NORMAL",
    vimCommandLine: null,
    ...overrides,
  };
}

async function renderWorkbench({
  columns,
  rows,
  focusedPane,
}: {
  readonly columns: number;
  readonly rows: number;
  readonly focusedPane: "surface" | "composer";
}): Promise<string> {
  return renderToString(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        workbench: {
          ...getDefaultAppState().workbench,
          activeSurfaceMode: "buffer",
          activeFilePath: "target.txt",
          focusedPane,
          explorerVisible: true,
          agentsVisible: true,
        },
      }}
    >
      <WorkbenchLayout transcript={<Text>transcript-anchor</Text>} composer={<ComposerFocusProbe />} />
    </AppStateProvider>,
    { columns, rows },
  );
}

async function installRenderedProvider({
  line,
  commandLine,
  fallbackReason,
  providerMessage,
  error,
}: RenderedProviderOptions): Promise<BufferEditorProvider & { readonly focus: ReturnType<typeof vi.fn> }> {
  const provider = createRenderedProvider({ line, commandLine, fallbackReason, providerMessage, error });
  const controller = getWorkbenchBufferProviderController();
  controller.setSelectionFactoryForTesting(async () => ({
    kind: "neovim",
    provider,
    discovery: {
      usable: true,
      executable: "nvim",
      version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
      args: ["--embed", "--clean", "-n"],
      useUserInit: false,
    },
  }));
  controller.resize({ rows: 18, columns: 82 });
  await controller.open("target.txt", 1);
  return provider;
}

type RenderedProviderOptions = {
  readonly line: string;
  readonly commandLine: string | null;
  readonly fallbackReason?: string | null;
  readonly providerMessage?: string | null;
  readonly error?: string | null;
};

function createRenderedProvider({
  line,
  commandLine,
  fallbackReason,
  providerMessage,
  error,
}: RenderedProviderOptions): BufferEditorProvider & { readonly focus: ReturnType<typeof vi.fn> } {
  const identity: BufferProviderIdentity = {
    kind: "neovim",
    label: "embedded Neovim test",
    fallbackReason: fallbackReason ?? null,
    capabilities: NEOVIM_BUFFER_CAPABILITIES,
  };
  const terminal = {
    ...createNeovimRenderSnapshot(12, 82),
    lines: [line, "second line"],
    commandLine,
    mode: commandLine === null ? "normal" : "normal",
  };
  const providerSnapshot: BufferProviderSnapshot = {
    ...emptyProviderSnapshot(identity),
    status: "ready",
    providerStatus: "ready",
    providerMessage: providerMessage ?? "provider ready",
    filePath: "target.txt",
    absolutePath: "/workspace/target.txt",
    error: error ?? null,
    position: { line: 1, column: 0, offset: 0 },
    lineCount: 2,
    viewportRows: 12,
    encoding: "utf8",
    lineEndings: "LF",
    terminal,
    vimMode: "NORMAL",
    vimCommandLine: commandLine,
  };
  return {
    identity,
    subscribe: vi.fn(() => () => {}),
    getSnapshot: () => providerSnapshot,
    getVisibleLines: () => [],
    open: vi.fn(async () => {}),
    save: vi.fn(async () => true),
    revert: vi.fn(async () => {}),
    close: vi.fn(async () => true),
    openExternalEditor: vi.fn(async () => false),
    undo: vi.fn(() => false),
    redo: vi.fn(() => false),
    move: vi.fn(() => false),
    requestHover: vi.fn(async () => null),
    goToDefinition: vi.fn(async () => false),
    handleInput: vi.fn(() => false),
    click: vi.fn(() => false),
    resize: vi.fn(),
    focus: vi.fn(),
    cleanup: vi.fn(async () => {}),
  };
}

function ComposerFocusProbe(): React.ReactElement {
  const active = useWorkbenchComposerFocus();
  return <Text>{active ? "composer-active" : "composer-inactive"}</Text>;
}

function allRenderedLinesFit(output: string, columns: number): boolean {
  return output.split(/\r?\n/u).every((line) => line.length <= columns);
}

function wheelEvent(raw: string) {
  return {
    key: key({ wheelDown: true }),
    keypress: { raw, sequence: raw },
  } as never;
}

type KeyOverrides = { readonly [Name in keyof Key]?: Key[Name] };

function key(overrides: KeyOverrides = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    wheelUp: false,
    wheelDown: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    fn: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    ...overrides,
  };
}
