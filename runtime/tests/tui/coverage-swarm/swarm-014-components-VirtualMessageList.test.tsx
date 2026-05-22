import { PassThrough } from "node:stream";

import React from "react";
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
    virtualScroll.scrollToIndex.mockClear();
    virtualScroll.topSpacer = 0;
  },
  scrollToIndex: vi.fn(),
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
      scrollToIndex: virtualScroll.scrollToIndex,
      spacerRef: { current: null },
      topSpacer: virtualScroll.topSpacer,
    };
  },
}));

vi.mock("../../utils/sleep.js", () => ({
  sleep: async () => {},
}));

import { createRoot } from "../ink/root.js";
import { Text } from "../ink.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import type { DOMElement } from "../ink/dom.js";
import type { RenderableMessage } from "../../types/message.js";
import { ScrollChromeContext } from "../components/FullscreenLayout.js";
import {
  type JumpHandle,
  type StickyPrompt,
  VirtualMessageList,
} from "../components/VirtualMessageList.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type TestScrollHandle = ScrollBoxHandle & {
  emit: () => void;
  setPendingDelta: (value: number) => void;
  setSticky: (value: boolean) => void;
};

function userMessage(
  uuid: string,
  text: string,
  overrides: Partial<RenderableMessage> = {},
): RenderableMessage {
  return {
    isCompactSummary: false,
    isMeta: false,
    isVisibleInTranscriptOnly: false,
    message: { content: [{ text, type: "text" }] },
    type: "user",
    uuid,
    ...overrides,
  } as RenderableMessage;
}

function nonTextUserMessage(uuid: string): RenderableMessage {
  return {
    isCompactSummary: false,
    isMeta: false,
    isVisibleInTranscriptOnly: false,
    message: { content: [{ source: "inline", type: "image" }] },
    type: "user",
    uuid,
  } as unknown as RenderableMessage;
}

function assistantMessage(uuid: string, text: string): RenderableMessage {
  return {
    message: { content: [{ text, type: "text" }] },
    type: "assistant",
    uuid,
  } as RenderableMessage;
}

function queuedTaskNotification(uuid: string): RenderableMessage {
  return {
    attachment: {
      commandMode: "task-notification",
      isMeta: false,
      prompt: "task status should not stick",
      type: "queued_command",
    },
    type: "attachment",
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

function createScrollHandle(initialScrollTop = 0): TestScrollHandle {
  let pendingDelta = 0;
  let scrollTop = initialScrollTop;
  let sticky = false;
  const listeners = new Set<() => void>();

  return {
    emit: () => {
      for (const listener of listeners) listener();
    },
    getPendingDelta: vi.fn(() => pendingDelta),
    getScrollTop: vi.fn(() => scrollTop),
    getViewportHeight: vi.fn(() => 5),
    getViewportTop: vi.fn(() => 0),
    isSticky: vi.fn(() => sticky),
    scrollTo: vi.fn((value: number) => {
      scrollTop = value;
    }),
    scrollToBottom: vi.fn(() => {
      sticky = true;
    }),
    scrollToElement: vi.fn(),
    setPendingDelta: (value: number) => {
      pendingDelta = value;
    },
    setSticky: (value: boolean) => {
      sticky = value;
    },
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } as unknown as TestScrollHandle;
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

function renderNode({
  jumpRef,
  messages,
  onSearchMatchesChange,
  scanElement,
  scrollHandle,
  selectedIndex,
  setPositions,
  setStickyPrompt,
  trackStickyPrompt = false,
}: {
  jumpRef?: React.RefObject<JumpHandle | null>;
  messages: RenderableMessage[];
  onSearchMatchesChange?: (count: number, current: number) => void;
  scanElement?: (el: DOMElement) => Array<{ row: number; col: number }>;
  scrollHandle: ScrollBoxHandle | null;
  selectedIndex?: number;
  setPositions?: (
    state: {
      positions: Array<{ row: number; col: number }>;
      rowOffset: number;
      currentIdx: number;
    } | null,
  ) => void;
  setStickyPrompt?: (prompt: StickyPrompt | null) => void;
  trackStickyPrompt?: boolean;
}): React.ReactNode {
  return (
    <ScrollChromeContext value={{ setStickyPrompt: setStickyPrompt ?? (() => {}) }}>
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
        selectedIndex={selectedIndex}
        setPositions={setPositions}
        trackStickyPrompt={trackStickyPrompt}
      />
    </ScrollChromeContext>
  );
}

describe("VirtualMessageList swarm 014 coverage", () => {
  beforeEach(() => {
    virtualScroll.reset();
  });

  afterEach(() => {
    virtualScroll.reset();
  });

  test("rebuilds cached keys after compaction and pins an unmounted selected row", async () => {
    const messages = [
      userMessage("u-one", "first prompt"),
      assistantMessage("a-one", "reply"),
      userMessage("u-two", "second prompt"),
    ];
    virtualScroll.range = [0, 2];
    virtualScroll.offsets = [0, 2, 4, 6];
    messages.forEach((_, index) => {
      virtualScroll.heights.set(index, 1);
      virtualScroll.itemTops.set(index, index * 2);
    });

    const scrollHandle = createScrollHandle();
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        renderNode({
          messages,
          scrollHandle,
          selectedIndex: 2,
        }),
      );
      await waitForCondition(
        () => virtualScroll.scrollToIndex.mock.calls.length > 0,
        "selected row fallback did not request virtual scrolling",
      );

      expect(virtualScroll.keys).toEqual(["u-one", "a-one", "u-two"]);
      expect(virtualScroll.scrollToIndex).toHaveBeenCalledWith(2);

      const compacted = [assistantMessage("a-new", "compacted reply")];
      virtualScroll.range = [0, compacted.length];
      virtualScroll.offsets = [0, 1];
      virtualScroll.scrollToIndex.mockClear();

      root.render(
        renderNode({
          messages: compacted,
          scrollHandle,
        }),
      );
      await waitForCondition(
        () => virtualScroll.keys.length === 1,
        "compacted key cache did not rebuild",
      );

      expect(virtualScroll.keys).toEqual(["a-new"]);
      expect(virtualScroll.scrollToIndex).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("queues next-match during seek and scrolls offscreen highlights into view", async () => {
    const messages = [
      userMessage("u-needle", "needle needle"),
      assistantMessage("a-needle", "needle"),
    ];
    virtualScroll.range = [0, messages.length];
    virtualScroll.offsets = [0, 10, 20];
    virtualScroll.elements.set(0, fakeElement());
    virtualScroll.elements.set(1, fakeElement());
    messages.forEach((_, index) => {
      virtualScroll.heights.set(index, 2);
      virtualScroll.itemTops.set(index, index * 10);
    });

    const jumpRef = React.createRef<JumpHandle | null>();
    const onSearchMatchesChange = vi.fn();
    const scrollHandle = createScrollHandle();
    const setPositions = vi.fn();
    const scanElement = vi
      .fn<(_: DOMElement) => Array<{ row: number; col: number }>>()
      .mockReturnValueOnce([
        { col: 1, row: 0 },
        { col: 8, row: 14 },
      ])
      .mockReturnValue([{ col: 2, row: 1 }]);
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        renderNode({
          jumpRef,
          messages,
          onSearchMatchesChange,
          scanElement,
          scrollHandle,
          setPositions,
        }),
      );
      await waitForCondition(
        () => jumpRef.current !== null,
        "jump handle was not exposed",
      );

      jumpRef.current?.setSearchQuery("needle");
      jumpRef.current?.nextMatch();

      await waitForCondition(
        () => scanElement.mock.calls.length >= 2,
        "queued next-match did not scan the next matched row",
      );

      expect(scrollHandle.scrollTo).toHaveBeenCalledWith(11);
      expect(scrollHandle.scrollTo).toHaveBeenLastCalledWith(7);
      expect(setPositions).toHaveBeenLastCalledWith({
        currentIdx: 0,
        positions: [{ col: 2, row: 1 }],
        rowOffset: 3,
      });
      expect(onSearchMatchesChange).toHaveBeenLastCalledWith(3, 3);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("clears phantom search matches when no rendered positions are found", async () => {
    const messages = [userMessage("u-phantom", "needle")];
    virtualScroll.range = [0, messages.length];
    virtualScroll.offsets = [0, 5];
    virtualScroll.elements.set(0, fakeElement());
    virtualScroll.heights.set(0, 2);
    virtualScroll.itemTops.set(0, 5);

    const jumpRef = React.createRef<JumpHandle | null>();
    const scrollHandle = createScrollHandle();
    const setPositions = vi.fn();
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        renderNode({
          jumpRef,
          messages,
          scrollHandle,
          setPositions,
        }),
      );
      await waitForCondition(
        () => jumpRef.current !== null,
        "jump handle was not exposed",
      );

      jumpRef.current?.setSearchQuery("needle");

      await waitForCondition(
        () => setPositions.mock.calls.length >= 2,
        "phantom match did not clear search positions",
      );

      expect(scrollHandle.scrollTo).toHaveBeenCalledWith(2);
      expect(setPositions).toHaveBeenLastCalledWith(null);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("filters non-real sticky prompt candidates before publishing an older prompt", async () => {
    const messages = [
      userMessage("u-old", "old prompt\n\nhidden details"),
      userMessage("u-meta", "meta prompt", { isMeta: true } as Partial<RenderableMessage>),
      nonTextUserMessage("u-image"),
      userMessage("u-xml", "<command-message>synthetic</command-message>"),
      queuedTaskNotification("q-task"),
      userMessage("u-edge", "visible prompt at viewport top"),
      assistantMessage("a-visible", "visible reply"),
    ];
    virtualScroll.range = [6, messages.length];
    virtualScroll.offsets = [0, 8, 16, 24, 30, 34, 50, 60];
    messages.forEach((_, index) => {
      virtualScroll.heights.set(index, 2);
      virtualScroll.itemTops.set(index, virtualScroll.offsets[index]!);
    });

    const setStickyPrompt = vi.fn();
    const scrollHandle = createScrollHandle(35);
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        renderNode({
          messages,
          scrollHandle,
          setStickyPrompt,
          trackStickyPrompt: true,
        }),
      );

      await waitForCondition(() => {
        const prompt = setStickyPrompt.mock.lastCall?.[0] as StickyPrompt | null;
        return typeof prompt === "object" && prompt !== null;
      }, "sticky prompt was not published");

      const prompt = setStickyPrompt.mock.lastCall?.[0] as Exclude<
        StickyPrompt,
        "clicked"
      >;
      expect(prompt.text).toBe("old prompt");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("clears sticky prompt when the previous candidate disappears", async () => {
    const messages = [
      userMessage("u-sticky", "temporary sticky prompt"),
      assistantMessage("a-visible", "visible reply"),
    ];
    virtualScroll.range = [1, messages.length];
    virtualScroll.offsets = [0, 10, 20];
    messages.forEach((_, index) => {
      virtualScroll.heights.set(index, 2);
      virtualScroll.itemTops.set(index, index * 10);
    });

    const setStickyPrompt = vi.fn();
    const scrollHandle = createScrollHandle(12);
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        renderNode({
          messages,
          scrollHandle,
          setStickyPrompt,
          trackStickyPrompt: true,
        }),
      );

      await waitForCondition(
        () => {
          const prompt = setStickyPrompt.mock.lastCall?.[0] as
            | StickyPrompt
            | null
            | undefined;
          return typeof prompt === "object" && prompt !== null;
        },
        "initial sticky prompt was not published",
      );

      const clearedMessages = [assistantMessage("a-only", "only reply")];
      virtualScroll.range = [0, clearedMessages.length];
      virtualScroll.offsets = [0, 10];
      virtualScroll.heights = new Map([[0, 2]]);
      virtualScroll.itemTops = new Map([[0, 0]]);

      root.render(
        renderNode({
          messages: clearedMessages,
          scrollHandle,
          setStickyPrompt,
          trackStickyPrompt: true,
        }),
      );

      await waitForCondition(
        () => setStickyPrompt.mock.lastCall?.[0] === null,
        "stale sticky prompt was not cleared",
      );

      expect(setStickyPrompt).toHaveBeenLastCalledWith(null);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
