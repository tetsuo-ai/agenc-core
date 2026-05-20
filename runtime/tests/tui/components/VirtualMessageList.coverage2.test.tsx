import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const virtualScroll = vi.hoisted(() => ({
  elements: new Map<number, unknown>(),
  heights: new Map<number, number | undefined>(),
  itemTops: new Map<number, number>(),
  keys: [] as readonly string[],
  offsets: [] as number[],
  range: [0, 0] as [number, number],
  reset() {
    virtualScroll.elements = new Map();
    virtualScroll.heights = new Map();
    virtualScroll.itemTops = new Map();
    virtualScroll.keys = [];
    virtualScroll.offsets = [];
    virtualScroll.range = [0, 0];
    virtualScroll.scrollToIndex.mockClear();
  },
  scrollToIndex: vi.fn(),
}));

vi.mock("../hooks/useVirtualScroll.js", () => ({
  useVirtualScroll: (_scrollRef: unknown, keys: readonly string[]) => {
    virtualScroll.keys = keys;
    return {
      bottomSpacer: 0,
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
      scrollToIndex: virtualScroll.scrollToIndex,
      spacerRef: { current: null },
      topSpacer: 0,
    };
  },
}));

import { createRoot } from "../ink/root.js";
import { Text } from "../ink.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import type { DOMElement } from "../ink/dom.js";
import type { RenderableMessage } from "../../types/message.js";
import {
  type JumpHandle,
  VirtualMessageList,
} from "./VirtualMessageList.js";

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

function fakeElement(height = 2): DOMElement {
  return {
    yogaNode: {
      getComputedHeight: () => height,
    },
  } as DOMElement;
}

function createStreams(): { stdin: TestStdin; stdout: PassThrough } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  stdout.on("data", () => {});
  stdout.resume();

  return { stdin, stdout };
}

function createScrollHandle(initialScrollTop = 0): ScrollBoxHandle {
  let scrollTop = initialScrollTop;

  return {
    getPendingDelta: vi.fn(() => 0),
    getScrollTop: vi.fn(() => scrollTop),
    getViewportHeight: vi.fn(() => 10),
    getViewportTop: vi.fn(() => 0),
    isSticky: vi.fn(() => false),
    scrollTo: vi.fn((value: number) => {
      scrollTop = value;
    }),
    scrollToBottom: vi.fn(),
    scrollToElement: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as unknown as ScrollBoxHandle;
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

describe("VirtualMessageList coverage 2", () => {
  beforeEach(() => {
    virtualScroll.reset();
  });

  afterEach(() => {
    virtualScroll.reset();
  });

  test("uses the default transcript search extractor across repeated queries", async () => {
    const messages = [
      userMessage("u-needle", "Alpha NEEDLE prompt"),
      assistantMessage("a-other", "ordinary reply"),
    ];
    virtualScroll.range = [0, messages.length];
    virtualScroll.offsets = [0, 8, 16];
    messages.forEach((_, index) => {
      virtualScroll.elements.set(index, fakeElement());
      virtualScroll.heights.set(index, 2);
      virtualScroll.itemTops.set(index, index * 8);
    });

    const jumpRef = React.createRef<JumpHandle | null>();
    const scrollHandle = createScrollHandle();
    const onSearchMatchesChange = vi.fn();
    const setPositions = vi.fn();
    const scanElement = vi.fn(() => [{ col: 6, row: 0 }]);
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
          itemKey={message => message.uuid}
          jumpRef={jumpRef}
          messages={messages}
          onSearchMatchesChange={onSearchMatchesChange}
          renderItem={(message, index) => (
            <Text>
              {index}:{message.uuid}
            </Text>
          )}
          scanElement={scanElement}
          scrollRef={{ current: scrollHandle }}
          setPositions={setPositions}
        />,
      );
      await waitForCondition(
        () => jumpRef.current !== null,
        "jump handle was not exposed",
      );

      jumpRef.current?.setSearchQuery("needle");
      await waitForCondition(
        () => scanElement.mock.calls.length === 1,
        "first default-extractor search did not scan the matched row",
      );

      expect(scrollHandle.scrollTo).toHaveBeenLastCalledWith(0);
      expect(scanElement).toHaveBeenLastCalledWith(
        virtualScroll.elements.get(0),
      );
      expect(setPositions).toHaveBeenLastCalledWith({
        currentIdx: 0,
        positions: [{ col: 6, row: 0 }],
        rowOffset: 0,
      });
      expect(onSearchMatchesChange).toHaveBeenLastCalledWith(1, 1);

      jumpRef.current?.setSearchQuery("NEEDLE");
      await waitForCondition(
        () => scanElement.mock.calls.length === 2,
        "cached default-extractor search did not rescan the matched row",
      );

      expect(onSearchMatchesChange).toHaveBeenLastCalledWith(1, 1);
      expect(virtualScroll.scrollToIndex).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
