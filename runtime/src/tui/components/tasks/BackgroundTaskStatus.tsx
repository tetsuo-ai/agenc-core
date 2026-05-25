import * as React from 'react';
import { useMemo, useState } from 'react';
import { selectAgenCTuiGlyphs } from '../../glyphs.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import { enterTeammateView, exitTeammateView } from '../../state/teammateViewHelpers.js';
import { getPillLabel } from 'src/tasks/pillLabel.js';
import { type BackgroundTaskState, isBackgroundTask, type TaskState } from 'src/tasks/types.js';
import { truncate } from '../../../utils/format.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { Box, Text } from '../../ink.js';
import { AGENT_COLOR_TO_THEME_COLOR, AGENT_COLORS, type AgentColorName } from 'src/tools/AgentTool/agentColorManager.js';
import type { Theme } from '../../../utils/theme.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint';
import { getTeammateFooterLayout } from './BackgroundTaskStatus.layout.js';

type Props = {
  tasksSelected: boolean;
  isViewingTeammate?: boolean;
  teammateFooterIndex?: number;
  isLeaderIdle?: boolean;
  onOpenDialog?: (taskId?: string) => void;
};

type FooterTask = Exclude<BackgroundTaskState, { readonly type: 'local_agent' }>;
type TeammateTask = Extract<FooterTask, { readonly type: 'in_process_teammate' }>;

type AgentPillModel = {
  color?: keyof Theme;
  idx: number;
  isIdle: boolean;
  name: string;
  taskId?: string;
};

function isFooterTask(task: TaskState): task is FooterTask {
  return isBackgroundTask(task) && task.type !== 'local_agent';
}

function isTeammateTask(task: FooterTask): task is TeammateTask {
  return task.type === 'in_process_teammate';
}

function sortTeammatesByName(a: TeammateTask, b: TeammateTask): number {
  return a.identity.agentName.localeCompare(b.identity.agentName);
}

function sortActiveBeforeIdle(a: Omit<AgentPillModel, 'idx'>, b: Omit<AgentPillModel, 'idx'>): number {
  if (a.isIdle !== b.isIdle) {
    return Number(a.isIdle) - Number(b.isIdle);
  }
  return 0;
}

function teammateToPill(task: TeammateTask): Omit<AgentPillModel, 'idx'> {
  return {
    name: task.identity.agentName,
    color: getAgentThemeColor(task.identity.color),
    isIdle: task.isIdle,
    taskId: task.id,
  };
}

function withIndex(pill: Omit<AgentPillModel, 'idx'>, idx: number): AgentPillModel {
  return { ...pill, idx };
}

function pillWidth(pill: AgentPillModel, index: number): number {
  return stringWidth(`@${pill.name}`) + (index > 0 ? 1 : 0);
}

function clampIndex(index: number, total: number): number {
  return Math.max(0, Math.min(index, Math.max(0, total - 1)));
}

export function BackgroundTaskStatus({
  tasksSelected,
  isViewingTeammate,
  teammateFooterIndex = 0,
  isLeaderIdle = false,
  onOpenDialog,
}: Props): React.ReactNode {
  const setAppState = useSetAppState();
  const { columns } = useTerminalSize();
  const glyphs = selectAgenCTuiGlyphs();
  const expandShortcut = glyphs.arrowDown === 'v' ? 'shift + down' : `shift + ${glyphs.arrowDown}`;
  const tasks = useAppState(s => s.tasks);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  const expandedView = useAppState(s => s.expandedView);
  const showSpinnerTree = expandedView === 'teammates';
  const footerTasks = useMemo(
    () => (Object.values(tasks) as TaskState[]).filter(isFooterTask),
    [tasks],
  );
  const teammateEntries = useMemo(
    () => footerTasks.filter(isTeammateTask).sort(sortTeammatesByName),
    [footerTasks],
  );
  const allTeammates =
    !showSpinnerTree &&
    footerTasks.length > 0 &&
    footerTasks.every(isTeammateTask);
  const onlySpinnerTreeTeammates =
    showSpinnerTree &&
    footerTasks.length > 0 &&
    footerTasks.every(isTeammateTask);

  const mainPill = useMemo<Omit<AgentPillModel, 'idx'>>(() => ({
    name: 'main',
    color: undefined,
    isIdle: isLeaderIdle,
    taskId: undefined,
  }), [isLeaderIdle]);

  const allPills = useMemo(() => {
    const teammatePills = teammateEntries.map(teammateToPill);
    if (!tasksSelected) {
      teammatePills.sort(sortActiveBeforeIdle);
    }
    return [mainPill, ...teammatePills].map(withIndex);
  }, [mainPill, tasksSelected, teammateEntries]);

  const pillWidths = useMemo(
    () => allPills.map(pillWidth),
    [allPills],
  );

  if (allTeammates || (!showSpinnerTree && isViewingTeammate)) {
    const selectedIdx = tasksSelected ? clampIndex(teammateFooterIndex, allPills.length) : -1;
    const viewedIdx = viewingAgentTaskId
      ? allPills.findIndex(pill => pill.taskId === viewingAgentTaskId)
      : 0;
    const layoutFocusIdx = selectedIdx >= 0 ? selectedIdx : viewedIdx >= 0 ? viewedIdx : 0;
    const {
      startIndex,
      endIndex,
      showLeftArrow,
      showRightArrow,
      showExpandHint,
      visiblePillWidths,
    } = getTeammateFooterLayout(pillWidths, columns, layoutFocusIdx);
    const visiblePills = allPills.slice(startIndex, endIndex);

    return (
      <>
        {showLeftArrow && <Text dimColor={true}>{glyphs.arrowLeft} </Text>}
        {visiblePills.map((pill, index) => (
          <React.Fragment key={`${pill.idx}:${pill.name}`}>
            {index > 0 && <Text> </Text>}
            <AgentPill
              name={pill.name}
              color={pill.color}
              maxWidth={visiblePillWidths[index]}
              isSelected={selectedIdx === pill.idx}
              isViewed={viewedIdx === pill.idx}
              isIdle={pill.isIdle}
              onClick={() => pill.taskId ? enterTeammateView(pill.taskId, setAppState) : exitTeammateView(setAppState)}
            />
          </React.Fragment>
        ))}
        {showRightArrow && <Text dimColor={true}> {glyphs.arrowRight}</Text>}
        {showExpandHint && (
          <Text dimColor={true}>
            {' '}{glyphs.separator}{' '}
            <KeyboardShortcutHint shortcut={expandShortcut} action="expand" />
          </Text>
        )}
      </>
    );
  }

  if (onlySpinnerTreeTeammates) {
    return null;
  }
  if (footerTasks.length === 0) {
    return null;
  }

  const label = getPillLabel(footerTasks);
  return (
    <>
      <SummaryPill selected={tasksSelected} onClick={onOpenDialog}>{label}</SummaryPill>
    </>
  );
}

type AgentPillProps = {
  name: string;
  color?: keyof Theme;
  maxWidth: number;
  isSelected: boolean;
  isViewed: boolean;
  isIdle: boolean;
  onClick: () => void;
};

function AgentPill({
  name,
  color,
  maxWidth,
  isSelected,
  isViewed,
  isIdle,
  onClick,
}: AgentPillProps): React.ReactNode {
  const [hover, setHover] = useState(false);
  const highlighted = isSelected || hover;
  const rawLabelText = `@${name}`;
  const labelText = truncate(rawLabelText, Math.max(1, maxWidth), true);

  let label: React.ReactNode;
  if (highlighted) {
    label = color
      ? <Text backgroundColor={color} color="inverseText" bold={isViewed}>{labelText}</Text>
      : <Text color="background" inverse={true} bold={isViewed}>{labelText}</Text>;
  } else if (isIdle) {
    label = <Text dimColor={true} bold={isViewed}>{labelText}</Text>;
  } else if (isViewed) {
    label = <Text color={color} bold={true}>{labelText}</Text>;
  } else {
    label = <Text color={color} dimColor={!color}>{labelText}</Text>;
  }

  return <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>{label}</Box>;
}

type SummaryPillProps = {
  selected: boolean;
  onClick?: () => void;
  children: React.ReactNode;
};

function SummaryPill({
  selected,
  onClick,
  children,
}: SummaryPillProps): React.ReactNode {
  const [hover, setHover] = useState(false);
  const label = <Text color="background" inverse={selected || hover}>{children}</Text>;

  if (!onClick) {
    return label;
  }

  return <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>{label}</Box>;
}

function getAgentThemeColor(colorName: string | undefined): keyof Theme | undefined {
  if (!colorName) return undefined;
  if (AGENT_COLORS.includes(colorName as AgentColorName)) {
    return AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName];
  }
  return undefined;
}
