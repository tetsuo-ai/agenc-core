import { describe, expect, it, vi } from "vitest";

import type { Key } from "../../../src/tui/ink.js";
import { nodeCache } from "../../../src/tui/ink/node-cache.js";
import { createChordInputHandler } from "../../../src/tui/keybindings/KeybindingProviderSetup.js";
import { DEFAULT_BINDINGS } from "../../../src/tui/keybindings/defaultBindings.js";
import { parseBindings } from "../../../src/tui/keybindings/parser.js";
import type { ParsedKeystroke } from "../../../src/tui/keybindings/types.js";
import {
  translateKeyToNeovimInput,
  translatePasteToNeovimInput,
  translateResizeToNeovimInput,
} from "../../../src/tui/workbench/buffer/neovim/NeovimInput.js";
import { createNeovimRenderSnapshot } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import { NeovimBufferProvider } from "../../../src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.js";
import type { StartEmbeddedNeovimOptions } from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";
import { wheelInputIsInsideNode } from "../../../src/tui/workbench/surfaces/BufferSurface.js";

const baseKey: Key = {
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
};

type KeyOverrides = { readonly [Name in keyof Key]?: Key[Name] };

function key(overrides: KeyOverrides): Key {
  return { ...baseKey, ...overrides };
}

describe("embedded Neovim input translation", () => {
  it("passes printable input through without workbench interpretation", () => {
    expect(translateKeyToNeovimInput("x", key({}))).toBe("x");
    expect(translateKeyToNeovimInput("<", key({}))).toBe("<");
  });

  it("translates named and modified keys to Neovim notation", () => {
    expect(translateKeyToNeovimInput("", key({ escape: true, meta: true }))).toBe("<Esc>");
    expect(translateKeyToNeovimInput("", key({ return: true }))).toBe("<CR>");
    expect(translateKeyToNeovimInput("", key({ tab: true }))).toBe("<Tab>");
    expect(translateKeyToNeovimInput("", key({ backspace: true }))).toBe("<BS>");
    expect(translateKeyToNeovimInput("", key({ delete: true }))).toBe("<Del>");
    expect(translateKeyToNeovimInput("", key({ upArrow: true, shift: true }))).toBe("<S-Up>");
    expect(translateKeyToNeovimInput("", key({ downArrow: true }))).toBe("<Down>");
    expect(translateKeyToNeovimInput("", key({ leftArrow: true, ctrl: true }))).toBe("<C-Left>");
    expect(translateKeyToNeovimInput("", key({ rightArrow: true, meta: true }))).toBe("<A-Right>");
    expect(translateKeyToNeovimInput("", key({ pageUp: true }))).toBe("<PageUp>");
    expect(translateKeyToNeovimInput("", key({ pageDown: true }))).toBe("<PageDown>");
    expect(translateKeyToNeovimInput("", key({ home: true }))).toBe("<Home>");
    expect(translateKeyToNeovimInput("", key({ end: true, super: true }))).toBe("<D-End>");
    expect(translateKeyToNeovimInput("s", key({ ctrl: true }))).toBe("<C-s>");
    expect(translateKeyToNeovimInput(" ", key({ ctrl: true }))).toBe("<C-Space>");
    expect(translateKeyToNeovimInput("x", key({ meta: true }))).toBe("<A-x>");
    expect(translateKeyToNeovimInput("<", key({ meta: true }))).toBe("<A-lt>");
    expect(translateKeyToNeovimInput("<CR>", key({ meta: true }))).toBe("<A-CR>");
    expect(translateKeyToNeovimInput("x", key({ super: true }))).toBe("<D-x>");
    expect(translateKeyToNeovimInput("", key({}))).toBeNull();
  });

  it("wraps bracketed paste as one paste operation", () => {
    expect(translatePasteToNeovimInput("alpha\nbeta")).toEqual([
      { type: "keys", keys: "<PasteStart>" },
      { type: "paste", text: "alpha\nbeta" },
      { type: "keys", keys: "<PasteEnd>" },
    ]);
    expect(translatePasteToNeovimInput("")).toEqual([]);
  });

  it("normalizes resize dimensions before forwarding", () => {
    expect(translateResizeToNeovimInput(0, -4)).toEqual({
      type: "resize",
      rows: 1,
      columns: 1,
    });
  });

  it("translates wheel events to Neovim input keys", () => {
    expect(translateKeyToNeovimInput("", key({ wheelUp: true }))).toBe("<ScrollWheelUp>");
    expect(translateKeyToNeovimInput("", key({ wheelDown: true }))).toBe("<ScrollWheelDown>");
    expect(translateKeyToNeovimInput("", key({ wheelDown: true, shift: true }))).toBe("<ScrollWheelDown>");
  });

  it("routes ctrl-s to the BUFFER save binding before raw editor input capture", () => {
    const save = vi.fn();
    const capture = vi.fn(() => true);
    const event = createInputEvent();
    const handler = createChordInputHandler({
      bindings: parseBindings(DEFAULT_BINDINGS),
      pendingChordRef: { current: null },
      setPendingChord: vi.fn(),
      activeContexts: new Set(["Buffer"]),
      handlerRegistryRef: { current: new Map([["buffer:save", new Set([{ action: "buffer:save", context: "Buffer" as const, handler: save }])]]) },
      inputCaptureRegistryRef: { current: new Set([{ context: "Buffer" as const, handler: capture }]) },
    });

    handler("s", key({ ctrl: true }), event as any);

    expect(save).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
    expect(event.didStopImmediatePropagation()).toBe(true);
  });

  it("routes BUFFER escape-hatch focus chords before raw Neovim capture", () => {
    const focusComposer = vi.fn();
    const focusExplorer = vi.fn();
    const capture = vi.fn(() => true);
    const pendingChordRef: { current: ParsedKeystroke[] | null } = { current: null };
    const handler = createChordInputHandler({
      bindings: parseBindings(DEFAULT_BINDINGS),
      pendingChordRef,
      setPendingChord: vi.fn((pending) => {
        pendingChordRef.current = pending;
      }),
      activeContexts: new Set(["Buffer"]),
      handlerRegistryRef: {
        current: new Map([
          ["workbench:focusComposer", new Set([{ action: "workbench:focusComposer", context: "Buffer" as const, handler: focusComposer }])],
          ["workbench:focusExplorer", new Set([{ action: "workbench:focusExplorer", context: "Buffer" as const, handler: focusExplorer }])],
        ]),
      },
      inputCaptureRegistryRef: { current: new Set([{ context: "Buffer" as const, handler: capture }]) },
    });

    const shiftTab = createInputEvent(key({ tab: true, shift: true }));
    handler("", key({ tab: true, shift: true }), shiftTab as any);
    expect(focusComposer).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
    expect(shiftTab.didStopImmediatePropagation()).toBe(true);

    const prefix = createInputEvent(key({ ctrl: true }));
    handler("x", key({ ctrl: true }), prefix as any);
    const explorer = createInputEvent(key({}));
    handler("h", key({}), explorer as any);

    expect(focusExplorer).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
    expect(prefix.didStopImmediatePropagation()).toBe(true);
    expect(explorer.didStopImmediatePropagation()).toBe(true);
  });

  it("forwards escape and wheel events to active BUFFER capture instead of global surface handlers", () => {
    const capture = vi.fn(() => true);
    const save = vi.fn();
    const handler = createChordInputHandler({
      bindings: parseBindings(DEFAULT_BINDINGS),
      pendingChordRef: { current: null },
      setPendingChord: vi.fn(),
      activeContexts: new Set(["Buffer"]),
      handlerRegistryRef: { current: new Map([["buffer:save", new Set([{ action: "buffer:save", context: "Buffer" as const, handler: save }])]]) },
      inputCaptureRegistryRef: { current: new Set([{ context: "Buffer" as const, handler: capture }]) },
    });

    const escapeEvent = createInputEvent();
    handler("", key({ escape: true }), escapeEvent as any);
    expect(capture).toHaveBeenCalledWith("", expect.objectContaining({ escape: true }), expect.anything());
    expect(escapeEvent.didStopImmediatePropagation()).toBe(true);

    const wheelKey = key({ wheelDown: true });
    const wheelEvent = createInputEvent(wheelKey);
    handler("", wheelKey, wheelEvent as any);
    expect(capture).toHaveBeenCalledWith("", expect.objectContaining({ wheelDown: true }), expect.anything());
    expect(wheelEvent.didStopImmediatePropagation()).toBe(true);
  });

  it("forwards escape in insert mode to Neovim before close handlers", () => {
    const capture = vi.fn(() => true);
    const closeSurface = vi.fn();
    const handler = createChordInputHandler({
      bindings: parseBindings(DEFAULT_BINDINGS),
      pendingChordRef: { current: null },
      setPendingChord: vi.fn(),
      activeContexts: new Set(["Buffer", "Chat"]),
      handlerRegistryRef: { current: new Map([["chat:cancel", new Set([{ action: "chat:cancel", context: "Chat" as const, handler: closeSurface }])]]) },
      inputCaptureRegistryRef: { current: new Set([{ context: "Buffer" as const, handler: capture }]) },
    });
    const escapeKey = key({ escape: true });
    const event = createInputEvent(escapeKey);

    handler("", escapeKey, event as any);

    expect(capture).toHaveBeenCalledWith("", expect.objectContaining({ escape: true }), expect.anything());
    expect(closeSurface).not.toHaveBeenCalled();
    expect(event.didStopImmediatePropagation()).toBe(true);
  });

  it("uses wheel coordinates so scrolling over BUFFER does not scroll the explorer", () => {
    const bufferNode = {} as never;
    nodeCache.set(bufferNode, { x: 10, y: 5, width: 30, height: 10 });
    const bufferCapture = vi.fn((_input: string, _key: Key, event: any) => wheelInputIsInsideNode(event, bufferNode));
    const explorerScroll = vi.fn(() => true);
    const handler = createChordInputHandler({
      bindings: parseBindings(DEFAULT_BINDINGS),
      pendingChordRef: { current: null },
      setPendingChord: vi.fn(),
      activeContexts: new Set(["Buffer", "Explorer"]),
      handlerRegistryRef: { current: new Map() },
      inputCaptureRegistryRef: {
        current: new Set([
          { context: "Buffer" as const, handler: bufferCapture },
          { context: "Explorer" as const, handler: explorerScroll },
        ]),
      },
    });
    const wheelKey = key({ wheelDown: true });
    const insideEvent = createInputEvent(wheelKey, "\x1B[<65;12;7M");

    handler("", wheelKey, insideEvent as any);

    expect(bufferCapture).toHaveBeenCalledTimes(1);
    expect(explorerScroll).not.toHaveBeenCalled();
    expect(insideEvent.didStopImmediatePropagation()).toBe(true);

    const outsideEvent = createInputEvent(wheelKey, "\x1B[<65;2;2M");
    handler("", wheelKey, outsideEvent as any);

    expect(bufferCapture).toHaveBeenCalledTimes(2);
    expect(explorerScroll).toHaveBeenCalledTimes(1);
    expect(outsideEvent.didStopImmediatePropagation()).toBe(true);

    const coordinateLessEvent = createInputEvent(wheelKey);
    handler("", wheelKey, coordinateLessEvent as any);

    expect(bufferCapture).toHaveBeenCalledTimes(3);
    expect(explorerScroll).toHaveBeenCalledTimes(2);
    expect(coordinateLessEvent.didStopImmediatePropagation()).toBe(true);
  });

  it("forwards paste, escape, wheel, resize, focus, and click through the embedded provider", async () => {
    const session = {
      pid: 123,
      input: vi.fn(async () => {}),
      paste: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      focus: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
      save: vi.fn(async () => true),
      isDirty: vi.fn(async () => false),
      quit: vi.fn(async () => ({ closed: true as const })),
      cleanup: vi.fn(async () => {}),
    };
    const provider = new NeovimBufferProvider({
      discovery: {
        usable: true,
        executable: "/usr/bin/nvim",
        version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
        args: ["--embed", "--clean", "-n"],
        useUserInit: false,
      },
      readFileSnapshot: vi.fn(async (filePath: string) => ({
        filePath,
        absolutePath: `/workspace/${filePath}`,
        content: "alpha\n",
        mtimeMs: 1,
        size: 6,
        encoding: "utf8",
        lineEndings: "LF",
      })),
      startSession: vi.fn(async (options: StartEmbeddedNeovimOptions) => {
        options.onSnapshot(createNeovimRenderSnapshot(options.size.rows, options.size.columns));
        return session as never;
      }),
    });

    await provider.open({ filePath: "target.txt" });

    expect(provider.handleInput({ input: "alpha\nbeta", key: key({}), context: { rows: 8, columns: 40 } })).toBe(true);
    await flush();
    expect(session.input).toHaveBeenCalledWith("<PasteStart>");
    expect(session.paste).toHaveBeenCalledWith("alpha\nbeta");
    expect(session.input).toHaveBeenCalledWith("<PasteEnd>");

    expect(provider.handleInput({ input: "", key: key({ escape: true }), context: { rows: 8, columns: 40 } })).toBe(true);
    expect(provider.handleInput({ input: "", key: key({ wheelDown: true }), context: { rows: 8, columns: 40 } })).toBe(true);
    expect(provider.handleInput({ input: ":", key: key({}), context: { rows: 8, columns: 40 } })).toBe(true);
    expect(provider.handleInput({ input: "w", key: key({}), context: { rows: 8, columns: 40 } })).toBe(true);
    expect(provider.handleInput({ input: "q", key: key({}), context: { rows: 8, columns: 40 } })).toBe(true);
    expect(provider.handleInput({ input: "", key: key({ return: true }), context: { rows: 8, columns: 40 } })).toBe(true);
    provider.resize({ rows: 0, columns: 0 });
    provider.focus(true);
    expect(provider.click(3, 7)).toBe(true);
    await flush();

    expect(session.input).toHaveBeenCalledWith("<Esc>");
    expect(session.input).toHaveBeenCalledWith("<ScrollWheelDown>");
    expect(session.input).toHaveBeenCalledWith(":");
    expect(session.input).toHaveBeenCalledWith("w");
    expect(session.input).toHaveBeenCalledWith("q");
    expect(session.input).toHaveBeenCalledWith("<CR>");
    expect(session.resize).toHaveBeenCalledWith({ rows: 1, columns: 1 });
    expect(session.focus).toHaveBeenCalledWith(true);
    expect(session.click).toHaveBeenCalledWith(3, 7);
  });
});

function createInputEvent(eventKey: Key = baseKey, raw = "") {
  let stopped = false;
  return {
    key: eventKey,
    keypress: {
      raw,
      sequence: raw,
    },
    stopImmediatePropagation: () => {
      stopped = true;
    },
    didStopImmediatePropagation: () => stopped,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
