import { PassThrough } from "node:stream";

import React, { useContext } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const virtualScroll = vi.hoisted(() => ({
  bottomSpacer: 0,
  elements: new Map<number, unknown>(),
  heights: new Map<number, number | undefined>(),
  itemTops: new Map<number, number>(),
  keys: [] as readonly string[],
  offsets: [] as number[],
  range: [0, 0] as [number, number],
  reset() {
    virtualScroll.bottomSpacer = 0;
    virtualScroll.elements = new Map();
    virtualScroll.heights = new Map();
    virtualScroll.itemTops = new Map();
    virtualScroll.keys = [];
    virtualScroll.offsets = [];
    virtualScroll.range = [0, 0];
    virtualScroll.topSpacer = 0;
  },
  topSpacer: 0,
}));

vi.mock("../hooks/useVirtualScroll.js", () => ({
  useVirtualScroll: (_scrollRef: unknown, keys: readonly string[]) => {
    virtualScroll.keys = keys;
    return {
      bottomSpacer: virtualScroll.bottomSpacer,
      getItemElement: (index: number) =>
        virtualScroll.elements.get(index) ?? null,
      getItemHeight: (index: number) => virtualScroll.heights.get(index),
      getItemTop: (index: number) => virtualScroll.itemTops.get(index) ?? -1,
      measureRef: (key: string) => (el: unknown) => {
        const index = virtualScroll.keys.indexOf(key);
        if (index >= 0 && el) virtualScroll.elements.set(index, el);
      },
      offsets: virtualScroll.offsets,
      range: virtualScroll.range,
      scrollToIndex: vi.fn(),
      spacerRef: { current: null },
      topSpacer: virtualScroll.topSpacer,
    };
  },
}));

import instances from "../ink/instances.js";
import type { DOMElement, DOMNode } from "../ink/dom.js";
import { createRoot } from "../ink/root.js";
import { Text } from "../ink.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import type { RenderableMessage } from "../../types/message.js";
import { TextHoverColorContext } from "./design-system/ThemedText.js";
import { VirtualMessageList } from "./VirtualMessageList.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function userMessage(uuid: string, text: string): RenderableMessage {
  return {
    isCompactSummary: false,
    isMeta: false,
    isVisibleInTranscriptOnly: false,
    message: { content: [{ text, type: "text" }] },
    type: "user",
    uuid,
  } as RenderableMessage;
}

function assistantMessage(uuid: string, text: string): RenderableMessage {
  return {
    message: { content: [{ text, type: "text" }] },
    type: "assistant",
    uuid,
  } as RenderableMessage;
}

function createStreams(): { stdin: TestStdin; stdout: PassThrough } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  stdout.on("data", () => {});
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  return { stdin, stdout };
}

function createScrollHandle(): ScrollBoxHandle {
  return {
    getPendingDelta: vi.fn(() => 0),
    getScrollTop: vi.fn(() => 0),
    getViewportHeight: vi.fn(() => 10),
    getViewportTop: vi.fn(() => 0),
    isSticky: vi.fn(() => true),
    scrollTo: vi.fn(),
    scrollToBottom: vi.fn(),
    scrollToElement: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as unknown as ScrollBoxHandle;
}

function collectText(node: DOMNode): string {
  if (node.nodeName === "#text") return node.nodeValue;
  return node.childNodes.map(collectText).join("");
}

function findBoxes(
  node: DOMNode,
  predicate: (node: DOMElement) => boolean,
  found: DOMElement[] = [],
): DOMElement[] {
  if (node.nodeName === "#text") return found;
  if (node.nodeName === "ink-box" && predicate(node)) found.push(node);
  for (const child of node.childNodes) findBoxes(child, predicate, found);
  return found;
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream);
  if (!instance?.rootNode) {
    throw new Error("Ink root node not found");
  }
  return instance.rootNode;
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(message);
}

describe("VirtualMessageList coverage", () => {
  beforeEach(() => {
    virtualScroll.reset();
  });

  afterEach(() => {
    virtualScroll.reset();
  });

  test("dispatches row clicks only from non-blank cells on clickable messages", async () => {
    const hoverColorByUuid = new Map<string, string>();
    const messages = [
      userMessage("u-clickable", "selectable prompt"),
      assistantMessage("a-static", "non-clickable reply"),
    ];
    virtualScroll.range = [0, messages.length];
    virtualScroll.offsets = [0, 1, 2];
    messages.forEach((_, index) => {
      virtualScroll.heights.set(index, 1);
      virtualScroll.itemTops.set(index, index);
    });

    function HoverProbe({ uuid }: { uuid: string }): React.ReactNode {
      const hoverColor = useContext(TextHoverColorContext);
      hoverColorByUuid.set(uuid, hoverColor ?? "none");
      return (
        <Text>
          {uuid}:{hoverColor ?? "none"}
        </Text>
      );
    }

    const onItemClick = vi.fn();
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <VirtualMessageList
          columns={80}
          isItemClickable={message => message.uuid === "u-clickable"}
          itemKey={message => message.uuid}
          messages={messages}
          onItemClick={onItemClick}
          renderItem={message => <HoverProbe uuid={message.uuid} />}
          scrollRef={{ current: createScrollHandle() }}
        />,
      );
      await waitForCondition(
        () => hoverColorByUuid.get("u-clickable") === "none",
        "initial row render did not complete",
      );

      const rootNode = getRootNode(stdout);
      const clickableBox = findBoxes(
        rootNode,
        box =>
          collectText(box).includes("u-clickable") &&
          typeof box._eventHandlers?.onClick === "function",
      )[0];
      const staticBox = findBoxes(rootNode, box =>
        collectText(box).includes("a-static"),
      )[0];

      expect(clickableBox).toBeDefined();
      expect(staticBox).toBeDefined();
      expect(staticBox?._eventHandlers?.onClick).toBeUndefined();
      expect(staticBox?._eventHandlers?.onMouseEnter).toBeUndefined();

      (
        clickableBox?._eventHandlers?.onClick as
          | ((event: { cellIsBlank: boolean }) => void)
          | undefined
      )?.({ cellIsBlank: true });
      expect(onItemClick).not.toHaveBeenCalled();

      (
        clickableBox?._eventHandlers?.onClick as
          | ((event: { cellIsBlank: boolean }) => void)
          | undefined
      )?.({ cellIsBlank: false });
      expect(onItemClick).toHaveBeenCalledTimes(1);
      expect(onItemClick).toHaveBeenCalledWith(messages[0]);

      (
        clickableBox?._eventHandlers?.onMouseEnter as (() => void) | undefined
      )?.();
      await waitForCondition(
        () => hoverColorByUuid.get("u-clickable") === "text",
        "hover color did not apply to clickable row",
      );

      (
        clickableBox?._eventHandlers?.onMouseLeave as (() => void) | undefined
      )?.();
      await waitForCondition(
        () => hoverColorByUuid.get("u-clickable") === "none",
        "hover color did not clear after leaving clickable row",
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
