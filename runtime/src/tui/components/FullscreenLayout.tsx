import { c as _c } from "react-compiler-runtime";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import React, { createContext, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { fileURLToPath } from 'url';
import { ModalContext } from '../context/modalContext';
import { PromptOverlayProvider } from '../context/promptOverlayContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { selectAgenCTuiGlyphs } from "../glyphs.js";
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js';
import instances from '../ink/instances.js';
import { Box, Text, useTerminalFocus } from '../ink.js';
import type { Message } from '../../types/message';
import { openBrowser, openPath } from '../../utils/browser.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { logError } from '../../utils/log.js';
import { plural } from '../../utils/stringUtils.js';
import { modelDisplayString } from '../../utils/model/model.js';
import { getTotalCost } from '../../cost/tracker.js';
import { formatUsdCost } from '../../session/cost.js';
import { isNullRenderingAttachment } from '../message-visibility.js';
import { PromptDialogOverlay, PromptSuggestionsOverlay } from './PromptOverlaySurfaces.js';
import { permissionModeFooterChrome } from './PromptInput/permissionModeChrome.js';
import type { PermissionMode } from '../../permissions/types.js';
import type { StickyPrompt } from './VirtualMessageList';
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js';
import { BrandCells, PlanModeBanner, TuiHeader, StatusBar as V2StatusBar, StatusSegment } from './v2/primitives.js';
import ThemedText from './design-system/ThemedText.js';
import { LedgerStatus } from './LedgerStatus.js';

/** Rows of transcript context kept visible above the modal pane's ▔ divider. */
const MODAL_TRANSCRIPT_PEEK = 2;
const TOP_CHROME_ROWS = 2;
const BOTTOM_CHROME_ROWS = 2;
const MIN_ROWS_FOR_TOP_CHROME = 8;
const MIN_ROWS_FOR_BOTTOM_CHROME = 5;
const MIN_ROWS_FOR_SCROLLABLE = 2;
const FILE_TREE_GUTTER_MIN_COLUMNS = 112;
const FILE_TREE_GUTTER_MIN_ROWS = 16;
const FILE_TREE_GUTTER_MIN_WIDTH = 22;
const FILE_TREE_GUTTER_MAX_WIDTH = 28;

export type FullscreenLayoutBudget = {
  readonly showTopChrome: boolean;
  readonly showScrollable: boolean;
  readonly showBottomChrome: boolean;
  readonly bottomMaxHeight: number;
};

export function calculateModalViewport(
  terminalRows: number,
  columns: number,
): { readonly rows: number; readonly columns: number; readonly maxHeight: number } {
  return {
    rows: Math.max(0, terminalRows - MODAL_TRANSCRIPT_PEEK - 1),
    columns: Math.max(0, columns - 4),
    maxHeight: Math.max(0, terminalRows - MODAL_TRANSCRIPT_PEEK),
  };
}

export function calculateFullscreenLayoutBudget(
  terminalRows: number,
): FullscreenLayoutBudget {
  const rows = Number.isFinite(terminalRows)
    ? Math.max(0, Math.trunc(terminalRows))
    : 0;
  const showTopChrome = rows >= MIN_ROWS_FOR_TOP_CHROME;
  const showBottomChrome = rows >= MIN_ROWS_FOR_BOTTOM_CHROME;
  const chromeRows =
    (showTopChrome ? TOP_CHROME_ROWS : 0) +
    (showBottomChrome ? BOTTOM_CHROME_ROWS : 0);
  const contentRows = Math.max(1, rows - chromeRows);

  return {
    showTopChrome,
    showScrollable: contentRows >= MIN_ROWS_FOR_SCROLLABLE,
    showBottomChrome,
    bottomMaxHeight: Math.max(1, Math.ceil(contentRows / 2)),
  };
}

export function calculateFileTreeGutterWidth(columns: number): number {
  const safeColumns = Number.isFinite(columns)
    ? Math.max(0, Math.trunc(columns))
    : 0;
  if (safeColumns < FILE_TREE_GUTTER_MIN_COLUMNS) return 0;
  return Math.min(
    FILE_TREE_GUTTER_MAX_WIDTH,
    Math.max(FILE_TREE_GUTTER_MIN_WIDTH, Math.floor(safeColumns * 0.18)),
  );
}

export function shouldShowFileTreeGutter(
  columns: number,
  terminalRows: number,
  hasModal = false,
): boolean {
  const safeRows = Number.isFinite(terminalRows)
    ? Math.max(0, Math.trunc(terminalRows))
    : 0;
  return (
    !hasModal &&
    safeRows >= FILE_TREE_GUTTER_MIN_ROWS &&
    calculateFileTreeGutterWidth(columns) > 0 &&
    calculateFullscreenLayoutBudget(safeRows).showScrollable
  );
}

export function isNoColorEnv(
  env: Pick<NodeJS.ProcessEnv, 'NO_COLOR' | 'FORCE_COLOR' | 'TERM'> = process.env,
): boolean {
  return env.NO_COLOR !== undefined || env.FORCE_COLOR === '0' || env.TERM === 'dumb';
}

/** Context for scroll-derived chrome (sticky header, pill). StickyTracker
 *  in VirtualMessageList writes via this instead of threading a callback
 *  up through Messages → REPL → FullscreenLayout. The setter is stable so
 *  consuming this context never causes re-renders. */
export const ScrollChromeContext = createContext<{
  setStickyPrompt: (p: StickyPrompt | null) => void;
}>({
  setStickyPrompt: () => {}
});
type Props = {
  /** Content that scrolls (messages, tool output) */
  scrollable: ReactNode;
  /** Content pinned to the bottom (spinner, prompt, permissions) */
  bottom: ReactNode;
  /** Content rendered inside the ScrollBox after messages — user can scroll
   *  up to see context while it's showing (used by PermissionRequest). */
  overlay?: ReactNode;
  /** Optional left chrome for wide fullscreen sessions. undefined renders
   *  the default workspace tree, null/false disables the gutter. */
  fileTreeGutter?: ReactNode | false;
  /** Absolute-positioned content anchored at the bottom-right of the
   *  ScrollBox area, floating over scrollback. Rendered inside the flexGrow
   *  region (not the bottom slot) so the overflowY:hidden cap doesn't clip
   *  it. Fullscreen only. */
  bottomFloat?: ReactNode;
  /** Slash-command dialog content. Rendered in an absolute-positioned
   *  bottom-anchored pane (▔ divider, paddingX=2) that paints over the
   *  ScrollBox AND bottom slot. Provides ModalContext so Pane/Dialog inside
   *  skip their own frame. Fullscreen only; inline after overlay otherwise. */
  modal?: ReactNode;
  /** Ref passed via ModalContext so Tabs (or any scroll-owning descendant)
   *  can attach it to their own ScrollBox for tall content. */
  modalScrollRef?: React.RefObject<ScrollBoxHandle | null>;
  /** Ref to the scroll box for keyboard scrolling. RefObject (not Ref) so
   *  pillVisible's useSyncExternalStore can subscribe to scroll changes. */
  scrollRef?: RefObject<ScrollBoxHandle | null>;
  /** Y-position (scrollHeight at snapshot) of the unseen-divider. Pill
   *  shows while viewport bottom hasn't reached this. Ref so REPL doesn't
   *  re-render on the one-shot snapshot write. */
  dividerYRef?: RefObject<number | null>;
  /** Force-hide the pill (e.g. viewing a sub-agent task). */
  hidePill?: boolean;
  /** Force-hide the sticky prompt header (e.g. viewing a teammate task). */
  hideSticky?: boolean;
  /** Count for the pill text. 0 → "Jump to bottom", >0 → "N new messages". */
  newMessageCount?: number;
  /** Called when the user clicks the "N new" pill. */
  onPillClick?: () => void;
};

/**
 * Tracks the in-transcript "N new messages" divider position while the
 * user is scrolled up. Snapshots message count AND scrollHeight the first
 * time sticky breaks. scrollHeight ≈ the y-position of the divider in the
 * scroll content (it renders right after the last message that existed at
 * snapshot time).
 *
 * `pillVisible` lives in FullscreenLayout (not here) — it subscribes
 * directly to ScrollBox via useSyncExternalStore with a boolean snapshot
 * against `dividerYRef`, so per-frame scroll never re-renders REPL.
 * `dividerIndex` stays here because REPL needs it for computeUnseenDivider
 * → Messages' divider line; it changes only ~twice/scroll-session
 * (first scroll-away + repin), acceptable REPL re-render cost.
 *
 * `onScrollAway` must be called by every scroll-away action with the
 * handle; `onRepin` by submit/scroll-to-bottom.
 */
export function useUnseenDivider(messageCount: number): {
  /** Index into messages[] where the divider line renders. Cleared on
   *  sticky-resume (scroll back to bottom) so the "N new" line doesn't
   *  linger once everything is visible. */
  dividerIndex: number | null;
  /** scrollHeight snapshot at first scroll-away — the divider's y-position.
   *  FullscreenLayout subscribes to ScrollBox and compares viewport bottom
   *  against this for pillVisible. Ref so writes don't re-render REPL. */
  dividerYRef: RefObject<number | null>;
  onScrollAway: (handle: ScrollBoxHandle) => void;
  onRepin: () => void;
  /** Scroll the handle so the divider line is at the top of the viewport. */
  jumpToNew: (handle: ScrollBoxHandle | null) => void;
  /** Shift dividerIndex and dividerYRef when messages are prepended
   *  (infinite scroll-back). indexDelta = number of messages prepended;
   *  heightDelta = content height growth in rows. */
  shiftDivider: (indexDelta: number, heightDelta: number) => void;
} {
  const [dividerIndex, setDividerIndex] = useState<number | null>(null);
  // Ref holds the current count for onScrollAway to snapshot. Written in
  // the render body (not useEffect) so wheel events arriving between a
  // message-append render and its effect flush don't capture a stale
  // count (off-by-one in the baseline). React Compiler bails out here —
  // acceptable for a hook instantiated once in REPL.
  const countRef = useRef(messageCount);
  countRef.current = messageCount;
  // scrollHeight snapshot — the divider's y in content coords. Ref-only:
  // read synchronously in onScrollAway (setState is batched, can't
  // read-then-write in the same callback) AND by FullscreenLayout's
  // pillVisible subscription. null = pinned to bottom.
  const dividerYRef = useRef<number | null>(null);
  const onRepin = useCallback(() => {
    // Don't clear dividerYRef here — a trackpad momentum wheel event
    // racing in the same stdin batch would see null and re-snapshot,
    // overriding the setDividerIndex(null) below. The useEffect below
    // clears the ref after React commits the null dividerIndex, so the
    // ref stays non-null until the state settles.
    setDividerIndex(null);
  }, []);
  const onScrollAway = useCallback((handle: ScrollBoxHandle) => {
    // Nothing below the viewport → nothing to jump to. Covers both:
    // • empty/short session: scrollUp calls scrollTo(0) which breaks sticky
    //   even at scrollTop=0 (wheel-up on fresh session showed the pill)
    // • click-to-select at bottom: useDragToScroll.check() calls
    //   scrollTo(current) to break sticky so streaming content doesn't shift
    //   under the selection, then onScroll(false, …) — but scrollTop is still
    //   at max (Sarah Deaton, #agenc-code-feedback 2026-03-15)
    // pendingDelta: scrollBy accumulates without updating scrollTop. Without
    // it, wheeling up from max would see scrollTop==max and suppress the pill.
    const max = Math.max(0, handle.getScrollHeight() - handle.getViewportHeight());
    if (handle.getScrollTop() + handle.getPendingDelta() >= max) return;
    // Snapshot only on the FIRST scroll-away. onScrollAway fires on EVERY
    // scroll action (not just the initial break from sticky) — this guard
    // preserves the original baseline so the count doesn't reset on the
    // second PageUp. Subsequent calls are ref-only no-ops (no REPL re-render).
    if (dividerYRef.current === null) {
      dividerYRef.current = handle.getScrollHeight();
      // New scroll-away session → move the divider here (replaces old one)
      setDividerIndex(countRef.current);
    }
  }, []);
  const jumpToNew = useCallback((handle_0: ScrollBoxHandle | null) => {
    if (!handle_0) return;
    // scrollToBottom (not scrollTo(dividerY)): sets stickyScroll=true so
    // useVirtualScroll mounts the tail and render-node-to-output pins
    // scrollTop=maxScroll. scrollTo sets stickyScroll=false → the clamp
    // (still at top-range bounds before React re-renders) pins scrollTop
    // back, stopping short. The divider stays rendered (dividerIndex
    // unchanged) so users see where new messages started; the clear on
    // next submit/explicit scroll-to-bottom handles cleanup.
    handle_0.scrollToBottom();
  }, []);

  // Sync dividerYRef with dividerIndex. When onRepin fires (submit,
  // scroll-to-bottom), it sets dividerIndex=null but leaves the ref
  // non-null — a wheel event racing in the same stdin batch would
  // otherwise see null and re-snapshot. Deferring the ref clear to
  // useEffect guarantees the ref stays non-null until React has committed
  // the null dividerIndex, blocking the if-null guard in onScrollAway.
  //
  // Also handles /clear, rewind, teammate-view swap — if the count drops
  // below the divider index, the divider would point at nothing.
  useEffect(() => {
    if (dividerIndex === null) {
      dividerYRef.current = null;
    } else if (messageCount < dividerIndex) {
      dividerYRef.current = null;
      setDividerIndex(null);
    }
  }, [messageCount, dividerIndex]);
  const shiftDivider = useCallback((indexDelta: number, heightDelta: number) => {
    setDividerIndex(idx => idx === null ? null : idx + indexDelta);
    if (dividerYRef.current !== null) {
      dividerYRef.current += heightDelta;
    }
  }, []);
  return {
    dividerIndex,
    dividerYRef,
    onScrollAway,
    onRepin,
    jumpToNew,
    shiftDivider
  };
}

/**
 * Counts assistant turns in messages[dividerIndex..end). A "turn" is what
 * users think of as "a new message from AgenC" — not raw assistant entries
 * (one turn yields multiple entries: tool_use blocks + text blocks). We count
 * non-assistant→assistant transitions, but only for entries that actually
 * carry text — tool-use-only entries are skipped (like progress messages)
 * so "⏺ Searched for 13 patterns, read 6 files" doesn't tick the pill.
 */
export function countUnseenAssistantTurns(messages: readonly Message[], dividerIndex: number): number {
  let count = 0;
  let prevWasAssistant = false;
  for (let i = dividerIndex; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.type === 'progress') continue;
    // Tool-use-only assistant entries aren't "new messages" to the user —
    // skip them the same way we skip progress. prevWasAssistant is NOT
    // updated, so a text block immediately following still counts as the
    // same turn (tool_use + text from one API response = 1).
    if (m.type === 'assistant' && !assistantHasVisibleText(m)) continue;
    const isAssistant = m.type === 'assistant';
    if (isAssistant && !prevWasAssistant) count++;
    prevWasAssistant = isAssistant;
  }
  return count;
}
function assistantHasVisibleText(m: Message): boolean {
  if (m.type !== 'assistant') return false;
  for (const b of m.message.content) {
    if (b.type === 'text' && b.text.trim() !== '') return true;
  }
  return false;
}
export type UnseenDivider = {
  firstUnseenUuid: Message['uuid'];
  count: number;
};

/**
 * Builds the unseenDivider object REPL passes to Messages + the pill.
 * Returns undefined only when no content has arrived past the divider
 * yet (messages[dividerIndex] doesn't exist). Once ANY message arrives
 * — including tool_use-only assistant entries and tool_result user entries
 * that countUnseenAssistantTurns skips — count floors at 1 so the pill
 * flips from "Jump to bottom" to "1 new message". Without the floor,
 * the pill stays "Jump to bottom" through an entire tool-call sequence
 * until AgenC's text response lands.
 */
export function computeUnseenDivider(messages: readonly Message[], dividerIndex: number | null): UnseenDivider | undefined {
  if (dividerIndex === null) return undefined;
  // Skip progress and null-rendering attachments when picking the divider
  // anchor — Messages.tsx filters these out of renderableMessages before the
  // dividerBeforeIndex search, so their UUID wouldn't be found (CC-724).
  // Hook attachments use randomUUID() so nothing shares their 24-char prefix.
  let anchorIdx = dividerIndex;
  while (anchorIdx < messages.length && (messages[anchorIdx]?.type === 'progress' || isNullRenderingAttachment(messages[anchorIdx]!))) {
    anchorIdx++;
  }
  const uuid = messages[anchorIdx]?.uuid;
  if (!uuid) return undefined;
  const count = countUnseenAssistantTurns(messages, dividerIndex);
  return {
    firstUnseenUuid: uuid,
    count: Math.max(1, count)
  };
}

/**
 * Layout wrapper for the REPL. In fullscreen mode, puts scrollable
 * content in a sticky-scroll box and pins bottom content via flexbox.
 * Outside fullscreen mode, renders content sequentially so the existing
 * main-screen scrollback rendering works unchanged.
 *
 * Fullscreen mode defaults on for ants (AGENC_NO_FLICKER=0 to opt out)
 * and off for external users (AGENC_NO_FLICKER=1 to opt in).
 * The <AlternateScreen> wrapper
 * (alt buffer + mouse tracking + height constraint) lives at REPL's root
 * so nothing can accidentally render outside it.
 */
export function FullscreenLayout(t0) {
  const $ = _c(47);
  const {
    scrollable,
    bottom,
    overlay,
    bottomFloat,
    modal,
    modalScrollRef,
    scrollRef,
    dividerYRef,
    hidePill: t1,
    hideSticky: t2,
    newMessageCount: t3,
    onPillClick
  } = t0;
  const fileTreeGutter = t0.fileTreeGutter;
  const hidePill = t1 === undefined ? false : t1;
  const hideSticky = t2 === undefined ? false : t2;
  const newMessageCount = t3 === undefined ? 0 : t3;
  const {
    rows: terminalRows,
    columns
  } = useTerminalSize();
  const layoutBudget = calculateFullscreenLayoutBudget(terminalRows);
  const noColor = isNoColorEnv();
  const [stickyPrompt, setStickyPrompt] = useState(null);
  let t4;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = {
      setStickyPrompt
    };
    $[0] = t4;
  } else {
    t4 = $[0];
  }
  const chromeCtx = t4;
  let t5;
  if ($[1] !== scrollRef) {
    t5 = listener => scrollRef?.current?.subscribe(listener) ?? _temp;
    $[1] = scrollRef;
    $[2] = t5;
  } else {
    t5 = $[2];
  }
  const subscribe = t5;
  let t6;
  if ($[3] !== dividerYRef || $[4] !== scrollRef) {
    t6 = () => {
      const s = scrollRef?.current;
      const dividerY = dividerYRef?.current;
      if (!s || dividerY == null) {
        return false;
      }
      return s.getScrollTop() + s.getPendingDelta() + s.getViewportHeight() < dividerY;
    };
    $[3] = dividerYRef;
    $[4] = scrollRef;
    $[5] = t6;
  } else {
    t6 = $[5];
  }
  const pillVisible = useSyncExternalStore(subscribe, t6);
  let t7;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = [];
    $[6] = t7;
  } else {
    t7 = $[6];
  }
  useLayoutEffect(_temp3, t7);
  if (isFullscreenEnvEnabled()) {
    const sticky = hideSticky ? null : stickyPrompt;
    const headerPrompt = sticky != null && sticky !== "clicked" && overlay == null ? sticky : null;
    const padCollapsed = sticky != null && overlay == null;
    let t8;
    if ($[7] !== headerPrompt) {
      t8 = headerPrompt && <StickyPromptHeader text={headerPrompt.text} onClick={headerPrompt.scrollTo} />;
      $[7] = headerPrompt;
      $[8] = t8;
    } else {
      t8 = $[8];
    }
    const t9 = padCollapsed ? 0 : 1;
    let t10;
    if ($[9] !== scrollable) {
      t10 = <ScrollChromeContext value={chromeCtx}>{scrollable}</ScrollChromeContext>;
      $[9] = scrollable;
      $[10] = t10;
    } else {
      t10 = $[10];
    }
    let t11;
    if ($[11] !== overlay || $[12] !== scrollRef || $[13] !== t10 || $[14] !== t9) {
      t11 = <ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column" paddingTop={t9} stickyScroll={true}>{t10}{overlay}</ScrollBox>;
      $[11] = overlay;
      $[12] = scrollRef;
      $[13] = t10;
      $[14] = t9;
      $[15] = t11;
    } else {
      t11 = $[15];
    }
    let t12;
    if ($[16] !== hidePill || $[17] !== newMessageCount || $[18] !== onPillClick || $[19] !== overlay || $[20] !== pillVisible) {
      t12 = !hidePill && pillVisible && overlay == null && <NewMessagesPill count={newMessageCount} onClick={onPillClick} />;
      $[16] = hidePill;
      $[17] = newMessageCount;
      $[18] = onPillClick;
      $[19] = overlay;
      $[20] = pillVisible;
      $[21] = t12;
    } else {
      t12 = $[21];
    }
    let t13;
    if ($[22] !== bottomFloat) {
      t13 = bottomFloat != null && <Box position="absolute" bottom={0} right={0} opaque={true}>{bottomFloat}</Box>;
      $[22] = bottomFloat;
      $[23] = t13;
    } else {
      t13 = $[23];
    }
    let t15;
    let t16;
    if ($[29] === Symbol.for("react.memo_cache_sentinel")) {
      t15 = <PromptSuggestionsOverlay />;
      t16 = <PromptDialogOverlay />;
      $[29] = t15;
      $[30] = t16;
    } else {
      t15 = $[29];
      t16 = $[30];
    }
    const t14Content = <Box flexGrow={1} flexDirection="column" overflow="hidden"><DesignBrandBleed columns={columns} />{t8}<DesignPlanModeBanner />{t11}{t12}{t13}{t16}</Box>;
    const showFileTreeGutter = shouldShowFileTreeGutter(columns, terminalRows, modal != null) && fileTreeGutter !== undefined && fileTreeGutter !== null && fileTreeGutter !== false;
    const t14 = showFileTreeGutter ? <Box flexGrow={1} flexDirection="row" overflow="hidden">{fileTreeGutter}{t14Content}</Box> : t14Content;
    let t17;
    if ($[31] !== bottom || $[38] !== layoutBudget.bottomMaxHeight) {
      t17 = <Box flexDirection="column" flexShrink={0} width="100%" maxHeight={layoutBudget.bottomMaxHeight}>{t15}<Box flexDirection="column" width="100%" flexGrow={1} overflowY="hidden">{bottom}</Box></Box>;
      $[31] = bottom;
      $[38] = layoutBudget.bottomMaxHeight;
      $[32] = t17;
    } else {
      t17 = $[32];
    }
    let t18;
    const modalViewport = calculateModalViewport(terminalRows, columns);
    if ($[33] !== columns || $[34] !== modal || $[35] !== modalScrollRef || $[36] !== terminalRows) {
      t18 = modal != null && <ModalContext value={{
        rows: modalViewport.rows,
        columns: modalViewport.columns,
        scrollRef: modalScrollRef ?? null
      }}><Box position="absolute" bottom={0} left={0} right={0} maxHeight={modalViewport.maxHeight} flexDirection="column" overflow="hidden" opaque={true}><Box flexShrink={0}><Text color="permission">{selectAgenCTuiGlyphs().modalDivider.repeat(Math.max(0, columns))}</Text></Box><Box flexDirection="column" paddingX={2} flexShrink={0} overflow="hidden">{modal}</Box></Box></ModalContext>;
      $[33] = columns;
      $[34] = modal;
      $[35] = modalScrollRef;
      $[36] = terminalRows;
      $[37] = t18;
    } else {
      t18 = $[37];
    }
    return <PromptOverlayProvider>{layoutBudget.showTopChrome ? <DesignTopChrome columns={columns} noColor={noColor} /> : null}{layoutBudget.showScrollable ? t14 : null}{t17}{layoutBudget.showBottomChrome ? <DesignBottomChrome columns={columns} /> : null}{t18}</PromptOverlayProvider>;
  }
  let t8;
  if ($[42] !== bottom || $[43] !== modal || $[44] !== overlay || $[45] !== scrollable) {
    t8 = <>{scrollable}{bottom}{overlay}{modal}</>;
    $[42] = bottom;
    $[43] = modal;
    $[44] = overlay;
    $[45] = scrollable;
    $[46] = t8;
  } else {
    t8 = $[46];
  }
  return t8;
}

function trimMiddle(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value;
  if (maxWidth <= 1) return value.slice(0, Math.max(0, maxWidth));
  const left = Math.ceil((maxWidth - 1) / 2);
  const right = Math.floor((maxWidth - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

const execFileAsync = promisify(execFile);

/** Slow poll cadence for the git chrome probe — covers branch switches made
 *  while the terminal keeps focus (the focus-in re-probe covers the rest). */
const GIT_CHROME_REFRESH_MS = 30_000;

let cachedGitChromeLabel: string | null = null;

async function probeGitChromeLabel(): Promise<string | null> {
  try {
    const branch = (await execFileAsync('git', ['branch', '--show-current'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 1000,
    })).stdout.trim() || 'detached';
    const shortSha = (await execFileAsync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 1000,
    })).stdout.trim();
    return `${branch} · ${shortSha}`;
  } catch {
    return 'no git';
  }
}

/** Git label for the bottom chrome. The probe runs async (two short `git`
 *  subprocesses) so it never blocks the first paint; it re-runs on terminal
 *  focus changes and on a slow interval so a mid-session branch switch
 *  surfaces. Until the first probe resolves, the git segment stays hidden —
 *  better a missing segment than a fabricated one. */
function useGitChromeLabel(): string | null {
  const terminalFocused = useTerminalFocus();
  const [label, setLabel] = useState<string | null>(() => cachedGitChromeLabel);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void probeGitChromeLabel().then(next => {
        if (cancelled || next === null) return;
        cachedGitChromeLabel = next;
        setLabel(prev => (prev === next ? prev : next));
      }, () => {});
    };
    refresh();
    const interval = setInterval(refresh, GIT_CHROME_REFRESH_MS);
    interval.unref?.();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [terminalFocused]);
  return label;
}

/** Slow tick that keeps the session spend label fresh: getTotalCost() is a
 *  plain non-reactive getter over the cost sidecar, so the chrome polls it on
 *  a slow cadence instead of re-rendering per API response. */
const SPEND_REFRESH_MS = 5_000;

function useSessionSpendLabel(): string {
  const [spend, setSpend] = useState(() => formatUsdCost(getTotalCost()));
  useEffect(() => {
    const interval = setInterval(() => {
      const next = formatUsdCost(getTotalCost());
      setSpend(prev => (prev === next ? prev : next));
    }, SPEND_REFRESH_MS);
    interval.unref?.();
    return () => clearInterval(interval);
  }, []);
  return spend;
}

function DesignBottomLeftLabel({
  gitLabel,
  mode,
  modelLabel,
}: {
  readonly gitLabel: string | null;
  readonly mode: PermissionMode;
  readonly modelLabel: string;
}): React.ReactNode {
  const modeLabel = permissionModeFooterChrome(mode).label;
  // Swarm indicator sits next to the mode (like yolo): visible only while
  // swarm mode is on; carries the live running-agent count from AppState.
  // Read from AppState (the appStateBridge /swarm writes through), with the
  // provider-safe hook so the label also renders without AppStateProvider.
  const swarmMode =
    useAppStateMaybeOutsideOfProvider((state) => state.swarmMode) === true;
  const tasks = useAppStateMaybeOutsideOfProvider(state => state.tasks) ?? {};
  const runningAgents = React.useMemo(
    () => Object.values(tasks ?? {}).filter((task: any) => task?.type !== "local_bash" && (task?.status === "running" || task?.status === "pending")).length,
    [tasks],
  );
  const swarmBadgeText = ` SWARM${runningAgents > 0 ? ` ${runningAgents}` : ""} `;
  return (
    <>
      <ThemedText color="text2" wrap="truncate-end">● {modeLabel}</ThemedText>
      {swarmMode ? (
        <ThemedText backgroundColor="agenc" color="ansi:white" bold wrap="truncate-end">{swarmBadgeText}</ThemedText>
      ) : null}
      <ThemedText color="text2" wrap="truncate-end"> · {modelLabel}{gitLabel === null ? '' : ` · ${gitLabel}`}</ThemedText>
    </>
  );
}

function DesignBottomRightLabel({
  spend,
}: {
  readonly spend: string;
}): React.ReactNode {
  return (
    <>
      <LedgerStatus />
      <ThemedText color="text2" wrap="truncate-end"> spend {spend}</ThemedText>
    </>
  );
}

function DesignPlanModeBanner(): React.ReactNode {
  const mode = useAppStateMaybeOutsideOfProvider(state => state.toolPermissionContext.mode) ?? 'default';
  return mode === 'plan' ? <PlanModeBanner /> : null;
}

export function DesignBrandBleed({ columns }: { columns: number }): React.ReactNode {
  if (columns < 72) return null;
  const compact = columns < 100;
  return <Box position="absolute" top={0} right={0}>
      <BrandCells columns={compact ? 18 : 28} rows={compact ? 3 : 5} />
    </Box>;
}

export function DesignTopChrome({ columns, noColor }: { columns: number; noColor: boolean }): React.ReactNode {
  const cwdName = React.useMemo(() => process.cwd().split(/[\\/]/u).filter(Boolean).at(-1) ?? 'workspace', []);
  const mode = useAppStateMaybeOutsideOfProvider(state => state.toolPermissionContext.mode) ?? 'default';
  const tasks = useAppStateMaybeOutsideOfProvider(state => state.tasks) ?? {};
  const activeTask = React.useMemo(() => {
    const values = Object.values(tasks ?? {});
    return values.find(task => task?.status === 'running' || task?.status === 'queued') ?? values[0];
  }, [tasks]);
  const taskPda = activeTask?.id ? trimMiddle(String(activeTask.id), Math.max(12, Math.floor(columns * 0.18))) : '—';
  const title = trimMiddle(`~/${cwdName}`, Math.max(12, Math.floor(columns * 0.24)));
  return <TuiHeader columns={columns} title={title} tabLabel="agenc · orchestrator" tabStatus={activeTask?.status === 'failed' ? 'warn' : 'live'} permissionMode={mode} taskPda={taskPda} />;
}

export function formatDesignBottomChromeLabels(
  columns: number,
  modelLabel: string,
  mode: PermissionMode,
  gitLabel: string | null,
  spend: string,
): { readonly left: string; readonly right: string } {
  const modeLabel = permissionModeFooterChrome(mode).label;
  const trimmedGitLabel = gitLabel === null
    ? null
    : trimMiddle(gitLabel, columns >= 100 ? 32 : 18);
  return {
    left: `● ${modeLabel} · ${modelLabel}${trimmedGitLabel === null ? '' : ` · ${trimmedGitLabel}`}`,
    right: `spend ${spend}`,
  };
}

function DesignBottomChrome({ columns }: { columns: number }): React.ReactNode {
  const model = useAppStateMaybeOutsideOfProvider(state => state.mainLoopModel) ?? 'agenc';
  const mode = useAppStateMaybeOutsideOfProvider(state => state.toolPermissionContext.mode) ?? 'default';
  const modelLabel = modelDisplayString(model);
  // Only segments with a real data source may render here. There is no live
  // context-% or stake feed at this point in the tree (the transcript's
  // per-message usage never reaches the layout), so those segments stay
  // hidden rather than showing fabricated values.
  const spend = useSessionSpendLabel();
  const gitLabel = useGitChromeLabel();
  const { right } = formatDesignBottomChromeLabels(columns, modelLabel, mode, gitLabel, spend);
  const trimmedGitLabel = gitLabel === null ? null : trimMiddle(gitLabel, columns >= 100 ? 32 : 18);
  return <V2StatusBar variant={mode === 'plan' ? 'plan' : mode === 'bypassPermissions' ? 'error' : mode === 'auto' ? 'success' : mode === 'acceptEdits' ? 'accent' : 'neutral'} left={[
      <DesignBottomLeftLabel key="left" gitLabel={trimmedGitLabel} mode={mode} modelLabel={modelLabel} />,
    ]} right={[
      // The honest right cluster is a single short segment (real spend), so
      // the <54-col compact branch can reuse the same string — it is already
      // compact now that the fabricated ctx/stake segments are gone.
      columns >= 54 ? <DesignBottomRightLabel key="right" spend={spend} /> : <StatusSegment key="right-compact" label="" value={right} color="muted3" />,
    ]} />;
}

const fullscreenHyperlinkOwners = new WeakMap<object, {
  base: ((url: string) => void) | undefined;
  handlers: Array<(url: string) => void>;
}>();

// Slack-style pill. Absolute overlay at bottom={0} of the scrollwrap — floats
// over the ScrollBox's last content row, only obscuring the centered pill
// text (the rest of the row shows ScrollBox content). Scroll-smear from
// DECSTBM shifting the pill's pixels is repaired at the Ink layer
// (absoluteRectsPrev third-pass in render-node-to-output.ts, #23939). Shows
// "Jump to bottom" when count is 0 (scrolled away but no new messages yet —
// the dead zone where users previously thought chat stalled).
function _temp3() {
  if (!isFullscreenEnvEnabled()) {
    return;
  }
  const ink = instances.get(process.stdout);
  if (!ink) {
    return;
  }
  const ownerState = fullscreenHyperlinkOwners.get(ink) ?? {
    base: ink.onHyperlinkClick,
    handlers: [],
  };
  fullscreenHyperlinkOwners.set(ink, ownerState);
  const handler = (url: string) => {
    _temp2(url);
  };
  ownerState.handlers.push(handler);
  ink.onHyperlinkClick = handler;
  return () => {
    const index = ownerState.handlers.indexOf(handler);
    if (index !== -1) {
      ownerState.handlers.splice(index, 1);
    }
    if (ink.onHyperlinkClick === handler) {
      ink.onHyperlinkClick = ownerState.handlers.at(-1) ?? ownerState.base;
    }
    if (ownerState.handlers.length === 0) {
      fullscreenHyperlinkOwners.delete(ink);
    }
  };
}
function openFullscreenHyperlinkTarget(result, failureMessage) {
  void Promise.resolve(result).then((opened) => {
    if (opened === false) logError(new Error(failureMessage));
  }, logError);
}
function _temp2(url) {
  if (url.startsWith("file:")) {
    try {
      const filePath = fileURLToPath(url);
      openFullscreenHyperlinkTarget(openPath(filePath), `Failed to open path: ${filePath}`);
    } catch (error) {
      logError(error);
    }
  } else {
    openFullscreenHyperlinkTarget(openBrowser(url), `Failed to open URL: ${url}`);
  }
}
function _temp() {}
function NewMessagesPill(t0) {
  const $ = _c(10);
  const {
    count,
    onClick
  } = t0;
  const [hover, setHover] = useState(false);
  let t1;
  let t2;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = () => setHover(true);
    t2 = () => setHover(false);
    $[0] = t1;
    $[1] = t2;
  } else {
    t1 = $[0];
    t2 = $[1];
  }
  const t3 = hover ? "userMessageBackgroundHover" : "userMessageBackground";
  let t4;
  if ($[2] !== count) {
    t4 = count > 0 ? `${count} new ${plural(count, "message")}` : "Jump to bottom";
    $[2] = count;
    $[3] = t4;
  } else {
    t4 = $[3];
  }
  let t5;
  if ($[4] !== t3 || $[5] !== t4) {
    t5 = <Text backgroundColor={t3} dimColor={true}>{" "}{t4}{" "}{selectAgenCTuiGlyphs().arrowDown}{" "}</Text>;
    $[4] = t3;
    $[5] = t4;
    $[6] = t5;
  } else {
    t5 = $[6];
  }
  let t6;
  if ($[7] !== onClick || $[8] !== t5) {
    t6 = <Box position="absolute" bottom={0} left={0} right={0} justifyContent="center"><Box onClick={onClick} onMouseEnter={t1} onMouseLeave={t2}>{t5}</Box></Box>;
    $[7] = onClick;
    $[8] = t5;
    $[9] = t6;
  } else {
    t6 = $[9];
  }
  return t6;
}

// Context breadcrumb: when scrolled up into history, pin the current
// conversation turn's prompt above the viewport so you know what AgenC was
// responding to. Normal-flow sibling BEFORE the ScrollBox (mirrors the pill
// below it) — shrinks the ScrollBox by exactly 1 row via flex, stays outside
// the DECSTBM scroll region. Click jumps back to the prompt.
//
// Height is FIXED at 1 row (truncate-end for long prompts). A variable-height
// header (1 when short, 2 when wrapped) shifts the ScrollBox by 1 row every
// time the sticky prompt switches during scroll — content jumps on screen
// even with scrollTop unchanged (the DECSTBM region top shifts with the
// ScrollBox, and the diff engine sees "everything moved"). Fixed height
// keeps the ScrollBox anchored; only the header TEXT changes, not its box.
function StickyPromptHeader(t0) {
  const $ = _c(8);
  const {
    text,
    onClick
  } = t0;
  const [hover, setHover] = useState(false);
  const t1 = hover ? "userMessageBackgroundHover" : "userMessageBackground";
  let t2;
  let t3;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => setHover(true);
    t3 = () => setHover(false);
    $[0] = t2;
    $[1] = t3;
  } else {
    t2 = $[0];
    t3 = $[1];
  }
  let t4;
  if ($[2] !== text) {
    t4 = <Text color="subtle" wrap="truncate-end">{selectAgenCTuiGlyphs().pointer} {text}</Text>;
    $[2] = text;
    $[3] = t4;
  } else {
    t4 = $[3];
  }
  let t5;
  if ($[4] !== onClick || $[5] !== t1 || $[6] !== t4) {
    t5 = <Box flexShrink={0} width="100%" height={1} paddingRight={1} backgroundColor={t1} onClick={onClick} onMouseEnter={t2} onMouseLeave={t3}>{t4}</Box>;
    $[4] = onClick;
    $[5] = t1;
    $[6] = t4;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  return t5;
}
