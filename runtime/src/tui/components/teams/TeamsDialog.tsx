import { c as _c } from "react-compiler-runtime";
import { randomUUID } from 'crypto';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInterval } from 'usehooks-ts';
import { useRegisterOverlay } from '../../context/overlayContext';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw j/k/arrow dialog navigation
import { Box, Text, useInput } from '../../ink.js';
import { selectAgenCTuiGlyphs } from '../../glyphs.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { type AppState, useAppState, useSetAppState } from '../../state/AppState.js';
import { getEmptyToolPermissionContext } from '../../../tools/Tool';
import { AGENT_COLOR_TO_THEME_COLOR } from 'src/tools/AgentTool/agentColorManager.js';
import { logForDebugging } from 'src/utils/debug.js';
import { errorMessage } from '../../../utils/errors.js';
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js';
import { logError } from '../../../utils/log.js';
import { getNextPermissionMode } from '../../../utils/permissions/getNextPermissionMode.js';
import { getModeColor, type PermissionMode, permissionModeFromString, permissionModeSymbol } from '../../../utils/permissions/PermissionMode.js';
import { jsonStringify } from '../../../utils/slowOperations.js';
import { getLeaderPaneId, IT2_COMMAND, isInsideTmuxSync } from '../../../utils/swarm/backends/detection.js';
import { ensureBackendsRegistered, getBackendByType, getCachedBackend } from '../../../utils/swarm/backends/registry.js';
import type { PaneBackendType } from '../../../utils/swarm/backends/types.js';
import { getSwarmSocketName, SWARM_SESSION_NAME, SWARM_VIEW_WINDOW_NAME, TMUX_COMMAND } from '../../../utils/swarm/constants.js';
import { addHiddenPaneId, removeHiddenPaneId, removeMemberFromTeam, setMemberMode, setMultipleMemberModes } from '../../../utils/swarm/teamHelpers.js';
import { listTasks, type Task, unassignTeammateTasks } from '../../../utils/tasks.js';
import { getTeammateStatuses, type TeammateStatus, type TeamSummary } from '../../../utils/teamDiscovery.js';
import { createModeSetRequestMessage, sendShutdownRequestToMailbox, writeToMailbox } from '../../../utils/teammateMailbox.js';
import { Dialog } from '../design-system/Dialog';
import ThemedText from '../design-system/ThemedText';
import {
  getTeamListFooterText,
  getTeammateDetailFooterText,
  getTeamsDialogPromptPreview,
} from './TeamsDialog.layout.js';
/**
 * How often the open dialog re-scans the team directory (getTeammateStatuses is
 * filesystem discovery) to pick up teammate mode changes. Kept well above one
 * second: teammate mode changes are human-driven, so a few seconds of latency is
 * fine and a per-second fs scan while the dialog is open is wasteful.
 */
export const TEAMMATE_STATUS_POLL_INTERVAL_MS = 3000;

type Props = {
  initialTeams?: TeamSummary[];
  onDone: () => void;
};
type DialogLevel = {
  type: 'teammateList';
  teamName: string;
} | {
  type: 'teammateDetail';
  teamName: string;
  memberName: string;
};
type TeamsDialogNotice = {
  kind: 'error' | 'info';
  message: string;
};
type TeamActionResult = {
  ok: true;
  message?: string;
} | {
  ok: false;
  message: string;
};
type TeammateTasksLoadState = {
  status: 'loading';
  tasks: Task[];
} | {
  status: 'loaded';
  tasks: Task[];
} | {
  status: 'error';
  tasks: Task[];
  message: string;
};

function ok(message?: string): TeamActionResult {
  return { ok: true, message };
}

function fail(message: string): TeamActionResult {
  return { ok: false, message };
}

function ActionNotice({
  notice
}: {
  notice: TeamsDialogNotice | null;
}): React.ReactNode {
  if (!notice) return null;
  return <Box marginTop={1}><Text color={notice.kind === 'error' ? 'error' : 'background'}>{notice.message}</Text></Box>;
}

/**
 * Dialog for viewing teammates in the current team
 */
export function TeamsDialog({
  initialTeams,
  onDone
}: Props): React.ReactNode {
  // Register as overlay so CancelRequestHandler doesn't intercept escape
  useRegisterOverlay('teams-dialog');

  // initialTeams is derived from teamContext in PromptInput (no filesystem I/O)
  const setAppState = useSetAppState();

  // Initialize dialogLevel with first team name if available
  const firstTeamName = initialTeams?.[0]?.name ?? '';
  const [dialogLevel, setDialogLevel] = useState<DialogLevel>({
    type: 'teammateList',
    teamName: firstTeamName
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [actionNotice, setActionNotice] = useState<TeamsDialogNotice | null>(null);

  // initialTeams is now always provided from PromptInput (derived from teamContext)
  // No filesystem I/O needed here

  const teammateStatuses = useMemo(() => {
    return getTeammateStatuses(dialogLevel.teamName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, [dialogLevel.teamName, refreshKey]);

  // Periodically refresh to pick up mode changes from teammates
  useInterval(() => {
    setRefreshKey(k => k + 1);
  }, TEAMMATE_STATUS_POLL_INTERVAL_MS);
  const currentTeammate = useMemo(() => {
    if (dialogLevel.type !== 'teammateDetail') return null;
    return teammateStatuses.find(t => t.name === dialogLevel.memberName) ?? null;
  }, [dialogLevel, teammateStatuses]);

  // Get isBypassPermissionsModeAvailable from AppState
  const isBypassAvailable = useAppState(s => s.toolPermissionContext.isBypassPermissionsModeAvailable);
  const goBackToList = (): void => {
    setDialogLevel({
      type: 'teammateList',
      teamName: dialogLevel.teamName
    });
    setSelectedIndex(0);
  };

  // Handler for confirm:cycleMode - cycle teammate permission modes
  const handleCycleMode = useCallback(() => {
    setActionNotice(null);
    if (dialogLevel.type === 'teammateDetail' && currentTeammate) {
      // Detail view: cycle just this teammate
      const result = cycleTeammateMode(currentTeammate, dialogLevel.teamName, isBypassAvailable);
      if (!result.ok) {
        setActionNotice({
          kind: 'error',
          message: result.message
        });
        return;
      }
      setRefreshKey(k => k + 1);
    } else if (dialogLevel.type === 'teammateList' && teammateStatuses.length > 0) {
      // List view: cycle all teammates in tandem
      const result = cycleAllTeammateModes(teammateStatuses, dialogLevel.teamName, isBypassAvailable);
      if (!result.ok) {
        setActionNotice({
          kind: 'error',
          message: result.message
        });
        return;
      }
      setRefreshKey(k => k + 1);
    }
  }, [dialogLevel, currentTeammate, teammateStatuses, isBypassAvailable]);

  // Use keybindings for mode cycling
  useKeybindings({
    'confirm:cycleMode': handleCycleMode
  }, {
    context: 'Confirmation'
  });
  useInput((input, key) => {
    // Handle left arrow to go back
    if (key.leftArrow) {
      setActionNotice(null);
      if (dialogLevel.type === 'teammateDetail') {
        goBackToList();
      }
      return;
    }

    // Handle up/down navigation
    if (key.upArrow || key.downArrow) {
      setActionNotice(null);
      const maxIndex = getMaxIndex();
      if (key.upArrow) {
        setSelectedIndex(prev => Math.max(0, prev - 1));
      } else {
        setSelectedIndex(prev => Math.min(maxIndex, prev + 1));
      }
      return;
    }

    // Handle Enter to drill down or view output
    if (key.return) {
      setActionNotice(null);
      if (dialogLevel.type === 'teammateList' && teammateStatuses[selectedIndex]) {
        setDialogLevel({
          type: 'teammateDetail',
          teamName: dialogLevel.teamName,
          memberName: teammateStatuses[selectedIndex].name
        });
      } else if (dialogLevel.type === 'teammateDetail' && currentTeammate) {
        // View output - switch to tmux pane
        void viewTeammateOutput(currentTeammate.tmuxPaneId, currentTeammate.backendType).then(result => {
          if (!result.ok) {
            setActionNotice({
              kind: 'error',
              message: result.message
            });
            return;
          }
          onDone();
        });
      }
      return;
    }

    // Handle 'k' to kill teammate
    if (input === 'k') {
      setActionNotice(null);
      if (dialogLevel.type === 'teammateList' && teammateStatuses[selectedIndex]) {
        void killTeammate(teammateStatuses[selectedIndex].tmuxPaneId, teammateStatuses[selectedIndex].backendType, dialogLevel.teamName, teammateStatuses[selectedIndex].agentId, teammateStatuses[selectedIndex].name, setAppState).then(result => {
          if (!result.ok) {
            setActionNotice({
              kind: 'error',
              message: result.message
            });
            return;
          }
          setRefreshKey(k => k + 1);
          // Adjust selection if needed
          setSelectedIndex(prev => Math.max(0, Math.min(prev, teammateStatuses.length - 2)));
        });
      } else if (dialogLevel.type === 'teammateDetail' && currentTeammate) {
        void killTeammate(currentTeammate.tmuxPaneId, currentTeammate.backendType, dialogLevel.teamName, currentTeammate.agentId, currentTeammate.name, setAppState).then(result => {
          if (!result.ok) {
            setActionNotice({
              kind: 'error',
              message: result.message
            });
            return;
          }
          goBackToList();
          setRefreshKey(k => k + 1);
        });
      }
      return;
    }

    // Handle 's' for shutdown of selected teammate
    if (input === 's') {
      setActionNotice(null);
      if (dialogLevel.type === 'teammateList' && teammateStatuses[selectedIndex]) {
        const teammate = teammateStatuses[selectedIndex];
        void requestTeammateShutdown(teammate.name, dialogLevel.teamName).then(result => {
          if (!result.ok) {
            setActionNotice({
              kind: 'error',
              message: result.message
            });
          }
        });
      } else if (dialogLevel.type === 'teammateDetail' && currentTeammate) {
        void requestTeammateShutdown(currentTeammate.name, dialogLevel.teamName).then(result => {
          if (!result.ok) {
            setActionNotice({
              kind: 'error',
              message: result.message
            });
            return;
          }
          goBackToList();
        });
      }
      return;
    }

    // Handle 'h' to hide/show individual teammate (only for backends that support it)
    if (input === 'h') {
      setActionNotice(null);
      const backend = getCachedBackend();
      const teammate = dialogLevel.type === 'teammateList' ? teammateStatuses[selectedIndex] : dialogLevel.type === 'teammateDetail' ? currentTeammate : null;
      if (teammate && backend?.supportsHideShow) {
        void toggleTeammateVisibility(teammate, dialogLevel.teamName).then(result => {
          if (!result.ok) {
            setActionNotice({
              kind: 'error',
              message: result.message
            });
            return;
          }
          // Force refresh of teammate statuses
          setRefreshKey(k => k + 1);
          if (dialogLevel.type === 'teammateDetail') {
            goBackToList();
          }
        });
      } else if (teammate) {
        setActionNotice({
          kind: 'error',
          message: `Cannot hide or show @${teammate.name}: current backend does not support pane visibility.`
        });
      }
      return;
    }

    // Handle 'H' to hide/show all teammates (only for backends that support it)
    if (input === 'H' && dialogLevel.type === 'teammateList') {
      setActionNotice(null);
      const backend = getCachedBackend();
      if (backend?.supportsHideShow && teammateStatuses.length > 0) {
        // If any are visible, hide all. Otherwise, show all.
        const anyVisible = teammateStatuses.some(t => !t.isHidden);
        void Promise.all(teammateStatuses.map(t => anyVisible ? hideTeammate(t, dialogLevel.teamName) : showTeammate(t, dialogLevel.teamName))).then(results => {
          const failed = results.find(result => !result.ok);
          if (failed) {
            setActionNotice({
              kind: 'error',
              message: failed.message
            });
          }
          // Force refresh of teammate statuses
          setRefreshKey(k => k + 1);
        });
      } else if (teammateStatuses.length > 0) {
        setActionNotice({
          kind: 'error',
          message: 'Cannot hide or show all teammates: current backend does not support pane visibility.'
        });
      }
      return;
    }

    // Handle 'p' to prune (kill) all idle teammates
    if (input === 'p' && dialogLevel.type === 'teammateList') {
      setActionNotice(null);
      const idleTeammates = teammateStatuses.filter(t => t.status === 'idle');
      if (idleTeammates.length > 0) {
        void Promise.all(idleTeammates.map(t => killTeammate(t.tmuxPaneId, t.backendType, dialogLevel.teamName, t.agentId, t.name, setAppState))).then(results => {
          const failed = results.find(result => !result.ok);
          if (failed) {
            setActionNotice({
              kind: 'error',
              message: failed.message
            });
          }
          setRefreshKey(k => k + 1);
          setSelectedIndex(prev => Math.max(0, Math.min(prev, teammateStatuses.length - idleTeammates.length - 1)));
        });
      }
      return;
    }

    // Note: Mode cycling (shift+tab) is handled via useKeybindings with confirm:cycleMode action
  });
  function getMaxIndex(): number {
    if (dialogLevel.type === 'teammateList') {
      return Math.max(0, teammateStatuses.length - 1);
    }
    return 0;
  }

  // Render based on dialog level
  if (dialogLevel.type === 'teammateList') {
    return <TeamDetailView teamName={dialogLevel.teamName} teammates={teammateStatuses} selectedIndex={selectedIndex} onCancel={onDone} actionNotice={actionNotice} />;
  }
  if (dialogLevel.type === 'teammateDetail' && currentTeammate) {
    return <TeammateDetailView teammate={currentTeammate} teamName={dialogLevel.teamName} onCancel={goBackToList} actionNotice={actionNotice} />;
  }
  return null;
}
type TeamDetailViewProps = {
  teamName: string;
  teammates: TeammateStatus[];
  selectedIndex: number;
  onCancel: () => void;
  actionNotice: TeamsDialogNotice | null;
};
function TeamDetailView(t0) {
  const {
    teamName,
    teammates,
    selectedIndex,
    onCancel,
    actionNotice
  } = t0;
  const glyphs = selectAgenCTuiGlyphs();
  const {
    columns
  } = useTerminalSize();
  const subtitle = `${teammates.length} ${teammates.length === 1 ? "teammate" : "teammates"}`;
  const supportsHideShow = getCachedBackend()?.supportsHideShow ?? false;
  const cycleModeShortcut = useShortcutDisplay("confirm:cycleMode", "Confirmation", "shift+tab");
  const t1 = `Team ${teamName}`;
  const footerText = getTeamListFooterText({
    glyphs,
    supportsHideShow,
    cycleModeShortcut,
    columns
  });
  const content = <Box flexDirection="column">{teammates.length === 0 ? <Text dimColor={true}>No teammates</Text> : <Box flexDirection="column">{teammates.map((teammate, index) => <TeammateListItem key={teammate.agentId} teammate={teammate} isSelected={index === selectedIndex} />)}</Box>}<ActionNotice notice={actionNotice} /></Box>;
  return <><Dialog title={t1} subtitle={subtitle} onCancel={onCancel} color="background" hideInputGuide={true}>{content}</Dialog><Box marginLeft={1}><Text dimColor={true}>{footerText}</Text></Box></>;
}
type TeammateListItemProps = {
  teammate: TeammateStatus;
  isSelected: boolean;
};
function TeammateListItem(t0) {
  const $ = _c(21);
  const {
    teammate,
    isSelected
  } = t0;
  const glyphs = selectAgenCTuiGlyphs();
  const isIdle = teammate.status === "idle";
  const shouldDim = isIdle && !isSelected;
  let modeSymbol;
  let t1;
  if ($[0] !== teammate.mode) {
    const mode = teammate.mode ? permissionModeFromString(teammate.mode) : "default";
    modeSymbol = permissionModeSymbol(mode);
    t1 = getModeColor(mode);
    $[0] = teammate.mode;
    $[1] = modeSymbol;
    $[2] = t1;
  } else {
    modeSymbol = $[1];
    t1 = $[2];
  }
  const modeColor = t1;
  const t2 = isSelected ? "suggestion" : undefined;
  const t3 = isSelected ? `${glyphs.pointer} ` : "  ";
  let t4;
  if ($[3] !== teammate.isHidden) {
    t4 = teammate.isHidden && <Text dimColor={true}>[hidden] </Text>;
    $[3] = teammate.isHidden;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  let t5;
  if ($[5] !== isIdle) {
    t5 = isIdle && <Text dimColor={true}>[idle] </Text>;
    $[5] = isIdle;
    $[6] = t5;
  } else {
    t5 = $[6];
  }
  let t6;
  if ($[7] !== modeColor || $[8] !== modeSymbol) {
    t6 = modeSymbol && <Text color={modeColor}>{modeSymbol} </Text>;
    $[7] = modeColor;
    $[8] = modeSymbol;
    $[9] = t6;
  } else {
    t6 = $[9];
  }
  let t7;
  if ($[10] !== teammate.model) {
    t7 = teammate.model && <Text dimColor={true}> ({teammate.model})</Text>;
    $[10] = teammate.model;
    $[11] = t7;
  } else {
    t7 = $[11];
  }
  let t8;
  if ($[12] !== shouldDim || $[13] !== t2 || $[14] !== t3 || $[15] !== t4 || $[16] !== t5 || $[17] !== t6 || $[18] !== t7 || $[19] !== teammate.name) {
    t8 = <Text color={t2} dimColor={shouldDim}>{t3}{t4}{t5}{t6}@{teammate.name}{t7}</Text>;
    $[12] = shouldDim;
    $[13] = t2;
    $[14] = t3;
    $[15] = t4;
    $[16] = t5;
    $[17] = t6;
    $[18] = t7;
    $[19] = teammate.name;
    $[20] = t8;
  } else {
    t8 = $[20];
  }
  return t8;
}
type TeammateDetailViewProps = {
  teammate: TeammateStatus;
  teamName: string;
  onCancel: () => void;
  actionNotice: TeamsDialogNotice | null;
};
function TeammateDetailView(t0) {
  const {
    teammate,
    teamName,
    onCancel,
    actionNotice
  } = t0;
  const glyphs = selectAgenCTuiGlyphs();
  const {
    columns
  } = useTerminalSize();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const cycleModeShortcut = useShortcutDisplay("confirm:cycleMode", "Confirmation", "shift+tab");
  const supportsHideShow = getCachedBackend()?.supportsHideShow ?? false;
  const themeColor = teammate.color ? AGENT_COLOR_TO_THEME_COLOR[teammate.color as keyof typeof AGENT_COLOR_TO_THEME_COLOR] : undefined;
  const [tasksState, setTasksState] = useState<TeammateTasksLoadState>({
    status: 'loading',
    tasks: []
  });
  useEffect(() => {
    let cancelled = false;
    setTasksState({
      status: 'loading',
      tasks: []
    });
    listTasks(teamName).then(allTasks => {
      if (cancelled) return;
      setTasksState({
        status: 'loaded',
        tasks: allTasks.filter(task => task.owner === teammate.agentId || task.owner === teammate.name)
      });
    }).catch(error => {
      if (cancelled) return;
      setTasksState({
        status: 'error',
        tasks: [],
        message: `Unable to load tasks: ${errorMessage(error)}`
      });
    });
    return () => {
      cancelled = true;
    };
  }, [teamName, teammate.agentId, teammate.name]);
  useInput(input => {
    if (input === "p") {
      setPromptExpanded(prev => !prev);
    }
  });
  const workingPath = teammate.worktreePath || teammate.cwd;
  const subtitleParts = [];
  if (teammate.model) {
    subtitleParts.push(teammate.model);
  }
  if (workingPath) {
    subtitleParts.push(teammate.worktreePath ? `worktree: ${workingPath}` : workingPath);
  }
  const subtitle = subtitleParts.join(` ${glyphs.separator} `) || undefined;
  const mode = teammate.mode ? permissionModeFromString(teammate.mode) : "default";
  const modeSymbol = permissionModeSymbol(mode);
  const modeColor = getModeColor(mode);
  const agentName = themeColor ? <ThemedText color={themeColor}>{`@${teammate.name}`}</ThemedText> : `@${teammate.name}`;
  const title = <>{modeSymbol && <Text color={modeColor}>{modeSymbol} </Text>}{agentName}</>;
  const promptPreview = getTeamsDialogPromptPreview(teammate.prompt, columns, promptExpanded, glyphs.ellipsis);
  const footerText = getTeammateDetailFooterText({
    glyphs,
    supportsHideShow,
    cycleModeShortcut,
    columns
  });
  const tasks = <Box flexDirection="column"><Text bold={true}>Tasks</Text>{tasksState.status === 'loading' ? <Text dimColor={true}>Loading tasks...</Text> : tasksState.status === 'error' ? <Text color="error">{tasksState.message}</Text> : tasksState.tasks.length === 0 ? <Text dimColor={true}>No tasks</Text> : tasksState.tasks.map(renderTeammateTaskRow)}</Box>;
  const prompt = teammate.prompt && <Box flexDirection="column"><Text bold={true}>Prompt</Text><Text>{promptPreview.text}{promptPreview.showExpandHint && <Text dimColor={true}> (p to expand)</Text>}</Text></Box>;

  return <><Dialog title={title} subtitle={subtitle} onCancel={onCancel} color="background" hideInputGuide={true}>{tasks}{prompt}<ActionNotice notice={actionNotice} /></Dialog><Box marginLeft={1}><Text dimColor={true}>{footerText}</Text></Box></>;
}
function renderTeammateTaskRow(task: Task): React.ReactNode {
  const statusText = task.status === "completed" ? "done" : task.status;
  return <Text key={task.id} color={task.status === "completed" ? "success" : undefined}>{statusText} {task.subject}</Text>;
}
async function killTeammate(paneId: string, backendType: PaneBackendType | undefined, teamName: string, teammateId: string, teammateName: string, setAppState: (f: (prev: AppState) => AppState) => void): Promise<TeamActionResult> {
  // Kill the pane using the backend that created it (handles -s / -L flags correctly).
  if (!backendType) {
    // backendType undefined: old team files predating this field, or in-process.
    logForDebugging(`[TeamsDialog] Skipping pane kill for ${paneId}: no backendType recorded`);
    return fail(`Cannot kill @${teammateName}: missing pane backend metadata.`);
  }

  try {
    // Use ensureBackendsRegistered (not detectAndGetBackend) — this process may
    // be a teammate that never ran detection, but we only need class imports
    // here, not subprocess probes that could throw in a different environment.
    await ensureBackendsRegistered();
    await getBackendByType(backendType).killPane(paneId, !isInsideTmuxSync());
  } catch (error) {
    const message = `Cannot kill @${teammateName}: ${errorMessage(error)}`;
    logForDebugging(`[TeamsDialog] Failed to kill pane ${paneId}: ${message}`);
    return fail(message);
  }

  // Remove from team config file
  let removedFromTeam: boolean;
  try {
    removedFromTeam = removeMemberFromTeam(teamName, paneId);
  } catch (error) {
    logError(error);
    return fail(`Killed @${teammateName}, but could not remove it from team ${teamName}: ${errorMessage(error)}`);
  }
  if (!removedFromTeam) {
    return fail(`Killed @${teammateName}, but could not remove it from team ${teamName}.`);
  }

  // Unassign tasks and build notification message
  let notificationMessage;
  try {
    ({
      notificationMessage
    } = await unassignTeammateTasks(teamName, teammateId, teammateName, 'terminated'));
  } catch (error) {
    return fail(`Killed @${teammateName}, but task cleanup failed: ${errorMessage(error)}`);
  }

  // Update AppState to keep status line in sync and notify the lead
  setAppState(prev => {
    if (!prev.teamContext?.teammates) return prev;
    if (!(teammateId in prev.teamContext.teammates)) return prev;
    const {
      [teammateId]: _,
      ...remainingTeammates
    } = prev.teamContext.teammates;
    return {
      ...prev,
      teamContext: {
        ...prev.teamContext,
        teammates: remainingTeammates
      },
      inbox: {
        messages: [...prev.inbox.messages, {
          id: randomUUID(),
          from: 'system',
          text: jsonStringify({
            type: 'teammate_terminated',
            message: notificationMessage
          }),
          timestamp: new Date().toISOString(),
          status: 'pending' as const
        }]
      }
    };
  });
  logForDebugging(`[TeamsDialog] Removed ${teammateId} from teamContext`);
  return ok(`Killed @${teammateName}.`);
}
async function viewTeammateOutput(paneId: string, backendType: PaneBackendType | undefined): Promise<TeamActionResult> {
  let result;
  try {
    if (backendType === 'iterm2') {
      // -s is required to target a specific session (ITermBackend.ts:216-217)
      result = await execFileNoThrow(IT2_COMMAND, ['session', 'focus', '-s', paneId]);
    } else {
      // External-tmux teammates live on the swarm socket — without -L, this
      // targets the default server and silently no-ops. Mirrors runTmuxInSwarm
      // in TmuxBackend.ts:85-89.
      const args = isInsideTmuxSync() ? ['select-pane', '-t', paneId] : ['-L', getSwarmSocketName(), 'select-pane', '-t', paneId];
      result = await execFileNoThrow(TMUX_COMMAND, args);
    }
  } catch (error) {
    logError(error);
    return fail(`Cannot view teammate output: ${errorMessage(error)}`);
  }
  if (result.code !== 0) {
    return fail(`Cannot view teammate output: ${result.error || result.stderr || `exit code ${result.code}`}`);
  }
  return ok();
}

async function requestTeammateShutdown(teammateName: string, teamName: string): Promise<TeamActionResult> {
  try {
    await sendShutdownRequestToMailbox(teammateName, teamName, 'Graceful shutdown requested by team lead');
    return ok(`Shutdown requested for @${teammateName}.`);
  } catch (error) {
    return fail(`Cannot request shutdown for @${teammateName}: ${errorMessage(error)}`);
  }
}

/**
 * Toggle visibility of a teammate pane (hide if visible, show if hidden)
 */
async function toggleTeammateVisibility(teammate: TeammateStatus, teamName: string): Promise<TeamActionResult> {
  if (teammate.isHidden) {
    return showTeammate(teammate, teamName);
  }
  return hideTeammate(teammate, teamName);
}

/**
 * Hide a teammate pane using the AgenC backend abstraction.
 */
async function hideTeammate(teammate: TeammateStatus, teamName: string): Promise<TeamActionResult> {
  if (!teammate.tmuxPaneId || !teammate.backendType) {
    return fail(`Cannot hide @${teammate.name}: missing pane metadata.`);
  }
  try {
    await ensureBackendsRegistered();
    const backend = getBackendByType(teammate.backendType);
    if (!backend.supportsHideShow) {
      return fail(`Cannot hide @${teammate.name}: backend does not support pane visibility.`);
    }
    const hidden = await backend.hidePane(teammate.tmuxPaneId, !isInsideTmuxSync());
    if (!hidden) {
      return fail(`Cannot hide @${teammate.name}: backend refused the hide request.`);
    }
    if (!addHiddenPaneId(teamName, teammate.tmuxPaneId)) {
      return fail(`Hidden @${teammate.name}, but could not record hidden state for team ${teamName}.`);
    }
  } catch (error) {
    return fail(`Cannot hide @${teammate.name}: ${errorMessage(error)}`);
  }
  logForDebugging(`[TeamsDialog] Hidden teammate ${teammate.name} (${teammate.tmuxPaneId})`);
  return ok(`Hidden @${teammate.name}.`);
}

export function resolveTeammateShowTargetPane(teammatePaneId: string): string | null {
  const targetPane = isInsideTmuxSync()
    ? getLeaderPaneId()
    : `${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`;
  if (!targetPane) return null;
  if (targetPane === teammatePaneId) return null;
  return targetPane;
}

/**
 * Show a previously hidden teammate pane using the AgenC backend abstraction.
 */
async function showTeammate(teammate: TeammateStatus, teamName: string): Promise<TeamActionResult> {
  if (!teammate.tmuxPaneId || !teammate.backendType) {
    return fail(`Cannot show @${teammate.name}: missing pane metadata.`);
  }
  try {
    await ensureBackendsRegistered();
    const backend = getBackendByType(teammate.backendType);
    if (!backend.supportsHideShow) {
      return fail(`Cannot show @${teammate.name}: backend does not support pane visibility.`);
    }
    const targetPane = resolveTeammateShowTargetPane(teammate.tmuxPaneId);
    if (!targetPane) {
      return fail(`Cannot show @${teammate.name}: no valid target pane is available.`);
    }
    const shown = await backend.showPane(
      teammate.tmuxPaneId,
      targetPane,
      !isInsideTmuxSync(),
    );
    if (!shown) {
      return fail(`Cannot show @${teammate.name}: backend refused the show request.`);
    }
    if (!removeHiddenPaneId(teamName, teammate.tmuxPaneId)) {
      return fail(`Shown @${teammate.name}, but could not update hidden state for team ${teamName}.`);
    }
  } catch (error) {
    return fail(`Cannot show @${teammate.name}: ${errorMessage(error)}`);
  }
  logForDebugging(`[TeamsDialog] Shown teammate ${teammate.name} (${teammate.tmuxPaneId})`);
  return ok(`Shown @${teammate.name}.`);
}

/**
 * Send a mode change message to a single teammate
 * Also updates config.json directly so the UI reflects the change immediately
 */
function sendModeChangeToTeammate(teammateName: string, teamName: string, targetMode: PermissionMode): TeamActionResult {
  // Update config.json directly so UI shows the change immediately
  let updatedMode: boolean;
  try {
    updatedMode = setMemberMode(teamName, teammateName, targetMode);
  } catch (error) {
    logError(error);
    return fail(`Cannot change @${teammateName} mode: ${errorMessage(error)}`);
  }
  if (!updatedMode) {
    return fail(`Cannot change @${teammateName} mode: could not update team config.`);
  }

  sendModeChangeMailboxMessage(teammateName, teamName, targetMode);
  logForDebugging(`[TeamsDialog] Sent mode change to ${teammateName}: ${targetMode}`);
  return ok();
}

function sendModeChangeMailboxMessage(teammateName: string, teamName: string, targetMode: PermissionMode): void {
  const message = createModeSetRequestMessage({
    mode: targetMode,
    from: 'team-lead'
  });
  void writeToMailbox(teammateName, {
    from: 'team-lead',
    text: jsonStringify(message),
    timestamp: new Date().toISOString()
  }, teamName).catch(error => {
    logError(error);
    logForDebugging(`[TeamsDialog] Failed to send mode change to ${teammateName}: ${errorMessage(error)}`);
  });
}

/**
 * Cycle a single teammate's mode
 */
function cycleTeammateMode(teammate: TeammateStatus, teamName: string, isBypassAvailable: boolean): TeamActionResult {
  const currentMode = teammate.mode ? permissionModeFromString(teammate.mode) : 'default';
  const context = {
    ...getEmptyToolPermissionContext(),
    mode: currentMode,
    isBypassPermissionsModeAvailable: isBypassAvailable
  };
  const nextMode = getNextPermissionMode(context);
  return sendModeChangeToTeammate(teammate.name, teamName, nextMode);
}

/**
 * Cycle all teammates' modes in tandem
 * If modes differ, reset all to default first
 * If same, cycle all to next mode
 * Uses batch update to avoid race conditions
 */
function cycleAllTeammateModes(teammates: TeammateStatus[], teamName: string, isBypassAvailable: boolean): TeamActionResult {
  if (teammates.length === 0) return ok();
  const modes = teammates.map(t => t.mode ? permissionModeFromString(t.mode) : 'default');
  const allSame = modes.every(m => m === modes[0]);

  // Determine target mode for all teammates
  const targetMode = !allSame ? 'default' : getNextPermissionMode({
    ...getEmptyToolPermissionContext(),
    mode: modes[0] ?? 'default',
    isBypassPermissionsModeAvailable: isBypassAvailable
  });

  // Batch update config.json in a single atomic operation
  const modeUpdates = teammates.map(t => ({
    memberName: t.name,
    mode: targetMode
  }));
  let updatedModes: boolean;
  try {
    updatedModes = setMultipleMemberModes(teamName, modeUpdates);
  } catch (error) {
    logError(error);
    return fail(`Cannot change team ${teamName} modes: ${errorMessage(error)}`);
  }
  if (!updatedModes) {
    return fail(`Cannot change team ${teamName} modes: could not update team config.`);
  }

  // Send mailbox messages to each teammate
  for (const teammate of teammates) {
    sendModeChangeMailboxMessage(teammate.name, teamName, targetMode);
  }
  logForDebugging(`[TeamsDialog] Sent mode change to all ${teammates.length} teammates: ${targetMode}`);
  return ok();
}
