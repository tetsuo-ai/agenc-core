import React, { type RefObject, useCallback, useSyncExternalStore } from "react";

import { selectAgenCTuiGlyphs } from "../../glyphs.js";
import { Box, Text } from "../../ink.js";
import ScrollBox, { type ScrollBoxHandle } from "../../ink/components/ScrollBox.js";

const NOOP_UNSUB = (): void => {};

/**
 * Number of content rows below the viewport bottom, or 0 when the viewport
 * already reaches the bottom. Uses scrollTop + the not-yet-drained
 * pendingScrollDelta so the count is correct mid-wheel-burst (scrollBy
 * accumulates into pendingScrollDelta without moving scrollTop until the
 * renderer drains it). Mirrors FullscreenLayout's pillVisible math.
 */
function rowsBelow(handle: ScrollBoxHandle): number {
  const bottom = handle.getScrollTop() + handle.getPendingDelta() + handle.getViewportHeight();
  return Math.max(0, handle.getScrollHeight() - bottom);
}

/**
 * Compact, on-brand "viewing history" affordance. Renders a single row ONLY
 * when the transcript is scrolled away from the bottom — nothing when
 * following (sticky) or when the viewport already reaches the bottom. It
 * reuses the scroll state the ScrollBox already exposes (isSticky,
 * scrollTop, pendingScrollDelta, viewportHeight, scrollHeight) — the same
 * signals FullscreenLayout's NewMessagesPill and the StickyTracker read —
 * rather than building any new scroll bookkeeping.
 *
 * It lives as a fixed 1-row sibling AFTER the ScrollBox (flexShrink={0}) so
 * it can never overlap the composer/footer: when present it shrinks the
 * scroll area by exactly one row; when absent the scroll area reclaims it.
 *
 * Return-to-bottom is the existing follow key (End / G / ctrl+End, handled
 * by ScrollKeybindingHandler's modal pager) — this row only labels it.
 */
function ScrollPositionIndicator({
  scrollRef,
  atWelcome,
}: {
  readonly scrollRef: RefObject<ScrollBoxHandle | null>;
  readonly atWelcome: boolean;
}): React.ReactElement | null {
  // Fine-grained subscription to imperative scroll changes — re-renders this
  // leaf only (the ScrollBox content tree is untouched), exactly like
  // FullscreenLayout's pillVisible / VirtualMessageList's StickyTracker.
  const subscribe = useCallback(
    (listener: () => void) => scrollRef.current?.subscribe(listener) ?? NOOP_UNSUB,
    [scrollRef],
  );
  // Snapshot folds "scrolled up" and the below-count into one number so the
  // store stays stable when nothing relevant changed: -1 = following (hide),
  // >= 0 = scrolled up with that many rows below.
  const snapshot = useSyncExternalStore(subscribe, () => {
    // On the empty welcome screen stickyScroll is off, so hide the indicator
    // there — it would otherwise read oddly ("End to follow" with no stream).
    if (atWelcome) return -1;
    const handle = scrollRef.current;
    if (!handle) return -1;
    // sticky → following the live bottom; never show the indicator. Also hide
    // when the viewport already reaches the bottom (e.g. content shorter than
    // the viewport) so we don't flash on a transcript that can't scroll.
    if (handle.isSticky()) return -1;
    const below = rowsBelow(handle);
    return below <= 0 ? -1 : below;
  });

  if (snapshot < 0) return null;

  const glyphs = selectAgenCTuiGlyphs();
  const noun = snapshot === 1 ? "line" : "lines";
  return (
    <Box height={1} flexShrink={0}>
      {/* `inactive` tone matches the ProjectExplorer "N above/below" overflow
          markers — the analogous position affordance — and reads as a
          position, not a notification. truncate-end degrades cleanly at
          narrow widths instead of wrapping into a second row. */}
      <Text color="inactive" wrap="truncate-end">
        {glyphs.arrowDown} {snapshot} {noun} below {glyphs.separator} End to follow
      </Text>
    </Box>
  );
}

export function TranscriptSurface({
  children,
  scrollRef,
  atWelcome = false,
}: {
  readonly children: React.ReactNode;
  readonly scrollRef?: RefObject<ScrollBoxHandle | null>;
  /**
   * Cold-start/empty transcript. When true the ScrollBox is NOT pinned to the
   * bottom, so on a short viewport (e.g. 80 cols) the welcome hero — the
   * `agenc.` brand line, the tagline, and the workspace box top border — stays
   * at the top instead of being scrolled off-screen. Once real messages arrive
   * the transcript returns to sticky-bottom follow behaviour.
   */
  readonly atWelcome?: boolean;
}): React.ReactElement {
  const body = scrollRef ? (
    <>
      <ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column" width="100%" stickyScroll={!atWelcome}>
        {children}
      </ScrollBox>
      <ScrollPositionIndicator scrollRef={scrollRef} atWelcome={atWelcome} />
    </>
  ) : (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {children}
    </Box>
  );

  // No pane-header row here: the workbench status bar already announces the
  // active surface ("AgenC Workbench | TRANSCRIPT" one row above), so a second
  // TRANSCRIPT label rendered the same word twice in the top three rows of the
  // screen. Other surfaces keep their own headers because their titles carry
  // real information (file paths, diff targets); this one was pure duplication.
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      {body}
    </Box>
  );
}
