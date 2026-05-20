import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const virtualScroll = vi.hoisted(() => ({
  elements: new Map<number, unknown>(),
  itemTops: new Map<number, number>(),
  offsets: [] as number[],
  range: [0, 0] as [number, number],
  reset() {
    virtualScroll.elements = new Map();
    virtualScroll.itemTops = new Map();
    virtualScroll.offsets = [];
    virtualScroll.range = [0, 0];
    virtualScroll.scrollToIndex.mockClear();
  },
  scrollToIndex: vi.fn(),
}));

vi.mock("../hooks/useVirtualScroll.js", () => ({
  useVirtualScroll: (_scrollRef: unknown, keys: readonly string[]) => ({
    bottomSpacer: 0,
    getItemElement: (index: number) =>
      virtualScroll.elements.get(index) ?? null,
    getItemHeight: () => 2,
    getItemTop: (index: number) => virtualScroll.itemTops.get(index) ?? -1,
    measureRef: (_key: string) => () => {},
    offsets: virtualScroll.offsets,
    range: virtualScroll.range,
    scrollToIndex: virtualScroll.scrollToIndex,
    spacerRef: { current: null },
    topSpacer: 0,
  }),
}));

import { createRoot } from "../ink/root.js";
import { Text } from "../ink.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import type { DOMElement } from "../ink/dom.js";
import type { RenderableMessage } from "../../types/message.js";
import { ScrollChromeContext } from "./FullscreenLayout.js";
import {
  type StickyPrompt,
  VirtualMessageList,
} from "./VirtualMessageList.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function assistantMessage(uuid: string, text: string): RenderableMessage {
  return {
    message: { content: [{ text, type: "text" }] },
    type: "assistant",
    uuid,
  } as RenderableMessage;
}

function queuedCommandMessage(uuid: string): RenderableMessage {
  return {
    attachment: {
      commandMode: "prompt",
      isMeta: false,
      prompt: [
        {
          text:
            "<system-reminder>hidden</system-reminder>\n\n" +
            "queued   command starts here\nwith continuation\n\nignored paragraph",
          type: "text",
        },
        { type: "image" },
      ],
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

function createScrollHandle(initialScrollTop = 20): ScrollBoxHandle {
  const listeners = new Set<() => void>();
  let scrollTop = initialScrollTop;

  return {
    getPendingDelta: vi.fn(() => 0),
    getScrollTop: vi.fn(() => scrollTop),
    isSticky: vi.fn(() => false),
    scrollTo: vi.fn((value: number) => {
      scrollTop = value;
    }),
    scrollToElement: vi.fn(),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
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

describe("VirtualMessageList wave200 coverage", () => {
  beforeEach(() => {
    virtualScroll.reset();
  });

  afterEach(() => {
    virtualScroll.reset();
  });

  test("publishes a collapsed queued-command sticky prompt that jumps to its mounted row", async () => {
    const messages = [
      assistantMessage("a-before", "earlier output"),
      queuedCommandMessage("queued-prompt"),
      assistantMessage("a-after", "visible output"),
    ];
    const queuedElement = fakeElement();
    virtualScroll.range = [0, messages.length];
    virtualScroll.offsets = [0, 10, 30, 40];
    virtualScroll.elements.set(1, queuedElement);
    virtualScroll.itemTops.set(0, 0);
    virtualScroll.itemTops.set(1, 10);
    virtualScroll.itemTops.set(2, 30);

    const setStickyPrompt = vi.fn();
    const scrollHandle = createScrollHandle();
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <ScrollChromeContext value={{ setStickyPrompt }}>
          <VirtualMessageList
            columns={80}
            itemKey={message => message.uuid}
            messages={messages}
            renderItem={message => <Text>{message.uuid}</Text>}
            scrollRef={{ current: scrollHandle }}
            trackStickyPrompt
          />
        </ScrollChromeContext>,
      );

      await waitForCondition(() => {
        const prompt = setStickyPrompt.mock.lastCall?.[0] as
          | StickyPrompt
          | null
          | undefined;
        return typeof prompt === "object" && prompt !== null;
      }, "sticky prompt was not published");

      const prompt = setStickyPrompt.mock.lastCall?.[0] as Exclude<
        StickyPrompt,
        "clicked"
      >;
      expect(prompt.text).toBe(
        "queued command starts here with continuation",
      );

      prompt.scrollTo();

      expect(setStickyPrompt).toHaveBeenLastCalledWith("clicked");
      expect(scrollHandle.scrollToElement).toHaveBeenCalledWith(
        queuedElement,
        1,
      );
      expect(scrollHandle.scrollTo).not.toHaveBeenCalled();
      expect(virtualScroll.scrollToIndex).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
