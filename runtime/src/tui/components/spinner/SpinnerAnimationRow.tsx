import figures from 'figures';
import * as React from 'react';

import type { InProcessTeammateTaskState } from '../../../tasks/InProcessTeammateTask/types.js';
import { formatDuration, formatNumber } from '../../../utils/format.js';
import { toInkColor } from '../../../utils/ink.js';
import type { Theme } from '../../../utils/theme.js';
import { Box, Text } from '../../ink.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { Byline } from '../design-system/Byline.js';
import FullWidthRow from '../design-system/FullWidthRow.js';
import type { SpinnerMode } from './types.js';
import { computeSpinnerMessageMaxWidth, truncateSpinnerText } from './utils.js';

const SEP_WIDTH = stringWidth(' · ');
const THINKING_BARE_WIDTH = stringWidth('thinking');
// Show the elapsed timer + token counter almost immediately (Claude Code
// parity): 30s felt like the indicator was frozen/slow on every normal turn.
// The tok/s rate keeps its own ≥20-token/≥5s floor, so early reads show the
// timer and raw token count without a noisy rate.
const SHOW_TOKENS_AFTER_MS = 3_000;
// After this long with no new token, surface a heartbeat note so a slow model
// reads as "alive but slow" instead of "hung". A healthy model streams tokens
// every fraction of a second, so this only fires on genuinely slow turns.
const STALL_NOTE_AFTER_MS = 8_000;
// Only compute a tokens/sec rate once the turn has run long enough and produced
// enough tokens that the figure is meaningful (mirrors the budget-path gate).
const RATE_MIN_ELAPSED_MS = 5_000;
const RATE_MIN_TOKENS = 20;
// "slow model" is a claim about the MODEL, so it needs genuine streaming-rate
// evidence: only attach the label when the measured active-streaming rate is
// below this floor. Silence alone (e.g. between chunks) stays a neutral
// "last token Ns ago" note.
const SLOW_MODEL_MAX_RATE_PER_SEC = 10;
// Mirrors Claude Code's spinner affordance: shown at the end of the status
// byline whenever there is any status content to attach it to.
const ESC_HINT_TEXT = 'esc to interrupt';
const ESC_HINT_WIDTH = stringWidth(ESC_HINT_TEXT);

/**
 * 1s wall-clock tick for the row. Before this, the row only re-rendered when
 * new tokens arrived, so the elapsed timer and the stall note froze during a
 * long thinking silence. The snapshot is rounded to whole seconds: a raw
 * Date.now() snapshot changes on every getSnapshot call, which
 * useSyncExternalStore treats as a store change and would re-render in a
 * loop. Subscribing mounts one interval per row; it is cleared on unmount, so
 * nothing ticks while the spinner is gone.
 */
function subscribeSecondTick(onChange: () => void): () => void {
  const interval = setInterval(onChange, 1_000);
  return () => clearInterval(interval);
}

function getWholeSecondNow(): number {
  return Math.floor(Date.now() / 1_000) * 1_000;
}

/**
 * Pure per-render step for token-liveness tracking. Exported for unit tests;
 * the {@link useTokenLiveness} hook owns the ref plumbing.
 *
 * Honesty contract (operator bug 2026-07-20): the tok/s denominator counts
 * ONLY active streaming windows. Wall-clock spent executing tools (or
 * otherwise not waiting on the model) previously stayed in the denominator,
 * so a healthy model read "2.4 tok/s · slow model" after a long tool run.
 * While `streamingActive` is false the active clock pauses AND the
 * no-token clock slides forward — tool time is never billed to the model.
 */
export interface TokenLivenessState {
  firstSeenAt: number | null;
  lastChangeAt: number;
  lastTokens: number;
  /** Accumulated ms spent in active streaming windows since first token. */
  activeStreamMs: number;
  /** Wall clock of the previous step (for active-window accumulation). */
  lastStepAt: number;
}

export function initialTokenLivenessState(
  totalTokens: number,
  now: number,
  turnStartedAt: number,
): TokenLivenessState {
  // First render of this turn. If no token has streamed yet, anchor the
  // no-token clock at the turn start so a long pre-token silence reads as
  // honest immediately (e.g. a remount mid-stall). If tokens are already
  // present we don't know when the last one arrived, so treat "now" as fresh
  // and never falsely flag a clearly-alive stream as stalled.
  return {
    firstSeenAt: totalTokens > 0 ? now : null,
    lastChangeAt: totalTokens > 0 ? now : Math.min(turnStartedAt, now),
    lastTokens: totalTokens,
    activeStreamMs: 0,
    lastStepAt: now,
  };
}

export function stepTokenLiveness(
  s: TokenLivenessState,
  input: {
    readonly totalTokens: number;
    readonly now: number;
    /** True while the turn is waiting on / receiving model output (no tools running). */
    readonly streamingActive: boolean;
  },
): { msSinceLastToken: number; ratePerSec: number } {
  const { totalTokens, now, streamingActive } = input;
  const stepMs = Math.max(0, now - s.lastStepAt);
  if (streamingActive && s.firstSeenAt !== null) {
    s.activeStreamMs += stepMs;
  }
  s.lastStepAt = now;
  if (!streamingActive) {
    // Not the model's silence: tools (or another non-model phase) own this
    // window. Slide the no-token clock so the eventual "last token Ns ago"
    // note measures only model-owned silence.
    s.lastChangeAt = Math.max(s.lastChangeAt, now);
  }
  if (totalTokens !== s.lastTokens) {
    if (s.firstSeenAt === null && totalTokens > 0) s.firstSeenAt = now;
    s.lastTokens = totalTokens;
    s.lastChangeAt = now;
  }
  const msSinceLastToken = Math.max(0, now - s.lastChangeAt);
  const ratePerSec =
    totalTokens >= RATE_MIN_TOKENS && s.activeStreamMs >= RATE_MIN_ELAPSED_MS
      ? (totalTokens / s.activeStreamMs) * 1000
      : 0;
  return { msSinceLastToken, ratePerSec };
}

/**
 * Tracks token liveness across renders so the row can tell "alive but slow"
 * from "hung". Returns ms since the token counter last moved and a tokens/sec
 * rate (active-streaming-window denominator) once tokens are flowing. Refs
 * (not state) — the row re-renders from its own 1s tick and from streaming
 * state changes, so reading on render is enough and avoids extra re-renders.
 *
 * `turnStartedAt` seeds the no-token clock so a turn that has already been
 * silent for minutes reports its real silence on the very first render (e.g.
 * after a remount), rather than resetting to zero each mount.
 */
function useTokenLiveness(
  totalTokens: number,
  now: number,
  turnStartedAt: number,
  streamingActive: boolean,
): {
  msSinceLastToken: number;
  ratePerSec: number;
} {
  const state = React.useRef<TokenLivenessState | null>(null);
  if (state.current === null) {
    state.current = initialTokenLivenessState(totalTokens, now, turnStartedAt);
  }
  return stepTokenLiveness(state.current, { totalTokens, now, streamingActive });
}

/**
 * The rate is derived from a chars/4 token ESTIMATE, not provider-reported
 * usage — mark it so it cannot be mistaken for provider truth.
 */
export function formatRate(ratePerSec: number): string {
  return ratePerSec >= 10
    ? `~${Math.round(ratePerSec)} tok/s`
    : `~${ratePerSec.toFixed(1)} tok/s`;
}

/**
 * Stall-note selection, exported for unit tests.
 *
 * - While tools are running the model is not being asked for tokens, so no
 *   note at all (the previous behavior showed "slow model · last token 16s
 *   ago" mid-tool-run — meaningless and defamatory).
 * - "slow model" requires genuine streaming-rate evidence (a measured
 *   active-window rate below {@link SLOW_MODEL_MAX_RATE_PER_SEC}); plain
 *   silence gets a neutral "last token Ns ago".
 * - Pre-first-token silence reads "waiting for model" — we have no rate
 *   evidence to blame the model with.
 */
export function selectStallNote(input: {
  readonly totalTokens: number;
  readonly msSinceLastToken: number;
  readonly ratePerSec: number;
  readonly toolsRunning: boolean;
}): string | null {
  if (input.toolsRunning) return null;
  if (input.msSinceLastToken <= STALL_NOTE_AFTER_MS) return null;
  if (input.totalTokens <= 0) {
    return "waiting for model · no output yet";
  }
  const gap = `last token ${formatDuration(input.msSinceLastToken)} ago`;
  const slowEvidence =
    input.ratePerSec > 0 && input.ratePerSec < SLOW_MODEL_MAX_RATE_PER_SEC;
  return slowEvidence ? `slow model · ${gap}` : gap;
}

export type SpinnerAnimationRowProps = {
  // Kept in the public prop shape while the surrounding spinner code is
  // migrated. The v2 visual contract keeps this row off the frame clock; a
  // 1s wall-clock tick (see subscribeSecondTick) keeps the elapsed timer and
  // stall note advancing through token silences.
  mode: SpinnerMode;
  reducedMotion: boolean;
  hasActiveTools: boolean;
  responseLengthRef: React.RefObject<number>;
  message: string;
  messageColor: keyof Theme;
  shimmerColor: keyof Theme;
  overrideColor?: keyof Theme | null;
  loadingStartTimeRef: React.RefObject<number>;
  totalPausedMsRef: React.RefObject<number>;
  pauseStartTimeRef: React.RefObject<number | null>;
  spinnerSuffix?: string | null;
  verbose: boolean;
  columns: number;
  hasRunningTeammates: boolean;
  teammateTokens: number;
  foregroundedTeammate: InProcessTeammateTaskState | undefined;
  leaderIsIdle?: boolean;
  thinkingStatus: 'thinking' | number | null;
  effortSuffix: string;
  showLeaderTokenStats?: boolean;
};

function statusGlyph(mode: SpinnerMode, hasActiveTools: boolean): string {
  if (hasActiveTools || mode === 'tool-use' || mode === 'tool-input') return '◐';
  return mode === 'requesting' ? figures.arrowUp : figures.arrowDown;
}

export function SpinnerAnimationRow({
  mode,
  hasActiveTools,
  responseLengthRef,
  message,
  messageColor,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerSuffix,
  verbose,
  columns,
  hasRunningTeammates,
  teammateTokens,
  foregroundedTeammate,
  thinkingStatus,
  effortSuffix,
  showLeaderTokenStats = true,
}: SpinnerAnimationRowProps): React.ReactNode {
  // Whole-second wall clock with a live tick, so the elapsed timer and the
  // stall note keep advancing while the spinner is up even if no token
  // arrives. Clamped below: the floor-to-second snapshot can sit up to 1s
  // behind loadingStartTimeRef's exact millisecond timestamp.
  const now = React.useSyncExternalStore(
    subscribeSecondTick,
    getWholeSecondNow,
    getWholeSecondNow,
  );
  const elapsedTimeMs = Math.max(
    0,
    pauseStartTimeRef.current !== null
      ? pauseStartTimeRef.current - loadingStartTimeRef.current - totalPausedMsRef.current
      : now - loadingStartTimeRef.current - totalPausedMsRef.current,
  );

  const visibleMessage = truncateSpinnerText(message, computeSpinnerMessageMaxWidth(columns));
  const leaderTokens = showLeaderTokenStats ? Math.round(responseLengthRef.current / 4) : 0;
  const totalTokens =
    foregroundedTeammate && !foregroundedTeammate.isIdle
      ? foregroundedTeammate.progress?.tokenCount ?? 0
      : leaderTokens + teammateTokens;
  const tokenCount = formatNumber(totalTokens);
  // Singular when exactly one token so the counter never reads "1 tokens".
  const tokenNoun = totalTokens === 1 ? 'token' : 'tokens';
  const tokensLabel = `${tokenCount} ${tokenNoun}`;
  const tokensText = hasRunningTeammates
    ? tokensLabel
    : `${figures.arrowDown} ${tokensLabel}`;
  const tokensWidth = stringWidth(tokensText);
  const timerText = formatDuration(elapsedTimeMs);
  const timerWidth = stringWidth(timerText);

  // Liveness: distinguishes "alive but slow" from "hung". Only meaningful for
  // the leader's own stream (a foregrounded teammate reports its own progress).
  const trackLiveness =
    showLeaderTokenStats && !(foregroundedTeammate && !foregroundedTeammate.isIdle);
  // While tools run the model is not streaming; the rate denominator pauses
  // and stall notes are suppressed (tool time is not model time).
  const toolsRunning =
    hasActiveTools || mode === 'tool-use' || mode === 'tool-input';
  const { msSinceLastToken, ratePerSec } = useTokenLiveness(
    trackLiveness ? totalTokens : 0,
    now,
    loadingStartTimeRef.current,
    !toolsRunning,
  );
  // Show the heartbeat once the turn has been waiting on a token long enough to
  // look stuck — but not while "thinking" is already explaining the silence.
  const stallNoteText =
    trackLiveness &&
    !hasRunningTeammates &&
    thinkingStatus !== 'thinking' &&
    elapsedTimeMs > STALL_NOTE_AFTER_MS
      ? selectStallNote({
          totalTokens,
          msSinceLastToken,
          ratePerSec,
          toolsRunning,
        })
      : null;
  const showStallNote = stallNoteText !== null;
  const stallNoteWidth = stallNoteText ? stringWidth(stallNoteText) : 0;
  const rateText = ratePerSec > 0 ? formatRate(ratePerSec) : null;

  let thinkingText =
    thinkingStatus === 'thinking'
      ? `thinking${effortSuffix}`
      : typeof thinkingStatus === 'number'
        ? `thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s`
        : null;
  let thinkingWidthValue = thinkingText ? stringWidth(thinkingText) : 0;

  const messageWidth = stringWidth(visibleMessage) + 2;
  const wantsThinking = thinkingStatus !== null;
  // The stall note is itself a liveness signal, so surface the timer/tokens
  // alongside it even before the usual 30s threshold.
  const wantsTimerAndTokens =
    verbose ||
    hasRunningTeammates ||
    (showLeaderTokenStats && (elapsedTimeMs > SHOW_TOKENS_AFTER_MS || showStallNote));
  const availableSpace = columns - messageWidth - 5;
  let showThinking = wantsThinking && availableSpace > thinkingWidthValue;
  if (!showThinking && wantsThinking && thinkingStatus === 'thinking' && effortSuffix) {
    if (availableSpace > THINKING_BARE_WIDTH) {
      thinkingText = 'thinking';
      thinkingWidthValue = THINKING_BARE_WIDTH;
      showThinking = true;
    }
  }

  const usedAfterThinking = showThinking ? thinkingWidthValue + SEP_WIDTH : 0;
  const showTimer = wantsTimerAndTokens && availableSpace > usedAfterThinking + timerWidth;
  const usedAfterTimer = usedAfterThinking + (showTimer ? timerWidth + SEP_WIDTH : 0);
  const showTokens = wantsTimerAndTokens && totalTokens > 0 && availableSpace > usedAfterTimer + tokensWidth;
  // Only append the rate when it actually fits next to the token count.
  const usedAfterTokens = usedAfterTimer + (showTokens ? tokensWidth + SEP_WIDTH : 0);
  const rateSuffix = showTokens && rateText ? ` · ${rateText}` : '';
  const showRate =
    rateSuffix !== '' && availableSpace > usedAfterTokens + stringWidth(rateSuffix);
  const usedAfterRate = usedAfterTokens + (showRate ? stringWidth(rateSuffix) : 0);
  const fitStallNote =
    stallNoteText !== null && availableSpace > usedAfterRate + stallNoteWidth + SEP_WIDTH;
  const thinkingOnly = showThinking && thinkingStatus === 'thinking' && !spinnerSuffix && !showTimer && !showTokens;

  const parts = [
    ...(spinnerSuffix ? [<Text dimColor key="suffix">{spinnerSuffix}</Text>] : []),
    ...(showTimer ? [<Text dimColor key="elapsedTime">{timerText}</Text>] : []),
    ...(showTokens ? [
      <Box flexDirection="row" key="tokens">
        {!hasRunningTeammates && <SpinnerModeGlyph mode={mode} />}
        <Text dimColor>{tokensLabel}{showRate ? rateSuffix : ''}</Text>
      </Box>,
    ] : []),
    ...(fitStallNote && stallNoteText ? [
      <Text color="warning" key="stall">{stallNoteText}</Text>,
    ] : []),
    ...(showThinking && thinkingText ? [
      <Text dimColor key="thinking">{thinkingOnly ? `(${thinkingText})` : thinkingText}</Text>,
    ] : []),
  ];
  // Claude Code parity: the leader's byline ends with the interrupt
  // affordance whenever there is status content (and it fits). The
  // thinking-only compact form keeps its bare "(thinking)" instead.
  if (
    !thinkingOnly &&
    parts.length > 0 &&
    availableSpace > usedAfterRate + ESC_HINT_WIDTH + SEP_WIDTH
  ) {
    parts.push(<Text dimColor key="esc">{ESC_HINT_TEXT}</Text>);
  }

  const status =
    foregroundedTeammate && !foregroundedTeammate.isIdle ? (
      <>
        {/* Leading space separates the verb (e.g. "Working…") from the status
            group; without it the message and "(" run together. */}
        <Text dimColor>{' (esc to interrupt '}</Text>
        <Text color={toInkColor(foregroundedTeammate.identity.color)}>
          {foregroundedTeammate.identity.agentName}
        </Text>
        <Text dimColor>)</Text>
      </>
    ) : !foregroundedTeammate && parts.length > 0 ? (
      thinkingOnly ? (
        // The thinking-only byline already carries its own "(…)"; a single
        // leading space keeps it off the verb.
        <>
          <Text dimColor>{' '}</Text>
          <Byline>{parts}</Byline>
        </>
      ) : (
        <>
          <Text dimColor>{' ('}</Text>
          <Byline>{parts}</Byline>
          <Text dimColor>)</Text>
        </>
      )
    ) : null;

  return (
    <FullWidthRow>
      <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
        <Box flexWrap="wrap" height={1} width={2}>
          <Text color={messageColor}>{statusGlyph(mode, hasActiveTools)}</Text>
        </Box>
        <Text color={messageColor}>{visibleMessage}</Text>
        {status}
      </Box>
    </FullWidthRow>
  );
}

function SpinnerModeGlyph({ mode }: { mode: SpinnerMode }): React.ReactNode {
  switch (mode) {
    case 'tool-input':
    case 'tool-use':
    case 'responding':
    case 'thinking':
      return <Box width={2}><Text dimColor>{figures.arrowDown}</Text></Box>;
    case 'requesting':
      return <Box width={2}><Text dimColor>{figures.arrowUp}</Text></Box>;
  }
}
