import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

import type { DOMElement } from "../dom.js";
import instances from "../instances.js";
import { createRoot } from "../root.js";
import ScrollBox, { type ScrollBoxHandle } from "./ScrollBox.js";
import Text from "./Text.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createTestStreams(): {
  stdin: TestStdin;
  stdout: PassThrough;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  stdout.resume();
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  return { stdin, stdout };
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream);
  if (!instance?.rootNode) throw new Error("Ink root node not found");
  return instance.rootNode;
}

function findScrollBox(node: DOMElement): DOMElement | null {
  if (
    node.nodeName === "ink-box" &&
    node.style.overflowX === "scroll" &&
    node.style.overflowY === "scroll"
  ) {
    return node;
  }

  for (const child of node.childNodes) {
    if (child.nodeName === "#text") continue;
    const found = findScrollBox(child);
    if (found) return found;
  }

  return null;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => queueMicrotask(resolve));
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
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

describe("ScrollBox imperative handle", () => {
  test("mutates DOM scroll state, notifies subscribers, and exposes viewport getters", async () => {
    const ref = React.createRef<ScrollBoxHandle>();
    const { stdin, stdout } = createTestStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    let mounted = true;

    try {
      root.render(
        <ScrollBox ref={ref} height={4}>
          <Text>scrollable content</Text>
        </ScrollBox>,
      );

      await waitForCondition(
        () => ref.current !== null && findScrollBox(getRootNode(stdout)) !== null,
        "ScrollBox did not mount",
      );

      const handle = ref.current;
      if (!handle) throw new Error("ScrollBox handle not attached");

      const scrollBox = findScrollBox(getRootNode(stdout));
      if (!scrollBox) throw new Error("ScrollBox DOM node not found");

      const render = vi.fn();
      getRootNode(stdout).onRender = render;

      expect(scrollBox.scrollTop).toBe(0);
      expect(scrollBox.style.flexDirection).toBe("row");
      expect(scrollBox.style.flexGrow).toBe(0);
      expect(scrollBox.style.flexShrink).toBe(1);
      expect(handle.isSticky()).toBe(false);

      scrollBox.scrollHeight = 31;
      scrollBox.scrollViewportHeight = 4;
      scrollBox.scrollViewportTop = 9;

      const content = scrollBox.childNodes[0] as DOMElement | undefined;
      if (!content) throw new Error("ScrollBox content wrapper not found");
      content.yogaNode = {
        getComputedHeight: () => 37,
      } as DOMElement["yogaNode"];

      expect(handle.getScrollHeight()).toBe(31);
      expect(handle.getFreshScrollHeight()).toBe(37);
      content.yogaNode = undefined;
      expect(handle.getFreshScrollHeight()).toBe(31);
      expect(handle.getViewportHeight()).toBe(4);
      expect(handle.getViewportTop()).toBe(9);

      const notifications: string[] = [];
      const unsubscribe = handle.subscribe(() => notifications.push("scroll"));

      scrollBox.attributes.stickyScroll = true;
      expect(handle.isSticky()).toBe(true);

      handle.scrollTo(6.9);
      expect(scrollBox.stickyScroll).toBe(false);
      expect(scrollBox.scrollTop).toBe(6);
      expect(scrollBox.pendingScrollDelta).toBeUndefined();
      expect(scrollBox.scrollAnchor).toBeUndefined();
      expect(handle.isSticky()).toBe(false);
      expect(notifications).toHaveLength(1);
      await flushMicrotasks();
      expect(render).toHaveBeenCalledTimes(1);

      handle.scrollBy(2.8);
      handle.scrollBy(1.2);
      expect(scrollBox.pendingScrollDelta).toBe(3);
      expect(notifications).toHaveLength(3);
      await flushMicrotasks();
      expect(render).toHaveBeenCalledTimes(2);

      const anchor = {
        yogaNode: {
          getComputedTop: () => 18,
        },
      } as DOMElement;
      handle.scrollToElement(anchor);
      expect(scrollBox.stickyScroll).toBe(false);
      expect(scrollBox.pendingScrollDelta).toBeUndefined();
      expect(scrollBox.scrollAnchor).toEqual({ el: anchor, offset: 0 });
      expect(notifications).toHaveLength(4);
      await flushMicrotasks();
      expect(render).toHaveBeenCalledTimes(3);

      handle.scrollToBottom();
      expect(scrollBox.pendingScrollDelta).toBeUndefined();
      expect(scrollBox.stickyScroll).toBe(true);
      expect(handle.isSticky()).toBe(true);
      expect(notifications).toHaveLength(5);

      handle.setClampBounds(4, 12);
      expect(scrollBox.scrollClampMin).toBe(4);
      expect(scrollBox.scrollClampMax).toBe(12);

      unsubscribe();
      handle.scrollBy(5);
      expect(notifications).toHaveLength(5);
      await flushMicrotasks();
      expect(render).toHaveBeenCalledTimes(4);

      root.unmount();
      mounted = false;
      await sleep();

      expect(handle.getScrollTop()).toBe(0);
      expect(handle.getPendingDelta()).toBe(0);
      expect(handle.getScrollHeight()).toBe(0);
      expect(handle.getFreshScrollHeight()).toBe(0);
      expect(handle.getViewportHeight()).toBe(0);
      expect(handle.getViewportTop()).toBe(0);
      expect(handle.isSticky()).toBe(false);
      expect(() => handle.scrollTo(1)).not.toThrow();
      expect(() => handle.scrollBy(1)).not.toThrow();
      expect(() => handle.scrollToElement(anchor)).not.toThrow();
      expect(() => handle.scrollToBottom()).not.toThrow();
      expect(() => handle.setClampBounds(undefined, undefined)).not.toThrow();
    } finally {
      if (mounted) root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
