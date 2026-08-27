import { feature } from "bun:bundle";
import * as path from "path";
import * as React from "react";
import type { ProviderAuthReadContext } from "../../../utils/auth.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useContentWidth } from "../../context/contentWidthContext.js";
import { useFullscreenMode } from "../../context/fullscreenModeContext.js";
import { useNotifications } from "../../context/notifications.js";
import { useCommandQueue } from "../../hooks/useCommandQueue.js";
import {
  type IDEAtMentioned,
  useIdeAtMentioned,
} from "../../hooks/useIdeAtMentioned.js";
import {
  type AppState,
  useAppState,
  useAppStateStore,
  useSetAppState,
} from "../../state/AppState.js";
import type { FooterItem } from "../../state/AppStateStore.js";
import { getCwd } from "../../../utils/cwd.js";
import {
  enqueue,
  isQueuedCommandEditable,
  popAllEditable,
  queuedCommandOwnedByMount,
  removeLastQueuedInput,
} from "../../../utils/messageQueueManager.js";
import stripAnsi from "strip-ansi";
import { type Command, hasCommand } from "../../../commands.js";
import {
  useIsModalOverlayActive,
  useRegisterOverlay,
} from "../../context/overlayContext.js";
import { useSetPromptOverlayDialog } from "../../context/promptOverlayContext.js";
import {
  expandPastedTextRefs,
  formatImageRef,
  formatPastedTextRef,
  getPastedTextRefNumLines,
  parseReferences,
} from "../../history/history.js";
import type { VerificationStatus } from "../../hooks/useApiKeyVerification.js";
import {
  type HistoryMode,
  useArrowKeyHistory,
} from "../../hooks/useArrowKeyHistory.js";
import { useDoublePress } from "../../hooks/useDoublePress.js";
import { useHistorySearch } from "../../hooks/useHistorySearch.js";
import type { IDESelection } from "../../hooks/useIdeSelection.js";
import { useInputBuffer } from "../../hooks/useInputBuffer.js";
import { useMainLoopModel } from "../../hooks/useMainLoopModel.js";
import { selectAgenCTuiGlyphs } from "../../glyphs.js";
import { useTerminalSize } from "../../hooks/useTerminalSize.js";
import { useTypeahead } from "../../hooks/useTypeahead.js";
import { useTerminalFocus } from "../../ink/hooks/use-terminal-focus.js";
import { stringWidth } from "../../ink/stringWidth.js";
import { Box, type ClickEvent, type Key, Text, useInput } from "../../ink.js";
import { useOptionalKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { getShortcutDisplay } from "../../keybindings/shortcutFormat.js";
import {
  useKeybinding,
  useKeybindings,
} from "../../keybindings/useKeybinding.js";
import type { MCPServerConnection } from "../../../services/mcp/types.js";
import {
  abortPromptSuggestion,
  logSuggestionSuppressed,
} from "../../../services/PromptSuggestion/promptSuggestion.js";
import {
  type ActiveSpeculationState,
  abortSpeculation,
} from "../../../services/PromptSuggestion/speculation.js";
import {
  getVisiblePromptSuggestion,
  shouldShowPromptSuggestionPlaceholder,
  shouldSuppressPromptSuggestionForTiming,
} from "./promptSuggestionControl.js";
import {
  getActiveAgentForInput,
  getViewedTeammateTask,
} from "../../state/selectors.js";
import {
  enterTeammateView,
  exitTeammateView,
  stopOrDismissAgent,
} from "../../state/teammateViewHelpers.js";
import type { ToolPermissionContext } from "../../../tools/Tool.js";
import { getRunningTeammatesSorted } from "../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js";
import type { InProcessTeammateTaskState } from "../../../tasks/InProcessTeammateTask/types.js";
import { type LocalAgentTaskState } from "../../../tasks/LocalAgentTask/LocalAgentTask.js";
import { isBackgroundTask } from "../../../tasks/types.js";
import {
  AGENT_COLOR_TO_THEME_COLOR,
  AGENT_COLORS,
  type AgentColorName,
} from "../../../tools/AgentTool/agentColorManager.js";
import type { AgentDefinition } from "../../../tools/AgentTool/loadAgentsDir.js";
import type { Message } from "../../../types/message.js";
import type { PermissionMode } from "../../../types/permissions.js";
import type {
  BaseTextInputProps,
  PromptInputMode,
  QueuedCommandOwner,
  VimMode,
} from "../../../types/textInputTypes.js";
import { isAgentSwarmsEnabled } from "../../../utils/agentSwarmsEnabled.js";
import { count } from "../../../utils/array.js";
import type { AutoUpdaterResult } from "../../../utils/autoUpdater.js";
// branding-scan: allow TextCursor is the text-caret utility name.
import { TextCursor } from "../../../utils/TextCursor.js";
import {
  getRuntimeState,
  type PastedContent,
  updateRuntimeState,
} from "../../../utils/config.js";
import type { RuntimeStateRepository } from "../../../config/runtime-state-repository.js";
import type { CanonicalSettingsAuthority } from "../../../utils/settings/canonicalAuthority.js";
import { logForDebugging } from "../../../utils/debug.js";
import {
  parseDirectMemberMessage,
  sendDirectMemberMessage,
} from "../../../utils/directMemberMessage.js";
import { env } from "../../../utils/env.js";
import { errorMessage } from "../../../utils/errors.js";
import type { VimRoutingState } from "../../input/processTextPrompt.js";
import { extractDraggedFilePaths } from "../../../utils/dragDropPaths.js";
import {
  getImageFromClipboard,
  PASTE_THRESHOLD,
} from "../../../utils/imagePaste.js";
import type { ImageDimensions } from "../../../utils/imageResizer.js";
import { cacheImagePath, storeImage } from "../../../utils/imageStore.js";
import {
  isMacosOptionChar,
  MACOS_OPTION_SPECIAL_CHARS,
} from "../../../utils/keyboardShortcuts.js";
import { logError } from "../../../utils/log.js";
import {
  getNextPermissionMode,
  isAutoModeGateEnabled,
  transitionPermissionMode,
} from "../../../permissions/permission-mode.js";
import { getPlatform } from "../../../utils/platform.js";
import type { PromptInputContext } from "../../input/inputContext.js";
import { editPromptInEditor } from "../../../utils/promptEditor.js";
import { hasAutoModeOptIn } from "../../../utils/settings/settings.js";
import { findSlashCommandPositions } from "../../../utils/suggestions/commandSuggestions.js";
import {
  findSlackChannelPositions,
  getKnownChannelsVersion,
  hasSlackMcpServer,
  subscribeKnownChannels,
} from "../../../utils/suggestions/slackChannelSuggestions.js";
import { isInProcessEnabled } from "../../../utils/swarm/backends/registry.js";
import { syncTeammateMode } from "../../../utils/swarm/teamHelpers.js";
import type { TeamSummary } from "../../../utils/teamDiscovery.js";
import { permissionModeShortTitle } from "../../../permissions/mode-display.js";
import { getTeammateColor } from "../../../utils/teammate.js";
import { isInProcessTeammate } from "../../../utils/teammateContext.js";
import { writeToMailbox } from "../../../utils/teammateMailbox.js";
import type { TextHighlight } from "../../../utils/textHighlighting.js";
import type { Theme } from "../../../utils/theme.js";
import {
  findThinkingTriggerPositions,
  findUltrareviewTriggerPositions,
  getRainbowColor,
  isUltrathinkEnabled,
} from "../../../utils/thinking.js";
import { escapeXml } from "../../../utils/xml.js";
import { findTokenBudgetPositions } from "../../../conversation/token-budget.js";

import { AutoModeOptInDialog } from "../AutoModeOptInDialog.js";
import { ConfigurableShortcutHint } from "../ConfigurableShortcutHint.js";
import {
  getVisibleAgentTasks,
  useCoordinatorTaskCount,
} from "../CoordinatorAgentStatus.js";
import { getEffortNotificationText } from "../EffortIndicator.js";
import { calculateFullscreenLayoutBudget } from "../FullscreenLayout.js";
import { GlobalSearchDialog } from "../GlobalSearchDialog.js";
import { HistorySearchDialog } from "../../history/HistorySearchDialog.js";
import { QuickOpenDialog } from "../QuickOpenDialog.js";
import { materializeAttachmentMentions } from "../../workbench/commands.js";
import {
  capturedAttachmentsToPastedContents,
  isCapturedWorkbenchAttachment,
} from "../../workbench/capturedAttachments.js";
import { useWorkbenchComposerFocus } from "../../workbench/composerFocusContext.js";
import { composerAttachmentsForState } from "../../workbench/reducer.js";
import {
  applyWorkbenchCommand,
  isWorkbenchEnabled,
} from "../../workbench/state.js";
import type { WorkbenchAttachment } from "../../workbench/types.js";
import { ThinkingToggle } from "../ThinkingToggle.js";
import { BackgroundTasksPanel } from "../tasks/BackgroundTasksPanel.js";
import { shouldHideTasksFooter } from "../tasks/taskStatusUtils.js";
import { TeamsDialog } from "../teams/TeamsDialog.js";
import { ModeSwitcher, visibleUserFacingModes } from "../v2/primitives.js";
import { ConfiguredPromptTextInput } from "./ConfiguredPromptTextInput.js";
import {
  detectModeEntry,
  getModeFromInput,
  getValueFromInput,
} from "./inputModes.js";
import {
  FOOTER_TEMPORARY_STATUS_TIMEOUT,
  Notifications,
} from "./Notifications.js";
import PromptInputFooter from "./PromptInputFooter.js";
import type { SuggestionItem } from "./PromptInputFooterSuggestions.js";
import { PromptInputModeIndicator } from "./PromptInputModeIndicator.js";
import { PromptInputQueuedCommands } from "./PromptInputQueuedCommands.js";
import { PromptInputStashNotice } from "./PromptInputStashNotice.js";
import { useMaybeTruncateInput } from "./useMaybeTruncateInput.js";
import { usePromptInputPlaceholder } from "./usePromptInputPlaceholder.js";
import { useSwarmBanner } from "./useSwarmBanner.js";
import {
  clampPromptTextInputColumns,
  clampWorkbenchPromptTextInputColumns,
  isNonSpacePrintable,
  isVimModeEnabled,
  pasteReferenceLineThreshold,
} from "./utils.js";

type PromptSuggestionHookProps = {
  inputValue: string;
  isAssistantResponding: boolean;
};

const NATIVE_CSIU_TERMINALS: Record<string, string> = {
  ghostty: "Ghostty",
  kitty: "Kitty",
  "iTerm.app": "iTerm2",
  WezTerm: "WezTerm",
  WarpTerminal: "Warp",
};

function getNativeCSIuTerminalDisplayName(): string | null {
  if (!env.terminal || !(env.terminal in NATIVE_CSIU_TERMINALS)) {
    return null;
  }
  return NATIVE_CSIU_TERMINALS[env.terminal] ?? null;
}

function isUltrareviewEnabled(): boolean {
  const config: Record<string, unknown> | null = null;
  return config?.enabled === true;
}

/**
 * Ports source-reference `src/hooks/usePromptSuggestion.ts` into the absorbed
 * PromptInput surface while delegating generation/speculation to the
 * AgenC-owned PromptSuggestion service.
 */
function usePromptSuggestion({
  inputValue,
  isAssistantResponding,
}: PromptSuggestionHookProps): {
  suggestion: string | null;
  markAccepted: () => void;
  markShown: () => void;
  logOutcomeAtSubmission: (
    finalInput: string,
    opts?: {
      skipReset: boolean;
    },
  ) => void;
} {
  const promptSuggestion = useAppState((s: AppState) => s.promptSuggestion);
  const setAppState = useSetAppState();
  const isTerminalFocused = useTerminalFocus();
  const { text: suggestionText, shownAt } = promptSuggestion;

  const suggestion = getVisiblePromptSuggestion({
    inputValue,
    isAssistantResponding,
    suggestionText,
  });
  const isValidSuggestion = suggestionText && shownAt > 0;
  const firstKeystrokeAt = useRef<number>(0);
  const wasFocusedWhenShown = useRef<boolean>(true);
  const prevShownAt = useRef<number>(0);

  if (shownAt > 0 && shownAt !== prevShownAt.current) {
    prevShownAt.current = shownAt;
    wasFocusedWhenShown.current = isTerminalFocused;
    firstKeystrokeAt.current = 0;
  } else if (shownAt === 0) {
    prevShownAt.current = 0;
  }

  if (
    inputValue.length > 0 &&
    firstKeystrokeAt.current === 0 &&
    isValidSuggestion
  ) {
    firstKeystrokeAt.current = Date.now();
  }

  const resetSuggestion = useCallback(() => {
    abortSpeculation(setAppState);

    setAppState((prev) => ({
      ...prev,
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null,
      },
    }));
  }, [setAppState]);

  const markAccepted = useCallback(() => {
    if (!isValidSuggestion) return;
    setAppState((prev) => ({
      ...prev,
      promptSuggestion: {
        ...prev.promptSuggestion,
        acceptedAt: Date.now(),
      },
    }));
  }, [isValidSuggestion, setAppState]);

  const markShown = useCallback(() => {
    setAppState((prev) => {
      if (prev.promptSuggestion.shownAt !== 0 || !prev.promptSuggestion.text) {
        return prev;
      }
      return {
        ...prev,
        promptSuggestion: {
          ...prev.promptSuggestion,
          shownAt: Date.now(),
        },
      };
    });
  }, [setAppState]);

  const logOutcomeAtSubmission = useCallback(
    (_finalInput: string, opts?: { skipReset: boolean }) => {
      if (!isValidSuggestion) return;
      if (!opts?.skipReset) resetSuggestion();
    },
    [isValidSuggestion, resetSuggestion],
  );

  return {
    suggestion,
    markAccepted,
    markShown,
    logOutcomeAtSubmission,
  };
}

type PromptInputHelpers = {
  setCursorOffset: (offset: number) => void;
  clearBuffer: () => void;
  resetHistory: () => void;
};

type Props = {
  debug: boolean;
  ideSelection: IDESelection | undefined;
  toolPermissionContext: ToolPermissionContext;
  setToolPermissionContext: (ctx: ToolPermissionContext) => void;
  apiKeyStatus: VerificationStatus;
  remoteAuthSessionContext: ProviderAuthReadContext;
  commands: Command[];
  agents: AgentDefinition[];
  isLoading: boolean;
  verbose: boolean;
  // The transcript is NOT passed by value: App hands a fresh messages array
  // on every streaming flush, which defeats this component's React.memo and
  // re-renders the whole composer at token rate. Instead it passes a stable
  // accessor (read inside handlers/memos, never during render) plus derived
  // flags that only change when a message completes.
  getMessages: () => Message[];
  hasMessages: boolean;
  isMidConversation: boolean;
  lastAssistantMessageId: string | null;
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  input: string;
  onInputChange: (value: string) => void;
  mode: PromptInputMode;
  onModeChange: (mode: PromptInputMode) => void;
  stashedPrompt:
    | {
        text: string;
        cursorOffset: number;
        pastedContents: Record<number, PastedContent>;
      }
    | undefined;
  setStashedPrompt: (
    value:
      | {
          text: string;
          cursorOffset: number;
          pastedContents: Record<number, PastedContent>;
        }
      | undefined,
  ) => void;
  submitCount: number;
  onShowMessageSelector: () => void;
  /** Fullscreen message actions: shift+↑ enters cursor. */
  onMessageActionsEnter?: () => void;
  mcpClients: MCPServerConnection[];
  pastedContents: Record<number, PastedContent>;
  setPastedContents: React.Dispatch<
    React.SetStateAction<Record<number, PastedContent>>
  >;
  vimMode: VimMode;
  setVimMode: (mode: VimMode) => void;
  showBashesDialog: string | boolean;
  setShowBashesDialog: (show: string | boolean) => void;
  onExit: () => void;
  getToolUseContext: (
    messages: Message[],
    newMessages: Message[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => PromptInputContext;
  /**
   * App-owned Bash runner. The daemon-backed shell fence lives above the
   * composer so direct and queued commands share one authority boundary.
   */
  onBashSubmit?: (command: string) => Promise<void>;
  /** Exact TUI mount that owns commands admitted while the composer is busy. */
  queueOwner?: QueuedCommandOwner;
  /** Frozen workspace root for Bash commands admitted while busy. */
  queueExecutionCwd?: string;
  /**
   * Restores a failed async submission to its originating workspace tab
   * without replacing a newer sibling/returning-tab draft.
   */
  restoreComposerDraftForView?: (
    view: "agent" | "editor",
    draft: {
      readonly input: string;
      readonly pastedContents?: Record<number, PastedContent>;
    },
  ) => void;
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    speculationAccept?: {
      state: ActiveSpeculationState;
      speculationSessionTimeSavedMs: number;
      setAppState: (f: (prev: AppState) => AppState) => void;
    },
    options?: {
      fromKeybinding?: boolean;
      vimRoutingState?: VimRoutingState;
      // round-2 MD-NEW4: composer input mode (prompt / bash). Bash is
      // intercepted inside PromptInput before this fires; the field is
      // still threaded through for future modes (e.g. memory) that
      // downstream callers may need to branch on.
      mode?: PromptInputMode;
      /** Exact live-editor captures admitted through the normal paste channel. */
      pastedContentsOverride?: Record<number, PastedContent>;
      /**
       * Called only after the owning app positively admits this submission.
       * Promise fulfillment alone is not sufficient because local commands and
       * handled transport failures also resolve without consuming attachments.
       */
      onWorkbenchAttachmentsAdmitted?: () => void;
    },
  ) => Promise<void>;
  onAgentSubmit?: (
    input: string,
    task: InProcessTeammateTaskState | LocalAgentTaskState,
    helpers: PromptInputHelpers,
  ) => Promise<void>;
  isSearchingHistory: boolean;
  setIsSearchingHistory: (isSearching: boolean) => void;
  helpOpen: boolean;
  setHelpOpen: React.Dispatch<React.SetStateAction<boolean>>;
  hasSuppressedDialogs?: boolean;
  isLocalJSXCommandActive?: boolean;
  /**
   * Fail-closed workspace safety gate. This is checked before speculation,
   * direct-message, slash, bash, or model routing so a rejected submission
   * leaves the originating draft and attachments untouched.
   */
  submissionBlockedReason?: string | null;
  onSubmissionBlocked?: (reason: string) => void;
  /** Opens the App-owned provider-neutral model selection surface. */
  onOpenModelMenu?: () => Promise<void> | void;
  onboardingInput?: {
    readonly placeholder: string;
    readonly footerHint: string;
    readonly allowEmptySubmit: boolean;
  };
  runtimeStateRepository: RuntimeStateRepository;
  settingsAuthority: CanonicalSettingsAuthority;
};

// Bottom slot has maxHeight="50%"; reserve lines for footer, border, status.
const PROMPT_FOOTER_LINES = 5;
const MIN_INPUT_VIEWPORT_LINES = 3;
const ABSOLUTE_MIN_INPUT_VIEWPORT_LINES = 1;

export function calculatePromptMaxVisibleLines(
  rows: number,
  fullscreen: boolean,
): number | undefined {
  if (!fullscreen) return undefined;

  const safeRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
  const desiredLines = Math.max(
    MIN_INPUT_VIEWPORT_LINES,
    Math.floor(safeRows / 2) - PROMPT_FOOTER_LINES,
  );
  const bottomBudget =
    calculateFullscreenLayoutBudget(safeRows).bottomMaxHeight;

  return Math.max(
    ABSOLUTE_MIN_INPUT_VIEWPORT_LINES,
    Math.min(desiredLines, bottomBudget),
  );
}

export type BusyInputSubmissionPolicyArgs = {
  isLoading: boolean;
  mode: PromptInputMode;
  input: string;
  addNotification: (notification: {
    key: string;
    text: string;
    priority: "immediate";
    timeoutMs: number;
  }) => void;
  setInput: (value: string) => void;
  setCursorOffset: (offset: number) => void;
  clearBuffer: () => void;
  resetHistory: () => void;
  onModeChange: (mode: PromptInputMode) => void;
  queueOwner?: QueuedCommandOwner;
  queueExecutionCwd?: string;
};

export function applyBusyInputSubmissionPolicy({
  isLoading,
  mode,
  input,
  addNotification,
  setInput,
  setCursorOffset,
  clearBuffer,
  resetHistory,
  onModeChange,
  queueOwner,
  queueExecutionCwd,
}: BusyInputSubmissionPolicyArgs): boolean {
  if (!isLoading) return false;
  if (mode === "bash") {
    const trimmedBash = input.trim();
    if (trimmedBash === "") {
      return true;
    }
    enqueue({
      value: trimmedBash,
      preExpansionValue: `!${trimmedBash}`,
      mode: "bash",
      queueOwner,
      executionCwd: queueExecutionCwd,
    });
    addNotification({
      key: "busy-bash-queued",
      text: "Bash command queued for next turn",
      priority: "immediate",
      timeoutMs: 3000,
    });
    setInput("");
    setCursorOffset(0);
    clearBuffer();
    resetHistory();
    onModeChange("prompt");
    return true;
  }

  if (mode !== "prompt") {
    addNotification({
      key: "busy-mode-preserved",
      text: `${mode} input is available after the current turn finishes`,
      priority: "immediate",
      timeoutMs: 3000,
    });
    return true;
  }

  return false;
}

function PromptInput({
  debug,
  ideSelection,
  toolPermissionContext,
  setToolPermissionContext,
  apiKeyStatus,
  remoteAuthSessionContext,
  commands,
  agents,
  isLoading,
  verbose,
  getMessages,
  hasMessages,
  isMidConversation,
  lastAssistantMessageId,
  onAutoUpdaterResult,
  autoUpdaterResult,
  input,
  onInputChange,
  mode,
  onModeChange,
  stashedPrompt,
  setStashedPrompt,
  submitCount,
  onShowMessageSelector,
  onMessageActionsEnter,
  mcpClients,
  pastedContents,
  setPastedContents,
  vimMode,
  setVimMode,
  showBashesDialog,
  setShowBashesDialog,
  onExit,
  getToolUseContext,
  onBashSubmit,
  queueOwner,
  queueExecutionCwd,
  restoreComposerDraftForView,
  onSubmit: onSubmitProp,
  onAgentSubmit,
  isSearchingHistory,
  setIsSearchingHistory,
  helpOpen,
  setHelpOpen,
  hasSuppressedDialogs,
  isLocalJSXCommandActive = false,
  submissionBlockedReason = null,
  onSubmissionBlocked,
  onOpenModelMenu,
  onboardingInput,
  runtimeStateRepository,
  settingsAuthority,
}: Props): React.ReactNode {
  const isFullscreen = useFullscreenMode();
  const mainLoopModel = useMainLoopModel();
  const runtimeState = getRuntimeState(runtimeStateRepository);
  // A local-jsx command (e.g., /mcp while agent is running) renders a full-
  // screen dialog on top of PromptInput via the immediate-command path with
  // shouldHidePromptInput: false. Those dialogs don't register in the overlay
  // system, so treat them as a modal overlay here to stop navigation keys from
  // leaking into TextInput/footer handlers and stacking a second dialog.
  const upstreamModalOverlayActive =
    useIsModalOverlayActive() || isLocalJSXCommandActive;
  const workbenchComposerFocused = useWorkbenchComposerFocus();
  const isWorkbenchComposer =
    workbenchComposerFocused !== null || isWorkbenchEnabled();
  const composerInputEnabled = workbenchComposerFocused ?? true;
  const [isAutoUpdating, setIsAutoUpdating] = useState(false);
  const [exitMessage, setExitMessage] = useState<{
    show: boolean;
    key?: string;
  }>({
    show: false,
  });
  const [cursorOffset, setCursorOffset] = useState<number>(input.length);
  // Input-mode changes originate in TextInput and can be submitted before
  // React commits the parent-owned mode prop. Keep that same-tick authority
  // synchronous so a freshly entered ! command cannot reach the model path.
  const currentModeRef = useRef(mode);
  currentModeRef.current = mode;
  const setCurrentMode = useCallback(
    (nextMode: PromptInputMode) => {
      currentModeRef.current = nextMode;
      onModeChange(nextMode);
    },
    [onModeChange],
  );
  // Ref mirrors cursorOffset for synchronous command handlers that can run
  // before React commits a cursor state update from TextInput.
  const cursorOffsetRef = useRef(cursorOffset);
  cursorOffsetRef.current = cursorOffset;
  const setCurrentCursorOffset = useCallback(
    (nextOffset: number | ((prev: number) => number)) => {
      const next =
        typeof nextOffset === "function"
          ? nextOffset(cursorOffsetRef.current)
          : nextOffset;
      cursorOffsetRef.current = next;
      setCursorOffset(next);
    },
    [],
  );
  // Track the last input value set via internal handlers so external updates
  // (for example speech-to-text injection) can still move the cursor to end
  // without clobbering a pending internal keystroke during render.
  const lastInternalInputRef = React.useRef(input);
  const lastPropInputRef = React.useRef(input);
  const pastedContentsRef = useRef(pastedContents);
  const lastPastedContentsPropRef = useRef(pastedContents);
  React.useLayoutEffect(() => {
    if (input === lastPropInputRef.current) {
      return;
    }

    lastPropInputRef.current = input;
    if (input === lastInternalInputRef.current) {
      return;
    }

    lastInternalInputRef.current = input;
    if (cursorOffsetRef.current !== input.length) {
      setCurrentCursorOffset(input.length);
    }
  }, [input, setCurrentCursorOffset]);
  React.useLayoutEffect(() => {
    if (pastedContents === lastPastedContentsPropRef.current) {
      return;
    }
    lastPastedContentsPropRef.current = pastedContents;
    if (input === lastInternalInputRef.current) {
      pastedContentsRef.current = pastedContents;
    }
  }, [input, pastedContents]);
  // Wrap onInputChange to track internal changes before they trigger re-render
  const trackAndSetInput = React.useCallback(
    (value: string) => {
      lastInternalInputRef.current = value;
      onInputChange(value);
    },
    [onInputChange],
  );
  const setPastedContentsAndRef = useCallback(
    (next: Record<number, PastedContent>) => {
      pastedContentsRef.current = next;
      setPastedContents(next);
    },
    [setPastedContents],
  );
  const updatePastedContentsAndRef = useCallback(
    (
      updater: (
        prev: Record<number, PastedContent>,
      ) => Record<number, PastedContent>,
    ) => {
      const next = updater(pastedContentsRef.current);
      setPastedContentsAndRef(next);
    },
    [setPastedContentsAndRef],
  );
  const store = useAppStateStore();
  const setAppState = useSetAppState();
  const composerWorkbenchState = useAppState((s) => s.workbench);
  const renderedWorkspaceView =
    composerWorkbenchState?.activeWorkspaceView ?? "agent";
  const renderedWorkbenchAttachments = useMemo(
    () =>
      composerWorkbenchState
        ? composerAttachmentsForState(composerWorkbenchState)
        : [],
    [composerWorkbenchState],
  );
  const composerDraftRequest =
    composerWorkbenchState?.composerDraftRequest ?? null;
  useEffect(() => {
    if (
      composerDraftRequest === null ||
      composerWorkbenchState?.activeWorkspaceView !== composerDraftRequest.view
    ) {
      return;
    }
    const current = lastInternalInputRef.current;
    const separator = current.trim().length > 0 ? "\n\n" : "";
    const next = `${current}${separator}${composerDraftRequest.text}`;
    trackAndSetInput(next);
    setCurrentCursorOffset(next.length);
    setAppState((prev) =>
      applyWorkbenchCommand(prev, {
        type: "acknowledgeComposerDraft",
        id: composerDraftRequest.id,
      }),
    );
  }, [
    composerDraftRequest,
    composerWorkbenchState?.activeWorkspaceView,
    setAppState,
    setCurrentCursorOffset,
    trackAndSetInput,
  ]);
  const tasks = useAppState((s) => s.tasks);
  const teamContext = useAppState((s) => s.teamContext);
  const swarmMode = useAppState((s) => s.swarmMode === true);
  const allQueuedCommands = useCommandQueue();
  const queuedCommands = useMemo(
    () =>
      queueOwner === undefined
        ? allQueuedCommands
        : allQueuedCommands.filter((command) =>
            queuedCommandOwnedByMount(command, queueOwner),
          ),
    [allQueuedCommands, queueOwner],
  );
  const promptSuggestionState = useAppState((s) => s.promptSuggestion);
  const speculation = useAppState((s) => s.speculation);
  const speculationSessionTimeSavedMs = useAppState(
    (s) => s.speculationSessionTimeSavedMs,
  );
  const viewingAgentTaskId = useAppState((s) => s.viewingAgentTaskId);
  const viewSelectionMode = useAppState((s) => s.viewSelectionMode);
  const showSpinnerTree = useAppState((s) => s.expandedView) === "teammates";
  // Brief mode: BriefSpinner/BriefIdleStatus own the 2-row footprint above
  // the input. Dropping marginTop here lets the spinner sit flush against
  // the input bar. viewingAgentTaskId mirrors the gate on both (Spinner.tsx,
  // the live TUI shell) — teammate view falls back to SpinnerWithVerbInner which has
  // its own marginTop, so the gap stays even without ours.
  const briefOwnsGap =
    feature("KAIROS") || feature("KAIROS_BRIEF")
      ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
        useAppState((s) => s.isBriefOnly) && !viewingAgentTaskId
      : false;
  const thinkingEnabled = useAppState((s) => s.thinkingEnabled);
  const effortValue = useAppState((s) => s.effortValue);
  const viewedTeammate = getViewedTeammateTask(store.getState());
  const viewingAgentName = viewedTeammate?.identity.agentName;
  // identity.color is typed as `string | undefined` (not AgentColorName) because
  // teammate identity comes from file-based config. Validate before casting to
  // ensure we only use valid color names (falls back to cyan if invalid).
  const viewingAgentColor =
    viewedTeammate?.identity.color &&
    AGENT_COLORS.includes(viewedTeammate.identity.color as AgentColorName)
      ? (viewedTeammate.identity.color as AgentColorName)
      : undefined;
  // In-process teammates sorted alphabetically for footer team selector
  const inProcessTeammates = useMemo(
    () => getRunningTeammatesSorted(tasks),
    [tasks],
  );

  // Team mode: all background tasks are in-process teammates
  const isTeammateMode =
    inProcessTeammates.length > 0 || viewedTeammate !== undefined;

  // When viewing a teammate, show their permission mode in the footer instead of the leader's
  const effectiveToolPermissionContext = useMemo((): ToolPermissionContext => {
    if (viewedTeammate) {
      return {
        ...toolPermissionContext,
        mode: viewedTeammate.permissionMode,
        isBypassPermissionsModeAvailable: false,
      };
    }
    return toolPermissionContext;
  }, [viewedTeammate, toolPermissionContext]);
  const { historyQuery, setHistoryQuery, historyMatch, historyFailedMatch } =
    useHistorySearch(
      (entry) => {
        setPastedContentsAndRef(entry.pastedContents);
        void onSubmit(entry.display);
      },
      input,
      trackAndSetInput,
      setCurrentCursorOffset,
      cursorOffset,
      setCurrentMode,
      mode,
      isSearchingHistory,
      setIsSearchingHistory,
      setPastedContentsAndRef,
      pastedContents,
    );
  // Counter for paste IDs (shared between images and text).
  // Compute initial value once from existing messages (for --continue/--resume).
  // useRef(fn()) evaluates fn() on every render and discards the result after
  // mount — getInitialPasteId walks all messages + regex-scans text blocks,
  // so guard with a lazy-init pattern to run it exactly once.
  const nextPasteIdRef = useRef(-1);
  if (nextPasteIdRef.current === -1) {
    nextPasteIdRef.current = getNextPasteIdAfter(
      getMessages(),
      pastedContents,
      input,
    );
  }
  function allocatePasteId(): number {
    const nextPasteId = Math.max(
      nextPasteIdRef.current,
      getNextPasteIdAfter(
        getMessages(),
        pastedContentsRef.current,
        lastInternalInputRef.current,
      ),
    );
    nextPasteIdRef.current = nextPasteId + 1;
    return nextPasteId;
  }
  // Armed by onImagePaste; if the very next keystroke is a non-space
  // printable, inputFilter prepends a space before it. Any other input
  // (arrow, escape, backspace, paste, space) disarms without inserting.
  const pendingSpaceAfterPillRef = useRef(false);
  const [showTeamsDialog, setShowTeamsDialog] = useState(false);
  const [teammateFooterIndex, setTeammateFooterIndex] = useState(0);
  // -1 sentinel: tasks pill is selected but no specific agent row is selected yet.
  // First ↓ selects the pill, second ↓ moves to row 0. Prevents double-select
  // of pill + row when both bg tasks (pill) and forked agents (rows) are visible.
  const coordinatorTaskIndex = useAppState((s) => s.coordinatorTaskIndex);
  const setCoordinatorTaskIndex = useCallback(
    (v: number | ((prev: number) => number)) =>
      setAppState((prev) => {
        const next = typeof v === "function" ? v(prev.coordinatorTaskIndex) : v;
        if (next === prev.coordinatorTaskIndex) return prev;
        return {
          ...prev,
          coordinatorTaskIndex: next,
        };
      }),
    [setAppState],
  );
  const coordinatorTaskCount = useCoordinatorTaskCount();
  // The pill (BackgroundTaskStatus) only renders when non-local_agent bg tasks
  // exist. When only local_agent tasks are running (coordinator/fork mode), the
  // pill is absent, so the -1 sentinel would leave nothing visually selected.
  // In that case, skip -1 and treat 0 as the minimum selectable index.
  const hasBgTaskPill = useMemo(
    () =>
      Object.values(tasks).some(
        (t) => isBackgroundTask(t) && t.type !== "local_agent",
      ),
    [tasks],
  );
  const minCoordinatorIndex = hasBgTaskPill ? -1 : 0;
  // Clamp index when tasks complete and the list shrinks beneath the cursor
  useEffect(() => {
    if (coordinatorTaskIndex >= coordinatorTaskCount) {
      setCoordinatorTaskIndex(
        Math.max(minCoordinatorIndex, coordinatorTaskCount - 1),
      );
    } else if (coordinatorTaskIndex < minCoordinatorIndex) {
      setCoordinatorTaskIndex(minCoordinatorIndex);
    }
  }, [coordinatorTaskCount, coordinatorTaskIndex, minCoordinatorIndex]);
  const [isPasting, setIsPasting] = useState(false);
  const [isExternalEditorActive, setIsExternalEditorActive] = useState(false);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [showHistoryPicker, setShowHistoryPicker] = useState(false);
  const [showThinkingToggle, setShowThinkingToggle] = useState(false);
  const [showModeSwitcher, setShowModeSwitcher] = useState(false);
  const [showAutoModeOptIn, setShowAutoModeOptIn] = useState(false);
  const [autoModeOptInPreview, setAutoModeOptInPreview] = useState(false);
  const promptModalOverlayActive =
    upstreamModalOverlayActive ||
    showModeSwitcher ||
    showAutoModeOptIn ||
    autoModeOptInPreview ||
    Boolean(showBashesDialog);
  const promptKeyboardActive =
    composerInputEnabled && !promptModalOverlayActive;
  const displayedToolPermissionContext = useMemo(
    (): ToolPermissionContext =>
      autoModeOptInPreview
        ? { ...effectiveToolPermissionContext, mode: "auto" }
        : effectiveToolPermissionContext,
    [autoModeOptInPreview, effectiveToolPermissionContext],
  );
  const autoModeOptInPendingRef = useRef(false);
  const autoModeOptInTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const modeSwitcherTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const modeCycleKeybindingActive =
    composerInputEnabled &&
    !upstreamModalOverlayActive &&
    !Boolean(showBashesDialog) &&
    (promptKeyboardActive ||
      showModeSwitcher ||
      showAutoModeOptIn ||
      autoModeOptInPreview ||
      Boolean(autoModeOptInTimeoutRef.current));

  useEffect(
    () => () => {
      autoModeOptInPendingRef.current = false;
      if (autoModeOptInTimeoutRef.current) {
        clearTimeout(autoModeOptInTimeoutRef.current);
        autoModeOptInTimeoutRef.current = null;
      }
      if (modeSwitcherTimeoutRef.current) {
        clearTimeout(modeSwitcherTimeoutRef.current);
        modeSwitcherTimeoutRef.current = null;
      }
    },
    [],
  );

  // Check if cursor is on the first line of input
  const isCursorOnFirstLine = useMemo(() => {
    const firstNewlineIndex = input.indexOf("\n");
    if (firstNewlineIndex === -1) {
      return true; // No newlines, cursor is always on first line
    }
    return cursorOffset <= firstNewlineIndex;
  }, [input, cursorOffset]);
  const isCursorOnLastLine = useMemo(() => {
    const lastNewlineIndex = input.lastIndexOf("\n");
    if (lastNewlineIndex === -1) {
      return true; // No newlines, cursor is always on last line
    }
    return cursorOffset > lastNewlineIndex;
  }, [input, cursorOffset]);

  // Derive team info from teamContext (no filesystem I/O needed)
  // A session can only lead one team at a time
  const cachedTeams: TeamSummary[] = useMemo(() => {
    if (!isAgentSwarmsEnabled()) return [];
    // In-process mode uses Shift+Down/Up navigation instead of footer menu
    if (isInProcessEnabled()) return [];
    if (!teamContext) {
      return [];
    }
    const teammateCount = count(
      Object.values(teamContext.teammates),
      (t) => t.name !== "team-lead",
    );
    return [
      {
        name: teamContext.teamName,
        memberCount: teammateCount,
        runningCount: 0,
        idleCount: 0,
      },
    ];
  }, [teamContext]);

  // ─── Footer pill navigation ─────────────────────────────────────────────
  // Which pills render below the input box. Order here IS the nav order
  // (down/right = forward, up/left = back). The inline AGENT FLEET panel (the
  // `tasks` footer item + its ↓-to-manage entry) was removed, so it is no
  // longer offered here — background agents still run; only the panel UI is gone.
  const teamsFooterVisible = cachedTeams.length > 0;
  const footerItems = useMemo(
    () => [teamsFooterVisible && "teams"].filter(Boolean) as FooterItem[],
    [teamsFooterVisible],
  );

  // Effective selection: null if the selected pill stopped rendering (bridge
  // disconnected, task finished). The derivation makes the UI correct
  // immediately; the useEffect below clears the raw state so it doesn't
  // resurrect when the same pill reappears (new task starts → focus stolen).
  const rawFooterSelection = useAppState((s) => s.footerSelection);
  const footerItemSelected =
    rawFooterSelection && footerItems.includes(rawFooterSelection)
      ? rawFooterSelection
      : null;
  useEffect(() => {
    if (rawFooterSelection && !footerItemSelected) {
      setAppState((prev) =>
        prev.footerSelection === null
          ? prev
          : {
              ...prev,
              footerSelection: null,
            },
      );
    }
  }, [rawFooterSelection, footerItemSelected, setAppState]);
  const tasksSelected = footerItemSelected === "tasks";
  const teamsSelected = footerItemSelected === "teams";
  function selectFooterItem(item: FooterItem | null): void {
    setAppState((prev) =>
      prev.footerSelection === item
        ? prev
        : {
            ...prev,
            footerSelection: item,
          },
    );
    if (item === "tasks") {
      setTeammateFooterIndex(0);
      setCoordinatorTaskIndex(minCoordinatorIndex);
    }
  }

  // delta: +1 = down/right, -1 = up/left. Returns true if nav happened
  // (including deselecting at the start), false if at a boundary.
  function navigateFooter(delta: 1 | -1, exitAtStart = false): boolean {
    if (tasksSelected && !isTeammateMode && coordinatorTaskCount > 0) {
      if (delta > 0) {
        if (coordinatorTaskIndex < coordinatorTaskCount - 1) {
          setCoordinatorTaskIndex((i) =>
            Math.min(coordinatorTaskCount - 1, i + 1),
          );
          return true;
        }
        // Already at the last coordinator row; fall through so normal footer
        // navigation can move to the next visible footer item.
      }
      if (delta < 0 && coordinatorTaskIndex > minCoordinatorIndex) {
        setCoordinatorTaskIndex((i) => Math.max(minCoordinatorIndex, i - 1));
        return true;
      }
      if (delta < 0 && exitAtStart) {
        selectFooterItem(null);
        return true;
      }
      if (delta < 0) return false;
    }

    const idx = footerItemSelected
      ? footerItems.indexOf(footerItemSelected)
      : -1;
    const next = footerItems[idx + delta];
    if (next) {
      selectFooterItem(next);
      return true;
    }
    if (delta < 0 && exitAtStart) {
      selectFooterItem(null);
      return true;
    }
    return false;
  }

  // Prompt suggestion hook - reads suggestions generated by forked agent in query loop
  const {
    suggestion: promptSuggestion,
    markAccepted,
    logOutcomeAtSubmission,
    markShown,
  } = usePromptSuggestion({
    inputValue: input,
    isAssistantResponding: isLoading,
  });
  const displayedValue = useMemo(
    () =>
      isSearchingHistory && historyMatch
        ? getValueFromInput(
            typeof historyMatch === "string"
              ? historyMatch
              : historyMatch.display,
          )
        : input,
    [isSearchingHistory, historyMatch, input],
  );
  const thinkTriggers = useMemo(
    () => findThinkingTriggerPositions(displayedValue),
    [displayedValue],
  );
  const ultrareviewTriggers = useMemo(
    () =>
      isUltrareviewEnabled()
        ? findUltrareviewTriggerPositions(displayedValue)
        : [],
    [displayedValue],
  );
  const slashCommandTriggers = useMemo(() => {
    const positions = findSlashCommandPositions(displayedValue);
    // Only highlight valid commands
    return positions.filter((pos) => {
      const commandName = displayedValue.slice(pos.start + 1, pos.end); // +1 to skip "/"
      return hasCommand(commandName, commands);
    });
  }, [displayedValue, commands]);
  const tokenBudgetTriggers = useMemo(
    () =>
      feature("TOKEN_BUDGET") ? findTokenBudgetPositions(displayedValue) : [],
    [displayedValue],
  );
  const knownChannelsVersion = useSyncExternalStore(
    subscribeKnownChannels,
    getKnownChannelsVersion,
  );
  const slackChannelTriggers = useMemo(
    () =>
      hasSlackMcpServer(store.getState().mcp.clients)
        ? findSlackChannelPositions(displayedValue)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store is a stable ref
    [displayedValue, knownChannelsVersion],
  );

  // Find @name mentions and highlight with team member's color
  const memberMentionHighlights = useMemo((): Array<{
    start: number;
    end: number;
    themeColor: keyof Theme;
  }> => {
    if (!isAgentSwarmsEnabled()) return [];
    if (!teamContext?.teammates) return [];
    const highlights: Array<{
      start: number;
      end: number;
      themeColor: keyof Theme;
    }> = [];
    const members = teamContext.teammates;
    if (!members) return highlights;

    // Find all @name patterns in the input
    const regex = /(^|\s)@([\w-]+)/g;
    const memberValues = Object.values(members);
    let match;
    while ((match = regex.exec(displayedValue)) !== null) {
      const leadingSpace = match[1] ?? "";
      const nameStart = match.index + leadingSpace.length;
      const fullMatch = match[0].trimStart();
      const name = match[2];

      // Check if this name matches a team member
      const member = memberValues.find((t) => t.name === name);
      if (member?.color) {
        const themeColor =
          AGENT_COLOR_TO_THEME_COLOR[member.color as AgentColorName];
        if (themeColor) {
          highlights.push({
            start: nameStart,
            end: nameStart + fullMatch.length,
            themeColor,
          });
        }
      }
    }
    return highlights;
  }, [displayedValue, teamContext]);
  const imageRefPositions = useMemo(
    () =>
      parseReferences(displayedValue)
        .filter((r) => r.match.startsWith("[Image"))
        .map((r) => ({
          start: r.index,
          end: r.index + r.match.length,
        })),
    [displayedValue],
  );

  // chip.start is the "selected" state: the inverted chip IS the cursor.
  // chip.end stays a normal position so you can park the cursor right after
  // `]` like any other character.
  const cursorAtImageChip = imageRefPositions.some(
    (r) => r.start === cursorOffset,
  );

  // up/down movement or a fullscreen click can land the cursor strictly
  // inside a chip; snap to the nearer boundary so it's never editable
  // char-by-char.
  useEffect(() => {
    const inside = imageRefPositions.find(
      (r) => cursorOffset > r.start && cursorOffset < r.end,
    );
    if (inside) {
      const mid = (inside.start + inside.end) / 2;
      setCurrentCursorOffset(cursorOffset < mid ? inside.start : inside.end);
    }
  }, [cursorOffset, imageRefPositions, setCurrentCursorOffset]);
  const combinedHighlights = useMemo((): TextHighlight[] => {
    const highlights: TextHighlight[] = [];

    // Invert the [Image #N] chip when the cursor is at chip.start (the
    // "selected" state) so backspace-to-delete is visually obvious.
    for (const ref of imageRefPositions) {
      if (cursorOffset === ref.start) {
        highlights.push({
          start: ref.start,
          end: ref.end,
          color: undefined,
          inverse: true,
          priority: 8,
        });
      }
    }
    if (isSearchingHistory && historyMatch && !historyFailedMatch) {
      highlights.push({
        start: cursorOffset,
        end: cursorOffset + historyQuery.length,
        color: "warning",
        priority: 20,
      });
    }

    // Add /command highlighting (blue)
    for (const trigger of slashCommandTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: "suggestion",
        priority: 5,
      });
    }

    // Add token budget highlighting (blue)
    for (const trigger of tokenBudgetTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: "suggestion",
        priority: 5,
      });
    }
    for (const trigger of slackChannelTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: "suggestion",
        priority: 5,
      });
    }

    // Add @name highlighting with team member's color
    for (const mention of memberMentionHighlights) {
      highlights.push({
        start: mention.start,
        end: mention.end,
        color: mention.themeColor,
        priority: 5,
      });
    }

    // Rainbow highlighting for ultrathink keyword (per-character cycling colors)
    if (isUltrathinkEnabled()) {
      for (const trigger of thinkTriggers) {
        for (let i = trigger.start; i < trigger.end; i++) {
          highlights.push({
            start: i,
            end: i + 1,
            color: getRainbowColor(i - trigger.start),
            shimmerColor: getRainbowColor(i - trigger.start, true),
            priority: 10,
          });
        }
      }
    }

    // Same rainbow treatment for the ultrareview keyword
    for (const trigger of ultrareviewTriggers) {
      for (let i = trigger.start; i < trigger.end; i++) {
        highlights.push({
          start: i,
          end: i + 1,
          color: getRainbowColor(i - trigger.start),
          shimmerColor: getRainbowColor(i - trigger.start, true),
          priority: 10,
        });
      }
    }

    return highlights;
  }, [
    isSearchingHistory,
    historyQuery,
    historyMatch,
    historyFailedMatch,
    cursorOffset,
    imageRefPositions,
    memberMentionHighlights,
    slashCommandTriggers,
    tokenBudgetTriggers,
    slackChannelTriggers,
    displayedValue,
    thinkTriggers,
    ultrareviewTriggers,
  ]);
  const { addNotification, removeNotification } = useNotifications();

  // Show ultrathink notification
  useEffect(() => {
    if (thinkTriggers.length && isUltrathinkEnabled()) {
      addNotification({
        key: "ultrathink-active",
        text: "Effort set to high for this turn",
        priority: "immediate",
        timeoutMs: 5000,
      });
    } else {
      removeNotification("ultrathink-active");
    }
  }, [addNotification, removeNotification, thinkTriggers.length]);
  useEffect(() => {
    if (isUltrareviewEnabled() && ultrareviewTriggers.length) {
      addNotification({
        key: "ultrareview-active",
        text: "Run /ultrareview after AgenC finishes to review these changes in the cloud",
        priority: "immediate",
        timeoutMs: 5000,
      });
    } else {
      removeNotification("ultrareview-active");
    }
  }, [addNotification, removeNotification, ultrareviewTriggers.length]);

  // Track input length for stash hint
  const prevInputLengthRef = useRef(input.length);
  const peakInputLengthRef = useRef(input.length);

  // Dismiss stash hint when user makes any input change
  const dismissStashHint = useCallback(() => {
    removeNotification("stash-hint");
  }, [removeNotification]);

  // Show stash hint when user gradually clears substantial input
  useEffect(() => {
    const prevLength = prevInputLengthRef.current;
    const peakLength = peakInputLengthRef.current;
    const currentLength = input.length;
    prevInputLengthRef.current = currentLength;

    // Update peak when input grows
    if (currentLength > peakLength) {
      peakInputLengthRef.current = currentLength;
      return;
    }

    // Reset state when input is empty
    if (currentLength === 0) {
      peakInputLengthRef.current = 0;
      return;
    }

    // Detect gradual clear: peak was high, current is low, but this wasn't a single big jump
    // (rapid clears like esc-esc go from 20+ to 0 in one step)
    const clearedSubstantialInput = peakLength >= 20 && currentLength <= 5;
    const wasRapidClear = prevLength >= 20 && currentLength <= 5;
    if (clearedSubstantialInput && !wasRapidClear) {
      const config = getRuntimeState(runtimeStateRepository);
      if (!config.hasUsedStash) {
        addNotification({
          key: "stash-hint",
          jsx: (
            <Text dimColor>
              Tip:{" "}
              <ConfigurableShortcutHint
                action="chat:stash"
                context="Chat"
                fallback="ctrl+s"
                description="stash"
              />
            </Text>
          ),
          priority: "immediate",
          timeoutMs: FOOTER_TEMPORARY_STATUS_TIMEOUT,
        });
      }
      peakInputLengthRef.current = currentLength;
    }
  }, [input.length, addNotification]);

  // Initialize input buffer for undo functionality
  const { pushToBuffer, undo, canUndo, clearBuffer } = useInputBuffer({
    maxBufferSize: 50,
    debounceMs: 1000,
  });
  useMaybeTruncateInput({
    input,
    pastedContents,
    onInputChange: trackAndSetInput,
    setCursorOffset: setCurrentCursorOffset,
    setPastedContents: setPastedContentsAndRef,
  });
  const defaultPlaceholder = usePromptInputPlaceholder({
    input,
    submitCount,
    viewingAgentName,
    queueOwner,
  });
  const onChange = useCallback(
    (
      value: string,
      options?: {
        interpretShortcuts?: boolean;
      },
    ) => {
      const interpretShortcuts = options?.interpretShortcuts ?? true;
      const currentInput = lastInternalInputRef.current;
      const currentCursorOffset = cursorOffsetRef.current;
      const currentPastedContents = pastedContentsRef.current;
      if (
        onboardingInput === undefined &&
        interpretShortcuts &&
        value === "?"
      ) {
        setHelpOpen((v) => !v);
        return;
      }
      setHelpOpen(false);

      // Dismiss stash hint when user makes any input change
      dismissStashHint();

      // Cancel any pending prompt suggestion and speculation when user types
      abortPromptSuggestion();
      abortSpeculation(setAppState);

      // Strip the mode character from the buffer when entering bash mode — the
      // mode itself is shown via the prompt prefix in the UI. Without this,
      // typing `!` into empty input would enter bash mode but leave the literal
      // `!` in the buffer (issue #662).
      const modeEntry =
        onboardingInput === undefined && interpretShortcuts
          ? detectModeEntry({
              value,
              prevInputLength: currentInput.length,
              cursorOffset: currentCursorOffset,
            })
          : null;
      if (modeEntry) {
        setCurrentMode(modeEntry.mode);
        const cleaned = modeEntry.strippedValue.replaceAll("\t", "    ");
        pushToBuffer(currentInput, currentCursorOffset, currentPastedContents);
        trackAndSetInput(cleaned);
        setCurrentCursorOffset(cleaned.length);
        return;
      }
      const processedValue = value.replaceAll("\t", "    ");

      // Push current state to buffer before making changes
      if (currentInput !== processedValue) {
        pushToBuffer(currentInput, currentCursorOffset, currentPastedContents);
      }

      // Deselect footer items when user types
      setAppState((prev) =>
        prev.footerSelection === null
          ? prev
          : {
              ...prev,
              footerSelection: null,
            },
      );
      trackAndSetInput(processedValue);
    },
    [
      trackAndSetInput,
      setCurrentMode,
      pushToBuffer,
      dismissStashHint,
      setAppState,
      setCurrentCursorOffset,
      onboardingInput,
    ],
  );
  const {
    resetHistory,
    onHistoryUp,
    onHistoryDown,
    dismissSearchHint,
    historyIndex,
  } = useArrowKeyHistory(
    (
      value: string,
      historyMode: HistoryMode,
      pastedContents: Record<number, PastedContent>,
    ) => {
      onChange(value, {
        interpretShortcuts: false,
      });
      setCurrentMode(historyMode);
      setPastedContentsAndRef(pastedContents);
    },
    input,
    pastedContents,
    setCurrentCursorOffset,
    mode,
  );

  // Dismiss search hint when user starts searching
  useEffect(() => {
    if (isSearchingHistory) {
      dismissSearchHint();
    }
  }, [isSearchingHistory, dismissSearchHint]);

  // Only use history navigation when there are 0 or 1 slash command suggestions.
  // Footer nav is NOT here — when a pill is selected, TextInput focus=false so
  // these never fire. The Footer keybinding context handles ↑/↓ instead.
  function handleHistoryUp() {
    if (suggestions.length > 1) {
      return;
    }

    // Only navigate history when cursor is on the first line.
    // In multiline inputs, up arrow should move the cursor (handled by TextInput)
    // and only trigger history when at the top of the input.
    if (!isCursorOnFirstLine) {
      return;
    }

    // If there's an editable queued command, move it to the input for editing when UP is pressed
    const hasEditableCommand = queuedCommands.some(isQueuedCommandEditable);
    if (hasEditableCommand) {
      void popAllCommandsFromQueue();
      return;
    }
    onHistoryUp();
  }
  function handleHistoryDown() {
    if (suggestions.length > 1) {
      return;
    }

    // Only navigate history/footer when cursor is on the last line.
    // In multiline inputs, down arrow should move the cursor (handled by TextInput)
    // and only trigger navigation when at the bottom of the input.
    if (!isCursorOnLastLine) {
      return;
    }

    // At bottom of history → enter footer at first visible pill
    if (onHistoryDown() && footerItems.length > 0) {
      const first = footerItems[0]!;
      selectFooterItem(first);
      if (
        first === "tasks" &&
        !getRuntimeState(runtimeStateRepository).hasSeenTasksHint
      ) {
        updateRuntimeState((c) =>
          c.hasSeenTasksHint
            ? c
            : {
                ...c,
                hasSeenTasksHint: true,
              },
          runtimeStateRepository,
        );
      }
    }
  }

  // Create a suggestions state directly - we'll sync it with useTypeahead later
  const [suggestionsState, setSuggestionsStateRaw] = useState<{
    suggestions: SuggestionItem[];
    selectedSuggestion: number;
    commandArgumentHint?: string;
  }>({
    suggestions: [],
    selectedSuggestion: -1,
    commandArgumentHint: undefined,
  });

  // Setter for suggestions state
  const setSuggestionsState = useCallback(
    (
      updater:
        | typeof suggestionsState
        | ((prev: typeof suggestionsState) => typeof suggestionsState),
    ) => {
      setSuggestionsStateRaw((prev) =>
        typeof updater === "function" ? updater(prev) : updater,
      );
    },
    [],
  );
  const onSubmit = useCallback(
    async (inputParam: string, isSubmittingSlashCommand = false) => {
      inputParam = inputParam.trimEnd();
      const submissionMode = currentModeRef.current;

      // Don't submit if a footer indicator is being opened. Read fresh from
      // store — footer:openSelected calls selectFooterItem(null) then onSubmit
      // in the same tick, and the closure value hasn't updated yet. Apply the
      // same "still visible?" derivation as footerItemSelected so a stale
      // selection (pill disappeared) doesn't swallow Enter.
      const state = store.getState();
      const liveWorkspaceView = state.workbench?.activeWorkspaceView ?? "agent";
      // AppStateStore switches tabs synchronously, while this component's
      // render-owned input and pasted-content refs update on the following
      // React commit. Ignore Enter in that narrow handoff window: submitting
      // the old render against the new tab would splice one tab's draft or
      // attachments into the other. The next render/Enter owns one coherent
      // composer snapshot.
      if (liveWorkspaceView !== renderedWorkspaceView) {
        return;
      }
      const workbenchAttachments =
        isWorkbenchEnabled() && state.workbench
          ? composerAttachmentsForState(state.workbench)
          : [];
      const hasWorkbenchAttachments = workbenchAttachments.length > 0;
      const submissionWorkspaceView =
        state.workbench?.activeWorkspaceView ?? "agent";
      const submissionAttachmentIds = workbenchAttachments.map(
        (attachment) => attachment.id,
      );
      if (
        state.footerSelection &&
        footerItems.includes(state.footerSelection)
      ) {
        return;
      }

      // Enter in selection modes confirms selection (useBackgroundTaskNavigation).
      // BaseTextInput's useInput registers before that hook (child effects fire first),
      // so without this guard Enter would double-fire and auto-submit the suggestion.
      if (state.viewSelectionMode === "selecting-agent") {
        return;
      }

      if (submissionBlockedReason !== null) {
        onSubmissionBlocked?.(submissionBlockedReason);
        return;
      }
      if (
        isLoading &&
        state.workbench?.activeWorkspaceView === "editor" &&
        workbenchAttachments.some(
          (attachment) => attachment.editorInteraction !== undefined,
        )
      ) {
        addNotification({
          key: "busy-editor-interaction-preserved",
          text: "Finish or cancel the active turn before starting another editor interaction.",
          priority: "immediate",
          timeoutMs: 3000,
        });
        return;
      }

      // Check for images early - we need this for suggestion logic below
      const hasImages = Object.values(pastedContentsRef.current).some(
        (c) => c.type === "image",
      );

      // If input is empty OR matches the suggestion, submit it
      // But if there are images attached, don't auto-accept the suggestion -
      // the user wants to submit just the image(s).
      // Only in leader view — promptSuggestion is leader-context, not teammate.
      const suggestionText = promptSuggestionState.text;
      const inputMatchesSuggestion =
        inputParam.trim() === "" || inputParam === suggestionText;
      if (
        submissionMode === "prompt" &&
        onboardingInput === undefined &&
        inputMatchesSuggestion &&
        suggestionText &&
        !hasImages &&
        !hasWorkbenchAttachments &&
        !state.viewingAgentTaskId
      ) {
        // If speculation is active, inject messages immediately as they stream
        if (speculation.status === "active") {
          markAccepted();
          // skipReset: resetSuggestion would abort the speculation before we accept it
          logOutcomeAtSubmission(suggestionText, {
            skipReset: true,
          });
          void onSubmitProp(
            suggestionText,
            {
              setCursorOffset: setCurrentCursorOffset,
              clearBuffer,
              resetHistory,
            },
            {
              state: speculation,
              speculationSessionTimeSavedMs: speculationSessionTimeSavedMs,
              setAppState,
            },
            {
              vimRoutingState: {
                enabled: isVimModeEnabled(),
                mode: vimMode,
                keys: [],
              },
              pastedContentsOverride: { ...pastedContentsRef.current },
            },
          );
          return; // Skip normal query - speculation handled it
        }

        // Regular suggestion acceptance (requires shownAt > 0)
        if (promptSuggestionState.shownAt > 0) {
          markAccepted();
          inputParam = suggestionText;
        }
      }

      // Handle @name direct message
      if (
        submissionMode === "prompt" &&
        state.workbench?.activeWorkspaceView !== "editor" &&
        isAgentSwarmsEnabled()
      ) {
        const directMessage = parseDirectMemberMessage(inputParam);
        const directMessageRefs = directMessage
          ? parseReferences(inputParam)
          : [];
        const directMessageHasUnsupportedAttachments =
          hasWorkbenchAttachments ||
          directMessageRefs.some((ref) => {
            const content = pastedContentsRef.current[ref.id];
            return content?.type === "image" || ref.match.startsWith("[Image");
          });
        const directMessageRecipientExists =
          directMessage !== null &&
          teamContext !== undefined &&
          Object.values(teamContext.teammates ?? {}).some(
            (teammate) => teammate.name === directMessage.recipientName,
          );
        if (
          directMessage &&
          directMessageRecipientExists &&
          !directMessageHasUnsupportedAttachments
        ) {
          const directMessagePastedContents = pastedContentsRef.current;
          const directMessageText = expandPastedTextRefs(
            directMessage.message,
            directMessagePastedContents,
          );
          // Consume the Agent composer before mailbox I/O. Completion may happen
          // after the user has switched to Editor, where shared setters would
          // otherwise erase an unrelated draft.
          trackAndSetInput("");
          setCurrentCursorOffset(0);
          setPastedContentsAndRef({});
          clearBuffer();
          resetHistory();
          let result;
          try {
            result = await sendDirectMemberMessage(
              directMessage.recipientName,
              directMessageText,
              teamContext,
              writeToMailbox,
            );
          } catch (error) {
            if (restoreComposerDraftForView !== undefined) {
              restoreComposerDraftForView(submissionWorkspaceView, {
                input: inputParam,
                pastedContents: directMessagePastedContents,
              });
            } else if (
              (store.getState().workbench?.activeWorkspaceView ?? "agent") ===
              submissionWorkspaceView
            ) {
              trackAndSetInput(inputParam);
              setPastedContentsAndRef(directMessagePastedContents);
            }
            throw error;
          }
          if (result.success) {
            addNotification({
              key: "direct-message-sent",
              text: `Sent to @${result.recipientName}`,
              priority: "immediate",
              timeoutMs: 3000,
            });
            return;
          } else if (result.error === "no_team_context") {
            pastedContentsRef.current = directMessagePastedContents;
            // No team context - fall through to normal prompt submission
          } else {
            pastedContentsRef.current = directMessagePastedContents;
            // Unrecognized recipient - fall through to normal prompt submission
            // This allows e.g. "@utils explain this code" to be sent as a prompt
          }
        }
      }

      // Allow submission if there are images attached, even without text
      if (
        inputParam.trim() === "" &&
        !hasImages &&
        !hasWorkbenchAttachments &&
        onboardingInput?.allowEmptySubmit !== true
      ) {
        return;
      }

      // PromptInput UX: Check if suggestions dropdown is showing
      // For directory suggestions, allow submission (Tab is used for completion)
      const hasDirectorySuggestions =
        suggestionsState.suggestions.length > 0 &&
        suggestionsState.suggestions.every(
          (s) => s.description === "directory",
        );
      if (
        submissionMode === "prompt" &&
        suggestionsState.suggestions.length > 0 &&
        !isSubmittingSlashCommand &&
        !hasDirectorySuggestions
      ) {
        logForDebugging(
          `[onSubmit] early return: suggestions showing (count=${suggestionsState.suggestions.length})`,
        );
        return; // Don't submit, user needs to clear suggestions first
      }

      // Log suggestion outcome if one exists
      if (
        submissionMode === "prompt" &&
        promptSuggestionState.text &&
        promptSuggestionState.shownAt > 0
      ) {
        logOutcomeAtSubmission(inputParam);
      }

      // Clear stash hint notification on submit
      removeNotification("stash-hint");
      const submitInput = hasWorkbenchAttachments
        ? materializeAttachmentMentions(inputParam, workbenchAttachments)
        : inputParam;
      const capturedPastedContents = capturedAttachmentsToPastedContents(
        workbenchAttachments,
        allocatePasteId,
      );
      const hasCapturedAttachments =
        Object.keys(capturedPastedContents).length > 0;
      const submissionPastedContents = {
        ...pastedContentsRef.current,
        ...capturedPastedContents,
      };

      // Route input to viewed agent (in-process teammate or named local_agent).
      const activeAgent = getActiveAgentForInput(store.getState());
      if (
        submissionMode === "prompt" &&
        state.workbench?.activeWorkspaceView !== "editor" &&
        activeAgent.type !== "leader" &&
        onAgentSubmit
      ) {
        const agentSubmitInput = hasCapturedAttachments
          ? `${submitInput}\n\n${Object.values(capturedPastedContents)
              .sort((a, b) => a.id - b.id)
              .map((item) => item.content)
              .join("\n\n")}`
          : submitInput;
        await onAgentSubmit(agentSubmitInput, activeAgent.task, {
          setCursorOffset: setCurrentCursorOffset,
          clearBuffer,
          resetHistory,
        });
        if (hasWorkbenchAttachments) {
          setAppState((prev) =>
            applyWorkbenchCommand(prev, {
              type: "clearAttachments",
              workspaceView: submissionWorkspaceView,
              ids: submissionAttachmentIds,
            }),
          );
        }
        return;
      }

      if (
        applyBusyInputSubmissionPolicy({
          isLoading,
          mode: submissionMode,
          input: inputParam,
          addNotification,
          setInput: trackAndSetInput,
          setCursorOffset: setCurrentCursorOffset,
          clearBuffer,
          resetHistory,
          onModeChange: setCurrentMode,
          queueOwner,
          queueExecutionCwd,
        })
      ) {
        return;
      }

      // Bash mode never sends the command to the model. The App callback uses
      // the daemon-owned session shell bridge and writes durable transcript
      // events. Standalone callers retain the admitted in-process fallback.
      if (submissionMode === "bash") {
        const trimmedBash = inputParam.trim();
        if (trimmedBash === "") {
          return;
        }
        // Consume the originating composer synchronously, while it is still
        // the active tab. Waiting for a long-running command to settle before
        // clearing would erase a sibling tab's draft if the user switched
        // Agent ↔ Editor in the meantime.
        trackAndSetInput("");
        setCurrentCursorOffset(0);
        clearBuffer();
        resetHistory();
        setCurrentMode("prompt");
        let fallbackSubId = 0;
        try {
          if (onBashSubmit !== undefined) {
            await onBashSubmit(trimmedBash);
          } else {
            const ctx = getToolUseContext(
              getMessages(),
              [],
              new AbortController(),
              mainLoopModel,
            ) as PromptInputContext & {
              session?: {
                emit?: (event: unknown) => void;
                nextInternalSubId?: () => string;
              };
              setToolJSX?: (jsx: unknown) => void;
            };
            const session = ctx.session;
            const emit =
              typeof session?.emit === "function"
                ? session.emit.bind(session)
                : undefined;
            const nextId =
              typeof session?.nextInternalSubId === "function"
                ? session.nextInternalSubId.bind(session)
                : () => `bash-${Date.now()}-${fallbackSubId++}`;
            const emitTranscriptText = (text: string) => {
              emit?.({
                id: nextId(),
                msg: {
                  type: "user_message",
                  payload: { displayText: text, message: text },
                },
              });
            };
            emitTranscriptText(
              `<bash-input>${escapeXml(trimmedBash)}</bash-input>`,
            );
            const { processBashCommand } =
              await import("../../input/processBashCommand.js");
            const result = await processBashCommand(
              trimmedBash,
              [],
              [],
              ctx,
              ctx.setToolJSX ?? (() => {}),
            );
            for (const m of result.messages) {
              if (m?.type !== "user") continue;
              for (const text of extractUserMessageBashOutputTexts(m)) {
                emitTranscriptText(text);
              }
            }
          }
        } catch (err) {
          if (onBashSubmit === undefined) {
            // The fallback runner owns its transcript output; the App-owned
            // runner reports its own daemon-fence and shell failures.
            const ctx = getToolUseContext(
              getMessages(),
              [],
              new AbortController(),
              mainLoopModel,
            ) as PromptInputContext & {
              session?: {
                emit?: (event: unknown) => void;
                nextInternalSubId?: () => string;
              };
            };
            const session = ctx.session;
            const emit =
              typeof session?.emit === "function"
                ? session.emit.bind(session)
                : undefined;
            emit?.({
              id:
                typeof session?.nextInternalSubId === "function"
                  ? session.nextInternalSubId()
                  : `bash-${Date.now()}-${fallbackSubId++}`,
              msg: {
                type: "user_message",
                payload: {
                  displayText: `<bash-stderr>${escapeXml(err instanceof Error ? err.message : String(err))}</bash-stderr>`,
                  message: `<bash-stderr>${escapeXml(err instanceof Error ? err.message : String(err))}</bash-stderr>`,
                },
              },
            });
          }
        }
        return;
      }

      // Normal leader submission. Pass mode through the 4th options arg so
      // downstream consumers can branch on composer state (e.g. future
      // routing of memory mode without round-tripping through input
      // prefix). Bash mode is intercepted above and never reaches here.
      await onSubmitProp(
        submitInput,
        {
          setCursorOffset: setCurrentCursorOffset,
          clearBuffer,
          resetHistory,
        },
        undefined,
        {
          mode: submissionMode,
          vimRoutingState: {
            enabled: isVimModeEnabled(),
            mode: vimMode,
            keys: [],
          },
          // Always forward the exact render-owned snapshot, including an
          // empty object. Falling back to App's render-captured value lets an
          // old tab's pasted content bleed across a same-tick tab switch.
          pastedContentsOverride: submissionPastedContents,
          ...(hasWorkbenchAttachments
            ? {
                onWorkbenchAttachmentsAdmitted: () => {
                  setAppState((prev) =>
                    applyWorkbenchCommand(prev, {
                      type: "clearAttachments",
                      workspaceView: submissionWorkspaceView,
                      ids: submissionAttachmentIds,
                    }),
                  );
                },
              }
            : {}),
        },
      );
    },
    [
      promptSuggestionState,
      speculation,
      speculationSessionTimeSavedMs,
      teamContext,
      store,
      footerItems,
      suggestionsState.suggestions,
      onSubmitProp,
      onAgentSubmit,
      clearBuffer,
      resetHistory,
      logOutcomeAtSubmission,
      setAppState,
      markAccepted,
      removeNotification,
      vimMode,
      mode,
      getToolUseContext,
      getMessages,
      mainLoopModel,
      trackAndSetInput,
      setCurrentMode,
      isLoading,
      addNotification,
      setCurrentCursorOffset,
      setPastedContentsAndRef,
      onboardingInput,
      submissionBlockedReason,
      onSubmissionBlocked,
      renderedWorkspaceView,
    ],
  );
  const {
    suggestions,
    selectedSuggestion,
    suggestionType,
    commandArgumentHint,
    inlineGhostText,
    maxColumnWidth,
  } = useTypeahead({
    commands,
    onInputChange: trackAndSetInput,
    onSubmit,
    setCursorOffset: setCurrentCursorOffset,
    input,
    cursorOffset,
    mode,
    agents,
    setSuggestionsState,
    suggestionsState,
    suppressSuggestions:
      onboardingInput !== undefined || isSearchingHistory || historyIndex > 0,
    markAccepted,
    onModeChange: setCurrentMode,
    runtimeState,
    settingsAuthority,
  });

  // Track if prompt suggestion should be shown (computed later with terminal width).
  // Hidden in teammate view — suggestion is leader-context only.
  const showPromptSuggestion =
    onboardingInput === undefined &&
    shouldShowPromptSuggestionPlaceholder({
      mode,
      promptSuggestion,
      suggestionCount: suggestions.length,
      viewingAgentTaskId,
    });
  useEffect(() => {
    if (showPromptSuggestion) markShown();
  }, [showPromptSuggestion, markShown]);

  // If suggestion was generated but can't be shown due to timing, log suppression.
  // Exclude teammate view: markShown() is gated above, so shownAt stays 0 there —
  // but that's not a timing failure, the suggestion is valid when returning to leader.
  const shouldSuppressPromptSuggestion =
    onboardingInput === undefined &&
    shouldSuppressPromptSuggestionForTiming({
      promptSuggestionText: promptSuggestionState.text,
      visiblePromptSuggestion: promptSuggestion,
      shownAt: promptSuggestionState.shownAt,
      viewingAgentTaskId,
    });
  useEffect(() => {
    if (!shouldSuppressPromptSuggestion || !promptSuggestionState.text) return;
    logSuggestionSuppressed("timing", promptSuggestionState.text);
    setAppState((prev) => ({
      ...prev,
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null,
      },
    }));
  }, [shouldSuppressPromptSuggestion, promptSuggestionState.text, setAppState]);
  function onImagePaste(
    image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) {
    setCurrentMode("prompt");
    const pasteId = allocatePasteId();
    const newContent: PastedContent = {
      id: pasteId,
      type: "image",
      content: image,
      mediaType: mediaType || "image/png",
      // default to PNG if not provided
      filename: filename || "Pasted image",
      dimensions,
      sourcePath,
    };

    // Cache path immediately (fast) so links work on render
    cacheImagePath(newContent);

    // Store image to disk in background
    void storeImage(newContent);

    const bufferPastedContents = pastedContentsRef.current;

    // Update UI
    updatePastedContentsAndRef((prev) => ({
      ...prev,
      [pasteId]: newContent,
    }));
    // Multi-image paste calls onImagePaste in a loop. If the ref is already
    // armed, the previous pill's lazy space fires now (before this pill)
    // rather than being lost.
    const prefix = pendingSpaceAfterPillRef.current ? " " : "";
    insertTextAtCursor(prefix + formatImageRef(pasteId), bufferPastedContents);
    pendingSpaceAfterPillRef.current = true;
  }

  // Prune images whose [Image #N] placeholder is no longer in the input text.
  // Covers pill backspace, Ctrl+U, char-by-char deletion — any edit that drops
  // the ref. onImagePaste batches setPastedContents + insertTextAtCursor in the
  // same event, so this effect sees the placeholder already present.
  useEffect(() => {
    const referencedIds = new Set(
      parseReferences(lastInternalInputRef.current).map((r) => r.id),
    );
    updatePastedContentsAndRef((prev) => {
      const orphaned = Object.values(prev).filter(
        (c) => c.type === "image" && !referencedIds.has(c.id),
      );
      if (orphaned.length === 0) return prev;
      const next = {
        ...prev,
      };
      for (const img of orphaned) delete next[img.id];
      return next;
    });
  }, [input, updatePastedContentsAndRef]);
  function onTextPaste(rawText: string) {
    pendingSpaceAfterPillRef.current = false;
    const currentInput = lastInternalInputRef.current;
    const currentCursorOffset = cursorOffsetRef.current;
    // Clean up pasted text - strip ANSI escape codes and normalize line endings and tabs
    let text = stripAnsi(rawText).replace(/\r/g, "\n").replaceAll("\t", "    ");

    // Detect file paths from drag-and-drop and convert to @mentions.
    // When files are dragged into the terminal, the terminal sends their
    // absolute paths via bracketed paste. Image files are handled by the
    // image paste handler upstream; here we handle non-image files by
    // converting them to @mentions so they get attached on submit.
    const draggedPaths = extractDraggedFilePaths(text);
    if (draggedPaths.length > 0) {
      const mentions = draggedPaths
        .map((p) => (p.includes(" ") || p.includes(":") ? `@"${p}"` : `@${p}`))
        .join(" ");
      // Ensure spacing around the mention(s) relative to existing input
      const charBefore = currentInput[currentCursorOffset - 1];
      const prefix = charBefore && !/\s/.test(charBefore) ? " " : "";
      text = prefix + mentions + " ";
    }

    // Match typed/auto-suggest: `!cmd` pasted into empty input enters bash mode.
    if (currentInput.length === 0) {
      const pastedMode = getModeFromInput(text);
      if (pastedMode !== "prompt") {
        setCurrentMode(pastedMode);
        text = getValueFromInput(text);
      }
    }
    const numLines = getPastedTextRefNumLines(text);
    // Limit the number of lines to show in the input
    // If the overall layout is too high then Ink will repaint
    // the entire terminal.
    // The actual required height is dependent on the content, this
    // is just an estimate.
    const maxLines = pasteReferenceLineThreshold(rows);

    // Use special handling for long pasted text (>PASTE_THRESHOLD chars)
    // or if it exceeds the number of lines we want to show
    if (text.length > PASTE_THRESHOLD || numLines > maxLines) {
      const pasteId = allocatePasteId();
      const newContent: PastedContent = {
        id: pasteId,
        type: "text",
        content: text,
      };
      const bufferPastedContents = pastedContentsRef.current;
      updatePastedContentsAndRef((prev) => ({
        ...prev,
        [pasteId]: newContent,
      }));
      insertTextAtCursor(
        formatPastedTextRef(pasteId, numLines),
        bufferPastedContents,
      );
    } else {
      // For shorter pastes, just insert the text normally
      insertTextAtCursor(text);
    }
  }
  const lazySpaceInputFilter = useCallback(
    (input: string, key: Key): string => {
      if (!pendingSpaceAfterPillRef.current) return input;
      pendingSpaceAfterPillRef.current = false;
      if (isNonSpacePrintable(input, key)) return " " + input;
      return input;
    },
    [],
  );
  function insertTextAtCursor(
    text: string,
    bufferPastedContents = pastedContentsRef.current,
  ) {
    // Use refs for input/cursor so back-to-back calls in the same event
    // (e.g. onImagePaste loop for multiple dragged images) chain correctly
    // instead of each reading the same stale closure values.
    const currentInput = lastInternalInputRef.current;
    const currentOffset = cursorOffsetRef.current;
    pushToBuffer(currentInput, currentOffset, bufferPastedContents);
    const newInput =
      currentInput.slice(0, currentOffset) +
      text +
      currentInput.slice(currentOffset);
    trackAndSetInput(newInput);
    const newOffset = currentOffset + text.length;
    setCurrentCursorOffset(newOffset);
  }
  const doublePressEscFromEmpty = useDoublePress(
    () => {},
    () => onShowMessageSelector(),
  );

  // Function to get the queued command for editing. Returns true if commands were popped.
  const popAllCommandsFromQueue = useCallback((): boolean => {
    const result = popAllEditable(
      lastInternalInputRef.current,
      cursorOffsetRef.current,
      queueOwner === undefined
        ? undefined
        : (command) => queuedCommandOwnedByMount(command, queueOwner),
    );
    if (!result) {
      return false;
    }
    trackAndSetInput(result.text);
    setCurrentMode("prompt"); // Always prompt mode for queued commands
    setCurrentCursorOffset(result.cursorOffset);

    // Restore images from queued commands to pastedContents
    if (result.images.length > 0) {
      updatePastedContentsAndRef((prev) => {
        const newContents = {
          ...prev,
        };
        for (const image of result.images) {
          newContents[image.id] = image;
        }
        return newContents;
      });
    }
    return true;
  }, [trackAndSetInput, setCurrentMode, updatePastedContentsAndRef, queueOwner]);

  // Insert the at-mentioned reference (the file and, optionally, a line range) when
  // we receive an at-mentioned notification the IDE.
  const onIdeAtMentioned = function (atMentioned: IDEAtMentioned) {
    let atMentionedText: string;
    const relativePath = path.relative(getCwd(), atMentioned.filePath);
    if (atMentioned.lineStart && atMentioned.lineEnd) {
      atMentionedText =
        atMentioned.lineStart === atMentioned.lineEnd
          ? `@${relativePath}#L${atMentioned.lineStart} `
          : `@${relativePath}#L${atMentioned.lineStart}-${atMentioned.lineEnd} `;
    } else {
      atMentionedText = `@${relativePath} `;
    }
    // IDE events can arrive before the parent rerenders after a paste, so make
    // the spacing decision from the same fresh refs used for insertion.
    const currentInput = lastInternalInputRef.current;
    const currentOffset = cursorOffsetRef.current;
    const cursorChar = currentInput[currentOffset - 1] ?? " ";
    if (!/\s/.test(cursorChar)) {
      atMentionedText = ` ${atMentionedText}`;
    }
    pendingSpaceAfterPillRef.current = false;
    insertTextAtCursor(atMentionedText);
  };
  useIdeAtMentioned(mcpClients, onIdeAtMentioned);

  // Handler for chat:undo - undo last edit
  const handleUndo = useCallback(() => {
    if (canUndo) {
      const previousState = undo();
      if (previousState) {
        trackAndSetInput(previousState.text);
        setCurrentCursorOffset(previousState.cursorOffset);
        setPastedContentsAndRef(previousState.pastedContents);
      }
    }
  }, [
    canUndo,
    undo,
    trackAndSetInput,
    setPastedContentsAndRef,
    setCurrentCursorOffset,
  ]);

  // Handler for chat:newline - insert a newline at the cursor position
  const handleNewline = useCallback(() => {
    pendingSpaceAfterPillRef.current = false;
    insertTextAtCursor("\n");
  }, [insertTextAtCursor]);

  // Handler for chat:externalEditor - edit in $EDITOR
  const handleExternalEditor = useCallback(async () => {
    setIsExternalEditorActive(true);
    const currentInput = lastInternalInputRef.current;
    const currentCursorOffset = cursorOffsetRef.current;
    const currentPastedContents = pastedContentsRef.current;
    try {
      // Pass pastedContents to expand collapsed text references
      const result = await editPromptInEditor(
        currentInput,
        currentPastedContents,
      );
      if (result.error) {
        addNotification({
          key: "external-editor-error",
          text: result.error,
          color: "warning",
          priority: "high",
        });
      }
      if (result.content !== null && result.content !== currentInput) {
        // Push current state to buffer before making changes
        pushToBuffer(currentInput, currentCursorOffset, currentPastedContents);
        trackAndSetInput(result.content);
        setCurrentCursorOffset(result.content.length);
      }
    } catch (err) {
      if (err instanceof Error) {
        logError(err);
      }
      addNotification({
        key: "external-editor-error",
        text: `External editor failed: ${errorMessage(err)}`,
        color: "warning",
        priority: "high",
      });
    } finally {
      setIsExternalEditorActive(false);
    }
  }, [pushToBuffer, trackAndSetInput, addNotification, setCurrentCursorOffset]);

  // Handler for chat:stash - stash/unstash prompt
  const handleStash = useCallback(() => {
    const currentInput = lastInternalInputRef.current;
    const currentCursorOffset = cursorOffsetRef.current;
    const currentPastedContents = pastedContentsRef.current;
    if (currentInput.trim() === "" && stashedPrompt !== undefined) {
      // Pop stash when input is empty
      trackAndSetInput(stashedPrompt.text);
      setCurrentCursorOffset(stashedPrompt.cursorOffset);
      setPastedContentsAndRef(stashedPrompt.pastedContents);
      setStashedPrompt(undefined);
      pendingSpaceAfterPillRef.current = false;
    } else if (currentInput.trim() !== "") {
      // Push to stash (save text, cursor position, and pasted contents)
      setStashedPrompt({
        text: currentInput,
        cursorOffset: currentCursorOffset,
        pastedContents: currentPastedContents,
      });
      trackAndSetInput("");
      setCurrentCursorOffset(0);
      setPastedContentsAndRef({});
      pendingSpaceAfterPillRef.current = false;
      // Track usage for /discover and stop showing hint
      updateRuntimeState(
        (c) => {
          if (c.hasUsedStash) return c;
          return {
            ...c,
            hasUsedStash: true,
          };
        },
        runtimeStateRepository,
      );
    }
  }, [
    stashedPrompt,
    trackAndSetInput,
    setStashedPrompt,
    setPastedContentsAndRef,
    setCurrentCursorOffset,
  ]);

  // Handler for chat:dropQueuedInput - remove the most recently queued input
  // before it dispatches. Per-item queue control: deletes exactly one specific
  // queued item (the last one added) through the same store the dispatcher
  // drains, so a dropped item truly never sends. No-op (and no notification)
  // when nothing is queued.
  const handleDropQueuedInput = useCallback(() => {
    const removed = removeLastQueuedInput(
      queueOwner === undefined
        ? undefined
        : (command) => queuedCommandOwnedByMount(command, queueOwner),
    );
    if (removed === undefined) return;
    addNotification({
      key: "queued-input-dropped",
      text: "Removed last queued input",
      priority: "immediate",
      timeoutMs: 3000,
    });
  }, [addNotification, queueOwner]);

  // The shortcut and typed /model command share the App-owned command
  // context, so model selection cannot bypass daemon runtime authority.
  const handleModelPicker = useCallback(() => {
    void onOpenModelMenu?.();
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [helpOpen, onOpenModelMenu, setHelpOpen]);

  // Handler for chat:thinkingToggle - toggle thinking mode
  const handleThinkingToggle = useCallback(() => {
    setShowThinkingToggle((prev) => !prev);
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [helpOpen]);

  // Shows the mode-switcher toast and (re)arms its auto-dismiss timer.
  const showModeSwitcherToast = useCallback(() => {
    setShowModeSwitcher(true);
    if (modeSwitcherTimeoutRef.current) {
      clearTimeout(modeSwitcherTimeoutRef.current);
    }
    modeSwitcherTimeoutRef.current = setTimeout(
      (setVisible, timeoutRef) => {
        setVisible(false);
        timeoutRef.current = null;
      },
      FOOTER_TEMPORARY_STATUS_TIMEOUT,
      setShowModeSwitcher,
      modeSwitcherTimeoutRef,
    );
  }, []);

  const dismissModeSwitcherToast = useCallback(() => {
    if (modeSwitcherTimeoutRef.current) {
      clearTimeout(modeSwitcherTimeoutRef.current);
      modeSwitcherTimeoutRef.current = null;
    }
    setShowModeSwitcher(false);
  }, []);

  const clearAutoModeOptInPreview = useCallback(() => {
    autoModeOptInPendingRef.current = false;
    if (autoModeOptInTimeoutRef.current) {
      clearTimeout(autoModeOptInTimeoutRef.current);
      autoModeOptInTimeoutRef.current = null;
    }
    setShowAutoModeOptIn(false);
    setAutoModeOptInPreview(false);
  }, []);

  // Applies one specific permission mode. Shared by shift+tab cycling and
  // digit picks in the mode-switcher toast.
  const selectPermissionMode = useCallback((targetMode: PermissionMode) => {
    // When viewing a teammate, set their mode instead of the leader's
    if (isAgentSwarmsEnabled() && viewedTeammate && viewingAgentTaskId) {
      if (targetMode === "bypassPermissions") {
        addNotification({
          key: "teammate-bypass-consent-required",
          text:
            "bypassPermissions is unavailable for teammate mode changes because this control cannot collect exact cwd consent.",
          priority: "immediate",
          color: "warning",
          timeoutMs: 8000,
        });
        return;
      }
      const teammateTaskId = viewingAgentTaskId;
      setAppState((prev) => {
        const task = prev.tasks[teammateTaskId];
        if (!task || task.type !== "in_process_teammate") {
          return prev;
        }
        if (task.permissionMode === targetMode) {
          return prev;
        }
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [teammateTaskId]: {
              ...task,
              permissionMode: targetMode,
            },
          },
        };
      });
      if (helpOpen) {
        setHelpOpen(false);
      }
      return;
    }

    logForDebugging(
      `[auto-mode] selectPermissionMode: currentMode=${toolPermissionContext.mode} targetMode=${targetMode} isAutoModeAvailable=${toolPermissionContext.isAutoModeAvailable} previewPending=${autoModeOptInPreview} showAutoModeOptIn=${showAutoModeOptIn} timeoutPending=${!!autoModeOptInTimeoutRef.current}`,
    );
    showModeSwitcherToast();

    // Check if user is entering auto mode for the first time. Gated on the
    // persistent settings flag (hasAutoModeOptIn) rather than the broader
    // hasAutoModeOptInAnySource so that --enable-auto-mode users still see
    // the warning dialog once — the CLI flag should grant carousel access,
    // not bypass the safety text.
    let isEnteringAutoModeFirstTime = false;
    if (feature("TRANSCRIPT_CLASSIFIER")) {
      isEnteringAutoModeFirstTime =
        targetMode === "auto" &&
        toolPermissionContext.mode !== "auto" &&
        !autoModeOptInPendingRef.current &&
        !hasAutoModeOptIn() &&
        !viewingAgentTaskId; // Only show for primary agent, not subagents
    }
    if (feature("TRANSCRIPT_CLASSIFIER")) {
      if (isEnteringAutoModeFirstTime) {
        autoModeOptInPendingRef.current = true;
        setAutoModeOptInPreview(true);

        // Keep the preview local until the warning has been accepted. Calling
        // setToolPermissionContext here would update the local registry or send
        // a daemon permission RPC before consent.
        if (autoModeOptInTimeoutRef.current) {
          clearTimeout(autoModeOptInTimeoutRef.current);
        }
        autoModeOptInTimeoutRef.current = setTimeout(
          (setShowAutoModeOptIn, autoModeOptInTimeoutRef) => {
            setShowAutoModeOptIn(true);
            autoModeOptInTimeoutRef.current = null;
          },
          400,
          setShowAutoModeOptIn,
          autoModeOptInTimeoutRef,
        );
        if (helpOpen) {
          setHelpOpen(false);
        }
        return;
      }
    }

    // Re-selecting auto while its opt-in dialog is pending: the dialog owns
    // the decision; applying the transition here would bypass the consent.
    if (
      targetMode === "auto" &&
      (autoModeOptInPendingRef.current ||
        autoModeOptInPreview ||
        showAutoModeOptIn ||
        autoModeOptInTimeoutRef.current)
    ) {
      return;
    }

    // Moving to another mode cancels the preview. The live permission context
    // has not changed, so there is nothing to revert.
    if (feature("TRANSCRIPT_CLASSIFIER")) {
      if (
        autoModeOptInPreview ||
        showAutoModeOptIn ||
        autoModeOptInTimeoutRef.current
      ) {
        clearAutoModeOptInPreview();
      }
    }

    // Now that we know this is NOT the first-time auto mode path, apply the
    // transition side effects (e.g. strip dangerous permissions, activate
    // classifier) for the picked target.
    const preparedContext = transitionPermissionMode(
      toolPermissionContext.mode,
      targetMode,
      toolPermissionContext,
      { workspacePath: getCwd() },
    );

    if ("error" in preparedContext) {
      addNotification({
        key: "bypass-consent-required",
        text:
          "bypassPermissions needs explicit consent. Run /permissions accept-bypass first.",
        priority: "immediate",
        color: "warning",
        timeoutMs: 8000,
      });
      return;
    }

    setToolPermissionContext({
      ...preparedContext,
      mode: targetMode,
    });

    // If this is a teammate, update config.json so team lead sees the change
    syncTeammateMode(targetMode, teamContext?.teamName);

    // Close help tips if they're open when mode is selected
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [
    toolPermissionContext,
    teamContext,
    viewingAgentTaskId,
    viewedTeammate,
    setToolPermissionContext,
    helpOpen,
    showAutoModeOptIn,
    autoModeOptInPreview,
    showModeSwitcherToast,
    clearAutoModeOptInPreview,
    addNotification,
  ]);

  // Handler for chat:cycleMode - cycle through permission modes
  const handleCycleMode = useCallback(() => {
    // When viewing a teammate, cycle from their mode instead of the leader's
    if (isAgentSwarmsEnabled() && viewedTeammate && viewingAgentTaskId) {
      const teammateContext: ToolPermissionContext = {
        ...displayedToolPermissionContext,
        mode: viewedTeammate.permissionMode,
      };
      selectPermissionMode(
        getNextPermissionMode(teammateContext.mode, teammateContext),
      );
      return;
    }
    selectPermissionMode(
      getNextPermissionMode(
        displayedToolPermissionContext.mode,
        displayedToolPermissionContext,
      ),
    );
  }, [
    displayedToolPermissionContext,
    teamContext,
    viewedTeammate,
    viewingAgentTaskId,
    selectPermissionMode,
  ]);

  // Digit picks and esc-dismiss for the mode-switcher toast. Active only
  // while the toast is visible; digits index into the same visible-mode
  // order the ModeSwitcher renders, so display and picking cannot drift.
  useInput(
    (input, key) => {
      if (key.escape) {
        dismissModeSwitcherToast();
        return;
      }
      if (!/^[1-9]$/u.test(input)) return;
      const modes = visibleUserFacingModes(
        displayedToolPermissionContext.isBypassPermissionsModeAvailable,
        displayedToolPermissionContext.isAutoModeAvailable,
      );
      const targetMode = modes[Number.parseInt(input, 10) - 1];
      if (targetMode === undefined) return;
      // The live gate can lag the startup availability flag; picking auto
      // without the gate would make transitionPermissionMode throw.
      if (targetMode === "auto" && !isAutoModeGateEnabled()) return;
      selectPermissionMode(targetMode);
    },
    { isActive: showModeSwitcher },
  );

  // Handler for auto mode opt-in dialog acceptance
  const handleAutoModeOptInAccept = useCallback(() => {
    if (feature("TRANSCRIPT_CLASSIFIER")) {
      if (!autoModeOptInPendingRef.current) return;
      clearAutoModeOptInPreview();

      // Permission requests can update the context while the warning is open.
      // Apply the transition to the latest context so those updates survive.
      const latestContext = store.getState().toolPermissionContext;
      const strippedContext = transitionPermissionMode(
        latestContext.mode,
        "auto",
        latestContext,
      );
      setToolPermissionContext({
        ...strippedContext,
        mode: "auto",
      });

      // Close help tips if they're open when auto mode is enabled
      if (helpOpen) {
        setHelpOpen(false);
      }
    }
  }, [
    helpOpen,
    setHelpOpen,
    clearAutoModeOptInPreview,
    store,
    setToolPermissionContext,
  ]);

  // Handler for auto mode opt-in dialog decline
  const handleAutoModeOptInDecline = useCallback(() => {
    if (feature("TRANSCRIPT_CLASSIFIER")) {
      logForDebugging("[auto-mode] opt-in declined; clearing preview");
      clearAutoModeOptInPreview();
    }
  }, [clearAutoModeOptInPreview]);

  // Handler for chat:imagePaste - paste image from clipboard
  const handleImagePaste = useCallback(async () => {
    try {
      const imageData = await getImageFromClipboard();
      if (imageData) {
        onImagePaste(
          imageData.base64,
          imageData.mediaType,
          undefined,
          imageData.dimensions,
        );
      } else {
        const shortcutDisplay = getShortcutDisplay(
          "chat:imagePaste",
          "Chat",
          "ctrl+v",
        );
        const message = env.isSSH()
          ? "No image found in clipboard. You're SSH'd; try scp?"
          : `No image found in clipboard. Use ${shortcutDisplay} to paste images.`;
        addNotification({
          key: "no-image-in-clipboard",
          text: message,
          priority: "immediate",
          timeoutMs: 1000,
        });
      }
    } catch (err) {
      logError(err);
      addNotification({
        key: "image-paste-error",
        text: `Image paste failed: ${errorMessage(err)}`,
        color: "warning",
        priority: "high",
      });
    }
  }, [addNotification, onImagePaste]);

  // Register chat:submit with the shared handler registry instead of a local
  // useKeybindings hook. The top-level chord interceptor owns normal submit
  // routing, while Autocomplete's higher-priority Enter binding owns suggestion
  // confirmation whenever the picker is active.
  const keybindingContext = useOptionalKeybindingContext();
  useEffect(() => {
    if (!keybindingContext || !promptKeyboardActive) return;
    return keybindingContext.registerHandler({
      action: "chat:submit",
      context: "Chat",
      handler: () => {
        void onSubmit(lastInternalInputRef.current);
      },
    });
  }, [keybindingContext, promptKeyboardActive, onSubmit]);

  // Chat context keybindings for editing shortcuts
  // Note: history:previous/history:next are NOT handled here. They are passed as
  // onHistoryUp/onHistoryDown props to TextInput, so that useTextInput's
  // upOrHistoryUp/downOrHistoryDown can try cursor movement first and only
  // fall through to history when the cursor can't move further.
  const chatHandlers = useMemo(
    () => ({
      "chat:undo": handleUndo,
      "chat:newline": handleNewline,
      "chat:externalEditor": handleExternalEditor,
      "chat:stash": handleStash,
      "chat:dropQueuedInput": handleDropQueuedInput,
      ...(onOpenModelMenu === undefined
        ? {}
        : { "chat:modelPicker": handleModelPicker }),
      "chat:thinkingToggle": handleThinkingToggle,
      "chat:imagePaste": handleImagePaste,
    }),
    [
      handleUndo,
      handleNewline,
      handleExternalEditor,
      handleStash,
      handleDropQueuedInput,
      handleModelPicker,
      onOpenModelMenu,
      handleThinkingToggle,
      handleImagePaste,
    ],
  );
  useKeybindings(chatHandlers, {
    context: "Chat",
    isActive: promptKeyboardActive,
  });

  // Keep mode cycling active while its own status/dialog overlays are visible,
  // without re-enabling ordinary prompt editing behind those overlays.
  useKeybinding("chat:cycleMode", handleCycleMode, {
    context: "Chat",
    isActive: modeCycleKeybindingActive,
  });

  // Shift+↑ enters message-actions cursor. Separate isActive so ctrl+r search
  // doesn't leave stale isSearchingHistory on cursor-exit remount.
  useKeybinding("chat:messageActions", () => onMessageActionsEnter?.(), {
    context: "Chat",
    isActive: promptKeyboardActive && !isSearchingHistory,
  });

  // Handle help:dismiss keybinding (ESC closes help menu)
  // This is registered separately from Chat context so it has priority over
  // CancelRequestHandler when help menu is open
  useKeybinding(
    "help:dismiss",
    () => {
      setHelpOpen(false);
    },
    {
      context: "Help",
      isActive: composerInputEnabled && helpOpen,
    },
  );

  // Quick Open / Global Search. Hook calls are unconditional (Rules of Hooks);
  // the handler body is feature()-gated so the setState calls and component
  // references get tree-shaken in external builds.
  const quickSearchActive = feature("QUICK_SEARCH")
    ? promptKeyboardActive
    : false;
  useKeybinding(
    "app:quickOpen",
    () => {
      if (feature("QUICK_SEARCH")) {
        setShowQuickOpen(true);
        setHelpOpen(false);
      }
    },
    {
      context: "Global",
      isActive: quickSearchActive,
    },
  );
  useKeybinding(
    "app:globalSearch",
    () => {
      if (feature("QUICK_SEARCH")) {
        if (isWorkbenchEnabled()) {
          setAppState((prev) =>
            applyWorkbenchCommand(prev, {
              type: "openSearch",
              query: lastInternalInputRef.current.trim(),
            }),
          );
          setHelpOpen(false);
          return;
        }
        setShowGlobalSearch(true);
        setHelpOpen(false);
      }
    },
    {
      context: "Global",
      isActive: quickSearchActive,
    },
  );
  useKeybinding(
    "history:search",
    () => {
      if (feature("HISTORY_PICKER")) {
        setShowHistoryPicker(true);
        setHelpOpen(false);
      }
    },
    {
      context: "Global",
      isActive: feature("HISTORY_PICKER") ? promptKeyboardActive : false,
    },
  );

  // Handle Ctrl+C to abort speculation when idle (not loading)
  // CancelRequestHandler only handles Ctrl+C during active tasks
  useKeybinding(
    "app:interrupt",
    () => {
      abortSpeculation(setAppState);
    },
    {
      context: "Global",
      isActive: !isLoading && speculation.status === "active",
    },
  );

  // Footer indicator navigation keybindings. ↑/↓ live here (not in
  // handleHistoryUp/Down) because TextInput focus=false when a pill is
  // selected — its useInput is inactive, so this is the only path.
  useKeybindings(
    {
      "footer:up": () => {
        // ↑ scrolls within the coordinator task list before leaving the pill
        navigateFooter(-1, true);
      },
      "footer:down": () => {
        // Non-agent background tasks have no coordinator rows; keep ↓ as the
        // shortcut into the full task dialog in that case.
        if (tasksSelected && !isTeammateMode && coordinatorTaskCount === 0) {
          setShowBashesDialog(true);
          selectFooterItem(null);
          return;
        }
        navigateFooter(1);
      },
      "footer:next": () => {
        // Teammate mode: ←/→ cycles within the team member list
        if (tasksSelected && isTeammateMode) {
          const totalAgents = 1 + inProcessTeammates.length;
          setTeammateFooterIndex((prev) => (prev + 1) % totalAgents);
          return;
        }
        navigateFooter(1);
      },
      "footer:previous": () => {
        if (tasksSelected && isTeammateMode) {
          const totalAgents = 1 + inProcessTeammates.length;
          setTeammateFooterIndex(
            (prev) => (prev - 1 + totalAgents) % totalAgents,
          );
          return;
        }
        navigateFooter(-1);
      },
      "footer:openSelected": () => {
        if (viewSelectionMode === "selecting-agent") {
          return;
        }
        switch (footerItemSelected) {
          case "tasks":
            if (isTeammateMode) {
              // Enter switches to the selected agent's view
              if (teammateFooterIndex === 0) {
                exitTeammateView(setAppState);
              } else {
                const teammate = inProcessTeammates[teammateFooterIndex - 1];
                if (teammate) enterTeammateView(teammate.id, setAppState);
              }
            } else if (coordinatorTaskIndex === 0) {
              exitTeammateView(setAppState);
            } else if (coordinatorTaskIndex >= 1) {
              const task =
                getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1];
              if (task) enterTeammateView(task.id, setAppState);
            } else {
              setShowBashesDialog(true);
              selectFooterItem(null);
            }
            break;
          case "teams":
            setShowTeamsDialog(true);
            selectFooterItem(null);
            break;
        }
      },
      "footer:clearSelection": () => {
        selectFooterItem(null);
      },
      "footer:close": () => {
        if (tasksSelected && coordinatorTaskIndex >= 1) {
          const task = getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1];
          if (!task) return false;
          // When the selected row IS the viewed agent, 'x' types into the
          // steering input. Any other row — dismiss it.
          if (
            viewSelectionMode === "viewing-agent" &&
            task.id === viewingAgentTaskId
          ) {
            const currentInput = lastInternalInputRef.current;
            const currentOffset = cursorOffsetRef.current;
            onChange(
              currentInput.slice(0, currentOffset) +
                "x" +
                currentInput.slice(currentOffset),
            );
            setCurrentCursorOffset(currentOffset + 1);
            return;
          }
          stopOrDismissAgent(task.id, setAppState);
          if (task.status !== "running") {
            setCoordinatorTaskIndex((i) =>
              Math.max(minCoordinatorIndex, i - 1),
            );
          }
          return;
        }
        // Not handled — let 'x' fall through to type-to-exit
        return false;
      },
    },
    {
      context: "Footer",
      isActive: !!footerItemSelected && promptKeyboardActive,
    },
  );
  useInput((char, key, event) => {
    if (!composerInputEnabled) {
      return;
    }
    // Skip all input handling when a full-screen dialog is open. These dialogs
    // render via early return, but hooks run unconditionally — so without this
    // guard, Escape inside a dialog leaks to the double-press message-selector.
    if (
      showTeamsDialog ||
      showQuickOpen ||
      showGlobalSearch ||
      showHistoryPicker
    ) {
      return;
    }

    // Detect failed Alt shortcuts on macOS (Option key produces special characters)
    if (getPlatform() === "macos" && isMacosOptionChar(char)) {
      const shortcut = MACOS_OPTION_SPECIAL_CHARS[char];
      const terminalName = getNativeCSIuTerminalDisplayName();
      const jsx = terminalName ? (
        <Text dimColor>
          To enable {shortcut}, set <Text bold>Option as Meta</Text> in{" "}
          {terminalName} preferences (⌘,)
        </Text>
      ) : (
        <Text dimColor>
          Use backslash + Enter for multi-line input, or enable Option as Meta
          in terminal settings
        </Text>
      );
      addNotification({
        key: "option-meta-hint",
        jsx,
        priority: "immediate",
        timeoutMs: 5000,
      });
      // Don't return - let the character be typed so user sees the issue
    }

    // Footer navigation is handled via useKeybindings above (Footer context)

    // NOTE: ctrl+_, ctrl+g, ctrl+s are handled via Chat context keybindings above

    const currentInput = lastInternalInputRef.current;
    const currentOffset = cursorOffsetRef.current;

    // When the text composer is empty, Backspace removes the most recently
    // attached workbench context chip. Keep this in the keyboard handler:
    // insertTextAtCursor is also used by paste, quick-open, IDE, and editor
    // callbacks, none of which have a key event.
    if (
      currentInput.length === 0 &&
      key.backspace &&
      renderedWorkbenchAttachments.length > 0
    ) {
      const lastAttachment =
        renderedWorkbenchAttachments[renderedWorkbenchAttachments.length - 1];
      if (lastAttachment) {
        setAppState((prev) =>
          applyWorkbenchCommand(prev, {
            type: "removeAttachment",
            id: lastAttachment.id,
          }),
        );
        event.stopImmediatePropagation();
        return;
      }
    }

    // Type-to-exit footer: printable chars while a pill is selected refocus
    // the input and type the char. Nav keys are captured by useKeybindings
    // above, so anything reaching here is genuinely not a footer action.
    // onChange clears footerSelection, so no explicit deselect.
    if (
      footerItemSelected &&
      char &&
      !key.ctrl &&
      !key.meta &&
      !key.escape &&
      !key.return
    ) {
      onChange(
        currentInput.slice(0, currentOffset) +
          char +
          currentInput.slice(currentOffset),
      );
      setCurrentCursorOffset(currentOffset + char.length);
      return;
    }

    // Exit special modes when backspace/escape/delete/ctrl+u is pressed at cursor position 0
    if (
      currentOffset === 0 &&
      (key.escape || key.backspace || key.delete || (key.ctrl && char === "u"))
    ) {
      setCurrentMode("prompt");
      setHelpOpen(false);
    }

    // Exit help mode when backspace is pressed and input is empty
    if (helpOpen && currentInput === "" && (key.backspace || key.delete)) {
      setHelpOpen(false);
    }

    // esc is a little overloaded:
    // - when we're loading a response, it's used to cancel the request
    // - otherwise, it's used to show the message selector
    // - when double pressed, it's used to clear the input
    // - when input is empty, pop from command queue

    // Handle ESC key press
    if (key.escape) {
      // Abort active speculation
      if (speculation.status === "active") {
        abortSpeculation(setAppState);
        return;
      }

      // Close help menu if open
      if (helpOpen) {
        setHelpOpen(false);
        event.stopImmediatePropagation();
        return;
      }

      // Footer selection clearing is now handled via Footer context keybindings
      // (footer:clearSelection action bound to escape)
      // If a footer item is selected, let the Footer keybinding handle it
      if (footerItemSelected) {
        return;
      }

      // If there's an editable queued command, move it to the input for editing when ESC is pressed
      const hasEditableCommand = queuedCommands.some(isQueuedCommandEditable);
      if (hasEditableCommand) {
        void popAllCommandsFromQueue();
        return;
      }
      if (hasMessages && currentInput === "" && !isLoading) {
        doublePressEscFromEmpty();
      }
    }
    if (key.return && helpOpen) {
      setHelpOpen(false);
      event.stopImmediatePropagation();
      return;
    }
  });
  const swarmBanner = useSwarmBanner();

  // Show the effort notification only when the level CHANGES mid-session,
  // never on startup (UX request: the pinned bottom-right label read as a
  // permanent login/auth chip). The change itself flashes for 12s and then
  // clears; /effort confirms its own change.
  // Suppressed in brief/assistant mode — the value reflects the local
  // client's effort, not the connected agent's.
  const effortNotificationText = briefOwnsGap
    ? undefined
    : getEffortNotificationText(
        effortValue,
        mainLoopModel,
        remoteAuthSessionContext,
      );
  const prevEffortNotificationTextRef = useRef(effortNotificationText);
  useEffect(() => {
    const previous = prevEffortNotificationTextRef.current;
    prevEffortNotificationTextRef.current = effortNotificationText;
    if (previous === effortNotificationText) return;
    if (!effortNotificationText) {
      removeNotification("effort-level");
      return;
    }
    addNotification({
      key: "effort-level",
      text: effortNotificationText,
      priority: "high",
      timeoutMs: 12_000,
    });
  }, [effortNotificationText, addNotification, removeNotification]);
  const { columns, rows } = useTerminalSize();
  const workbenchFrameColumns = useContentWidth();
  const promptGlyphs = selectAgenCTuiGlyphs();
  const workbenchPermissionLabel =
    displayedToolPermissionContext.mode === "bypassPermissions"
      ? "YOLO"
      : permissionModeShortTitle(
          displayedToolPermissionContext.mode,
        ).toUpperCase();
  const workbenchPromptGlyph =
    viewingAgentName || mode !== "bash"
      ? displayedToolPermissionContext.mode === "bypassPermissions"
        ? promptGlyphs.promptBypass
        : promptGlyphs.pointer
      : "!";
  const textInputColumns =
    isWorkbenchComposer && workbenchFrameColumns !== null
      ? clampWorkbenchPromptTextInputColumns(
          workbenchFrameColumns,
          workbenchPermissionLabel,
          workbenchPromptGlyph,
          swarmMode,
        )
      : clampPromptTextInputColumns(columns);

  // POC: click-to-position-cursor. Mouse tracking is only enabled inside
  // <AlternateScreen>, so this is dormant in the normal main-screen TUI.
  // localCol/localRow are relative to the onClick Box's top-left; the Box
  // tightly wraps the text input so they map directly to (column, line)
  // branding-scan: allow TextCursor is the text-caret utility name.
  // in the TextCursor wrap model. MeasuredText.getOffsetFromPosition handles
  // wide chars, wrapped lines, and clamps past-end clicks to line end.
  const maxVisibleLines = calculatePromptMaxVisibleLines(
    rows,
    isFullscreen,
  );
  const handleInputClick = useCallback(
    (e: ClickEvent) => {
      // During history search the displayed text is historyMatch, not
      // input, and showCursor is false anyway — skip rather than
      // compute an offset against the wrong string.
      if (!input || isSearchingHistory) return;
      // branding-scan: allow TextCursor is the text-caret utility name.
      const c = TextCursor.fromText(input, textInputColumns, cursorOffset);
      const viewportStart = c.getViewportStartLine(maxVisibleLines);
      const offset = c.measuredText.getOffsetFromPosition({
        line: e.localRow + viewportStart,
        column: e.localCol,
      });
      setCurrentCursorOffset(offset);
    },
    [
      input,
      textInputColumns,
      isSearchingHistory,
      cursorOffset,
      maxVisibleLines,
      setCurrentCursorOffset,
    ],
  );
  const handleOpenTasksDialog = useCallback(
    (taskId?: string) => setShowBashesDialog(taskId ?? true),
    [setShowBashesDialog],
  );
  // Suppress the placeholder while pasting so the input row stays empty
  // while the footer shows "Pasting text…". Otherwise both dim hints
  // (the input placeholder + the paste toast) paint together for one
  // frame and compete for attention.
  const placeholder = isPasting
    ? undefined
    : onboardingInput !== undefined
      ? onboardingInput.placeholder
      : showPromptSuggestion && promptSuggestion
        ? promptSuggestion
        : defaultPlaceholder;

  // Calculate if input has multiple lines
  const isInputWrapped = useMemo(() => input.includes("\n"), [input]);

  // Memoized callbacks for thinking toggle
  const handleThinkingSelect = useCallback(
    (enabled: boolean) => {
      setAppState((prev) => ({
        ...prev,
        thinkingEnabled: enabled,
      }));
      setShowThinkingToggle(false);
      addNotification({
        key: "thinking-toggled-hotkey",
        jsx: (
          <Text color={enabled ? "suggestion" : undefined} dimColor={!enabled}>
            Thinking {enabled ? "on" : "off"}
          </Text>
        ),
        priority: "immediate",
        timeoutMs: 3000,
      });
    },
    [setAppState, addNotification],
  );
  const handleThinkingCancel = useCallback(() => {
    setShowThinkingToggle(false);
  }, []);

  // Memoize the thinking toggle element
  const thinkingToggleElement = useMemo(() => {
    if (!showThinkingToggle) return null;
    return (
      <Box flexDirection="column" marginTop={1}>
        <ThinkingToggle
          currentValue={thinkingEnabled ?? true}
          onSelect={handleThinkingSelect}
          onCancel={handleThinkingCancel}
          isMidConversation={isMidConversation}
        />
      </Box>
    );
  }, [
    showThinkingToggle,
    thinkingEnabled,
    handleThinkingSelect,
    handleThinkingCancel,
    isMidConversation,
  ]);
  const modeSwitcherElement = useMemo(() => {
    if (!showModeSwitcher) return null;
    return (
      <ModeSwitcher
        currentMode={displayedToolPermissionContext.mode}
        bypassAvailable={
          displayedToolPermissionContext.isBypassPermissionsModeAvailable
        }
        autoAvailable={displayedToolPermissionContext.isAutoModeAvailable}
      />
    );
  }, [showModeSwitcher, displayedToolPermissionContext]);
  const backgroundTasksDialogElement = useMemo(() => {
    if (!showBashesDialog) return null;
    return (
      <BackgroundTasksPanel
        onDone={() => setShowBashesDialog(false)}
        toolUseContext={getToolUseContext(
          getMessages(),
          [],
          new AbortController(),
          mainLoopModel,
        )}
        initialDetailTaskId={
          typeof showBashesDialog === "string" ? showBashesDialog : undefined
        }
      />
    );
  }, [
    showBashesDialog,
    setShowBashesDialog,
    getToolUseContext,
    getMessages,
    mainLoopModel,
  ]);

  // Portal dialog to DialogOverlay in fullscreen so it escapes the bottom
  // slot's overflowY:hidden clip (same pattern as SuggestionsOverlay).
  // Must be called before early returns below to satisfy rules-of-hooks.
  // Memoized so the portal useEffect doesn't churn on every PromptInput render.
  const autoModeOptInDialog = useMemo(
    () =>
      feature("TRANSCRIPT_CLASSIFIER") && showAutoModeOptIn ? (
        <AutoModeOptInDialog
          onAccept={handleAutoModeOptInAccept}
          onDecline={handleAutoModeOptInDecline}
        />
      ) : null,
    [showAutoModeOptIn, handleAutoModeOptInAccept, handleAutoModeOptInDecline],
  );
  const fullscreenPromptDialog = isFullscreen
    ? (backgroundTasksDialogElement ??
      modeSwitcherElement ??
      autoModeOptInDialog)
    : null;
  useSetPromptOverlayDialog(fullscreenPromptDialog);
  useRegisterOverlay("prompt-overlay-dialog", fullscreenPromptDialog !== null);
  if (showBashesDialog && !isFullscreen) {
    return backgroundTasksDialogElement;
  }
  if (isAgentSwarmsEnabled() && showTeamsDialog) {
    return (
      <TeamsDialog
        initialTeams={cachedTeams}
        onDone={() => {
          setShowTeamsDialog(false);
        }}
      />
    );
  }
  if (feature("QUICK_SEARCH")) {
    const insertWithSpacing = (text: string) => {
      const currentInput = lastInternalInputRef.current;
      const currentOffset = cursorOffsetRef.current;
      const cursorChar = currentInput[currentOffset - 1] ?? " ";
      pendingSpaceAfterPillRef.current = false;
      insertTextAtCursor(/\s/.test(cursorChar) ? text : ` ${text}`);
    };
    if (showQuickOpen) {
      return (
        <QuickOpenDialog
          onDone={() => setShowQuickOpen(false)}
          onInsert={insertWithSpacing}
          settingsAuthority={settingsAuthority}
        />
      );
    }
    if (showGlobalSearch) {
      return (
        <GlobalSearchDialog
          onDone={() => setShowGlobalSearch(false)}
          onInsert={insertWithSpacing}
        />
      );
    }
  }
  if (feature("HISTORY_PICKER") && showHistoryPicker) {
    return (
      <HistorySearchDialog
        initialQuery={lastInternalInputRef.current}
        onSelect={(entry) => {
          const entryMode = getModeFromInput(entry.display);
          const value = getValueFromInput(entry.display);
          setCurrentMode(entryMode);
          trackAndSetInput(value);
          setPastedContentsAndRef(entry.pastedContents);
          setCurrentCursorOffset(value.length);
          setShowHistoryPicker(false);
        }}
        onCancel={() => setShowHistoryPicker(false)}
      />
    );
  }

  if (thinkingToggleElement) {
    return thinkingToggleElement;
  }
  const baseProps: BaseTextInputProps = {
    multiline: true,
    onSubmit,
    onChange,
    value:
      isSearchingHistory && historyMatch
        ? getValueFromInput(
            typeof historyMatch === "string"
              ? historyMatch
              : historyMatch.display,
          )
        : input,
    // History navigation is handled via TextInput props (onHistoryUp/onHistoryDown),
    // NOT via useKeybindings. This allows useTextInput's upOrHistoryUp/downOrHistoryDown
    // to try cursor movement first and only fall through to history navigation when the
    // cursor can't move further (important for wrapped text and multi-line input).
    onHistoryUp: onboardingInput === undefined ? handleHistoryUp : undefined,
    onHistoryDown:
      onboardingInput === undefined ? handleHistoryDown : undefined,
    onHistoryReset: resetHistory,
    placeholder,
    onExit,
    onExitMessage: (show, key) =>
      setExitMessage({
        show,
        key,
      }),
    onImagePaste,
    columns: textInputColumns,
    maxVisibleLines,
    disableCursorMovementForUpDownKeys:
      suggestions.length > 0 || !!footerItemSelected,
    disableEscapeDoublePress: suggestions.length > 0,
    cursorOffset,
    onChangeCursorOffset: setCurrentCursorOffset,
    onPaste: onTextPaste,
    onIsPastingChange: setIsPasting,
    focus:
      composerInputEnabled &&
      !isSearchingHistory &&
      !promptModalOverlayActive &&
      !footerItemSelected,
    showCursor:
      composerInputEnabled &&
      !footerItemSelected &&
      !isSearchingHistory &&
      !cursorAtImageChip,
    argumentHint: commandArgumentHint,
    onUndo: canUndo
      ? () => {
          const previousState = undo();
          if (previousState) {
            trackAndSetInput(previousState.text);
            setCurrentCursorOffset(previousState.cursorOffset);
            setPastedContentsAndRef(previousState.pastedContents);
          }
        }
      : undefined,
    highlights: combinedHighlights,
    inlineGhostText,
    inputFilter: lazySpaceInputFilter,
  };
  const getBorderColor = (): keyof Theme => {
    if (onboardingInput !== undefined) {
      return "agenc";
    }
    const modeColors: Record<string, keyof Theme> = {
      bash: "worker",
    };

    // Mode colors take priority, then teammate color, then default
    if (modeColors[mode]) {
      return modeColors[mode];
    }

    // In-process teammates run headless - don't apply teammate colors to leader UI
    if (isInProcessTeammate()) {
      return "lineSoft";
    }

    // Check for teammate color from environment
    const teammateColorName = getTeammateColor();
    if (
      teammateColorName &&
      AGENT_COLORS.includes(teammateColorName as AgentColorName)
    ) {
      return AGENT_COLOR_TO_THEME_COLOR[teammateColorName as AgentColorName];
    }
    return "lineSoft";
  };
  if (isExternalEditorActive) {
    return (
      <Box
        flexDirection="row"
        alignItems="center"
        justifyContent="center"
        width="100%"
        paddingX={1}
        backgroundColor="surfaceBackground"
        opaque
      >
        <Text dimColor italic>
          Save and close editor to continue...
        </Text>
      </Box>
    );
  }
  const textInputElement = (
    <ConfiguredPromptTextInput
      baseProps={baseProps}
      vimMode={vimMode}
      onVimModeChange={setVimMode}
    />
  );
  return (
    <Box
      flexDirection="column"
      marginTop={isWorkbenchComposer || briefOwnsGap ? 0 : 1}
      paddingBottom={isWorkbenchComposer ? 1 : 0}
      backgroundColor="surfaceBackground"
      opaque
    >
      {!isFullscreen && (
        <PromptInputQueuedCommands queueOwner={queueOwner} />
      )}
      {hasSuppressedDialogs && (
        <Box marginTop={1} marginLeft={2}>
          <Text dimColor>Waiting for permission…</Text>
        </Box>
      )}
      <PromptInputStashNotice hasStash={stashedPrompt !== undefined} />
      {renderedWorkbenchAttachments.length > 0 ? (
        <WorkbenchAttachmentChips
          attachments={renderedWorkbenchAttachments}
          onRemove={(id) => {
            setAppState((prev) =>
              applyWorkbenchCommand(prev, {
                type: "removeAttachment",
                id,
              }),
            );
          }}
        />
      ) : null}
      {swarmBanner ? (
        <>
          <Text color={swarmBanner.bgColor}>
            {swarmBanner.text ? (
              <>
                {promptGlyphs.horizontal.repeat(
                  Math.max(0, columns - stringWidth(swarmBanner.text) - 4),
                )}
                <Text backgroundColor={swarmBanner.bgColor} color="inverseText">
                  {" "}
                  {swarmBanner.text}{" "}
                </Text>
                {promptGlyphs.horizontal.repeat(2)}
              </>
            ) : (
              promptGlyphs.horizontal.repeat(columns)
            )}
          </Text>
          <Box flexDirection="row" width="100%">
            <PromptInputModeIndicator
              mode={mode}
              permissionMode={displayedToolPermissionContext.mode}
              isLoading={isLoading}
              viewingAgentName={viewingAgentName}
              viewingAgentColor={viewingAgentColor}
            />
            <Box flexGrow={1} flexShrink={1} onClick={handleInputClick}>
              {textInputElement}
            </Box>
          </Box>
          <Text color={swarmBanner.bgColor}>
            {promptGlyphs.horizontal.repeat(columns)}
          </Text>
        </>
      ) : (
        <Box
          flexDirection="row"
          alignItems="flex-start"
          justifyContent="flex-start"
          borderColor={isWorkbenchComposer ? undefined : "text"}
          borderStyle={isWorkbenchComposer ? undefined : "single"}
          width="100%"
          paddingX={isWorkbenchComposer ? 2 : 1}
          backgroundColor="surfaceBackground"
          opaque
        >
          {isWorkbenchComposer ? (
            <>
              <Text color="inverseText" backgroundColor="text" bold>
                {` ${workbenchPermissionLabel} `}
              </Text>
              {swarmMode ? (
                <>
                  <Box width={2} flexShrink={0} />
                  <Text color="text" bold>
                    ◆ SWARM
                  </Text>
                </>
              ) : null}
              <Box width={2} flexShrink={0} />
            </>
          ) : null}
          <PromptInputModeIndicator
            mode={mode}
            permissionMode={displayedToolPermissionContext.mode}
            isLoading={isLoading}
            viewingAgentName={viewingAgentName}
            viewingAgentColor={viewingAgentColor}
          />
          <Box flexGrow={1} flexShrink={1} onClick={handleInputClick}>
            {textInputElement}
          </Box>
        </Box>
      )}
      {onboardingInput === undefined &&
      !isFullscreen &&
      modeSwitcherElement ? (
        <Box flexDirection="column" marginTop={1}>
          {modeSwitcherElement}
        </Box>
      ) : null}
      {/* Round-2 M-NEW6: don't hide "? for shortcuts" on the first
          keystroke — the hint is about discovering keybindings, not
          about typing. Suppress it only when an active dropdown (the
          slash command picker / @-mention list) needs the same row,
          which the suggestions branch in PromptInputFooter handles
          via its own early return. */}
      {onboardingInput !== undefined ? (
        <Box paddingX={2}>
          <Text dimColor>{onboardingInput.footerHint}</Text>
        </Box>
      ) : isWorkbenchComposer &&
        suggestions.length === 0 &&
        !helpOpen &&
        !exitMessage.show ? null : (
        <PromptInputFooter
          apiKeyStatus={apiKeyStatus}
          remoteAuthSessionContext={remoteAuthSessionContext}
          debug={debug}
          exitMessage={exitMessage}
          vimMode={isVimModeEnabled() ? vimMode : undefined}
          mode={mode}
          autoUpdaterResult={autoUpdaterResult}
          isAutoUpdating={isAutoUpdating}
          verbose={verbose}
          onAutoUpdaterResult={onAutoUpdaterResult}
          onChangeIsUpdating={setIsAutoUpdating}
          suggestions={suggestions}
          selectedSuggestion={selectedSuggestion}
          suggestionType={suggestionType}
          maxColumnWidth={maxColumnWidth}
          toolPermissionContext={displayedToolPermissionContext}
          helpOpen={helpOpen}
          suppressHint={false}
          isLoading={isLoading}
          tasksSelected={tasksSelected}
          teamsSelected={teamsSelected}
          teammateFooterIndex={teammateFooterIndex}
          ideSelection={ideSelection}
          mcpClients={mcpClients}
          isPasting={isPasting}
          isInputWrapped={isInputWrapped}
          getMessages={getMessages}
          lastAssistantMessageId={lastAssistantMessageId}
          isSearching={isSearchingHistory}
          historyQuery={historyQuery}
          setHistoryQuery={setHistoryQuery}
          historyFailedMatch={historyFailedMatch}
          onOpenTasksDialog={
            isFullscreen ? handleOpenTasksDialog : undefined
          }
          runtimeState={runtimeState}
        />
      )}
      {onboardingInput !== undefined || isFullscreen
        ? null
        : autoModeOptInDialog}
      {onboardingInput === undefined && isFullscreen ? (
        // position=absolute takes zero layout height so the spinner
        // doesn't shift when a notification appears/disappears. Yoga
        // anchors absolute children at the parent's content-box origin;
        // marginTop=-1 pulls it into the marginTop=1 gap row above the
        // prompt border. In brief mode there is no such gap (briefOwnsGap
        // strips our marginTop) and BriefSpinner sits flush against the
        // border — marginTop=-2 skips over the spinner content into
        // BriefSpinner's own marginTop=1 blank row. height=1 +
        // overflow=hidden clips multi-line notifications to a single row.
        // flex-end anchors the bottom line so the visible row is always
        // the most recent. Suppressed while the slash overlay or
        // auto-mode opt-in dialog is up by height=0 (NOT unmount) — this
        // Box renders later in tree order so it would paint over their
        // bottom row. Keeping Notifications mounted prevents AutoUpdater's
        // initial-check effect from re-firing on every slash-completion
        // toggle (PR#22413).
        <Box
          position="absolute"
          marginTop={briefOwnsGap ? -2 : -1}
          height={suggestions.length === 0 && !showAutoModeOptIn ? 1 : 0}
          width="100%"
          paddingLeft={2}
          paddingRight={1}
          flexDirection="column"
          justifyContent="flex-end"
          overflow="hidden"
          backgroundColor="surfaceBackground"
          opaque
        >
          <Notifications
            apiKeyStatus={apiKeyStatus}
            remoteAuthSessionContext={remoteAuthSessionContext}
            autoUpdaterResult={autoUpdaterResult}
            debug={debug}
            isAutoUpdating={isAutoUpdating}
            verbose={verbose}
            getMessages={getMessages}
            lastAssistantMessageId={lastAssistantMessageId}
            onAutoUpdaterResult={onAutoUpdaterResult}
            onChangeIsUpdating={setIsAutoUpdating}
            ideSelection={ideSelection}
            mcpClients={mcpClients}
            isInputWrapped={isInputWrapped}
          />
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Compute the next paste ID after every ID already visible to the current
 * prompt, including resumed messages and restored draft paste references.
 */
export function getNextPasteIdAfter(
  messages: Message[],
  pastedContents: Record<number, PastedContent> = {},
  input = "",
): number {
  let maxId = 0;
  const scanReferences = (text: string) => {
    const refs = parseReferences(text);
    for (const ref of refs) {
      if (ref.id > maxId) maxId = ref.id;
    }
  };
  for (const message of messages) {
    if (message.type === "user") {
      // Check image paste IDs
      if (message.imagePasteIds) {
        for (const id of message.imagePasteIds) {
          if (id > maxId) maxId = id;
        }
      }
      // Check text paste references in message content
      if (typeof message.message.content === "string") {
        scanReferences(message.message.content);
      } else if (Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === "text") {
            scanReferences(block.text);
          }
        }
      }
    }
  }
  scanReferences(input);
  for (const [key, content] of Object.entries(pastedContents)) {
    const keyId = Number(key);
    if (Number.isFinite(keyId) && keyId > maxId) maxId = keyId;
    if (content.id > maxId) maxId = content.id;
  }
  return maxId + 1;
}
function isBashOutputText(text: string): boolean {
  return text.startsWith("<bash-stdout") || text.startsWith("<bash-stderr");
}
function extractUserMessageBashOutputTexts(m: unknown): string[] {
  const content =
    (m as { message?: { content?: unknown }; content?: unknown }).message
      ?.content ?? (m as { content?: unknown }).content;
  if (typeof content === "string")
    return isBashOutputText(content) ? [content] : [];
  if (!Array.isArray(content)) return [];
  const outputs: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      if (isBashOutputText(block.text)) {
        outputs.push(block.text);
      }
    }
  }
  return outputs;
}
function WorkbenchAttachmentChips({
  attachments,
  onRemove,
}: {
  readonly attachments: readonly WorkbenchAttachment[];
  readonly onRemove: (id: string) => void;
}): React.ReactElement {
  return (
    <Box
      flexDirection="row"
      flexWrap="wrap"
      paddingX={2}
      columnGap={1}
      backgroundColor="surfaceBackground"
    >
      {attachments.map((attachment) => {
        const captured = isCapturedWorkbenchAttachment(attachment);
        const suffix =
          captured && attachment.dirty
            ? " · unsaved snapshot"
            : captured
              ? " · editor snapshot"
              : "";
        return (
          <Box
            key={attachment.id}
            flexShrink={1}
            onClick={(event) => {
              event.stopImmediatePropagation();
              onRemove(attachment.id);
            }}
          >
            <Text
              color={captured ? "suggestion" : "inactive"}
              wrap="truncate-end"
            >
              {`[${attachment.label}${suffix} ×]`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export default React.memo(PromptInput);
