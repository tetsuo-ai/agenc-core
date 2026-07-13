/**
 * CoordinatorTaskPanel — Steerable list of background agents.
 *
 * Renders below the prompt input footer when agent tasks appear, when the
 * tasks footer is selected, or while a task is being viewed. Enter to
 * view/steer, x to dismiss.
 */

import * as React from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { Box } from '../ink.js';
import { type AppState, useAppState, useSetAppState } from '../state/AppState.js';
import { enterTeammateView, exitTeammateView } from '../state/teammateViewHelpers';
import { isLocalAgentTask, isPanelAgentTask, type LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask';
import { agentRolePresentation } from '../../agents/role-presentation.js';
import { formatDuration, formatNumber } from '../../utils/format';
import { estimateAgentCostUsd, formatUsdCost } from '../../session/cost.js';
import { evictTerminalTask } from '../../utils/task/framework';
import { isTerminalStatus } from './tasks/taskStatusUtils';
import { AURA_LIFECYCLE_GLYPHS } from '../../utils/theme.js';
import ThemedBox from './design-system/ThemedBox.js';
import ThemedText from './design-system/ThemedText.js';

export const AGENT_PANEL_TRANSIENT_MS = 5_000;

function formatAgentPanelRole(roleName: string | undefined): string {
  return agentRolePresentation(roleName)?.label ?? "Agent";
}

function formatAgentPanelIdentity(task: LocalAgentTaskState, name: string | undefined): string {
  return `${name ?? task.agentId} · ${formatAgentPanelRole(task.agentType)}`;
}

/**
 * Which panel-managed tasks currently have a visible row.
 * Presence in AppState.tasks IS visibility — the 1s tick in
 * CoordinatorTaskPanel evicts tasks past their evictAfter deadline. The
 * evictAfter !== 0 check handles immediate dismiss (x key) without making
 * the filter time-dependent. Shared by panel render, useCoordinatorTaskCount,
 * and index resolvers so the math can't drift.
 */
export function getVisibleAgentTasks(tasks: AppState['tasks']): LocalAgentTaskState[] {
  return Object.values(tasks).filter((t): t is LocalAgentTaskState => isPanelAgentTask(t) && t.evictAfter !== 0).sort((a, b) => a.startTime - b.startTime);
}

export function getCoordinatorTaskCount(tasks: AppState['tasks']): number {
  const visibleTasks = getVisibleAgentTasks(tasks);
  return visibleTasks.length === 0 ? 0 : visibleTasks.length + 1;
}

export function getCoordinatorTaskPanelVisibilityKey(
  visibleTasks: readonly LocalAgentTaskState[],
): string {
  return visibleTasks
    .map(task => `${task.id}:${task.status}:${task.startTime}:${task.endTime ?? ''}`)
    .join('|');
}

export function shouldShowCoordinatorTaskPanel({
  visibleTasks,
  footerSelection,
  viewingAgentTaskId,
  transientVisibleUntil,
  now,
}: {
  visibleTasks: readonly LocalAgentTaskState[];
  footerSelection: AppState['footerSelection'];
  viewingAgentTaskId?: string;
  transientVisibleUntil: number;
  now: number;
}): boolean {
  if (visibleTasks.length === 0) {
    return false;
  }
  if (footerSelection === 'tasks') {
    return true;
  }
  if (now < transientVisibleUntil) {
    return true;
  }
  return viewingAgentTaskId !== undefined && visibleTasks.some(task => task.id === viewingAgentTaskId);
}

export function CoordinatorTaskPanel(): React.ReactNode {
  const tasks = useAppState(s => s.tasks);
  const viewingAgentTaskId = useAppState(s_0 => s_0.viewingAgentTaskId);
  const agentNameRegistry = useAppState(s_1 => s_1.agentNameRegistry);
  const coordinatorTaskIndex = useAppState(s_2 => s_2.coordinatorTaskIndex);
  const footerSelection = useAppState(s_3 => s_3.footerSelection);
  const tasksSelected = footerSelection === 'tasks';
  const setAppState = useSetAppState();
  const visibleTasks = getVisibleAgentTasks(tasks);
  const selectedIndex = tasksSelected
    ? Math.max(0, Math.min(coordinatorTaskIndex, visibleTasks.length))
    : undefined;
  const hasTasks = Object.values(tasks).some(isPanelAgentTask);
  const visibilityKey = getCoordinatorTaskPanelVisibilityKey(visibleTasks);
  const visibilityKeyRef = React.useRef('');
  const transientVisibleUntilRef = React.useRef(0);
  const now = Date.now();

  if (visibleTasks.length === 0) {
    visibilityKeyRef.current = '';
    transientVisibleUntilRef.current = 0;
  } else if (visibilityKeyRef.current !== visibilityKey) {
    visibilityKeyRef.current = visibilityKey;
    transientVisibleUntilRef.current = now + AGENT_PANEL_TRANSIENT_MS;
  }

  // 1s tick: re-render for elapsed time + evict tasks past their deadline.
  // The eviction deletes from prev.tasks, which makes useCoordinatorTaskCount
  // (and other consumers) see the updated count without their own tick.
  const tasksRef = React.useRef(tasks);
  tasksRef.current = tasks;
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!hasTasks) return;
    const interval = setInterval((tasksRef_0, setAppState_0, setTick_0) => {
      const now = Date.now();
      for (const t of Object.values(tasksRef_0.current)) {
        if (isPanelAgentTask(t) && isTerminalStatus(t.status) && (t.evictAfter ?? Infinity) <= now) {
          evictTerminalTask(t.id, setAppState_0);
        }
      }
      setTick_0((prev: number) => prev + 1);
    }, 1000, tasksRef, setAppState, setTick);
    return () => clearInterval(interval);
  }, [hasTasks, setAppState]);
  const nameByAgentId = React.useMemo(() => {
    const inv = new Map<string, string>();
    for (const [n, id] of agentNameRegistry) inv.set(id, n);
    return inv;
  }, [agentNameRegistry]);
  if (!shouldShowCoordinatorTaskPanel({
    visibleTasks,
    footerSelection,
    viewingAgentTaskId,
    transientVisibleUntil: transientVisibleUntilRef.current,
    now,
  })) {
    return null;
  }
  const focusedTask = selectedIndex !== undefined && selectedIndex > 0
    ? visibleTasks[selectedIndex - 1]
    : viewingAgentTaskId
      ? visibleTasks.find(task => task.id === viewingAgentTaskId)
      : visibleTasks[0];
  return <ThemedBox flexDirection="column" marginTop={1} borderStyle="single" borderColor="lineSoft" paddingX={1}>
      <Box justifyContent="space-between">
        <ThemedText color="muted3" bold={true}>AGENT FLEET</ThemedText>
        <ThemedText color="text2">{visibleTasks.length} active</ThemedText>
      </Box>
      <FleetHeader />
      <MainLine isSelected={selectedIndex === 0} isViewed={viewingAgentTaskId === undefined} tokens={orchestratorTokenLabel(tasks)} onClick={() => exitTeammateView(setAppState)} />
      {visibleTasks.map((task, i) => <AgentLine key={task.id} task={task} name={nameByAgentId.get(task.id)} isSelected={selectedIndex === i + 1} isViewed={viewingAgentTaskId === task.id} onClick={() => enterTeammateView(task.id, setAppState)} />)}
      {focusedTask ? <FocusedAgentBlock task={focusedTask} name={nameByAgentId.get(focusedTask.id)} /> : null}
    </ThemedBox>;
}

/**
 * Returns the number of visible coordinator tasks (for selection bounds).
 * The panel's 1s tick evicts expired tasks from prev.tasks, so this count
 * stays accurate without needing its own tick.
 */
export function useCoordinatorTaskCount() {
  const tasks = useAppState(_temp);
  return getCoordinatorTaskCount(tasks);
}
function _temp(s) {
  return s.tasks;
}

function taskElapsed(task: LocalAgentTaskState, now = Date.now()): string {
  const running = !isTerminalStatus(task.status);
  const pausedMs = task.totalPausedMs ?? 0;
  const elapsedMs = Math.max(0, running ? now - task.startTime - pausedMs : (task.endTime ?? task.startTime) - task.startTime - pausedMs);
  return formatDuration(elapsedMs);
}

function taskStatusGlyph(task: LocalAgentTaskState): string {
  if (task.status === 'running') return AURA_LIFECYCLE_GLYPHS.running;
  if (task.status === 'completed') return AURA_LIFECYCLE_GLYPHS.done;
  if (task.status === 'failed' || task.status === 'killed') return AURA_LIFECYCLE_GLYPHS.failed;
  return AURA_LIFECYCLE_GLYPHS.queued;
}

function taskStatusColor(task: LocalAgentTaskState): 'agenc' | 'worker' | 'muted3' {
  if (task.status === 'running') return 'worker';
  if (task.status === 'completed') return 'agenc';
  if (task.status === 'failed' || task.status === 'killed') return 'agenc';
  return 'muted3';
}

function taskLastAction(task: LocalAgentTaskState): string {
  const error = typeof task.error === 'string' && task.error.trim().length > 0
    ? task.error.trim()
    : undefined;
  const description = task.description.trim();
  return error
    ?? task.progress?.summary
    ?? task.progress?.lastActivity?.activityDescription
    ?? task.progress?.lastActivity?.toolName
    ?? (description.length > 0 ? description : undefined)
    ?? 'idle';
}

function taskTokenLabel(task: LocalAgentTaskState): string {
  const tokenCount = task.progress?.tokenCount;
  return tokenCount !== undefined && tokenCount > 0 ? `${formatNumber(tokenCount)} tokens` : '—';
}

/**
 * Per-agent spend label for the focused-agent block. The TUI surfaces a per-
 * agent TOTAL token count (progress.tokenCount) and the agent's model, but no
 * input/output split — so this is an ESTIMATE (suffixed "est.") derived via
 * the same cost registry the live sidecar uses. Returns "—" when no real
 * token count / resolvable model is available; never fabricates "$0.00".
 */
export function taskSpendLabel(task: LocalAgentTaskState): string {
  const estimate = estimateAgentCostUsd({
    totalTokens: task.progress?.tokenCount,
    model: task.model,
  });
  if (estimate === null) return '—';
  return `${formatUsdCost(estimate.costUsd)} est.`;
}

/**
 * Token label for the orchestrator (main-session) row. Reads the live
 * main-session task's accumulated token count from AppState so the row shows
 * real usage instead of a hardcoded dash. "—" only when no main-session task
 * has reported a token count yet.
 */
export function orchestratorTokenLabel(tasks: AppState['tasks']): string {
  let total = 0;
  for (const task of Object.values(tasks)) {
    if (
      isLocalAgentTask(task) &&
      task.agentType === 'main-session' &&
      typeof task.progress?.tokenCount === 'number'
    ) {
      total += task.progress.tokenCount;
    }
  }
  return total > 0 ? `${formatNumber(total)} tokens` : '—';
}

function taskScopeLabel(task: LocalAgentTaskState): string {
  return task.selectedAgent?.memory ?? task.selectedAgent?.source ?? 'session';
}

function taskWorktreeLabel(task: LocalAgentTaskState): string {
  const worktreePath = (task as { readonly worktreePath?: unknown }).worktreePath;
  return typeof worktreePath === 'string' && worktreePath.length > 0 ? worktreePath : 'current checkout';
}

function FleetHeader(): React.ReactNode {
  const { columns } = useTerminalSize();
  const nameWidth = columns >= 90 ? 26 : 20;
  const statusWidth = columns >= 90 ? 16 : 13;
  const tokenWidth = columns >= 90 ? 14 : 10;
  const ageWidth = columns >= 90 ? 10 : 8;
  const lastActionWidth = Math.max(
    14,
    columns - nameWidth - statusWidth - tokenWidth - ageWidth - 8,
  );
  return (
    <Box flexDirection="row">
      <Box width={1} />
      <Box width={nameWidth}><ThemedText color="muted3" wrap="truncate-end">name · Role</ThemedText></Box>
      <Box width={statusWidth}><ThemedText color="muted3" wrap="truncate-end">status</ThemedText></Box>
      <Box width={lastActionWidth}><ThemedText color="muted3" wrap="truncate-end">last action</ThemedText></Box>
      <Box width={tokenWidth}><ThemedText color="muted3" wrap="truncate-end">tokens</ThemedText></Box>
      <Box width={ageWidth}><ThemedText color="muted3" wrap="truncate-end">age</ThemedText></Box>
    </Box>
  );
}

function FleetRow({
  age,
  lastAction,
  nameRole,
  onClick,
  selected,
  status,
  statusColor,
  tokens,
}: {
  readonly age: string;
  readonly lastAction: string;
  readonly nameRole: string;
  readonly onClick: () => void;
  readonly selected?: boolean;
  readonly status: string;
  readonly statusColor: 'agenc' | 'worker' | 'muted3';
  readonly tokens: string;
}): React.ReactNode {
  const { columns } = useTerminalSize();
  const [hover, setHover] = React.useState(false);
  const highlighted = selected || hover;
  const nameWidth = columns >= 90 ? 26 : 20;
  const statusWidth = columns >= 90 ? 16 : 13;
  const tokenWidth = columns >= 90 ? 14 : 10;
  const ageWidth = columns >= 90 ? 10 : 8;
  const lastActionWidth = Math.max(
    14,
    columns - nameWidth - statusWidth - tokenWidth - ageWidth - 8,
  );
  const row = (
    <ThemedBox flexDirection="row" backgroundColor={highlighted ? "agencWash" : undefined}>
      <Box width={1}><ThemedText color={highlighted ? "agenc" : "lineSoft"}>{highlighted ? "▌" : " "}</ThemedText></Box>
      <Box width={nameWidth}><ThemedText color={highlighted ? "agenc" : "text2"} wrap="truncate-end">{nameRole}</ThemedText></Box>
      <Box width={statusWidth}><ThemedText color={statusColor} wrap="truncate-end">{status}</ThemedText></Box>
      <Box width={lastActionWidth}><ThemedText color="text2" wrap="truncate-end">{lastAction}</ThemedText></Box>
      <Box width={tokenWidth}><ThemedText color="muted3" wrap="truncate-end">{tokens}</ThemedText></Box>
      <Box width={ageWidth}><ThemedText color="muted3" wrap="truncate-end">{age}</ThemedText></Box>
    </ThemedBox>
  );
  return <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>{row}</Box>;
}

function FocusedAgentBlock({
  task,
  name,
}: {
  readonly task: LocalAgentTaskState;
  readonly name?: string;
}): React.ReactNode {
  const progressGlyph = task.progress?.toolUseCount && task.progress.toolUseCount > 0 ? AURA_LIFECYCLE_GLYPHS.running : AURA_LIFECYCLE_GLYPHS.queued;
  const lastAction = taskLastAction(task);
  const queuedCount = task.pendingMessages.length;
  const actionHint = isTerminalStatus(task.status) ? "x to clear" : "x to stop";
  return (
    <ThemedBox flexDirection="column" borderStyle="single" borderColor="lineSoft" marginTop={1} paddingX={1}>
      <ThemedText color="agenc" wrap="truncate-end">{formatAgentPanelIdentity(task, name)}</ThemedText>
      <Box flexDirection="row">
        <ThemedText color="muted3">scope </ThemedText><ThemedText color="text2">{taskScopeLabel(task)}</ThemedText>
        <ThemedText color="muted3"> · worktree </ThemedText><ThemedText color="text2" wrap="truncate-middle">{taskWorktreeLabel(task)}</ThemedText>
      </Box>
      <Box flexDirection="row">
        <ThemedText color="muted3">progress </ThemedText><ThemedText color="worker">{progressGlyph} {task.progress?.toolUseCount ?? 0} tools</ThemedText>
        <ThemedText color="muted3"> · spend </ThemedText><ThemedText color="text2">{taskSpendLabel(task)}</ThemedText>
      </Box>
      {queuedCount > 0 ? (
        <Box flexDirection="row">
          <ThemedText color="muted3">queued </ThemedText>
          <ThemedText color="text2">{queuedCount} queued · {actionHint}</ThemedText>
        </Box>
      ) : null}
      <Box flexDirection="column">
        <ThemedText color="muted3">last output</ThemedText>
        <Box flexGrow={1} overflow="hidden">
          <ThemedText color="text2" wrap="truncate-end">{lastAction}</ThemedText>
        </Box>
      </Box>
    </ThemedBox>
  );
}

function MainLine(t0: {
  isSelected?: boolean;
  isViewed?: boolean;
  tokens?: string;
  onClick: () => void;
}) {
  const {
    isSelected,
    isViewed,
    tokens,
    onClick
  } = t0;
  return <FleetRow nameRole="orchestrator · Orchestrator" status={`${AURA_LIFECYCLE_GLYPHS.done} active`} statusColor="agenc" lastAction="main session" tokens={tokens ?? "—"} age="now" selected={isSelected || isViewed} onClick={onClick} />;
}
type AgentLineProps = {
  task: LocalAgentTaskState;
  name?: string;
  isSelected?: boolean;
  isViewed?: boolean;
  onClick: () => void;
};
function AgentLine(t0) {
  const {
    task,
    name,
    isSelected,
    isViewed,
    onClick
  } = t0;
  const queuedCount = task.pendingMessages.length;
  const queuedText = queuedCount > 0 ? ` · ${queuedCount} queued` : "";
  const agentIdentity = formatAgentPanelIdentity(task, name);
  const actionHint = isSelected && !isViewed ? ` · x to ${isTerminalStatus(task.status) ? "clear" : "stop"}` : "";
  return <FleetRow nameRole={agentIdentity} status={`${taskStatusGlyph(task)} ${task.status}`} statusColor={taskStatusColor(task)} lastAction={`${taskLastAction(task)}${queuedText}${actionHint}`} tokens={taskTokenLabel(task)} age={taskElapsed(task)} selected={isSelected || isViewed} onClick={onClick} />;
}
