import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { Box, Text } from '../../ink.js';
import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { feature } from 'bun:bundle';
import { getKairosActive, getUserMsgOptIn } from '../../../bootstrap/state.js';
import { isEnvTruthy } from '../../../utils/envUtils.js';
import { count } from '../../../utils/array.js';
import sample from 'lodash-es/sample.js';
import { formatDuration, formatNumber } from '../../../utils/format.js';
import type { Theme } from '../../../utils/theme.js';
import { activityManager } from '../../../utils/activityManager.js';
import { getSpinnerVerbs } from '../../../constants/spinnerVerbs.js';
import { MessageResponse } from '../MessageResponse.js';
import { TaskListV2 } from '../TaskListV2.js';
import { useTasksV2 } from '../../hooks/useTasksV2.js';
import type { Task } from '../../../utils/tasks.js';
import { useAppState } from '../../state/AppState.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { stringWidth } from '../../ink/stringWidth.js';
import type { SpinnerMode } from './types.js';
import { computeBriefRightStatusLayout, getSpinnerEllipsis, titleVerbForMode } from './utils.js';
import { SpinnerAnimationRow } from './SpinnerAnimationRow.js';
import { useSettings } from '../../hooks/useSettings.js';
import { isInProcessTeammateTask } from '../../../tasks/InProcessTeammateTask/types.js';
import { isBackgroundTask } from '../../../tasks/types.js';
import { getAllInProcessTeammateTasks } from '../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { getEffortSuffix } from '../../../utils/effort.js';
import { getMainLoopModel } from '../../../utils/model/model.js';
import { getViewedTeammateTask } from '../../state/selectors.js';
import { TEARDROP_ASTERISK } from '../../../constants/figures.js';
import figures from 'figures';
import { getCurrentTurnTokenBudget, getTurnOutputTokens } from '../../../bootstrap/state.js';
import { TeammateSpinnerTree } from './TeammateSpinnerTree.js';
import { formatRunningAgentSummary, getActiveLocalAgentTasks } from './agentActivity.js';
import { SPINNER_AGENT_THEME_COLOR } from './spinnerTheme.js';
export type { SpinnerMode } from './types.js';

type Props = {
  mode: SpinnerMode;
  loadingStartTimeRef: React.RefObject<number>;
  totalPausedMsRef: React.RefObject<number>;
  pauseStartTimeRef: React.RefObject<number | null>;
  spinnerTip?: string;
  responseLengthRef: React.RefObject<number>;
  overrideColor?: keyof Theme | null;
  overrideShimmerColor?: keyof Theme | null;
  overrideMessage?: string | null;
  spinnerSuffix?: string | null;
  verbose: boolean;
  hasActiveTools?: boolean;
  /** Leader's turn has completed (no active query). Used to suppress stall-red spinner when only teammates are running. */
  leaderIsIdle?: boolean;
};

// Thin wrapper: branches on isBriefOnly so the two variants have independent
// hook call chains. Without this split, toggling /brief mid-render would
// violate Rules of Hooks (the inner variant calls ~10 more hooks).
export function SpinnerWithVerb(props: Props): React.ReactNode {
  const isBriefOnly = useAppState((s: any) => s.isBriefOnly);
  // REPL overrides isBriefOnly→false when viewing a teammate transcript
  // (see isBriefOnly={viewedTeammateTask ? false : isBriefOnly}). That
  // prop isn't threaded here, so replicate the gate from the store —
  // teammate view needs the real spinner (which shows teammate status).
  const viewingAgentTaskId = useAppState((s_0: any) => s_0.viewingAgentTaskId);
  // Hoisted to mount-time — this component re-renders at animation framerate.
  const briefEnvEnabled = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useMemo(() => isEnvTruthy(process.env.AGENC_BRIEF), []) : false;

  // Runtime gate mirrors isBriefEnabled() but inlined — importing from
  // BriefTool.ts would leak tool-name strings into external builds. Single
  // spinner instance → hooks stay unconditional (two subs, negligible).
  if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && (getKairosActive() || getUserMsgOptIn() && (briefEnvEnabled || false)) && isBriefOnly && !viewingAgentTaskId) {
    return <BriefSpinner mode={props.mode} overrideMessage={props.overrideMessage} />;
  }
  return <SpinnerWithVerbInner {...props} />;
}
function SpinnerWithVerbInner({
  mode,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerTip,
  responseLengthRef,
  overrideColor,
  overrideShimmerColor,
  overrideMessage,
  spinnerSuffix,
  verbose,
  hasActiveTools = false,
  leaderIsIdle = false
}: Props): React.ReactNode {
  const settings = useSettings();
  const reducedMotion = settings?.prefersReducedMotion ?? false;

  // The v2 visual contract keeps this row off the animation clock. It
  // re-renders from streaming/tool/task state changes rather than a timer.

  const tasks = useAppState((s: any) => s.tasks);
  const viewingAgentTaskId = useAppState((s_0: any) => s_0.viewingAgentTaskId);
  const expandedView = useAppState((s_1: any) => s_1.expandedView);
  const showExpandedTodos = expandedView === 'tasks';
  const showSpinnerTree = expandedView === 'teammates';
  const selectedIPAgentIndex = useAppState((s_2: any) => s_2.selectedIPAgentIndex);
  const viewSelectionMode = useAppState((s_3: any) => s_3.viewSelectionMode);
  // Get foregrounded teammate (if viewing a teammate's transcript)
  const foregroundedTeammate = viewingAgentTaskId ? getViewedTeammateTask({
    viewingAgentTaskId,
    tasks
  }) : undefined;
  const {
    columns
  } = useTerminalSize();
  const tasksV2 = useTasksV2();

  // Track thinking status: 'thinking' | number (duration in ms) | null
  // Shows each state for minimum 2s to avoid UI jank
  const [thinkingStatus, setThinkingStatus] = useState<'thinking' | number | null>(null);
  const thinkingStartRef = useRef<number | null>(null);
  useEffect(() => {
    let showDurationTimer: ReturnType<typeof setTimeout> | null = null;
    let clearStatusTimer: ReturnType<typeof setTimeout> | null = null;
    if (mode === 'thinking') {
      // Started thinking
      if (thinkingStartRef.current === null) {
        thinkingStartRef.current = Date.now();
        setThinkingStatus('thinking');
      }
    } else if (thinkingStartRef.current !== null) {
      // Stopped thinking - calculate duration and ensure 2s minimum display
      const duration = Date.now() - thinkingStartRef.current;
      const elapsed = Date.now() - thinkingStartRef.current;
      const remainingThinkingTime = Math.max(0, 2000 - elapsed);
      thinkingStartRef.current = null;

      // Show "thinking..." for remaining time if < 2s elapsed, then show duration
      const showDuration = (): void => {
        setThinkingStatus(duration);
        // Clear after 2s
        clearStatusTimer = setTimeout(setThinkingStatus, 2000, null);
      };
      if (remainingThinkingTime > 0) {
        showDurationTimer = setTimeout(showDuration, remainingThinkingTime);
      } else {
        showDuration();
      }
    }
    return () => {
      if (showDurationTimer) clearTimeout(showDurationTimer);
      if (clearStatusTimer) clearTimeout(clearStatusTimer);
    };
  }, [mode]);

  // Find the current in-progress task and next queued task.
  const currentTask = tasksV2?.find(task => task.status !== 'pending' && task.status !== 'completed');
  const nextTask = findNextPendingTask(tasksV2);

  // Use useState with initializer to pick a random verb once on mount.
  // Only used as a teammate-verb fallback now — the leader's own fallback is an
  // HONEST phase label (see phaseVerb below), never a random flavor word, so a
  // slow turn can't read as a system fault like a frozen "Booting…".
  const [randomVerb] = useState(() => sample(getSpinnerVerbs()));

  // Honest phase label derived from the real streaming mode. Agrees with the
  // workbench title-bar indicator (both call verbForMode), so the title bar and
  // the status line never disagree about what the model is doing.
  const phaseVerb = titleVerbForMode(mode);

  // Leader's own verb (always the leader's, regardless of who is foregrounded).
  // Prefer a real task subject/activeForm when present; otherwise show the
  // honest phase label rather than a random flavor verb.
  const leaderVerb = overrideMessage ?? currentTask?.activeForm ?? currentTask?.subject ?? phaseVerb;
  const effectiveVerb = foregroundedTeammate && !foregroundedTeammate.isIdle ? foregroundedTeammate.spinnerVerb ?? randomVerb : leaderVerb;
  const message = effectiveVerb + getSpinnerEllipsis();

  // Track CLI activity when spinner is active
  useEffect(() => {
    const operationId = 'spinner-' + mode;
    activityManager.startCLIActivity(operationId);
    return () => {
      activityManager.endCLIActivity(operationId);
    };
  }, [mode]);
  const effortValue = useAppState((s_4: any) => s_4.effortValue);
  const effortSuffix = getEffortSuffix(getMainLoopModel(), effortValue);

  // Check if any running in-process teammates exist (needed for both modes)
  const runningTeammates = getAllInProcessTeammateTasks(tasks ?? {}).filter(t => t.status === 'running');
  const hasRunningTeammates = runningTeammates.length > 0;
  const runningLocalAgents = getActiveLocalAgentTasks(tasks);
  const hasRunningLocalAgents = runningLocalAgents.length > 0;
  const allIdle = hasRunningTeammates && runningTeammates.every(t_0 => t_0.isIdle);

  // Gather aggregate token stats from all running swarm teammates
  // In spinner-tree mode, skip aggregation (teammates have their own lines in the tree)
  let teammateTokens = 0;
  if (!showSpinnerTree) {
    for (const task_0 of Object.values(tasks ?? {})) {
      if (isInProcessTeammateTask(task_0) && task_0.status === 'running') {
        if (task_0.progress?.tokenCount) {
          teammateTokens += task_0.progress.tokenCount;
        }
      }
    }
  }

  const elapsedSnapshot = pauseStartTimeRef.current !== null ? pauseStartTimeRef.current - loadingStartTimeRef.current - totalPausedMsRef.current : Date.now() - loadingStartTimeRef.current - totalPausedMsRef.current;

  // Leader token count for TeammateSpinnerTree — read raw (non-animated) from
  // the ref. The tree is only shown when teammates are running; teammate
  // progress updates to s.tasks trigger re-renders that keep this fresh.
  const leaderTokenCount = Math.round(responseLengthRef.current / 4);
  const defaultColor: keyof Theme = 'suggestion';
  const defaultShimmerColor: keyof Theme = 'suggestion';
  const messageColor = overrideColor ?? defaultColor;
  const shimmerColor = overrideShimmerColor ?? defaultShimmerColor;

  // When leader is idle but teammates are running (and we're viewing the leader),
  // show a static dim idle display instead of the animated spinner — otherwise
  // useStalledAnimation detects no new tokens after 3s and turns the spinner red.
  if (leaderIsIdle && (hasRunningTeammates || hasRunningLocalAgents) && !foregroundedTeammate) {
    return <Box flexDirection="column" width="100%" alignItems="flex-start">
        <Box flexDirection="row" flexWrap="wrap" marginTop={1} width="100%">
          <Text dimColor>
            {TEARDROP_ASTERISK} Idle
            {hasRunningLocalAgents ? ' · agents running' : !allIdle && ' · teammates running'}
          </Text>
        </Box>
        {hasRunningLocalAgents && <RunningLocalAgentsLine agents={runningLocalAgents} />}
        {showSpinnerTree && <TeammateSpinnerTree selectedIndex={selectedIPAgentIndex} isInSelectionMode={viewSelectionMode === 'selecting-agent'} allIdle={allIdle} leaderTokenCount={leaderTokenCount} leaderIdleText="Idle" />}
      </Box>;
  }

  // When viewing an idle teammate, show static idle display instead of animated spinner
  if (foregroundedTeammate?.isIdle) {
    const idleText = allIdle ? `${TEARDROP_ASTERISK} Worked for ${formatDuration(Date.now() - foregroundedTeammate.startTime)}` : `${TEARDROP_ASTERISK} Idle`;
    return <Box flexDirection="column" width="100%" alignItems="flex-start">
        <Box flexDirection="row" flexWrap="wrap" marginTop={1} width="100%">
          <Text dimColor>{idleText}</Text>
        </Box>
        {showSpinnerTree && hasRunningTeammates && <TeammateSpinnerTree selectedIndex={selectedIPAgentIndex} isInSelectionMode={viewSelectionMode === 'selecting-agent'} allIdle={allIdle} leaderVerb={leaderIsIdle ? undefined : leaderVerb} leaderIdleText={leaderIsIdle ? 'Idle' : undefined} leaderTokenCount={leaderTokenCount} />}
      </Box>;
  }

  // Time-based tip overrides: coarse thresholds so a stale ref read (we're
  // off the 50ms clock) is fine. Other triggers (mode change, setMessages)
  // cause re-renders that refresh this in practice.
  let contextTipsActive = false;
  const tipsEnabled = settings?.spinnerTipsEnabled !== false;
  const showClearTip = tipsEnabled && elapsedSnapshot > 1_800_000;
  const effectiveTip = contextTipsActive ? undefined : showClearTip && !nextTask ? 'Use /clear to start fresh when switching topics and free up context' : spinnerTip;

  // Budget text (internal-only) — shown above the tip line
  let budgetText: string | null = null;
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget();
    if (budget !== null && budget > 0) {
      const tokens = getTurnOutputTokens();
      if (tokens >= budget) {
        budgetText = `Target: ${formatNumber(tokens)} used (${formatNumber(budget)} min ${figures.tick})`;
      } else {
        const pct = Math.round(tokens / budget * 100);
        const remaining = budget - tokens;
        const rate = elapsedSnapshot > 5000 && tokens >= 2000 ? tokens / elapsedSnapshot : 0;
        const eta = rate > 0 ? ` \u00B7 ~${formatDuration(remaining / rate, {
          mostSignificantOnly: true
        })}` : '';
        budgetText = `Target: ${formatNumber(tokens)} / ${formatNumber(budget)} (${pct}%)${eta}`;
      }
    }
  }
  return <Box flexDirection="column" width="100%" alignItems="flex-start">
      <SpinnerAnimationRow mode={mode} reducedMotion={reducedMotion} hasActiveTools={hasActiveTools} responseLengthRef={responseLengthRef} message={message} messageColor={messageColor} shimmerColor={shimmerColor} overrideColor={overrideColor} loadingStartTimeRef={loadingStartTimeRef} totalPausedMsRef={totalPausedMsRef} pauseStartTimeRef={pauseStartTimeRef} spinnerSuffix={spinnerSuffix} verbose={verbose} columns={columns} hasRunningTeammates={hasRunningTeammates} teammateTokens={teammateTokens} foregroundedTeammate={foregroundedTeammate} leaderIsIdle={leaderIsIdle} thinkingStatus={thinkingStatus} effortSuffix={effortSuffix} />
      {hasRunningLocalAgents && <RunningLocalAgentsLine agents={runningLocalAgents} />}
      {showSpinnerTree && hasRunningTeammates ? <TeammateSpinnerTree selectedIndex={selectedIPAgentIndex} isInSelectionMode={viewSelectionMode === 'selecting-agent'} allIdle={allIdle} leaderVerb={leaderIsIdle ? undefined : leaderVerb} leaderIdleText={leaderIsIdle ? 'Idle' : undefined} leaderTokenCount={leaderTokenCount} /> : showExpandedTodos && tasksV2 && tasksV2.length > 0 ? <Box width="100%" flexDirection="column">
          <MessageResponse>
            <TaskListV2 tasks={tasksV2} />
          </MessageResponse>
        </Box> : nextTask || effectiveTip || budgetText ?
    // IMPORTANT: width="100%" avoids an Ink bug where the tip is duplicated
    // while the spinner is running in very small terminals.
    <Box width="100%" flexDirection="column">
          {budgetText && <MessageResponse>
              <Text dimColor>{budgetText}</Text>
            </MessageResponse>}
          {(nextTask || effectiveTip) && <MessageResponse>
              <Text dimColor>
                {nextTask ? `Next: ${nextTask.subject}` : `Tip: ${effectiveTip}`}
              </Text>
            </MessageResponse>}
        </Box> : null}
    </Box>;
}

// Brief/assistant mode spinner: single status line. PromptInput drops its
// own marginTop when isBriefOnly is active, so this component owns the
// 2-row footprint between messages and input. Footprint is [blank, content]
// — one blank row above (breathing room under the messages list), spinner
// flush against the input bar. PromptInput's absolute-positioned
// Notifications overlay compensates with marginTop=-2 in brief mode
// (PromptInput.tsx:~2928) so it floats into the blank row above the
// spinner, not over the spinner content. Paired with BriefIdleStatus which
// keeps the same footprint when idle.
type BriefSpinnerProps = {
  mode: SpinnerMode;
  overrideMessage?: string | null;
};
function BriefSpinner(t0: BriefSpinnerProps) {
  const {
    mode,
    overrideMessage
  } = t0;
  const [randomVerb] = useState(_temp4);
  const verb = overrideMessage ?? randomVerb;
  const connStatus = useAppState(_temp5);
  useEffect(() => {
      const operationId = "spinner-" + mode;
      activityManager.startCLIActivity(operationId);
      return () => {
        activityManager.endCLIActivity(operationId);
      };
  }, [mode]);
  const runningCount = useAppState(_temp6);
  const showConnWarning = connStatus === "reconnecting" || connStatus === "disconnected";
  const connText = connStatus === "reconnecting" ? "Reconnecting" : "Disconnected";
  const leftText = showConnWarning ? `${connText}${getSpinnerEllipsis()}` : `${verb}${getSpinnerEllipsis()}`;
  const {
    columns
  } = useTerminalSize();
  const rightText = runningCount > 0 ? `${runningCount} in background` : "";
  const leftWidth = stringWidth(leftText);
  const briefRightLayout = computeBriefRightStatusLayout(columns, leftWidth, rightText);
  const pad = briefRightLayout.pad;
  const visibleRightText = briefRightLayout.rightText;
  return (
    <Box flexDirection="row" width="100%" marginTop={1} paddingLeft={2}>
      <Text color={showConnWarning ? "error" : "subtle"}>{leftText}</Text>
      {visibleRightText ? (
        <>
          <Text>{" ".repeat(pad)}</Text>
          <Text color="subtle">{visibleRightText}</Text>
        </>
      ) : null}
    </Box>
  );
}

// Idle placeholder for brief mode. Same 2-row [blank, content] footprint
// as BriefSpinner so the input bar never jumps when toggling between
// working/idle/disconnected. See BriefSpinner's comment for the
// Notifications overlay coupling.
function _temp6(s_0: any) {
  return count(Object.values(s_0.tasks ?? {}), isBackgroundTask) + (s_0.remoteBackgroundTaskCount ?? 0);
}
function RunningLocalAgentsLine({
  agents
}: {
  agents: readonly ReturnType<typeof getActiveLocalAgentTasks>[number][];
}) {
  return <MessageResponse>
      <Text color={SPINNER_AGENT_THEME_COLOR}>{figures.play} {formatRunningAgentSummary(agents)}</Text>
    </MessageResponse>;
}
function _temp5(s: any) {
  return s.remoteConnectionStatus;
}
function _temp4() {
  return sample(getSpinnerVerbs()) ?? "Working";
}
export function BriefIdleStatus() {
  const $ = _c(9);
  const connStatus = useAppState(_temp7);
  const runningCount = useAppState(_temp8);
  const tasks = useAppState((s: any) => s.tasks);
  const runningLocalAgents = getActiveLocalAgentTasks(tasks);
  const {
    columns
  } = useTerminalSize();
  const showConnWarning = connStatus === "reconnecting" || connStatus === "disconnected";
  const connText = connStatus === "reconnecting" ? `Reconnecting${getSpinnerEllipsis()}` : "Disconnected";
  const leftText = showConnWarning ? connText : "";
  const rightText = runningLocalAgents.length > 0 ? `${runningLocalAgents.length} ${runningLocalAgents.length === 1 ? "agent" : "agents"} running` : runningCount > 0 ? `${runningCount} in background` : "";
  if (!leftText && !rightText) {
    let t0;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t0 = <Box height={2} />;
      $[0] = t0;
    } else {
      t0 = $[0];
    }
    return t0;
  }
  const briefRightLayout = computeBriefRightStatusLayout(columns, stringWidth(leftText), rightText);
  const pad = briefRightLayout.pad;
  const visibleRightText = briefRightLayout.rightText;
  let t0;
  if ($[1] !== leftText) {
    t0 = leftText ? <Text color="error">{leftText}</Text> : null;
    $[1] = leftText;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  let t1;
  if ($[3] !== pad || $[4] !== visibleRightText) {
    t1 = visibleRightText ? <><Text>{" ".repeat(pad)}</Text><Text color="subtle">{visibleRightText}</Text></> : null;
    $[3] = pad;
    $[4] = visibleRightText;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  let t2;
  if ($[6] !== t0 || $[7] !== t1) {
    t2 = <Box marginTop={1} paddingLeft={2}><Text>{t0}{t1}</Text></Box>;
    $[6] = t0;
    $[7] = t1;
    $[8] = t2;
  } else {
    t2 = $[8];
  }
  return t2;
}
function _temp8(s_0: any) {
  return count(Object.values(s_0.tasks ?? {}), isBackgroundTask) + (s_0.remoteBackgroundTaskCount ?? 0);
}
function _temp7(s: any) {
  return s.remoteConnectionStatus;
}
export function Spinner() {
  return <Box flexWrap="wrap" height={1} width={2}><Text color="text">◐</Text></Box>;
}
function findNextPendingTask(tasks: Task[] | undefined): Task | undefined {
  if (!tasks) {
    return undefined;
  }
  const pendingTasks = tasks.filter(t => t.status === 'pending');
  if (pendingTasks.length === 0) {
    return undefined;
  }
  const unresolvedIds = new Set(tasks.filter(t => t.status !== 'completed').map(t => t.id));
  return pendingTasks.find(t => !t.blockedBy.some(id => unresolvedIds.has(id))) ?? pendingTasks[0];
}
