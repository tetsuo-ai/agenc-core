import { PassThrough } from "node:stream";

import React, { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import type { DOMElement } from "../ink/dom.js";
import {
  type VirtualScrollResult,
  useVirtualScroll,
} from "./useVirtualScroll.js";

type FakeScrollHandle = ScrollBoxHandle & {
  emit: () => void;
  lastClamp: [number | undefined, number | undefined] | undefined;
  scrollToCalls: number[];
  setPendingDelta: (value: number) => void;
  setScrollTop: (value: number) => void;
  setSticky: (value: boolean) => void;
  setViewportHeight: (value: number) => void;
};

function createScrollHandle(
  overrides: {
    pendingDelta?: number;
    scrollTop?: number;
    sticky?: boolean;
    viewportHeight?: number;
  } = {},
): FakeScrollHandle {
  let scrollTop = overrides.scrollTop ?? 0;
  let pendingDelta = overrides.pendingDelta ?? 0;
  let sticky = overrides.sticky ?? false;
  let viewportHeight = overrides.viewportHeight ?? 20;
  const listeners = new Set<() => void>();
  const handle = {
    emit: () => {
      for (const listener of listeners) listener();
    },
    getPendingDelta: () => pendingDelta,
    getScrollTop: () => scrollTop,
    getViewportHeight: () => viewportHeight,
    isSticky: () => sticky,
    lastClamp: undefined as [number | undefined, number | undefined] | undefined,
    scrollTo: vi.fn((value: number) => {
      handle.scrollToCalls.push(value);
      scrollTop = value;
    }),
    scrollToCalls: [] as number[],
    setClampBounds: vi.fn((min?: number, max?: number) => {
      handle.lastClamp = [min, max];
    }),
    setPendingDelta: (value: number) => {
      pendingDelta = value;
    },
    setScrollTop: (value: number) => {
      scrollTop = value;
    },
    setSticky: (value: boolean) => {
      sticky = value;
    },
    setViewportHeight: (value: number) => {
      viewportHeight = value;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as FakeScrollHandle;
  return handle;
}

function createStreams(): {
  stdout: PassThrough;
  stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  stdout.resume();
  return { stdin, stdout };
}

function fakeElement(
  height: number,
  top: number,
  width = 10,
): DOMElement {
  return {
    yogaNode: {
      getComputedHeight: () => height,
      getComputedTop: () => top,
      getComputedWidth: () => width,
    },
  } as DOMElement;
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function renderHookHarness(
  initial: {
    columns?: number;
    itemKeys: readonly string[];
    scrollRef: React.RefObject<ScrollBoxHandle | null>;
  },
): Promise<{
  dispose: () => Promise<void>;
  latest: () => VirtualScrollResult;
  render: (next?: Partial<typeof initial>) => Promise<void>;
}> {
  let props = {
    columns: 80,
    ...initial,
  };
  let latest: VirtualScrollResult | undefined;
  const { stdin, stdout } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  function Harness(): null {
    latest = useVirtualScroll(props.scrollRef, props.itemKeys, props.columns);
    useLayoutEffect(() => {
      latest = latest;
    });
    return null;
  }

  async function render(next: Partial<typeof initial> = {}): Promise<void> {
    props = {
      ...props,
      ...next,
    };
    root.render(<Harness />);
    await sleep();
  }

  await render();
  return {
    dispose: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    },
    latest: () => {
      if (!latest) throw new Error("hook did not render");
      return latest;
    },
    render,
  };
}

describe("useVirtualScroll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders a tail range before the scrollbox is attached", async () => {
    const harness = await renderHookHarness({
      itemKeys: Array.from({ length: 40 }, (_, index) => `item-${index}`),
      scrollRef: { current: null },
    });

    try {
      expect(harness.latest().range).toEqual([10, 40]);
      expect(harness.latest().topSpacer).toBe(30);
      expect(harness.latest().bottomSpacer).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  test("uses sticky mode to mount the tail and clears clamp bounds", async () => {
    const scroll = createScrollHandle({ sticky: true, viewportHeight: 20 });
    const harness = await renderHookHarness({
      itemKeys: Array.from({ length: 400 }, (_, index) => `item-${index}`),
      scrollRef: { current: scroll },
    });

    try {
      const result = harness.latest();
      expect(result.range[1]).toBe(400);
      expect(result.range[1] - result.range[0]).toBeLessThanOrEqual(300);
      expect(result.topSpacer).toBeGreaterThan(0);
      expect(scroll.setClampBounds).toHaveBeenLastCalledWith(undefined, undefined);
    } finally {
      await harness.dispose();
    }
  });

  test("computes a non-sticky range from committed and pending scroll", async () => {
    const scroll = createScrollHandle({
      pendingDelta: 240,
      scrollTop: 600,
      sticky: false,
      viewportHeight: 20,
    });
    const harness = await renderHookHarness({
      itemKeys: Array.from({ length: 500 }, (_, index) => `item-${index}`),
      scrollRef: { current: scroll },
    });

    try {
      const result = harness.latest();
      expect(result.range[0]).toBeGreaterThan(0);
      expect(result.range[1]).toBeGreaterThan(result.range[0]);
      expect(result.range[1] - result.range[0]).toBeLessThanOrEqual(300);
      expect(result.topSpacer).toBe(result.offsets[result.range[0]]);
      expect(scroll.lastClamp?.[0]).toBe(result.topSpacer);
      expect(scroll.lastClamp?.[1]).toBeGreaterThan(result.topSpacer);
    } finally {
      await harness.dispose();
    }
  });

  test("stores measured heights and scrolls to cached item offsets", async () => {
    const scroll = createScrollHandle({
      scrollTop: 0,
      sticky: false,
      viewportHeight: 20,
    });
    const harness = await renderHookHarness({
      itemKeys: ["a", "b", "c"],
      scrollRef: { current: scroll },
    });

    try {
      harness.latest().measureRef("a")(fakeElement(5, 11));
      harness.latest().measureRef("b")(fakeElement(7, 16));
      harness.latest().spacerRef.current = fakeElement(0, 4);
      await harness.render();
      await harness.render();

      const result = harness.latest();
      expect(result.getItemTop(0)).toBe(11);
      expect(result.getItemElement(1)).not.toBeNull();
      expect(result.getItemHeight(0)).toBe(5);
      expect(result.getItemHeight(1)).toBe(7);
      expect(Array.from(result.offsets).slice(0, 4)).toEqual([0, 5, 12, 15]);

      result.scrollToIndex(2);
      expect(scroll.scrollToCalls).toEqual([16]);

      result.measureRef("b")(null);
      expect(result.getItemElement(1)).toBeNull();
      expect(result.getItemHeight(1)).toBe(7);
    } finally {
      await harness.dispose();
    }
  });

  test("scales cached heights and freezes range across column changes", async () => {
    const scroll = createScrollHandle({
      scrollTop: 0,
      sticky: false,
      viewportHeight: 20,
    });
    const harness = await renderHookHarness({
      columns: 100,
      itemKeys: ["a", "b", "c", "d"],
      scrollRef: { current: scroll },
    });

    try {
      harness.latest().measureRef("a")(fakeElement(10, 0));
      harness.latest().measureRef("b")(fakeElement(20, 10));
      await harness.render();
      await harness.render();
      const beforeResize = harness.latest().range;
      harness.latest().measureRef("a")(fakeElement(3, 0));

      await harness.render({ columns: 50 });
      const firstResize = harness.latest();
      expect(firstResize.range).toEqual(beforeResize);
      expect(firstResize.getItemHeight(0)).toBe(20);
      expect(firstResize.getItemHeight(1)).toBe(40);

      await harness.render();
      expect(harness.latest().getItemHeight(0)).toBe(3);
    } finally {
      await harness.dispose();
    }
  });
});
