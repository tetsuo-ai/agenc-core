import * as React from 'react';
import { memo, type ReactNode, useMemo, useRef } from 'react';


import { useIsModalOverlayActive } from '../../context/overlayContext.js';
import { useSetPromptOverlay } from '../../context/promptOverlayContext.js';
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js';
import type { IDESelection } from '../../hooks/useIdeSelection.js';
import { useSettings } from '../../hooks/useSettings.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box } from '../../ink.js';
import type { MCPServerConnection } from '../../../services/mcp/types.js';
import { useAppState } from '../../state/AppState.js';
import type { ToolPermissionContext } from '../../../tools/Tool.js';
import type { Message } from '../../../types/message.js';
import type { PromptInputMode, VimMode } from '../../../types/textInputTypes.js';
import type { AutoUpdaterResult } from '../../../utils/autoUpdater.js';
import { isFullscreenEnvEnabled } from '../../../utils/fullscreen.js';
import { useCoordinatorTaskCount } from '../CoordinatorAgentStatus.js';
import { StatusLine, statusLineShouldDisplay } from '../../startup/StatusLine.js';
import { Notifications } from './Notifications.js';
import { PromptInputFooterLeftSide } from './PromptInputFooterLeftSide.js';
import { PromptInputFooterSuggestions, type SuggestionItem, type SuggestionType } from './PromptInputFooterSuggestions.js';
import { PromptInputHelpMenu } from './PromptInputHelpMenu.js';

type Props = {
  apiKeyStatus: VerificationStatus;
  debug: boolean;
  exitMessage: {
    show: boolean;
    key?: string;
  };
  vimMode: VimMode | undefined;
  mode: PromptInputMode;
  autoUpdaterResult: AutoUpdaterResult | null;
  isAutoUpdating: boolean;
  verbose: boolean;
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  suggestions: SuggestionItem[];
  selectedSuggestion: number;
  maxColumnWidth?: number;
  suggestionType: SuggestionType;
  toolPermissionContext: ToolPermissionContext;
  helpOpen: boolean;
  suppressHint: boolean;
  isLoading: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  teammateFooterIndex?: number;
  ideSelection: IDESelection | undefined;
  mcpClients?: MCPServerConnection[];
  agencHome?: string;
  isPasting?: boolean;
  isInputWrapped?: boolean;
  // Live transcript accessor (stable identity) + the re-render trigger for
  // the status line / token warning. Same contract as StatusLine's
  // messagesRef + lastAssistantMessageId pair.
  getMessages: () => Message[];
  lastAssistantMessageId: string | null;
  isSearching: boolean;
  historyQuery: string;
  setHistoryQuery: (query: string) => void;
  historyFailedMatch: boolean;
  onOpenTasksDialog?: (taskId?: string) => void;
};
function PromptInputFooter({
  apiKeyStatus,
  debug,
  exitMessage,
  vimMode,
  mode,
  autoUpdaterResult,
  isAutoUpdating,
  verbose,
  onAutoUpdaterResult,
  onChangeIsUpdating,
  suggestions,
  selectedSuggestion,
  maxColumnWidth,
  suggestionType,
  toolPermissionContext,
  helpOpen,
  suppressHint: suppressHintFromProps,
  isLoading,
  tasksSelected,
  teamsSelected,
  teammateFooterIndex,
  ideSelection,
  mcpClients,
  agencHome,
  isPasting = false,
  isInputWrapped = false,
  getMessages,
  lastAssistantMessageId,
  isSearching,
  historyQuery,
  setHistoryQuery,
  historyFailedMatch,
  onOpenTasksDialog
}: Props): ReactNode {
  const settings = useSettings();
  const {
    columns,
    rows
  } = useTerminalSize();
  const messagesRef = useRef<Message[]>(getMessages());
  messagesRef.current = getMessages();
  const isNarrow = columns < 80;
  // In fullscreen the bottom slot is flexShrink:0, so every row here is a row
  // stolen from the ScrollBox. Drop the optional StatusLine first. Non-fullscreen
  // has terminal scrollback to absorb overflow, so we never hide StatusLine there.
  const isFullscreen = isFullscreenEnvEnabled();
  const isShort = isFullscreen && rows < 24;
  const isModalOverlayActive = useIsModalOverlayActive();
  const shouldShowSuggestions = suggestions.length > 0 && !isModalOverlayActive;

  // Pill highlights when tasks is the active footer item AND no specific
  // agent row is selected. When coordinatorTaskIndex >= 0 the pointer has
  // moved into CoordinatorTaskPanel, so the pill should un-highlight.
  // coordinatorTaskCount === 0 covers the bash-only case (no agent rows
  // exist, pill is the only selectable item).
  const coordinatorTaskCount = useCoordinatorTaskCount();
  const coordinatorTaskIndex = useAppState(s => s.coordinatorTaskIndex);
  const pillSelected = tasksSelected && (coordinatorTaskCount === 0 || coordinatorTaskIndex < 0);

  // Hide `? for shortcuts` if the user has a custom status line, or during ctrl-r
  const suppressHint = suppressHintFromProps || statusLineShouldDisplay(settings) || isSearching;
  const showStatusLine = mode === 'prompt' && !isShort && !exitMessage.show && !isPasting && statusLineShouldDisplay(settings);
  // Fullscreen: portal data to FullscreenLayout — see promptOverlayContext.tsx
  const overlayData = useMemo(() => isFullscreen && shouldShowSuggestions ? {
    suggestions,
    selectedSuggestion,
    maxColumnWidth,
    suggestionType
  } : null, [isFullscreen, shouldShowSuggestions, suggestions, selectedSuggestion, maxColumnWidth, suggestionType]);
  useSetPromptOverlay(overlayData);
  if (shouldShowSuggestions && !isFullscreen) {
    return <Box paddingX={2} paddingY={0}>
        <PromptInputFooterSuggestions suggestions={suggestions} selectedSuggestion={selectedSuggestion} maxColumnWidth={maxColumnWidth} suggestionType={suggestionType} />
      </Box>;
  }
  if (helpOpen) {
    return <PromptInputHelpMenu dimColor={true} fixedWidth={true} paddingX={2} />;
  }
  return <>
      <Box flexDirection={isNarrow ? 'column' : 'row'} justifyContent={isNarrow ? 'flex-start' : 'space-between'} paddingX={2} gap={isNarrow ? 0 : 1}>
        <Box flexDirection="column" flexShrink={isNarrow ? 0 : 1}>
          {showStatusLine && <StatusLine messagesRef={messagesRef} lastAssistantMessageId={lastAssistantMessageId} vimMode={vimMode} />}
          <PromptInputFooterLeftSide exitMessage={exitMessage} vimMode={showStatusLine ? undefined : vimMode} mode={mode} toolPermissionContext={toolPermissionContext} suppressHint={suppressHint} isLoading={isLoading} tasksSelected={pillSelected} teamsSelected={teamsSelected} teammateFooterIndex={teammateFooterIndex} isPasting={isPasting} isSearching={isSearching} historyQuery={historyQuery} setHistoryQuery={setHistoryQuery} historyFailedMatch={historyFailedMatch} onOpenTasksDialog={onOpenTasksDialog} />
        </Box>
        <Box flexShrink={1} gap={1}>
          {isFullscreen ? null : <Notifications apiKeyStatus={apiKeyStatus} autoUpdaterResult={autoUpdaterResult} debug={debug} isAutoUpdating={isAutoUpdating} verbose={verbose} getMessages={getMessages} lastAssistantMessageId={lastAssistantMessageId} onAutoUpdaterResult={onAutoUpdaterResult} onChangeIsUpdating={onChangeIsUpdating} ideSelection={ideSelection} mcpClients={mcpClients} agencHome={agencHome} isInputWrapped={isInputWrapped} isNarrow={isNarrow} />}
        </Box>
      </Box>
    </>;
}
export default memo(PromptInputFooter);
