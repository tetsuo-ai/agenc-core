/**
 * VirtualMessageList — windowed transcript renderer.
 *
 * Adapted from upstream's `components/VirtualMessageList.tsx`.
 *
 * Goals
 * -----
 * Provide the upstream API surface for transcript virtualization,
 * search, row expansion, sticky prompt tracking, and cursor navigation.
 *
 * AgenC adaptations
 * -----------------
 *   - `useVirtualScroll` exposes the upstream navigation seam
 *     (`getItemTop`, `getItemElement`, `getItemHeight`, `scrollToIndex`)
 *     so `JumpHandle` methods can move to offscreen rows instead of
 *     silently no-oping.
 *   - `useSearchHighlight` from `tui/ink/hooks/use-search-highlight.js`
 *     is wired for the screen-buffer overlay path so search queries
 *     invert visible matches while row navigation follows the match list.
 *   - Each item is wrapped in `OffscreenFreeze` to match the existing
 *     transcript's offscreen-perf strategy.
 *
 * @module
 */

import type { RefObject, Ref } from "react";
import React, {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import Box from "../ink/components/Box.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import type { DOMElement } from "../ink/dom.js";
import type { MatchPosition } from "../ink/render-to-screen.js";
import { useSearchHighlight } from "../ink/hooks/use-search-highlight.js";
import type { TranscriptMessage } from "./MessageList.js";
import { OffscreenFreeze } from "./OffscreenFreeze.js";
import { useVirtualScroll } from "../hooks/useVirtualScroll.js";

const HEADROOM_ROWS = 3;

/**
 * Imperative handle for transcript navigation.
 *
 * Search/jump navigation mirrors upstream's high-level contract. Query
 * updates build a message-index match list, visible rows are scanned for
 * match coordinates when the renderer provides a scanner, and navigation
 * delegates to the virtual-scroll hook so offscreen rows mount before the
 * next paint.
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

export interface MessageActionsState {
  readonly index: number;
  readonly id: string;
}

export interface MessageActionsNav {
  readonly moveBy: (delta: number) => void;
  readonly moveTo: (index: number) => void;
  readonly activate: () => void;
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
  readonly onItemClick?: (message: TranscriptMessage) => void;
  readonly isItemClickable?: (message: TranscriptMessage) => boolean;
  readonly isItemExpanded?: (message: TranscriptMessage) => boolean;
  readonly trackStickyPrompt?: boolean;
  readonly onStickyPromptChange?: (
    prompt: { readonly text: string; readonly scrollTo: () => void } | null,
  ) => void;
  readonly selectedIndex?: number;
  readonly cursorNavRef?: Ref<MessageActionsNav>;
  readonly setCursor?: (cursor: MessageActionsState | null) => void;
  readonly scanElement?: (element: DOMElement) => MatchPosition[];
  readonly setPositions?: (
    state: {
      readonly positions: MatchPosition[];
      readonly rowOffset: number;
      readonly currentIdx: number;
    } | null,
  ) => void;
}

const fallbackLowerCache = new WeakMap<TranscriptMessage, string>();
function defaultExtractSearchText(message: TranscriptMessage): string {
  const cached = fallbackLowerCache.get(message);
  if (cached !== undefined) return cached;
  const lowered = (message.content ?? "").toLowerCase();
  fallbackLowerCache.set(message, lowered);
  return lowered;
}

function smallHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function rowFreezeKey(message: TranscriptMessage): string {
  let groupedToolsKey = "";
  if (message.groupedTools && message.groupedTools.length > 0) {
    try {
      groupedToolsKey = smallHash(JSON.stringify(message.groupedTools));
    } catch {
      groupedToolsKey = "grouped-tools";
    }
  }
  return [
    message.id,
    message.timestamp,
    message.content?.length ?? 0,
    groupedToolsKey,
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
  onItemClick,
  isItemClickable = () => false,
  isItemExpanded = () => false,
  trackStickyPrompt = false,
  onStickyPromptChange,
  selectedIndex,
  cursorNavRef,
  setCursor,
  scanElement,
  setPositions,
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
  const rowElementsRef = useRef(new Map<string, DOMElement>());
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  // Search highlight integration. Calls into Ink's screen-buffer overlay
  // so all visible matches across the transcript get inverted.
  const highlight = useSearchHighlight();
  const searchAnchorRef = useRef<number>(-1);
  const lastQueryRef = useRef<string>("");
  const matchCountRef = useRef<number>(0);
  const matchIndicesRef = useRef<number[]>([]);
  const matchPtrRef = useRef<number>(0);
  const indexWarmedRef = useRef<boolean>(false);

  const recomputeMatches = useCallback(
    (query: string): number[] => {
      if (query.length === 0) return [];
      const lq = query.toLowerCase();
      const matches: number[] = [];
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!;
        const text = extractSearchText(message);
        if (text.indexOf(lq) >= 0) matches.push(index);
      }
      return matches;
    },
    [extractSearchText, messages],
  );

  const jumpToIndex = useCallback(
    (index: number): void => {
      if (!Number.isFinite(index)) return;
      const bounded = Math.max(0, Math.min(messages.length - 1, Math.trunc(index)));
      const top = window.getItemTop(bounded);
      if (top >= 0) {
        scrollRef.current?.scrollTo(Math.max(0, top - HEADROOM_ROWS));
        return;
      }
      window.scrollToIndex(bounded);
    },
    [messages.length, scrollRef, window],
  );

  const publishMatchPosition = useCallback(
    (matches: readonly number[], ptr: number): void => {
      const total = matches.length;
      matchCountRef.current = total;
      onSearchMatchesChange?.(total, total > 0 ? ptr + 1 : 0);
    },
    [onSearchMatchesChange],
  );

  const updateVisibleMatchPositions = useCallback(
    (matches: readonly number[], ptr: number): void => {
      if (!scanElement || !setPositions || matches.length === 0) {
        setPositions?.(null);
        return;
      }
      const currentMessageIndex = matches[ptr];
      if (currentMessageIndex === undefined) {
        setPositions(null);
        return;
      }
      const key = keys[currentMessageIndex];
      const element = key ? rowElementsRef.current.get(key) : undefined;
      if (!element) {
        setPositions(null);
        return;
      }
      const positions = scanElement(element);
      setPositions({
        positions,
        rowOffset: element.yogaNode?.getComputedTop?.() ?? 0,
        currentIdx: 0,
      });
    },
    [keys, scanElement, setPositions],
  );

  const setSearchQuery = useCallback(
    (query: string): void => {
      lastQueryRef.current = query;
      highlight.setQuery(query);
      const matches = recomputeMatches(query);
      matchIndicesRef.current = matches;
      matchPtrRef.current = 0;
      publishMatchPosition(matches, 0);
      updateVisibleMatchPositions(matches, 0);
      if (matches.length > 0) {
        jumpToIndex(matches[0]!);
      } else if (searchAnchorRef.current >= 0) {
        scrollRef.current?.scrollTo(searchAnchorRef.current);
      }
    },
    [
      highlight,
      jumpToIndex,
      publishMatchPosition,
      recomputeMatches,
      scrollRef,
      updateVisibleMatchPositions,
    ],
  );

  const setAnchor = useCallback((): void => {
    const handle = scrollRef.current;
    if (handle) searchAnchorRef.current = handle.getScrollTop();
  }, [scrollRef]);

  const disarmSearch = useCallback((): void => {
    highlight.setPositions(null);
    setPositions?.(null);
  }, [highlight, setPositions]);

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

  const nextMatch = useCallback((): void => {
    const matches = matchIndicesRef.current;
    if (matches.length <= 0) return;
    const ptr = (matchPtrRef.current + 1) % matches.length;
    matchPtrRef.current = ptr;
    publishMatchPosition(matches, ptr);
    updateVisibleMatchPositions(matches, ptr);
    jumpToIndex(matches[ptr]!);
  }, [jumpToIndex, publishMatchPosition, updateVisibleMatchPositions]);

  const prevMatch = useCallback((): void => {
    const matches = matchIndicesRef.current;
    if (matches.length <= 0) return;
    const ptr = (matchPtrRef.current - 1 + matches.length) % matches.length;
    matchPtrRef.current = ptr;
    publishMatchPosition(matches, ptr);
    updateVisibleMatchPositions(matches, ptr);
    jumpToIndex(matches[ptr]!);
  }, [jumpToIndex, publishMatchPosition, updateVisibleMatchPositions]);

  useImperativeHandle(
    cursorNavRef,
    (): MessageActionsNav => ({
      moveBy(delta: number): void {
        const current = selectedIndex ?? -1;
        const next = Math.max(
          0,
          Math.min(messages.length - 1, current < 0 ? 0 : current + delta),
        );
        const message = messages[next];
        if (message) {
          setCursor?.({ index: next, id: message.id });
          jumpToIndex(next);
        }
      },
      moveTo(index: number): void {
        const next = Math.max(0, Math.min(messages.length - 1, index));
        const message = messages[next];
        if (message) {
          setCursor?.({ index: next, id: message.id });
          jumpToIndex(next);
        }
      },
      activate(): void {
        const message =
          selectedIndex !== undefined ? messages[selectedIndex] : undefined;
        if (message && isItemClickable(message)) onItemClick?.(message);
      },
    }),
    [
      isItemClickable,
      jumpToIndex,
      messages,
      onItemClick,
      selectedIndex,
      setCursor,
    ],
  );

  React.useEffect(() => {
    if (!trackStickyPrompt || !onStickyPromptChange) return;
    for (let index = start; index < end; index += 1) {
      const message = messages[index];
      if (!message || message.kind !== "user") continue;
      const text = extractSearchText(message).trim();
      if (!text || text.startsWith("<")) continue;
      onStickyPromptChange({
        text: text.slice(0, 500),
        scrollTo: () => jumpToIndex(index),
      });
      return;
    }
    onStickyPromptChange(null);
  }, [
    end,
    extractSearchText,
    jumpToIndex,
    messages,
    onStickyPromptChange,
    start,
    trackStickyPrompt,
  ]);

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
        const clickable = isItemClickable(message);
        const expanded = isItemExpanded(message);
        const selected = selectedIndex === virtualIndex;
        return (
          <Box
            key={key}
            ref={(element) => {
              window.measureRef(key)(element);
              if (element) rowElementsRef.current.set(key, element);
              else rowElementsRef.current.delete(key);
            }}
            flexDirection="column"
            backgroundColor={
              expanded || selected
                ? "ansi256(236)"
                : hoveredKey === key && clickable
                  ? "ansi256(234)"
                  : undefined
            }
            paddingBottom={expanded ? 1 : undefined}
            onClick={clickable ? () => onItemClick?.(message) : undefined}
            onMouseEnter={clickable ? () => setHoveredKey(key) : undefined}
            onMouseLeave={
              clickable
                ? () => setHoveredKey((current) => (current === key ? null : current))
                : undefined
            }
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
