/**
 * VirtualMessageList — windowed transcript renderer.
 *
 * Adapted from upstream's `components/VirtualMessageList.tsx`.
 *
 * Goals
 * -----
 * Provide the upstream API surface so the lead can wire this as a
 * drop-in replacement for the existing `MessageList`'s body in a follow-up
 * commit. The component itself is a pure windowed renderer plus a search
 * highlight integration; sticky-scroll-to-bottom remains the
 * caller's responsibility (the existing `MessageList` keeps that policy
 * inside the same file).
 *
 * AgenC adaptations
 * -----------------
 *   - upstream's `useVirtualScroll` returned a much wider surface than
 *     AgenC's: `offsets`, `getItemTop`, `getItemElement`, `getItemHeight`,
 *     `spacerRef`, `scrollToIndex`. AgenC's hook (`tui/hooks/useVirtualScroll.ts`)
 *     currently exposes only `range`, `topSpacer`, `bottomSpacer`, and
 *     `measureRef`. The two-phase jump engine, message-relative position
 *     scan, sticky-prompt tracker, and search-anchor logic from upstream
 *     therefore degrade to the methods the hook supports today; the rest
 *     of the `JumpHandle` API is exported but the index-based methods are
 *     stubbed with `// TODO(useVirtualScroll-extension)` notes so the lead
 *     can broaden the hook in a future tranche without changing this
 *     component's signature.
 *   - `useSearchHighlight` from `tui/ink/hooks/use-search-highlight.js`
 *     is wired for the screen-buffer overlay path so a future search box
 *     can call `setSearchQuery` and have all visible matches inverted.
 *   - Each item is wrapped in `OffscreenFreeze` to match the existing
 *     transcript's offscreen-perf strategy.
 *
 * @module
 */

import type { RefObject } from "react";
import React, {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import Box from "../ink/components/Box.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import { useSearchHighlight } from "../ink/hooks/use-search-highlight.js";
import type { TranscriptMessage } from "./MessageList.js";
import { OffscreenFreeze } from "./OffscreenFreeze.js";
import { useVirtualScroll } from "../hooks/useVirtualScroll.js";

/**
 * Imperative handle for transcript navigation.
 *
 * `jumpToIndex`, `nextMatch`, `prevMatch`, and `setAnchor` require
 * scroll-position arithmetic that AgenC's `useVirtualScroll` doesn't yet
 * expose. They are wired to no-op stubs that log a TODO at first use.
 * `setSearchQuery` and `disarmSearch` route through the screen-buffer
 * highlight (`useSearchHighlight`) which works today.
 */
export interface JumpHandle {
  readonly jumpToIndex: (index: number) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly nextMatch: () => void;
  readonly prevMatch: () => void;
  readonly setAnchor: () => void;
  readonly disarmSearch: () => void;
  readonly warmSearchIndex: () => Promise<number>;
}

export interface VirtualMessageListProps {
  readonly messages: readonly TranscriptMessage[];
  readonly scrollRef: RefObject<ScrollBoxHandle | null>;
  /** Terminal column count. Used to invalidate cached row heights on resize. */
  readonly columns: number;
  /** Stable React key for a given message. */
  readonly itemKey: (message: TranscriptMessage) => string;
  /** Renders a single row body. */
  readonly renderItem: (
    message: TranscriptMessage,
    index: number,
  ) => React.ReactNode;
  /**
   * Return true to suppress the `OffscreenFreeze` wrapper for a row. Useful
   * for rows whose content mutates in place (e.g. exec stdout streaming).
   */
  readonly isItemFreezable?: (message: TranscriptMessage) => boolean;
  /**
   * Optional pre-lowered search text extractor. Used when
   * `setSearchQuery(q)` is invoked on the imperative handle.
   */
  readonly extractSearchText?: (message: TranscriptMessage) => string;
  /** Search match count notification. `(total, current1Based)`. */
  readonly onSearchMatchesChange?: (total: number, current: number) => void;
  /** Externally-provided ref for the imperative jump handle. */
  readonly jumpRef?: RefObject<JumpHandle | null>;
  /** When `true`, every row is wrapped in `OffscreenFreeze`. */
  readonly freezeOffscreen?: boolean;
}

const fallbackLowerCache = new WeakMap<TranscriptMessage, string>();
function defaultExtractSearchText(message: TranscriptMessage): string {
  const cached = fallbackLowerCache.get(message);
  if (cached !== undefined) return cached;
  const lowered = (message.content ?? "").toLowerCase();
  fallbackLowerCache.set(message, lowered);
  return lowered;
}

function rowFreezeKey(message: TranscriptMessage): string {
  return [
    message.id,
    message.timestamp,
    message.content?.length ?? 0,
    message.toolResultContent?.length ?? 0,
    message.execStdout?.length ?? 0,
    message.execStderr?.length ?? 0,
    message.isComplete === false ? "s" : "f",
  ].join(":");
}

export function VirtualMessageList({
  messages,
  scrollRef,
  columns,
  itemKey,
  renderItem,
  isItemFreezable,
  extractSearchText = defaultExtractSearchText,
  onSearchMatchesChange,
  jumpRef,
  freezeOffscreen = true,
}: VirtualMessageListProps): React.ReactElement {
  // Stable per-message keys. Rebuild on prefix mismatch (compaction /
  // /clear / itemKey identity change), append on streaming growth.
  const keysRef = useRef<string[]>([]);
  const prevMessagesRef = useRef<readonly TranscriptMessage[]>(messages);
  const prevItemKeyRef = useRef(itemKey);
  if (
    prevItemKeyRef.current !== itemKey ||
    messages.length < keysRef.current.length ||
    messages[0] !== prevMessagesRef.current[0]
  ) {
    keysRef.current = messages.map((m) => itemKey(m));
  } else {
    for (let i = keysRef.current.length; i < messages.length; i += 1) {
      keysRef.current.push(itemKey(messages[i]!));
    }
  }
  prevMessagesRef.current = messages;
  prevItemKeyRef.current = itemKey;
  const keys = keysRef.current;

  const window = useVirtualScroll(scrollRef, keys, columns);
  const [start, end] = window.range;

  const visibleMessages = useMemo(
    () => messages.slice(start, end),
    [messages, start, end],
  );

  // Search highlight integration. Calls into Ink's screen-buffer overlay
  // so all visible matches across the transcript get inverted.
  const highlight = useSearchHighlight();
  const searchAnchorRef = useRef<number>(-1);
  const lastQueryRef = useRef<string>("");
  const matchCountRef = useRef<number>(0);
  const indexWarmedRef = useRef<boolean>(false);

  const recomputeMatchCount = useCallback(
    (query: string): number => {
      if (query.length === 0) return 0;
      const lq = query.toLowerCase();
      let count = 0;
      for (const message of messages) {
        const text = extractSearchText(message);
        if (text.indexOf(lq) >= 0) count += 1;
      }
      return count;
    },
    [extractSearchText, messages],
  );

  const setSearchQuery = useCallback(
    (query: string): void => {
      lastQueryRef.current = query;
      highlight.setQuery(query);
      const total = recomputeMatchCount(query);
      matchCountRef.current = total;
      onSearchMatchesChange?.(total, total > 0 ? 1 : 0);
    },
    [highlight, onSearchMatchesChange, recomputeMatchCount],
  );

  const setAnchor = useCallback((): void => {
    const handle = scrollRef.current;
    if (handle) searchAnchorRef.current = handle.getScrollTop();
  }, [scrollRef]);

  const disarmSearch = useCallback((): void => {
    highlight.setPositions(null);
  }, [highlight]);

  // Index warming is cheap for AgenC's bounded transcripts. Yields once
  // so the caller can paint an "indexing…" status if it wants to.
  const warmSearchIndex = useCallback(async (): Promise<number> => {
    if (indexWarmedRef.current) return 0;
    const perf = (globalThis as { performance?: { now(): number } }).performance;
    const now = (): number => (perf ? perf.now() : Date.now());
    const tStart = now();
    await Promise.resolve();
    for (const message of messages) {
      extractSearchText(message);
    }
    indexWarmedRef.current = true;
    return Math.round(now() - tStart);
  }, [extractSearchText, messages]);

  // TODO(useVirtualScroll-extension): the next/prev/jumpToIndex APIs need
  // `getItemTop`/`getItemElement`/`scrollToIndex` plumbing from
  // `tui/hooks/useVirtualScroll.ts`. Until that lands they short-circuit
  // to no-ops that update the match-count badge so callers don't break.
  const nextMatch = useCallback((): void => {
    const total = matchCountRef.current;
    if (total <= 0) return;
    onSearchMatchesChange?.(total, 1);
  }, [onSearchMatchesChange]);

  const prevMatch = useCallback((): void => {
    const total = matchCountRef.current;
    if (total <= 0) return;
    onSearchMatchesChange?.(total, total);
  }, [onSearchMatchesChange]);

  const jumpToIndex = useCallback((_index: number): void => {
    void _index;
    // TODO(useVirtualScroll-extension): scroll the viewport so message
    // index `_index` lands HEADROOM rows below the viewport top.
  }, []);

  useImperativeHandle(
    jumpRef,
    (): JumpHandle => ({
      jumpToIndex,
      setSearchQuery,
      nextMatch,
      prevMatch,
      setAnchor,
      disarmSearch,
      warmSearchIndex,
    }),
    [
      disarmSearch,
      jumpToIndex,
      nextMatch,
      prevMatch,
      setAnchor,
      setSearchQuery,
      warmSearchIndex,
    ],
  );

  // Rendering. The wrapping Box is the layout anchor; spacers carry the
  // virtual height of items above/below the mounted window. AgenC's
  // existing `MessageList` already wraps the whole thing in a ScrollBox,
  // so this component renders only the inner content.
  return (
    <Box flexDirection="column" width="100%">
      {window.topSpacer > 0 ? (
        <Box height={Math.floor(window.topSpacer)} flexShrink={0} />
      ) : null}
      {visibleMessages.map((message, offset) => {
        const virtualIndex = start + offset;
        const key = keys[virtualIndex] ?? message.id;
        const freezable =
          freezeOffscreen && (isItemFreezable?.(message) ?? true);
        const body = renderItem(message, virtualIndex);
        return (
          <Box
            key={key}
            ref={window.measureRef(key)}
            flexDirection="column"
          >
            {freezable ? (
              <OffscreenFreeze
                cacheKey={rowFreezeKey(message)}
                freeze={message.isComplete !== false}
              >
                {body}
              </OffscreenFreeze>
            ) : (
              body
            )}
          </Box>
        );
      })}
      {window.bottomSpacer > 0 ? (
        <Box height={Math.floor(window.bottomSpacer)} flexShrink={0} />
      ) : null}
    </Box>
  );
}

export default VirtualMessageList;
