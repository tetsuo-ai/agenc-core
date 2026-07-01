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
const SHOW_TOKENS_AFTER_MS = 30_000;
// After this long with no new token, surface a heartbeat note so a slow model
// reads as "alive but slow" instead of "hung". A healthy model streams tokens
// every fraction of a second, so this only fires on genuinely slow turns.
const STALL_NOTE_AFTER_MS = 8_000;
// Only compute a tokens/sec rate once the turn has run long enough and produced
// enough tokens that the figure is meaningful (mirrors the budget-path gate).
const RATE_MIN_ELAPSED_MS = 5_000;
const RATE_MIN_TOKENS = 20;

/**
 * Tracks token liveness across renders so the row can tell "alive but slow"
 * from "hung". Returns ms since the token counter last moved and a tokens/sec
 * rate once tokens are flowing. Refs (not state) — the row re-renders from its
 * parent's wall-clock tick, so reading on render is enough and avoids extra
 * re-renders. `firstSeenAt` lets us measure rate from when tokens started, not
 * from a pre-stream zero.
 *
 * `turnStartedAt` seeds the no-token clock so a turn that has already been
 * silent for minutes reports its real silence on the very first render (e.g.
 * after a remount), rather than resetting to zero each mount.
 */
function useTokenLiveness(
  totalTokens: number,
  now: number,
  turnStartedAt: number,
): {
  msSinceLastToken: number;
  ratePerSec: number;
} {
  const state = React.useRef<{
    firstSeenAt: number | null;
    lastChangeAt: number;
    lastTokens: number;
  } | null>(null);
  if (state.current === null) {
    // First render of this turn. If no token has streamed yet, anchor the
    // no-token clock at the turn start so a long pre-token silence reads as
    // honest immediately (e.g. a remount mid-stall). If tokens are already
    // present we don't know when the last one arrived, so treat "now" as fresh
    // and never falsely flag a clearly-alive stream as stalled.
    state.current = {
      firstSeenAt: totalTokens > 0 ? now : null,
      lastChangeAt: totalTokens > 0 ? now : Math.min(turnStartedAt, now),
      lastTokens: totalTokens,
    };
  }
  const s = state.current;
  if (totalTokens !== s.lastTokens) {
    if (s.firstSeenAt === null && totalTokens > 0) s.firstSeenAt = now;
    s.lastTokens = totalTokens;
    s.lastChangeAt = now;
  }
  const msSinceLastToken = Math.max(0, now - s.lastChangeAt);
  const sinceFirst = s.firstSeenAt !== null ? now - s.firstSeenAt : 0;
  const ratePerSec =
    totalTokens >= RATE_MIN_TOKENS && sinceFirst >= RATE_MIN_ELAPSED_MS
      ? (totalTokens / sinceFirst) * 1000
      : 0;
  return { msSinceLastToken, ratePerSec };
}

function formatRate(ratePerSec: number): string {
  return ratePerSec >= 10
    ? `${Math.round(ratePerSec)} tok/s`
    : `${ratePerSec.toFixed(1)} tok/s`;
}

export type SpinnerAnimationRowProps = {
  // Kept in the public prop shape while the surrounding spinner code is
  // migrated. The v2 visual contract renders this row without a frame clock.
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
  const now = Date.now();
  const elapsedTimeMs =
    pauseStartTimeRef.current !== null
      ? pauseStartTimeRef.current - loadingStartTimeRef.current - totalPausedMsRef.current
      : now - loadingStartTimeRef.current - totalPausedMsRef.current;

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
  const { msSinceLastToken, ratePerSec } = useTokenLiveness(
    trackLiveness ? totalTokens : 0,
    now,
    loadingStartTimeRef.current,
  );
  // Show the heartbeat once the turn has been waiting on a token long enough to
  // look stuck — but not while "thinking" is already explaining the silence.
  const showStallNote =
    trackLiveness &&
    !hasRunningTeammates &&
    thinkingStatus !== 'thinking' &&
    elapsedTimeMs > STALL_NOTE_AFTER_MS &&
    msSinceLastToken > STALL_NOTE_AFTER_MS;
  const stallNoteText = showStallNote
    ? totalTokens > 0
      ? `slow model · last token ${formatDuration(msSinceLastToken)} ago`
      : 'slow model · still generating'
    : null;
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
