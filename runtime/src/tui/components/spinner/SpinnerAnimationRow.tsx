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
}: SpinnerAnimationRowProps): React.ReactNode {
  const now = Date.now();
  const elapsedTimeMs =
    pauseStartTimeRef.current !== null
      ? pauseStartTimeRef.current - loadingStartTimeRef.current - totalPausedMsRef.current
      : now - loadingStartTimeRef.current - totalPausedMsRef.current;

  const visibleMessage = truncateSpinnerText(message, computeSpinnerMessageMaxWidth(columns));
  const leaderTokens = Math.round(responseLengthRef.current / 4);
  const totalTokens =
    foregroundedTeammate && !foregroundedTeammate.isIdle
      ? foregroundedTeammate.progress?.tokenCount ?? 0
      : leaderTokens + teammateTokens;
  const tokenCount = formatNumber(totalTokens);
  const tokensText = hasRunningTeammates
    ? `${tokenCount} tokens`
    : `${figures.arrowDown} ${tokenCount} tokens`;
  const tokensWidth = stringWidth(tokensText);
  const timerText = formatDuration(elapsedTimeMs);
  const timerWidth = stringWidth(timerText);

  let thinkingText =
    thinkingStatus === 'thinking'
      ? `thinking${effortSuffix}`
      : typeof thinkingStatus === 'number'
        ? `thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s`
        : null;
  let thinkingWidthValue = thinkingText ? stringWidth(thinkingText) : 0;

  const messageWidth = stringWidth(visibleMessage) + 2;
  const wantsThinking = thinkingStatus !== null;
  const wantsTimerAndTokens = verbose || hasRunningTeammates || elapsedTimeMs > SHOW_TOKENS_AFTER_MS;
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
  const thinkingOnly = showThinking && thinkingStatus === 'thinking' && !spinnerSuffix && !showTimer && !showTokens;

  const parts = [
    ...(spinnerSuffix ? [<Text dimColor key="suffix">{spinnerSuffix}</Text>] : []),
    ...(showTimer ? [<Text dimColor key="elapsedTime">{timerText}</Text>] : []),
    ...(showTokens ? [
      <Box flexDirection="row" key="tokens">
        {!hasRunningTeammates && <SpinnerModeGlyph mode={mode} />}
        <Text dimColor>{tokenCount} tokens</Text>
      </Box>,
    ] : []),
    ...(showThinking && thinkingText ? [
      <Text dimColor key="thinking">{thinkingOnly ? `(${thinkingText})` : thinkingText}</Text>,
    ] : []),
  ];

  const status =
    foregroundedTeammate && !foregroundedTeammate.isIdle ? (
      <>
        <Text dimColor>(esc to interrupt </Text>
        <Text color={toInkColor(foregroundedTeammate.identity.color)}>
          {foregroundedTeammate.identity.agentName}
        </Text>
        <Text dimColor>)</Text>
      </>
    ) : !foregroundedTeammate && parts.length > 0 ? (
      thinkingOnly ? (
        <Byline>{parts}</Byline>
      ) : (
        <>
          <Text dimColor>(</Text>
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
