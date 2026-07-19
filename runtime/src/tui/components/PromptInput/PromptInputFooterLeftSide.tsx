import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { feature } from 'bun:bundle';
import { isCoordinatorMode } from '../../../coordinator/coordinatorMode.js';
import { Box, Text, Link } from '../../ink.js';
import * as React from 'react';
import figures from 'figures';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { VimMode, PromptInputMode } from '../../../types/textInputTypes.js';
import type { ToolPermissionContext } from '../../../tools/Tool.js';
import { formatVimModeIndicator, isVimModeEnabled } from './utils.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { isDefaultMode, getModeColor } from '../../../utils/permissions/PermissionMode.js';
import { permissionModeFooterChrome } from './permissionModeChrome.js';
import { BackgroundTaskStatus } from '../tasks/BackgroundTaskStatus.js';
import { isBackgroundTask } from '../../../tasks/types.js';
import { getVisibleAgentTasks } from '../CoordinatorAgentStatus.js';
import { count } from '../../../utils/array.js';
import { shouldHideTasksFooter } from '../tasks/taskStatusUtils.js';
import { isAgentSwarmsEnabled } from '../../../utils/agentSwarmsEnabled.js';
import { TeamStatus } from '../teams/TeamStatus.js';
import { isInProcessEnabled } from '../../../utils/swarm/backends/registry.js';
import { useAppState, useAppStateStore } from '../../state/AppState.js';
import { getIsRemoteMode } from '../../../bootstrap/state.js';
import HistorySearchInput from './HistorySearchInput.js';
import { usePrStatus } from '../../hooks/usePrStatus.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { Byline } from '../design-system/Byline.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useTasksV2 } from '../../hooks/useTasksV2.js';
import { formatDuration } from '../../../utils/format.js';
import { isFullscreenEnvEnabled } from '../../../utils/fullscreen.js';
import { isXtermJs } from '../../ink/terminal.js';
import { useHasSelection, useSelection } from '../../ink/hooks/use-selection.js';
import { getGlobalConfig } from '../../../utils/config.js';
import { getPlatform } from '../../../utils/platform.js';
import { PrBadge } from '../PrBadge.js';
import {
  getPromptInputProactiveNextTickAt,
  isPromptInputProactiveActive,
  subscribeToPromptInputProactiveChanges,
} from './proactiveAdapter.js';
const NO_OP_SUBSCRIBE = (_cb: () => void) => () => {};
const NULL = () => null;
type Props = {
  exitMessage: {
    show: boolean;
    key?: string;
  };
  vimMode: VimMode | undefined;
  mode: PromptInputMode;
  toolPermissionContext: ToolPermissionContext;
  suppressHint: boolean;
  isLoading: boolean;
  showMemoryTypeSelector?: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  teammateFooterIndex?: number;
  isPasting?: boolean;
  isSearching: boolean;
  historyQuery: string;
  setHistoryQuery: (query: string) => void;
  historyFailedMatch: boolean;
  onOpenTasksDialog?: (taskId?: string) => void;
};
function ProactiveCountdown() {
  const $ = _c(7);
  const nextTickAt = useSyncExternalStore(
    (feature('PROACTIVE') || feature('KAIROS'))
      ? subscribeToPromptInputProactiveChanges
      : NO_OP_SUBSCRIBE,
    (feature('PROACTIVE') || feature('KAIROS'))
      ? getPromptInputProactiveNextTickAt
      : NULL,
    NULL,
  );
  const [remainingSeconds, setRemainingSeconds] = useState(null);
  let t0;
  let t1;
  if ($[0] !== nextTickAt) {
    t0 = () => {
      if (nextTickAt === null) {
        setRemainingSeconds(null);
        return;
      }
      const update = function update() {
        const remaining = Math.max(0, Math.ceil((nextTickAt - Date.now()) / 1000));
        setRemainingSeconds(remaining);
      };
      update();
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    };
    t1 = [nextTickAt];
    $[0] = nextTickAt;
    $[1] = t0;
    $[2] = t1;
  } else {
    t0 = $[1];
    t1 = $[2];
  }
  useEffect(t0, t1);
  if (remainingSeconds === null) {
    return null;
  }
  const t2 = remainingSeconds * 1000;
  let t3;
  if ($[3] !== t2) {
    t3 = formatDuration(t2, {
      mostSignificantOnly: true
    });
    $[3] = t2;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  if ($[5] !== t3) {
    t4 = <Text dimColor={true}>waiting{" "}{t3}</Text>;
    $[5] = t3;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  return t4;
}
export function PromptInputFooterLeftSide(t0) {
  const $ = _c(27);
  const {
    exitMessage,
    vimMode,
    mode,
    toolPermissionContext,
    suppressHint,
    isLoading,
    tasksSelected,
    teamsSelected,
    teammateFooterIndex,
    isPasting,
    isSearching,
    historyQuery,
    setHistoryQuery,
    historyFailedMatch,
    onOpenTasksDialog
  } = t0;
  if (exitMessage.show) {
    // Key-agnostic message: keeps the footer text stable when the pending
    // exit key changes mid-sequence (e.g. Ctrl-C followed by Ctrl-D). Each
    // handler is independently pending for its own key, but the visible
    // text should not appear to "jump" between keys during the abort window.
    let t1;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = <Text dimColor={true} key="exit-message">Press the same key again to exit</Text>;
      $[0] = t1;
    } else {
      t1 = $[0];
    }
    return t1;
  }
  if (isPasting) {
    let t1;
    if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = <Text dimColor={true} key="pasting-message">Pasting text…</Text>;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    return t1;
  }
  let t1;
  if ($[3] !== isSearching || $[4] !== vimMode) {
    t1 = isVimModeEnabled() && vimMode !== undefined && !isSearching;
    $[3] = isSearching;
    $[4] = vimMode;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  const showVim = t1;
  let t2;
  if ($[6] !== historyFailedMatch || $[7] !== historyQuery || $[8] !== isSearching || $[9] !== setHistoryQuery) {
    t2 = isSearching && <HistorySearchInput value={historyQuery} onChange={setHistoryQuery} historyFailedMatch={historyFailedMatch} />;
    $[6] = historyFailedMatch;
    $[7] = historyQuery;
    $[8] = isSearching;
    $[9] = setHistoryQuery;
    $[10] = t2;
  } else {
    t2 = $[10];
  }
  const vimModeIndicator = formatVimModeIndicator(vimMode);
  const t3 = showVim && vimModeIndicator ? <Text dimColor={true} key="vim-mode">{vimModeIndicator}</Text> : null;
  const t4 = !suppressHint && !showVim;
  let t5;
  if ($[13] !== isLoading || $[14] !== mode || $[15] !== onOpenTasksDialog || $[16] !== t4 || $[17] !== tasksSelected || $[18] !== teammateFooterIndex || $[19] !== teamsSelected || $[20] !== toolPermissionContext) {
    t5 = <ModeIndicator mode={mode} toolPermissionContext={toolPermissionContext} showHint={t4} isLoading={isLoading} tasksSelected={tasksSelected} teamsSelected={teamsSelected} teammateFooterIndex={teammateFooterIndex} exitPending={exitMessage.show} onOpenTasksDialog={onOpenTasksDialog} />;
    $[13] = isLoading;
    $[14] = mode;
    $[15] = onOpenTasksDialog;
    $[16] = t4;
    $[17] = tasksSelected;
    $[18] = teammateFooterIndex;
    $[19] = teamsSelected;
    $[20] = toolPermissionContext;
    $[21] = t5;
  } else {
    t5 = $[21];
  }
  let t6;
  if ($[23] !== t2 || $[24] !== t3 || $[25] !== t5) {
    t6 = <Box justifyContent="flex-start" gap={1}>{t2}{t3}{t5}</Box>;
    $[23] = t2;
    $[24] = t3;
    $[25] = t5;
    $[26] = t6;
  } else {
    t6 = $[26];
  }
  return t6;
}
type ModeIndicatorProps = {
  mode: PromptInputMode;
  toolPermissionContext: ToolPermissionContext;
  showHint: boolean;
  isLoading: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  teammateFooterIndex?: number;
  exitPending?: boolean;
  onOpenTasksDialog?: (taskId?: string) => void;
};
function ModeIndicator({
  mode,
  toolPermissionContext,
  showHint,
  isLoading,
  tasksSelected,
  teamsSelected,
  teammateFooterIndex,
  exitPending,
  onOpenTasksDialog
}: ModeIndicatorProps): React.ReactNode {
  const {
    columns
  } = useTerminalSize();
  const modeCycleShortcut = useShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab');
  const tasks = useAppState(s => s.tasks);
  const teamContext = useAppState(s_0 => s_0.teamContext);
  // Set once in initialState (main.tsx --remote mode) and never mutated — lazy
  // init captures the immutable value without a subscription.
  const store = useAppStateStore();
  const [remoteSessionUrl] = useState(() => store.getState().remoteSessionUrl);
  const viewSelectionMode = useAppState(s_1 => s_1.viewSelectionMode);
  const viewingAgentTaskId = useAppState(s_2 => s_2.viewingAgentTaskId);
  const expandedView = useAppState(s_3 => s_3.expandedView);
  const showSpinnerTree = expandedView === 'teammates';
  const prStatus = usePrStatus(isLoading, isPrStatusEnabled());
  const nextTickAt = useSyncExternalStore((feature('PROACTIVE') || feature('KAIROS')) ? subscribeToPromptInputProactiveChanges : NO_OP_SUBSCRIBE, (feature('PROACTIVE') || feature('KAIROS')) ? getPromptInputProactiveNextTickAt : NULL, NULL);
  const hasSelection = useHasSelection();
  const selGetState = useSelection().getState;
  const hasNextTick = nextTickAt !== null;
  const isCoordinator = feature('COORDINATOR_MODE') ? isCoordinatorMode() : false;
  const runningTaskCount = useMemo(() => count(Object.values(tasks), isBackgroundTask), [tasks]);
  const tasksV2 = useTasksV2();
  const hasTaskItems = tasksV2 !== undefined && tasksV2.length > 0;
  const escShortcut = useShortcutDisplay('chat:cancel', 'Chat', 'esc').toLowerCase();
  const todosShortcut = useShortcutDisplay('app:toggleTodos', 'Global', 'ctrl+t');
  const killAgentsShortcut = useShortcutDisplay('chat:killAgents', 'Chat', 'ctrl+x ctrl+k');
  const isKillAgentsConfirmShowing = useAppState(s_7 => s_7.notifications.current?.key === 'kill-agents-confirm');

  // Derive team info from teamContext (no filesystem I/O needed)
  // Match the same logic as TeamStatus to avoid trailing separator
  // In-process mode uses Shift+Down/Up navigation, not footer teams menu
  const hasTeams = isAgentSwarmsEnabled() && !isInProcessEnabled() && teamContext !== undefined && count(Object.values(teamContext.teammates), t_0 => t_0.name !== 'team-lead') > 0;
  if (mode === 'bash') {
    return <Text color="bashBorder">! for bash mode</Text>;
  }
  const currentMode = toolPermissionContext?.mode;
  const hasActiveMode = !isDefaultMode(currentMode);
  const currentModeChrome = currentMode && hasActiveMode ? permissionModeFooterChrome(currentMode) : null;
  const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined;
  const isViewingTeammate = viewSelectionMode === 'viewing-agent' && viewedTask?.type === 'in_process_teammate';
  const isViewingCompletedTeammate = isViewingTeammate && viewedTask != null && viewedTask.status !== 'running';
  const hasBackgroundTasks = runningTaskCount > 0 || isViewingTeammate;

  // Count primary items (permission mode or coordinator mode, background tasks, and teams)
  const primaryItemCount = (isCoordinator || hasActiveMode ? 1 : 0) + (hasBackgroundTasks ? 1 : 0) + (hasTeams ? 1 : 0);

  // PR indicator is short (~10 chars) — unlike the old diff indicator the
  // >=100 threshold was tuned for. Now that auto mode is effectively the
  // baseline, primaryItemCount is ≥1 for most sessions; keep the threshold
  // low enough to show PR status on standard 80-col terminals.
  const shouldShowPrStatus = isPrStatusEnabled() && prStatus.number !== null && prStatus.reviewState !== null && prStatus.url !== null && primaryItemCount < 2 && (primaryItemCount === 0 || columns >= 80);

  // Hide the shift+tab hint when there are 2 primary items
  const shouldShowModeHint = primaryItemCount < 2;

  // Check if we have in-process teammates (showing pills)
  // In spinner-tree mode, pills are disabled - teammates appear in the spinner tree instead
  const hasInProcessTeammates = !showSpinnerTree && hasBackgroundTasks && Object.values(tasks).some(t_1 => t_1.type === 'in_process_teammate');
  const hasTeammatePills = hasInProcessTeammates || !showSpinnerTree && isViewingTeammate;

  // In remote mode the agent runs elsewhere;
  // the local permission mode shown here doesn't reflect the agent's state.
  // Rendered before the tasks pill so a long task label doesn't push the mode
  // indicator off-screen.
  const modePart = currentMode && currentModeChrome && !getIsRemoteMode() ? <Text color={getModeColor(currentMode)} bold={currentModeChrome.emphasize} key="mode">
        {currentModeChrome.symbol}{currentModeChrome.symbol ? ' ' : ''}{currentModeChrome.label}
        {shouldShowModeHint && <Text dimColor>
            {' '}
            <KeyboardShortcutHint shortcut={modeCycleShortcut} action="cycle" parens />
          </Text>}
      </Text> : null;

  // Build parts array - exclude BackgroundTaskStatus when we have teammate pills
  // (teammate pills get their own row)
  const parts = [
  // Remote session indicator
  ...(remoteSessionUrl ? [<Link url={remoteSessionUrl} key="remote">
            <Text color="ide">{figures.circleDouble} remote</Text>
          </Link>] : []),
  // BackgroundTaskStatus is NOT in parts — it renders as a Box sibling so
  // its click-target Box isn't nested inside the <Text wrap="truncate">
  // wrapper (reconciler throws on Box-in-Text).
  ...(isAgentSwarmsEnabled() && hasTeams ? [<TeamStatus key="teams" teamsSelected={teamsSelected} showHint={showHint && !hasBackgroundTasks} />] : []), ...(shouldShowPrStatus ? [<PrBadge key="pr-status" number={prStatus.number!} url={prStatus.url!} reviewState={prStatus.reviewState!} />] : [])];

  // Check if any in-process teammates exist (for hint text cycling)
  const hasAnyInProcessTeammates = Object.values(tasks).some(t_2 => t_2.type === 'in_process_teammate' && t_2.status === 'running');
  const hasRunningAgentTasks = Object.values(tasks).some(t_3 => t_3.type === 'local_agent' && (t_3.status === 'pending' || t_3.status === 'running'));

  // Get hint parts separately for potential second-line rendering
  const hintParts = showHint ? getSpinnerHintParts(isLoading, todosShortcut, killAgentsShortcut, hasTaskItems, expandedView, hasAnyInProcessTeammates, hasRunningAgentTasks, isKillAgentsConfirmShowing) : [];
  if (isViewingCompletedTeammate) {
    parts.push(<Text dimColor key="esc-return">
        <KeyboardShortcutHint shortcut={escShortcut} action="return to team lead" />
      </Text>);
  } else if ((feature('PROACTIVE') || feature('KAIROS')) && isPromptInputProactiveActive() && hasNextTick) {
    parts.push(<ProactiveCountdown key="proactive" />);
  } else if (!hasTeammatePills && showHint) {
    parts.push(...hintParts);
  }

  // When we have teammate pills, always render them on their own line above other parts
  if (hasTeammatePills) {
    // Don't append spinner hints when viewing a completed teammate —
    // the "esc to return to team lead" hint already replaces "esc to interrupt"
    const otherParts = [...(modePart ? [modePart] : []), ...parts, ...(isViewingCompletedTeammate ? [] : hintParts)];
    return <Box flexDirection="column">
        <Box>
          <BackgroundTaskStatus tasksSelected={tasksSelected} isViewingTeammate={isViewingTeammate} teammateFooterIndex={teammateFooterIndex} isLeaderIdle={!isLoading} onOpenDialog={onOpenTasksDialog} />
        </Box>
        {otherParts.length > 0 && <Box>
            <Byline>{otherParts}</Byline>
          </Box>}
      </Box>;
  }

  // Tasks pill renders as a Box sibling (not a parts entry) so its
  // click-target Box isn't nested inside <Text wrap="truncate"> — the
  // reconciler throws on Box-in-Text. Computed here so the empty-checks
  // below still treat "pill present" as non-empty.
  const tasksPart = hasBackgroundTasks && !hasTeammatePills && !shouldHideTasksFooter(tasks, showSpinnerTree) ? <BackgroundTaskStatus tasksSelected={tasksSelected} isViewingTeammate={isViewingTeammate} teammateFooterIndex={teammateFooterIndex} isLeaderIdle={!isLoading} onOpenDialog={onOpenTasksDialog} /> : null;
  // Suppress the cold-idle "? for shortcuts" hint while the exit warning is
  // active — the active "Press X again to exit" text takes precedence and
  // these two single-line hints must not stack.
  if (parts.length === 0 && !tasksPart && !modePart && showHint && !exitPending) {
    parts.push(<Text dimColor key="shortcuts-hint">
        ? for shortcuts
      </Text>);
  }

  const copyOnSelect = getGlobalConfig().copyOnSelect ?? true;
  const selectionHintHasContent = hasSelection && (!copyOnSelect || isXtermJs());

  if (isFullscreenEnvEnabled() && selectionHintHasContent) {
    // branding-scan: allow Cursor is a supported editor name in this selection hint.
    // xterm.js (VS Code/Cursor/Windsurf) force-selection modifier is
    // platform-specific and gated on macOS (SelectionService.shouldForceSelection):
    //   macOS:     altKey && macOptionClickForcesSelection (VS Code default: false)
    //   non-macOS: shiftKey
    // On macOS, if we RECEIVED an alt+click (lastPressHadAlt), the VS Code
    // setting is off — xterm.js would have consumed the event otherwise.
    // Tell the user the exact setting to flip instead of repeating the
    // option+click hint they just tried.
    // Non-reactive getState() read is safe: lastPressHadAlt is immutable
    // while hasSelection is true (set pre-drag, cleared with selection).
    const isMac = getPlatform() === 'macos';
    const altClickFailed = isMac && (selGetState()?.lastPressHadAlt ?? false);
    parts.push(<Text dimColor key="selection-copy">
        <Byline>
          {!copyOnSelect && <KeyboardShortcutHint shortcut="ctrl+c" action="copy" />}
          {isXtermJs() && (altClickFailed ? <Text>set macOptionClickForcesSelection in VS Code settings</Text> : <KeyboardShortcutHint shortcut={isMac ? 'option+click' : 'shift+click'} action="native select" />)}
        </Byline>
      </Text>);
  }
  // The inline AGENT FLEET panel was removed, so there is no ↓-to-manage entry.

  // In fullscreen the bottom section is flexShrink:0 — every row here
  // is a row stolen from the ScrollBox. This component must have a STABLE
  // height so the footer never grows/shrinks and shifts scroll content.
  // Returning null when parts is empty (e.g. StatusLine on → suppressHint
  // → showHint=false → no "? for shortcuts") would let a later-added
  // part (e.g. the selection copy/native-select hints) grow the column
  // from 0→1 row. Always render 1 row in fullscreen; return a space when
  // empty so Yoga reserves the row without painting anything visible.
  if (parts.length === 0 && !tasksPart && !modePart) {
    return isFullscreenEnvEnabled() ? <Text> </Text> : null;
  }

  // flexShrink=0 keeps mode + pill at natural width; the remaining parts
  // truncate at the tail as one string inside the Text wrapper.
  return <Box height={1} overflow="hidden">
      {modePart && <Box flexShrink={0}>
          {modePart}
          {(tasksPart || parts.length > 0) && <Text dimColor> · </Text>}
        </Box>}
      {tasksPart && <Box flexShrink={0}>
          {tasksPart}
          {parts.length > 0 && <Text dimColor> · </Text>}
        </Box>}
      {parts.length > 0 && <Text wrap="truncate">
          <Byline>{parts}</Byline>
        </Text>}
    </Box>;
}
function getSpinnerHintParts(isLoading: boolean, todosShortcut: string, killAgentsShortcut: string, hasTaskItems: boolean, expandedView: 'none' | 'tasks' | 'teammates', hasTeammates: boolean, hasRunningAgentTasks: boolean, isKillAgentsConfirmShowing: boolean): React.ReactElement[] {
  let toggleAction: string;
  if (hasTeammates) {
    // Cycling: none → tasks → teammates → none
    switch (expandedView) {
      case 'none':
        toggleAction = 'show tasks';
        break;
      case 'tasks':
        toggleAction = 'show teammates';
        break;
      case 'teammates':
        toggleAction = 'hide';
        break;
    }
  } else {
    toggleAction = expandedView === 'tasks' ? 'hide tasks' : 'show tasks';
  }

  // Show the toggle hint only when there are task items to display or
  // teammates to cycle to
  const showToggleHint = hasTaskItems || hasTeammates;
  // "esc to interrupt" is deliberately NOT rendered here: the spinner byline
  // already ends with that affordance (SpinnerAnimationRow), and the codebase
  // convention (see PromptInputQueuedCommands) is to never repeat it.
  return [...(!isLoading && hasRunningAgentTasks && !isKillAgentsConfirmShowing ? [<Text dimColor key="kill-agents">
            <KeyboardShortcutHint shortcut={killAgentsShortcut} action="stop agents" />
          </Text>] : []), ...(showToggleHint ? [<Text dimColor key="toggle-tasks">
            <KeyboardShortcutHint shortcut={todosShortcut} action={toggleAction} />
          </Text>] : [])];
}
function isPrStatusEnabled(): boolean {
  return getGlobalConfig().prStatusFooterEnabled ?? true;
}
