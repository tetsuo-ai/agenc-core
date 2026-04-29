import type { RefObject } from "react";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import type { DOMElement } from "../ink/dom.js";

const DEFAULT_ESTIMATE_ROWS = 3;
const OVERSCAN_ROWS = 60;
const COLD_START_COUNT = 40;
export const VIRTUAL_SCROLL_MAX_MOUNTED_ITEMS = 240;

export interface VirtualScrollWindow {
  readonly range: readonly [number, number];
  readonly topSpacer: number;
  readonly bottomSpacer: number;
  readonly measureRef: (key: string) => (el: DOMElement | null) => void;
  readonly getItemTop: (index: number) => number;
  readonly getItemElement: (index: number) => DOMElement | null;
  readonly getItemHeight: (index: number) => number | undefined;
  readonly scrollToIndex: (index: number) => void;
}

function buildOffsets(
  itemKeys: readonly string[],
  heights: ReadonlyMap<string, number>,
): Float64Array {
  const offsets = new Float64Array(itemKeys.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < itemKeys.length; index += 1) {
    offsets[index + 1] =
      offsets[index]! + (heights.get(itemKeys[index]!) ?? DEFAULT_ESTIMATE_ROWS);
  }
  return offsets;
}

function findStart(offsets: Float64Array, lowRow: number): number {
  let left = 0;
  let right = Math.max(0, offsets.length - 1);
  while (left < right) {
    const mid = (left + right) >> 1;
    if (offsets[mid + 1]! <= lowRow) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left;
}

function computeWindow(args: {
  readonly itemCount: number;
  readonly offsets: Float64Array;
  readonly scrollTop: number;
  readonly pendingDelta: number;
  readonly viewportHeight: number;
  readonly sticky: boolean;
}): readonly [number, number] {
  const { itemCount, offsets, scrollTop, pendingDelta, viewportHeight, sticky } =
    args;
  if (itemCount <= VIRTUAL_SCROLL_MAX_MOUNTED_ITEMS) {
    return [0, itemCount];
  }
  if (viewportHeight <= 0 || scrollTop < 0) {
    return [Math.max(0, itemCount - COLD_START_COUNT), itemCount];
  }

  if (sticky) {
    const targetTop = Math.max(0, offsets[itemCount]! - viewportHeight - OVERSCAN_ROWS);
    const start = Math.max(
      0,
      Math.min(
        findStart(offsets, targetTop),
        itemCount - VIRTUAL_SCROLL_MAX_MOUNTED_ITEMS,
      ),
    );
    return [start, itemCount];
  }

  const targetScrollTop = Math.max(0, scrollTop + pendingDelta);
  const low = Math.max(0, Math.min(scrollTop, targetScrollTop) - OVERSCAN_ROWS);
  const high =
    Math.max(scrollTop, targetScrollTop) + viewportHeight + OVERSCAN_ROWS;
  let start = findStart(offsets, low);
  let end = start;
  while (
    end < itemCount &&
    end - start < VIRTUAL_SCROLL_MAX_MOUNTED_ITEMS &&
    offsets[end]! < high
  ) {
    end += 1;
  }
  if (end === start) {
    end = Math.min(itemCount, start + 1);
  }
  return [start, end];
}

export function useVirtualScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  itemKeys: readonly string[],
  columns: number,
): VirtualScrollWindow {
  const heightsRef = useRef(new Map<string, number>());
  const itemRefs = useRef(new Map<string, DOMElement>());
  const refCache = useRef(new Map<string, (el: DOMElement | null) => void>());
  const previousColumnsRef = useRef(columns);
  const scrollSnapshotRef = useRef("unmounted");
  const [, forceRender] = useState(0);
  const invalidate = useCallback(() => {
    forceRender((value) => (value + 1) % Number.MAX_SAFE_INTEGER);
  }, []);

  if (previousColumnsRef.current !== columns) {
    const ratio = previousColumnsRef.current / Math.max(1, columns);
    previousColumnsRef.current = columns;
    for (const [key, height] of heightsRef.current) {
      heightsRef.current.set(key, Math.max(1, Math.round(height * ratio)));
    }
  }

  const live = new Set(itemKeys);
  for (const key of heightsRef.current.keys()) {
    if (!live.has(key)) heightsRef.current.delete(key);
  }
  for (const key of refCache.current.keys()) {
    if (!live.has(key)) refCache.current.delete(key);
  }
  for (const key of itemRefs.current.keys()) {
    if (!live.has(key)) itemRefs.current.delete(key);
  }

  const getScrollSnapshot = useCallback((): string => {
    const scroll = scrollRef.current;
    if (!scroll) return "unmounted";
    const target = scroll.getScrollTop() + scroll.getPendingDelta();
    return `${Math.floor(target / Math.max(1, OVERSCAN_ROWS / 2))}:${
      scroll.isSticky() ? "sticky" : "manual"
    }`;
  }, [scrollRef]);

  useLayoutEffect(
    () => {
      const scroll = scrollRef.current;
      if (!scroll) return undefined;
      scrollSnapshotRef.current = getScrollSnapshot();
      return scroll.subscribe(() => {
        const next = getScrollSnapshot();
        if (next === scrollSnapshotRef.current) return;
        scrollSnapshotRef.current = next;
        invalidate();
      });
    },
    [getScrollSnapshot, invalidate, scrollRef],
  );

  const offsets = buildOffsets(itemKeys, heightsRef.current);
  const scrollTop = scrollRef.current?.getScrollTop() ?? -1;
  const pendingDelta = scrollRef.current?.getPendingDelta() ?? 0;
  const viewportHeight = scrollRef.current?.getViewportHeight() ?? 0;
  const sticky = scrollRef.current?.isSticky() ?? true;
  const [start, end] = computeWindow({
    itemCount: itemKeys.length,
    offsets,
    scrollTop,
    pendingDelta,
    viewportHeight,
    sticky,
  });
  const topSpacer = offsets[start] ?? 0;
  const bottomSpacer = Math.max(
    0,
    (offsets[itemKeys.length] ?? 0) - (offsets[end] ?? 0),
  );

  useLayoutEffect(() => {
    if (sticky || itemKeys.length <= VIRTUAL_SCROLL_MAX_MOUNTED_ITEMS) {
      scrollRef.current?.setClampBounds(undefined, undefined);
      return;
    }
    const min = start === 0 ? 0 : topSpacer;
    const max =
      end >= itemKeys.length
        ? Infinity
        : Math.max(topSpacer, (offsets[end] ?? topSpacer) - viewportHeight);
    scrollRef.current?.setClampBounds(min, max);
  });

  useLayoutEffect(() => {
    let changed = false;
    for (const [key, element] of itemRefs.current) {
      const yoga = element.yogaNode;
      if (!yoga) continue;
      const height = yoga.getComputedHeight();
      const width = yoga.getComputedWidth();
      if (height > 0 || width > 0) {
        if (heightsRef.current.get(key) !== height) {
          heightsRef.current.set(key, height);
          changed = true;
        }
      }
    }
    if (changed) invalidate();
  });

  const measureRef = useCallback((key: string) => {
    let cached = refCache.current.get(key);
    if (!cached) {
      cached = (element: DOMElement | null) => {
        if (element) {
          itemRefs.current.set(key, element);
          return;
        }
        const previous = itemRefs.current.get(key);
        const yoga = previous?.yogaNode;
        if (yoga && (yoga.getComputedHeight() > 0 || yoga.getComputedWidth() > 0)) {
          heightsRef.current.set(key, yoga.getComputedHeight());
        }
        itemRefs.current.delete(key);
      };
      refCache.current.set(key, cached);
    }
    return cached;
  }, []);

  const getItemTop = useCallback(
    (index: number): number => {
      if (index < 0 || index >= itemKeys.length) return -1;
      return offsets[index] ?? -1;
    },
    [itemKeys.length, offsets],
  );

  const getItemElement = useCallback(
    (index: number): DOMElement | null => {
      const key = itemKeys[index];
      return key ? itemRefs.current.get(key) ?? null : null;
    },
    [itemKeys],
  );

  const getItemHeight = useCallback(
    (index: number): number | undefined => {
      const key = itemKeys[index];
      return key ? heightsRef.current.get(key) : undefined;
    },
    [itemKeys],
  );

  const scrollToIndex = useCallback(
    (index: number): void => {
      if (index < 0 || index >= itemKeys.length) return;
      scrollRef.current?.scrollTo(Math.max(0, offsets[index] ?? 0));
      invalidate();
    },
    [invalidate, itemKeys.length, offsets, scrollRef],
  );

  return {
    range: [start, end],
    topSpacer,
    bottomSpacer,
    measureRef,
    getItemTop,
    getItemElement,
    getItemHeight,
    scrollToIndex,
  };
}
