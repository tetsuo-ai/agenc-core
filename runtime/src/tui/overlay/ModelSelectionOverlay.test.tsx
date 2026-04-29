import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test, vi } from "vitest";

import type { DOMElement } from "../ink/dom.js";
import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import StdinContext from "../ink/components/StdinContext.js";
import { EventEmitter } from "../ink/events/emitter.js";
import { InputEvent } from "../ink/events/input-event.js";
import { charInCellAt } from "../ink/screen.js";
import { KeybindingProvider } from "../keybindings/KeybindingContext.js";
import {
  ModelSelectionOverlay,
  type ModelSelectionItem,
} from "./ModelSelectionOverlay.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(size?: {
  readonly columns?: number;
  readonly rows?: number;
}): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = size?.columns ?? 80;
  (stdout as unknown as { rows: number }).rows = size?.rows ?? 24;
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

async function mountWithSize(
  element: React.ReactElement,
  size?: { readonly columns?: number; readonly rows?: number },
): Promise<{
  stdout: PassThrough;
  unmount: () => void;
}> {
  const { stdout, stdin } = createStreams(size);
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

function collectText(node: DOMElement): string {
  const parts: string[] = [];
  const walk = (n: DOMElement): void => {
    for (const child of n.childNodes) {
      if (child.nodeName === "#text") {
        parts.push((child as unknown as { nodeValue: string }).nodeValue ?? "");
      } else {
        walk(child as DOMElement);
      }
    }
  };
  walk(node);
  return parts.join("");
}

function getRoot(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  if (!instance?.rootNode) {
    throw new Error("Ink root missing");
  }
  return instance.rootNode;
}

function latestFrameText(stdout: PassThrough): string {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { frontFrame?: { screen?: { width: number; height: number } } }
    | undefined;
  const screen = instance?.frontFrame?.screen;
  if (!screen) return "";
  const rows: string[] = [];
  for (let y = 0; y < screen.height; y += 1) {
    let row = "";
    for (let x = 0; x < screen.width; x += 1) {
      row += charInCellAt(screen as never, x, y) ?? " ";
    }
    rows.push(row.replace(/\s+$/u, ""));
  }
  return rows.join("\n");
}

function makeKeyEvent(opts: {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  shift?: boolean;
}): InputEvent {
  return new InputEvent({
    kind: "key" as const,
    name: opts.name ?? "",
    fn: false,
    ctrl: opts.ctrl ?? false,
    meta: false,
    shift: opts.shift ?? false,
    option: false,
    super: false,
    sequence: opts.sequence ?? "",
    raw: opts.sequence ?? "",
  } as never);
}

function withProviders(
  emitter: EventEmitter,
  child: React.ReactElement,
): React.ReactElement {
  return (
    <StdinContext.Provider
      value={{
        stdin: process.stdin,
        setRawMode: () => undefined,
        isRawModeSupported: true,
        internal_exitOnCtrlC: true,
        internal_eventEmitter: emitter,
        internal_querier: null,
      }}
    >
      <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
        {child}
      </KeybindingProvider>
    </StdinContext.Provider>
  );
}

describe("ModelSelectionOverlay", () => {
  const items: readonly ModelSelectionItem[] = [
    { id: "xai", label: "xAI", description: "use xAI" },
    { id: "openai", label: "OpenAI", description: "use OpenAI" },
  ];

  test("renders title, tabs, and items", async () => {
    const emitter = new EventEmitter();
    const { stdout, unmount } = await mount(
      withProviders(
        emitter,
        <ModelSelectionOverlay
          title="Select Model Provider"
          subtitle="Choose a provider."
          tabs={["Provider", "Model"]}
          activeTab="Provider"
          items={items}
          onSelect={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );

    const text = collectText(getRoot(stdout));
    expect(text).toContain("Select Model Provider");
    expect(text).toContain("[Provider]");
    expect(text).toContain("Model");
    expect(text).toContain("xAI");
    expect(text).toContain("OpenAI");
    unmount();
  });

  test("renders options as compact single-row selection entries", async () => {
    const emitter = new EventEmitter();
    const { stdout, unmount } = await mount(
      withProviders(
        emitter,
        <ModelSelectionOverlay
          title="Select Model"
          items={[
            {
              id: "reasoning",
              label: "grok-4.20-0309-reasoning",
              description: "Reasoning model",
            },
            {
              id: "fast",
              label: "grok-4-1-fast-non-reasoning",
              description: "Fast model",
            },
          ]}
          onSelect={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );

    const rows = latestFrameText(stdout)
      .split("\n")
      .map((row) => row.trim());
    expect(
      rows.some((row) =>
        row.includes("\u203A grok-4.20-0309-reasoning  Reasoning model"),
      ),
    ).toBe(true);
    expect(rows.some((row) => row === "Reasoning model")).toBe(false);
    unmount();
  });

  test("down arrow changes selection and enter confirms it", async () => {
    const emitter = new EventEmitter();
    const onSelect = vi.fn();
    const { unmount } = await mount(
      withProviders(
        emitter,
        <ModelSelectionOverlay
          title="Select Model"
          items={items}
          onSelect={onSelect}
          onClose={() => undefined}
        />,
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "down" }));
    await new Promise((r) => setTimeout(r, 20));
    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toEqual(items[1]);
    unmount();
  });

  test("escape prefers onBack before onClose", async () => {
    const emitter = new EventEmitter();
    const onBack = vi.fn();
    const onClose = vi.fn();
    const { unmount } = await mount(
      withProviders(
        emitter,
        <ModelSelectionOverlay
          title="Select Model"
          items={items}
          onSelect={() => undefined}
          onClose={onClose}
          onBack={onBack}
        />,
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "escape" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    unmount();
  });

  test("scrolls long option lists through a bounded viewport", async () => {
    const emitter = new EventEmitter();
    const longItems = Array.from({ length: 10 }, (_, index) => ({
      id: `item-${index + 1}`,
      label: `Item ${index + 1}`,
      description: `Option ${index + 1}`,
    }));
    const { stdout, unmount } = await mountWithSize(
      withProviders(
        emitter,
        <ModelSelectionOverlay
          title="Select Item"
          items={longItems}
          onSelect={() => undefined}
          onClose={() => undefined}
        />,
      ),
      { rows: 12 },
    );

    for (let step = 0; step < 5; step += 1) {
      emitter.emit("input", makeKeyEvent({ name: "down" }));
      await new Promise((r) => setTimeout(r, 10));
    }

    const text = collectText(getRoot(stdout));
    expect(text).toContain("↑ 3 more");
    expect(text).toContain("↓ 3 more");
    expect(text).toContain("Item 6");
    expect(text).not.toContain("Item 1");
    unmount();
  });

  test("filters items as the user types and confirms the filtered selection", async () => {
    const emitter = new EventEmitter();
    const onSelect = vi.fn();
    const { stdout, unmount } = await mount(
      withProviders(
        emitter,
        <ModelSelectionOverlay
          title="Select Provider"
          items={[
            { id: "xai", label: "xAI" },
            { id: "openai", label: "OpenAI" },
            { id: "anthropic", label: "Anthropic" },
          ]}
          onSelect={onSelect}
          onClose={() => undefined}
        />,
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "o", sequence: "o" }));
    emitter.emit("input", makeKeyEvent({ name: "p", sequence: "p" }));
    await new Promise((r) => setTimeout(r, 20));

    const text = collectText(getRoot(stdout));
    expect(text).toContain("Search: op");
    expect(text).toContain("OpenAI");
    expect(text).not.toContain("xAI");

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "openai" }),
    );
    unmount();
  });

  test("skips disabled rows during navigation", async () => {
    const emitter = new EventEmitter();
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();
    const { unmount } = await mount(
      withProviders(
        emitter,
        <ModelSelectionOverlay
          title="Permission Mode"
          items={[
            { id: "default", label: "Default", disabled: true, disabledReason: "Current mode" },
            { id: "plan", label: "Plan" },
            { id: "auto", label: "Auto", disabled: true, disabledReason: "Unavailable" },
            { id: "bypass", label: "Bypass" },
          ]}
          onSelectionChange={onSelectionChange}
          onSelect={onSelect}
          onClose={() => undefined}
        />,
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "down" }));
    await new Promise((r) => setTimeout(r, 20));
    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bypass" }),
    );

    expect(onSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "plan" }),
    );
    unmount();
  });

  test("number keys select immediately when search is disabled", async () => {
    const emitter = new EventEmitter();
    const onSelect = vi.fn();
    const { unmount } = await mount(
      withProviders(
        emitter,
        <ModelSelectionOverlay
          title="Permission Mode"
          searchable={false}
          items={[
            { id: "default", label: "Default", disabled: true, disabledReason: "Current mode" },
            { id: "plan", label: "Plan" },
            { id: "auto", label: "Auto" },
          ]}
          onSelect={onSelect}
          onClose={() => undefined}
        />,
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "2", sequence: "2" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "plan" }),
    );
    unmount();
  });

  test("Ctrl+U clears the active search query", async () => {
    const emitter = new EventEmitter();
    const { stdout, unmount } = await mount(
      withProviders(
        emitter,
        <ModelSelectionOverlay
          title="Select Model"
          items={[
            { id: "grok", label: "grok-4.20" },
            { id: "gpt", label: "gpt-5" },
          ]}
          onSelect={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "g", sequence: "g" }));
    emitter.emit("input", makeKeyEvent({ name: "r", sequence: "r" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(collectText(getRoot(stdout))).toContain("Search: gr");

    emitter.emit("input", makeKeyEvent({ name: "u", sequence: "u", ctrl: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(collectText(getRoot(stdout))).toContain("Search: type to filter");
    unmount();
  });

  test("cycles tabs with arrow keys", async () => {
    const emitter = new EventEmitter();
    const onTabChange = vi.fn();
    const { unmount } = await mount(
      withProviders(
        emitter,
        <ModelSelectionOverlay
          title="Select Model Provider"
          tabs={["Provider", "Model"]}
          activeTab="Provider"
          onTabChange={onTabChange}
          items={items}
          onSelect={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "right" }));
    await new Promise((r) => setTimeout(r, 20));
    emitter.emit("input", makeKeyEvent({ name: "left" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onTabChange).toHaveBeenNthCalledWith(1, "Model");
    expect(onTabChange).toHaveBeenNthCalledWith(2, "Provider");
    unmount();
  });

  test("switching tabs clears the active search query", async () => {
    const emitter = new EventEmitter();
    function Wrapper(): React.ReactElement {
      const [activeTab, setActiveTab] = React.useState("Provider");
      return (
        <ModelSelectionOverlay
          title="Select Model Provider"
          tabs={["Provider", "Model"]}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          items={items}
          onSelect={() => undefined}
          onClose={() => undefined}
        />
      );
    }
    const { stdout, unmount } = await mount(
      withProviders(emitter, <Wrapper />),
    );

    emitter.emit("input", makeKeyEvent({ name: "x", sequence: "x" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(collectText(getRoot(stdout))).toContain("Search: x");

    emitter.emit("input", makeKeyEvent({ name: "tab" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(collectText(getRoot(stdout))).toContain("Search: type to filter");
    unmount();
  });

  test("Enter dismisses the overlay when the current filter has no matches", async () => {
    const emitter = new EventEmitter();
    const onClose = vi.fn();
    const { unmount } = await mount(
      withProviders(
        emitter,
        <ModelSelectionOverlay
          title="Select Provider"
          items={items}
          onSelect={() => undefined}
          onClose={onClose}
        />,
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "z", sequence: "z" }));
    await new Promise((r) => setTimeout(r, 20));
    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });
});
