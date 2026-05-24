import figures from 'figures';
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import type { AppState } from '../../state/AppState.js';
import { getRunningTeammatesSorted } from '../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { formatNumber } from '../../../utils/format.js';
import { selectAgenCTuiGlyphs } from '../../glyphs.js';
import { TeammateSpinnerLine } from './TeammateSpinnerLine.js';
import { SPINNER_AGENT_THEME_COLOR } from './spinnerTheme.js';
import { TEAMMATE_SELECT_HINT } from './teammateSelectHint.js';
import { getSpinnerEllipsis } from './utils.js';
type Props = {
  selectedIndex?: number;
  isInSelectionMode?: boolean;
  allIdle?: boolean;
  /** Leader's active verb (when leader is actively processing) */
  leaderVerb?: string;
  /** Leader's token count (when leader is actively processing) */
  leaderTokenCount?: number;
  /** Leader's idle status text (when leader is idle, e.g. "✻ Idle for 3s") */
  leaderIdleText?: string;
};

export function isTeammateHideRowSelected({
  isInSelectionMode,
  selectedIndex,
  teammateCount,
}: {
  isInSelectionMode?: boolean;
  selectedIndex?: number;
  teammateCount: number;
}): boolean {
  return (
    isInSelectionMode === true
    && selectedIndex !== undefined
    && selectedIndex >= teammateCount
  );
}

export function TeammateSpinnerTree({
  selectedIndex,
  isInSelectionMode,
  allIdle,
  leaderVerb,
  leaderTokenCount,
  leaderIdleText,
}: Props): React.ReactElement | null {
  const tasks = useAppState(_temp);
  const viewingAgentTaskId = useAppState(_temp2);
  const showTeammateMessagePreview = useAppState(_temp3);
  const glyphs = selectAgenCTuiGlyphs();

  const teammateTasks = getRunningTeammatesSorted(tasks);
  if (teammateTasks.length === 0) {
    return null;
  }

  const isLeaderForegrounded = viewingAgentTaskId === undefined;
  const isLeaderSelected = isInSelectionMode === true && selectedIndex === -1;
  const isLeaderHighlighted = isLeaderForegrounded || isLeaderSelected;
  const isHideSelected = isTeammateHideRowSelected({
    isInSelectionMode,
    selectedIndex,
    teammateCount: teammateTasks.length,
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingLeft={3}>
        <Text
          color={isLeaderSelected ? 'suggestion' : undefined}
          bold={isLeaderHighlighted}
        >
          {isLeaderSelected ? figures.pointer : ' '}
        </Text>
        <Text dimColor={!isLeaderHighlighted} bold={isLeaderHighlighted}>
          {isLeaderHighlighted ? glyphs.treeSelectedRoot : glyphs.treeRoot}{' '}
        </Text>
        <Text bold={isLeaderHighlighted} color={SPINNER_AGENT_THEME_COLOR}>
          team-lead
        </Text>
        {!isLeaderForegrounded && leaderVerb && (
          <Text dimColor={true}>: {leaderVerb}{getSpinnerEllipsis()}</Text>
        )}
        {!isLeaderForegrounded && !leaderVerb && leaderIdleText && (
          <Text dimColor={true}>: {leaderIdleText}</Text>
        )}
        {leaderTokenCount !== undefined && leaderTokenCount > 0 && (
          <Text dimColor={!isLeaderHighlighted}>
            {' '}· {formatNumber(leaderTokenCount)} tokens
          </Text>
        )}
        {isLeaderHighlighted && (
          <Text dimColor={true}> · {TEAMMATE_SELECT_HINT}</Text>
        )}
        {isLeaderSelected && !isLeaderForegrounded && (
          <Text dimColor={true}> · enter to view</Text>
        )}
      </Box>
      {teammateTasks.map((teammate, index) => (
        <TeammateSpinnerLine
          key={teammate.id}
          teammate={teammate}
          isLast={!isInSelectionMode && index === teammateTasks.length - 1}
          isSelected={isInSelectionMode === true && selectedIndex === index}
          isForegrounded={viewingAgentTaskId === teammate.id}
          allIdle={allIdle}
          showPreview={showTeammateMessagePreview}
        />
      ))}
      {isInSelectionMode === true && <HideRow isSelected={isHideSelected} />}
    </Box>
  );
}
function _temp3(s_1: AppState) {
  return s_1.showTeammateMessagePreview;
}
function _temp2(s_0: AppState) {
  return s_0.viewingAgentTaskId;
}
function _temp(s: AppState) {
  return s.tasks;
}
function HideRow({ isSelected }: { isSelected?: boolean }): React.ReactElement {
  const glyphs = selectAgenCTuiGlyphs();

  return (
    <Box paddingLeft={3}>
      <Text color={isSelected ? 'suggestion' : undefined} bold={isSelected}>
        {isSelected ? figures.pointer : ' '}
      </Text>
      <Text dimColor={!isSelected} bold={isSelected}>
        {isSelected ? glyphs.treeSelectedLast : glyphs.treeLast}{' '}
      </Text>
      <Text dimColor={!isSelected} bold={isSelected}>
        hide
      </Text>
      {isSelected && <Text dimColor={true}> · enter to collapse</Text>}
    </Box>
  );
}
