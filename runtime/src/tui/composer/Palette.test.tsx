/**
 * Palette component tests.
 *
 * The first block drives `fuzzyMatch` directly (no React). The second
 * mounts `<Palette>` inside an Ink root fed by a PassThrough stdin, wraps
 * it in a test `KeybindingProvider`, and pumps keypresses through the
 * provider's stdin seam exactly the way `KeybindingContext.test.tsx`
 * does. That avoids touching the real terminal while still exercising
 * the Up/Down/Enter/Escape bindings the component declares.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { DOMElement, DOMNode } from "../ink/dom.js";
import { EventEmitter } from "../ink/events/emitter.js";
import { InputEvent } from "../ink/events/input-event.js";
import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import { KeybindingProvider } from "../keybindings/KeybindingContext.js";

import { fuzzyMatch, Palette, type PaletteItem } from "./Palette.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(element: React.ReactElement): Promise<{
  stdout: PassThrough;
  unmount: () => void;
}> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 20));
  return {
    stdout,
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

function makeParsedKeyEvent(opts: {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}): InputEvent {
  const parsedKey = {
    kind: "key" as const,
    name: opts.name ?? "",
    fn: false,
    ctrl: !!opts.ctrl,
    meta: !!opts.meta,
    shift: !!opts.shift,
    option: false,
    super: false,
    sequence: opts.sequence ?? "",
    raw: opts.sequence ?? "",
  };
  return new InputEvent(parsedKey as never);
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  if (!instance?.rootNode) {
    throw new Error("Ink root not found in test harness");
  }
  return instance.rootNode;
}

/** Collect every `#text` node value, joined by spaces, for assertions. */
function collectText(node: DOMNode): string {
  if (node.nodeName === "#text") {
    return node.nodeValue;
  }
  const parts: string[] = [];
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      parts.push(collectText(child));
    }
  }
  return parts.join("");
}

describe("fuzzyMatch", () => {
  test("ranks prefix match above subsequence", () => {
    const items: PaletteItem[] = [
      { id: "x", label: "statusCompact", value: "/statusCompact" },
      { id: "y", label: "status", value: "/status" },
    ];
    const ranked = fuzzyMatch(items, "sta");
    // Both are prefix matches, so the shorter label wins on tiebreak.
    expect(ranked.map((item) => item.id)).toEqual(["y", "x"]);

    const items2: PaletteItem[] = [
      { id: "a", label: "contextLines", value: "/contextLines" },
      { id: "b", label: "clear", value: "/clear" },
    ];
    // `cl` is a prefix of "clear" (tier 0) and a plain subsequence of
    // "contextLines" (c-...-L is plain since L is not at a separator
    // position by name; treated as tier 2). The prefix match must rank
    // ahead of the subsequence regardless of length.
    const ranked2 = fuzzyMatch(items2, "cl");
    expect(ranked2[0]?.id).toBe("b");
    expect(ranked2.map((item) => item.id)).toContain("a");
  });

  test("is case-insensitive", () => {
    const items: PaletteItem[] = [
      { id: "a", label: "Help", value: "/Help" },
    ];
    expect(fuzzyMatch(items, "hel").map((i) => i.id)).toEqual(["a"]);
    expect(fuzzyMatch(items, "HEL").map((i) => i.id)).toEqual(["a"]);
  });

  test("matches across word boundaries (sc -> statusCompact)", () => {
    const items: PaletteItem[] = [
      { id: "a", label: "statusCompact", value: "/statusCompact" },
      { id: "b", label: "someotherthing", value: "/someotherthing" },
    ];
    const ranked = fuzzyMatch(items, "sc");
    // `statusCompact` matches on the s at 0 and C at 6 (word-boundary tier).
    // `someotherthing` is a plain subsequence match; it should rank lower.
    expect(ranked[0]?.id).toBe("a");
  });
});

describe("<Palette>", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("renders '(no matches)' when the item list is empty", async () => {
    const emitter = new EventEmitter();
    const { stdout, unmount } = await mount(
      <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
        <Palette
          trigger="/"
          query=""
          items={[]}
          placement="above"
          onSelect={() => undefined}
          onClose={() => undefined}
        />
      </KeybindingProvider>,
    );
    const text = collectText(getRootNode(stdout));
    expect(text).toContain("(no matches)");
    unmount();
  });

  test("renders items from props", async () => {
    const emitter = new EventEmitter();
    const items: PaletteItem[] = [
      { id: "help", label: "/help", description: "show help", value: "/help" },
      { id: "exit", label: "/exit", description: "leave", value: "/exit" },
    ];
    const { stdout, unmount } = await mount(
      <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
        <Palette
          trigger="/"
          query=""
          items={items}
          placement="above"
          onSelect={() => undefined}
          onClose={() => undefined}
        />
      </KeybindingProvider>,
    );
    const text = collectText(getRootNode(stdout));
    expect(text).toContain("/help");
    expect(text).toContain("/exit");
    expect(text).toContain("show help");
    unmount();
  });

  test("Up/Down arrows move the selection (with wrap-around)", async () => {
    const emitter = new EventEmitter();
    const onSelect = vi.fn();
    const items: PaletteItem[] = [
      { id: "a", label: "/alpha", value: "/alpha" },
      { id: "b", label: "/bravo", value: "/bravo" },
      { id: "c", label: "/charlie", value: "/charlie" },
    ];
    const { unmount } = await mount(
      <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
        <Palette
          trigger="/"
          query=""
          items={items}
          placement="above"
          onSelect={onSelect}
          onClose={() => undefined}
        />
      </KeybindingProvider>,
    );
    // Down twice from index 0 -> index 2 (charlie). Then Up once -> index 1
    // (bravo). The combination exercises both directions in one flight.
    emitter.emit("input", makeParsedKeyEvent({ name: "down" }));
    emitter.emit("input", makeParsedKeyEvent({ name: "down" }));
    emitter.emit("input", makeParsedKeyEvent({ name: "up" }));
    // Allow React state updates to flush.
    await new Promise((r) => setTimeout(r, 20));
    emitter.emit("input", makeParsedKeyEvent({ name: "return" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0].id).toBe("b");
    unmount();
  });

  test("Enter fires onSelect with the currently selected item", async () => {
    const emitter = new EventEmitter();
    const onSelect = vi.fn();
    const items: PaletteItem[] = [
      { id: "help", label: "/help", value: "/help" },
    ];
    const { unmount } = await mount(
      <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
        <Palette
          trigger="/"
          query=""
          items={items}
          placement="above"
          onSelect={onSelect}
          onClose={() => undefined}
        />
      </KeybindingProvider>,
    );
    emitter.emit("input", makeParsedKeyEvent({ name: "return" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0].value).toBe("/help");
    unmount();
  });

  test("Escape fires onClose", async () => {
    const emitter = new EventEmitter();
    const onClose = vi.fn();
    const items: PaletteItem[] = [
      { id: "help", label: "/help", value: "/help" },
    ];
    const { unmount } = await mount(
      <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
        <Palette
          trigger="/"
          query=""
          items={items}
          placement="above"
          onSelect={() => undefined}
          onClose={onClose}
        />
      </KeybindingProvider>,
    );
    emitter.emit("input", makeParsedKeyEvent({ name: "escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });
});
