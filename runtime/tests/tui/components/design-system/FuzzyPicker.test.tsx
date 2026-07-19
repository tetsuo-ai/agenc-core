import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import instances from "../../ink/instances.js";
import type { DOMElement, DOMNode } from "../../ink/dom.js";
import { createRoot } from "../../ink/root.js";
import { Box, Text } from "../../ink.js";
import { FuzzyPicker } from "./FuzzyPicker.js";

type PickerItem = {
  readonly id: string;
  readonly label: string;
  readonly preview: string;
};

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

type PickerAction = {
  action: string;
  handler: (item: PickerItem) => void;
};

type PickerProps = {
  title: string;
  placeholder?: string;
  initialQuery?: string;
  items: readonly PickerItem[];
  renderItem: (item: PickerItem, isFocused: boolean) => React.ReactNode;
  renderPreview?: (item: PickerItem) => React.ReactNode;
  previewPosition?: "bottom" | "right";
  visibleCount?: number;
  direction?: "down" | "up";
  onQueryChange: (query: string) => void;
  onSelect: (item: PickerItem) => void;
  onTab?: PickerAction;
  onShiftTab?: PickerAction;
  onFocus?: (item: PickerItem | undefined) => void;
  onCancel: () => void;
  emptyMessage?: string | ((query: string) => string);
  matchLabel?: string;
  selectAction?: string;
  extraHints?: React.ReactNode;
};

type PickerRoot = Awaited<ReturnType<typeof createRoot>>;

type PickerHarness = {
  stdout: PassThrough;
  stdin: TestStdin;
  root: PickerRoot;
  render: (next?: Partial<PickerProps>) => void;
  text: () => string;
  segments: () => string[];
  boxes: (predicate: (node: DOMElement) => boolean) => DOMElement[];
  send: (sequence: string) => Promise<void>;
  dispose: () => Promise<void>;
};

const ITEMS: readonly PickerItem[] = [
  { id: "alpha", label: "Alpha result", preview: "Alpha preview" },
  { id: "bravo", label: "Bravo result", preview: "Bravo preview" },
  { id: "charlie", label: "Charlie result", preview: "Charlie preview" },
  { id: "delta", label: "Delta result", preview: "Delta preview" },
  { id: "echo", label: "Echo result", preview: "Echo preview" },
];

const mountedHarnesses: PickerHarness[] = [];

afterEach(async () => {
  while (mountedHarnesses.length > 0) {
    await mountedHarnesses.pop()?.dispose();
  }
});

function createTestStreams(columns = 120, rows = 30): {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: TestStdin;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdout.on("data", () => {});
  stderr.on("data", () => {});

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  (stdout as unknown as { columns: number }).columns = columns;
  (stdout as unknown as { rows: number }).rows = rows;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  return { stdout, stderr, stdin };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }

  throw new Error(message);
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(
    stdout as unknown as NodeJS.WriteStream,
  ) as { rootNode?: DOMElement } | undefined;

  if (!instance?.rootNode) {
    throw new Error("Ink root node not found");
  }

  return instance.rootNode;
}

function collectText(node: DOMNode): string {
  if (node.nodeName === "#text") return node.nodeValue;
  return node.childNodes.map(collectText).join("");
}

function collectTextSegments(node: DOMNode, segments: string[] = []): string[] {
  if (node.nodeName === "#text") {
    if (node.nodeValue !== "") segments.push(node.nodeValue);
    return segments;
  }

  for (const child of node.childNodes) {
    collectTextSegments(child, segments);
  }

  return segments;
}

function findBoxes(
  node: DOMNode,
  predicate: (node: DOMElement) => boolean,
  results: DOMElement[] = [],
): DOMElement[] {
  if (node.nodeName !== "#text") {
    if (node.nodeName === "ink-box" && predicate(node)) {
      results.push(node);
    }

    for (const child of node.childNodes) {
      findBoxes(child, predicate, results);
    }
  }

  return results;
}

function itemText(item: PickerItem, isFocused: boolean): React.ReactNode {
  return (
    <Text>
      {isFocused ? "focused" : "plain"}:{item.label}
    </Text>
  );
}

async function createPickerHarness(
  overrides: Partial<PickerProps> = {},
  viewport: { readonly columns?: number; readonly rows?: number } = {},
): Promise<PickerHarness> {
  const { stdout, stderr, stdin } = createTestStreams(
    viewport.columns ?? 120,
    viewport.rows ?? 30,
  );
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  const props: PickerProps = {
    title: "Pick result",
    items: ITEMS,
    renderItem: itemText,
    onQueryChange: vi.fn(),
    onSelect: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  } as PickerProps;

  const render = (next: Partial<PickerProps> = {}) => {
    Object.assign(props, next);
    root.render(
      <FuzzyPicker<PickerItem>
        title={props.title}
        placeholder={props.placeholder}
        initialQuery={props.initialQuery}
        items={props.items}
        getKey={item => item.id}
        renderItem={props.renderItem}
        renderPreview={props.renderPreview}
        previewPosition={props.previewPosition}
        visibleCount={props.visibleCount}
        direction={props.direction}
        onQueryChange={props.onQueryChange}
        onSelect={props.onSelect}
        onTab={props.onTab}
        onShiftTab={props.onShiftTab}
        onFocus={props.onFocus}
        onCancel={props.onCancel}
        emptyMessage={props.emptyMessage}
        matchLabel={props.matchLabel}
        selectAction={props.selectAction}
        extraHints={props.extraHints}
      />,
    );
  };

  render();

  const harness = {
    stdout,
    stdin,
    root,
    render,
    text: () => collectText(getRootNode(stdout)),
    segments: () => collectTextSegments(getRootNode(stdout)),
    boxes: (predicate: (node: DOMElement) => boolean) =>
      findBoxes(getRootNode(stdout), predicate),
    send: async (sequence: string) => {
      stdin.write(sequence);
      await sleep(sequence === "\x1b" ? 90 : 30);
    },
    dispose: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      stderr.end();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      await sleep(20);
    },
  };

  mountedHarnesses.push(harness);

  await waitForCondition(
    () => harness.text().includes(props.title),
    "FuzzyPicker did not mount",
  );

  return harness;
}

async function waitForLatestFocus(
  focusCalls: PickerItem[],
  id: string,
): Promise<void> {
  await waitForCondition(
    () => focusCalls.at(-1)?.id === id,
    `Expected focus to move to ${id}`,
  );
}

describe("FuzzyPicker", () => {
  test("updates the query, renders the query-aware empty message, and cancels", async () => {
    const onQueryChange = vi.fn();
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const harness = await createPickerHarness({
      items: [],
      onQueryChange,
      onSelect,
      onCancel,
      emptyMessage: query => `No picks for ${query || "empty query"}`,
    });

    await waitForCondition(
      () => onQueryChange.mock.calls.some(([query]) => query === ""),
      "Initial query was not reported",
    );
    expect(harness.text()).toContain("No picks for empty query");

    await harness.send("ab");
    await waitForCondition(
      () => onQueryChange.mock.calls.some(([query]) => query === "ab"),
      "Typed query was not reported",
    );
    expect(harness.text()).toContain("No picks for ab");

    await harness.send("\r");
    await harness.send("\t");
    expect(onSelect).not.toHaveBeenCalled();

    await harness.send("\x1b");
    await waitForCondition(
      () => onCancel.mock.calls.length === 1,
      "Escape did not cancel the picker",
    );
  });

  test("moves focus through the visible window and clamps at list bounds", async () => {
    const focusCalls: PickerItem[] = [];
    const renderItem = vi.fn(itemText);
    const onSelect = vi.fn();
    const harness = await createPickerHarness({
      visibleCount: 3,
      matchLabel: "5 matches",
      renderItem,
      onSelect,
      onFocus: item => {
        if (item) focusCalls.push(item);
      },
    });

    await waitForLatestFocus(focusCalls, "alpha");
    expect(harness.text()).toContain("Alpha result");
    expect(harness.text()).toContain("Bravo result");
    expect(harness.text()).toContain("Charlie result");
    expect(harness.text()).not.toContain("Delta result");

    await harness.send("\x1b[B");
    await waitForLatestFocus(focusCalls, "bravo");
    await harness.send("\x0e");
    await waitForLatestFocus(focusCalls, "charlie");
    await harness.send("\x1b[B");
    await waitForLatestFocus(focusCalls, "delta");
    expect(harness.text()).not.toContain("Alpha result");
    expect(harness.text()).toContain("Bravo result");
    expect(harness.text()).toContain("Charlie result");
    expect(harness.text()).toContain("Delta result");

    await harness.send("\x1b[B");
    await waitForLatestFocus(focusCalls, "echo");
    await harness.send("\x1b[B");
    await sleep(30);
    expect(focusCalls.at(-1)?.id).toBe("echo");
    expect(harness.text()).not.toContain("Alpha result");
    expect(harness.text()).not.toContain("Bravo result");
    expect(harness.text()).toContain("Charlie result");
    expect(harness.text()).toContain("Delta result");
    expect(harness.text()).toContain("Echo result");

    await harness.send("\x1b[A");
    await waitForLatestFocus(focusCalls, "delta");
    await harness.send("\x10");
    await waitForLatestFocus(focusCalls, "charlie");

    await harness.send("\r");
    expect(onSelect).toHaveBeenLastCalledWith(ITEMS[2]);
    expect(renderItem).toHaveBeenCalledWith(ITEMS[2], true);
    expect(renderItem).toHaveBeenCalledWith(ITEMS[1], false);
  });

  test("routes select, tab, shift-tab, and tab fallback actions", async () => {
    const onSelect = vi.fn();
    const onTab = { action: "insert", handler: vi.fn() };
    const onShiftTab = { action: "open", handler: vi.fn() };
    const harness = await createPickerHarness({
      onSelect,
      onTab,
      onShiftTab,
      selectAction: "select result",
    });

    await harness.send("\x1b[B");
    await harness.send("\r");
    expect(onSelect).toHaveBeenLastCalledWith(ITEMS[1]);

    await harness.send("\t");
    expect(onTab.handler).toHaveBeenLastCalledWith(ITEMS[1]);

    await harness.send("\x1b[Z");
    expect(onShiftTab.handler).toHaveBeenLastCalledWith(ITEMS[1]);

    const fallbackSelect = vi.fn();
    const fallbackHarness = await createPickerHarness({
      onSelect: fallbackSelect,
      onTab: undefined,
      onShiftTab: undefined,
    });

    await fallbackHarness.send("\t");
    expect(fallbackSelect).toHaveBeenLastCalledWith(ITEMS[0]);
  });

  test("renders bottom and right preview paths and preserves the right preview slot when empty", async () => {
    const renderPreview = vi.fn((item: PickerItem) => (
      <Box flexDirection="column">
        <Text>Preview panel:{item.preview}</Text>
      </Box>
    ));
    const harness = await createPickerHarness({
      visibleCount: 2,
      matchLabel: "2 matches",
      items: ITEMS.slice(0, 2),
      renderPreview,
      previewPosition: "bottom",
    });

    await waitForCondition(
      () => harness.text().includes("Preview panel:Alpha preview"),
      "Bottom preview did not render",
    );
    const bottomSegments = harness.segments();
    expect(bottomSegments.indexOf("2 matches")).toBeLessThan(
      bottomSegments.indexOf("Preview panel:"),
    );
    expect(
      harness.boxes(
        box =>
          box.style.flexDirection === "row" &&
          box.style.gap === 2 &&
          collectText(box).includes("Preview panel:Alpha preview"),
      ),
    ).toHaveLength(0);

    harness.render({ previewPosition: "right" });
    await waitForCondition(
      () =>
        harness.boxes(
          box =>
            box.style.flexDirection === "row" &&
            box.style.gap === 2 &&
            box.style.height === 3 &&
            collectText(box).includes("Preview panel:Alpha preview"),
        ).length === 1,
      "Right preview row did not render",
    );

    await harness.send("\x1b[B");
    await waitForCondition(
      () => harness.text().includes("Preview panel:Bravo preview"),
      "Focused preview did not update",
    );
    expect(renderPreview).toHaveBeenCalledWith(ITEMS[1]);

    const previewCallsBeforeEmpty = renderPreview.mock.calls.length;
    harness.render({
      items: [],
      emptyMessage: "No previewable items",
      matchLabel: "0 matches",
    });
    await waitForCondition(
      () => harness.text().includes("No previewable items"),
      "Empty right-preview state did not render",
    );
    expect(renderPreview).toHaveBeenCalledTimes(previewCallsBeforeEmpty);
    expect(harness.text()).not.toContain("Preview panel:");
    expect(
      harness.boxes(
        box =>
          box.style.flexDirection === "row" &&
          box.style.gap === 2 &&
          box.style.height === 3,
      ),
    ).toHaveLength(1);
  });

  test("renders upward lists with the input below and reversed screen-direction movement", async () => {
    const focusCalls: PickerItem[] = [];
    const harness = await createPickerHarness({
      direction: "up",
      visibleCount: 2,
      onFocus: item => {
        if (item) focusCalls.push(item);
      },
    });

    await waitForLatestFocus(focusCalls, "alpha");
    expect(
      harness.boxes(
        box =>
          box.style.flexDirection === "column-reverse" &&
          box.style.height === 2 &&
          collectText(box).includes("Alpha result"),
      ),
    ).toHaveLength(1);

    const text = harness.text();
    expect(text.indexOf("Alpha result")).toBeLessThan(
      text.indexOf("Type to search"),
    );

    await harness.send("\x1b[B");
    await sleep(30);
    expect(focusCalls.at(-1)?.id).toBe("alpha");

    await harness.send("\x1b[A");
    await waitForLatestFocus(focusCalls, "bravo");
  });

  test("clips the bottom preview to its row budget and hides it when no rows are left", async () => {
    const renderPreview = vi.fn((item: PickerItem) => (
      <Box flexDirection="column">
        <Text>Preview panel:{item.preview}</Text>
        <Text>extra line 1</Text>
        <Text>extra line 2</Text>
        <Text>extra line 3</Text>
      </Box>
    ));

    // rows=13, visibleCount=2, no matchLabel → budget = 13 - 10 - 2 = 1 row.
    const harness = await createPickerHarness(
      { visibleCount: 2, renderPreview },
      { rows: 13 },
    );

    await waitForCondition(
      () => harness.text().includes("Preview panel:Alpha preview"),
      "Budgeted preview did not render",
    );
    const previewBoxes = harness.boxes(
      box =>
        box.style.overflowY === "hidden" &&
        collectText(box).includes("Preview panel:"),
    );
    expect(previewBoxes).toHaveLength(1);
    expect(previewBoxes[0]?.style.maxHeight).toBe(1);
    expect(previewBoxes[0]?.yogaNode?.getComputedHeight()).toBeLessThanOrEqual(1);
    expect(harness.text()).toContain("Type to search");

    // rows=12 → budget = 0: the preview is hidden outright so the result list
    // and the search box keep their rows.
    const hiddenHarness = await createPickerHarness(
      { visibleCount: 2, renderPreview },
      { rows: 12 },
    );
    await waitForCondition(
      () => hiddenHarness.text().includes("Alpha result"),
      "List did not render with hidden preview",
    );
    expect(hiddenHarness.text()).not.toContain("Preview panel:");
    expect(hiddenHarness.text()).toContain("Type to search");
    expect(
      hiddenHarness.boxes(box => collectText(box).includes("Preview panel:")),
    ).toHaveLength(0);
  });
});
