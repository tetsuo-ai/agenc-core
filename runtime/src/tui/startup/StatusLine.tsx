import { feature } from 'bun:bundle';
import * as React from 'react';
import { memo, useCallback, useEffect, useRef } from 'react';
import { logEvent } from '../../agenc/upstream/services/analytics/index.js';
import { getRawUtilization } from '../../agenc/upstream/services/agencAiLimitsHook.js';
import { getIsRemoteMode, getKairosActive, getMainThreadAgentType, getOriginalCwd, getSdkBetas, getSessionId } from '../../agenc/upstream/bootstrap/state.js';
import { DEFAULT_OUTPUT_STYLE_NAME } from '../../agenc/upstream/constants/outputStyles.js';
import { useNotifications } from '../../agenc/upstream/context/notifications.js';
import { getTotalAPIDuration, getTotalCost, getTotalDuration, getTotalInputTokens, getTotalLinesAdded, getTotalLinesRemoved, getTotalOutputTokens } from '../../agenc/upstream/cost-tracker.js';
import { useMainLoopModel } from '../../agenc/upstream/hooks/useMainLoopModel.js';
import { type ReadonlySettings, useSettings } from '../../agenc/upstream/hooks/useSettings.js';
import type { Message } from '../../agenc/upstream/types/message.js';
import type { StatusLineCommandInput } from '../../agenc/upstream/types/statusLine.js';
import type { VimMode } from '../../agenc/upstream/types/textInputTypes.js';
import { checkHasProjectTrustAcceptedSync } from '../../permissions/trust/project-trust.js';
import { calculateContextPercentages, getContextWindowForModel } from '../../agenc/upstream/utils/context.js';
import { getCwd } from '../../agenc/upstream/utils/cwd.js';
import { isFullscreenEnvEnabled } from '../../agenc/upstream/utils/fullscreen.js';
import { createBaseHookInput, executeStatusLineCommand } from '../../agenc/upstream/utils/hooks.js';
import { getLastAssistantMessage } from '../../agenc/upstream/utils/messages.js';
import { getRuntimeMainLoopModel, type ModelName, renderModelName } from '../../agenc/upstream/utils/model/model.js';
import type { PermissionMode } from '../../agenc/upstream/utils/permissions/PermissionMode.js';
import { getCurrentSessionTitle } from '../../agenc/upstream/utils/sessionStorage.js';
import { doesMostRecentAssistantMessageExceed200k, getCurrentUsage } from '../../agenc/upstream/utils/tokens.js';
import { getCurrentWorktreeSession } from '../../agenc/upstream/utils/worktree.js';
import { logForDebugging } from '../../utils/debug.js';
import { Ansi, Box, Text } from '../ink.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import { isVimModeEnabled } from '../components/PromptInput/utils.js';
export function statusLineShouldDisplay(settings: ReadonlySettings): boolean {
  // Assistant mode: statusline fields (model, permission mode, cwd) reflect the
  // REPL/daemon process, not what the agent child is actually running. Hide it.
  if (feature('KAIROS') && getKairosActive()) return false;
  return settings?.statusLine !== undefined;
}
function buildStatusLineCommandInput(permissionMode: PermissionMode, exceeds200kTokens: boolean, settings: ReadonlySettings, messages: Message[], addedDirs: string[], mainLoopModel: ModelName, vimMode?: VimMode): StatusLineCommandInput {
  const agentType = getMainThreadAgentType();
  const worktreeSession = getCurrentWorktreeSession();
  const runtimeModel = getRuntimeMainLoopModel({
    permissionMode,
    mainLoopModel,
    exceeds200kTokens
  });
  const outputStyleName = settings?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME;
  const currentUsage = getCurrentUsage(messages);
  const contextWindowSize = getContextWindowForModel(runtimeModel, getSdkBetas());
  const contextPercentages = calculateContextPercentages(currentUsage, contextWindowSize);
  const sessionId = getSessionId();
  const sessionName = getCurrentSessionTitle(sessionId);
  const rawUtil = getRawUtilization();
  const rateLimits: StatusLineCommandInput['rate_limits'] = {
    ...(rawUtil.five_hour && {
      five_hour: {
        used_percentage: rawUtil.five_hour.utilization * 100,
        resets_at: rawUtil.five_hour.resets_at
      }
    }),
    ...(rawUtil.seven_day && {
      seven_day: {
        used_percentage: rawUtil.seven_day.utilization * 100,
        resets_at: rawUtil.seven_day.resets_at
      }
    })
  };
  return {
    ...createBaseHookInput(),
    ...(sessionName && {
      session_name: sessionName
    }),
    model: {
      id: runtimeModel,
      display_name: renderModelName(runtimeModel)
    },
    workspace: {
      current_dir: getCwd(),
      project_dir: getOriginalCwd(),
      added_dirs: addedDirs
    },
    version: MACRO.VERSION,
    output_style: {
      name: outputStyleName
    },
    cost: {
      total_cost_usd: getTotalCost(),
      total_duration_ms: getTotalDuration(),
      total_api_duration_ms: getTotalAPIDuration(),
      total_lines_added: getTotalLinesAdded(),
      total_lines_removed: getTotalLinesRemoved()
    },
    context_window: {
      total_input_tokens: getTotalInputTokens(),
      total_output_tokens: getTotalOutputTokens(),
      context_window_size: contextWindowSize,
      current_usage: currentUsage,
      used_percentage: contextPercentages.used,
      remaining_percentage: contextPercentages.remaining
    },
    exceeds_200k_tokens: exceeds200kTokens,
    ...((rateLimits.five_hour || rateLimits.seven_day) && {
      rate_limits: rateLimits
    }),
    ...(isVimModeEnabled() && {
      vim: {
        mode: vimMode ?? 'INSERT'
      }
    }),
    ...(agentType && {
      agent: {
        name: agentType
      }
    }),
    ...(getIsRemoteMode() && {
      remote: {
        session_id: getSessionId()
      }
    }),
    ...(worktreeSession && {
      worktree: {
        name: worktreeSession.worktreeName,
        path: worktreeSession.worktreePath,
        branch: worktreeSession.worktreeBranch,
        original_cwd: worktreeSession.originalCwd,
        original_branch: worktreeSession.originalBranch
      }
    })
  };
}
type Props = {
  // messages stays behind a ref (read only in the debounced callback);
  // lastAssistantMessageId is the actual re-render trigger.
  messagesRef: React.RefObject<Message[]>;
  lastAssistantMessageId: string | null;
  vimMode?: VimMode;
};
export function getLastAssistantMessageId(messages: Message[]): string | null {
  return getLastAssistantMessage(messages)?.uuid ?? null;
}
function StatusLineInner({
  messagesRef,
  lastAssistantMessageId,
  vimMode
}: Props): React.ReactNode {
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const permissionMode = useAppState(s => s.toolPermissionContext.mode);
  const additionalWorkingDirectories = useAppState(s => s.toolPermissionContext.additionalWorkingDirectories);
  const statusLineText = useAppState(s => s.statusLineText);
  const setAppState = useSetAppState();
  const settings = useSettings();
  const {
    addNotification
  } = useNotifications();
  // AppState-sourced model — same source as API requests. getMainLoopModel()
  // re-reads settings.json on every call, so another session's /model write
  // would leak into this session's statusline (tracked in upstream issue #37596).
  const mainLoopModel = useMainLoopModel();

  // Keep latest values in refs for stable callback access
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const vimModeRef = useRef(vimMode);
  vimModeRef.current = vimMode;
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  const addedDirsRef = useRef(additionalWorkingDirectories);
  addedDirsRef.current = additionalWorkingDirectories;
  const mainLoopModelRef = useRef(mainLoopModel);
  mainLoopModelRef.current = mainLoopModel;

  // Track previous state to detect changes and cache expensive calculations
  const previousStateRef = useRef<{
    messageId: string | null;
    exceeds200kTokens: boolean;
    permissionMode: PermissionMode;
    vimMode: VimMode | undefined;
    mainLoopModel: ModelName;
  }>({
    messageId: null,
    exceeds200kTokens: false,
    permissionMode,
    vimMode,
    mainLoopModel
  });

  // Debounce timer ref
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // True when the next invocation should log its result (first run or after settings reload)
  const logNextResultRef = useRef(true);

  // Stable update function — reads latest values from refs
  const doUpdate = useCallback(async () => {
    // Cancel any in-flight requests
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const msgs = messagesRef.current;
    const logResult = logNextResultRef.current;
    logNextResultRef.current = false;
    try {
      let exceeds200kTokens = previousStateRef.current.exceeds200kTokens;

      // Only recalculate 200k check if messages changed
      const currentMessageId = getLastAssistantMessageId(msgs);
      if (currentMessageId !== previousStateRef.current.messageId) {
        exceeds200kTokens = doesMostRecentAssistantMessageExceed200k(msgs);
        previousStateRef.current.messageId = currentMessageId;
        previousStateRef.current.exceeds200kTokens = exceeds200kTokens;
      }
      const statusInput = buildStatusLineCommandInput(permissionModeRef.current, exceeds200kTokens, settingsRef.current, msgs, Array.from(addedDirsRef.current.keys()), mainLoopModelRef.current, vimModeRef.current);
      const text = await executeStatusLineCommand(statusInput, controller.signal, undefined, logResult);
      if (!controller.signal.aborted) {
        setAppState(prev => {
          if (prev.statusLineText === text) return prev;
          return {
            ...prev,
            statusLineText: text
          };
        });
      }
    } catch {
      // Silently ignore errors in status line updates
    }
  }, [messagesRef, setAppState]);

  // Stable debounced schedule function — no deps, uses refs
  const scheduleUpdate = useCallback(() => {
    if (debounceTimerRef.current !== undefined) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout((ref, doUpdate) => {
      ref.current = undefined;
      void doUpdate();
    }, 300, debounceTimerRef, doUpdate);
  }, [doUpdate]);

  // Only trigger update when assistant message, permission mode, vim mode, or model actually changes
  useEffect(() => {
    if (lastAssistantMessageId !== previousStateRef.current.messageId || permissionMode !== previousStateRef.current.permissionMode || vimMode !== previousStateRef.current.vimMode || mainLoopModel !== previousStateRef.current.mainLoopModel) {
      // Don't update messageId here — let doUpdate handle it so
      // exceeds200kTokens is recalculated with the latest messages
      previousStateRef.current.permissionMode = permissionMode;
      previousStateRef.current.vimMode = vimMode;
      previousStateRef.current.mainLoopModel = mainLoopModel;
      scheduleUpdate();
    }
  }, [lastAssistantMessageId, permissionMode, vimMode, mainLoopModel, scheduleUpdate]);

  // When the statusLine command changes (hot reload), log the next result
  const statusLineCommand = settings?.statusLine?.command;
  const isFirstSettingsRender = useRef(true);
  useEffect(() => {
    if (isFirstSettingsRender.current) {
      isFirstSettingsRender.current = false;
      return;
    }
    logNextResultRef.current = true;
    void doUpdate();
  }, [statusLineCommand, doUpdate]);

  // Separate effect for logging on mount
  useEffect(() => {
    const statusLine = settings?.statusLine;
    if (statusLine) {
      logEvent('agenc_status_line_mount', {
        command_length: statusLine.command.length,
        padding: statusLine.padding
      });
      // Log if status line is configured but disabled by disableAllHooks
      if (settings.disableAllHooks === true) {
        logForDebugging('Status line is configured but disableAllHooks is true', {
          level: 'warn'
        });
      }
      // executeStatusLineCommand (hooks.ts) returns undefined when trust is
      // blocked — statusLineText stays undefined forever, user sees nothing,
      // and agenc_status_line_mount above fires anyway so telemetry looks fine.
      const trustCwd = getOriginalCwd() || getCwd();
      if (!checkHasProjectTrustAcceptedSync({ cwd: trustCwd })) {
        addNotification({
          key: 'statusline-trust-blocked',
          text: 'statusline skipped until project trust is accepted',
          color: 'warning',
          priority: 'low'
        });
        logForDebugging('Status line command skipped: workspace trust not accepted', {
          level: 'warn'
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, []); // Only run once on mount - settings stable for initial logging

  // Initial update on mount + cleanup on unmount
  useEffect(() => {
    void doUpdate();
    return () => {
      abortControllerRef.current?.abort();
      if (debounceTimerRef.current !== undefined) {
        clearTimeout(debounceTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, []); // Only run once on mount, not when doUpdate changes

  // Get padding from settings or default to 0
  const paddingX = settings?.statusLine?.padding ?? 0;

  // StatusLine must have stable height in fullscreen — the footer is
  // flexShrink:0 so a 0→1 row change when the command finishes steals
  // a row from ScrollBox and shifts content. Reserve the row while loading
  // (same trick as PromptInputFooterLeftSide).
  return <Box paddingX={paddingX} gap={2}>
      {statusLineText ? <Text dimColor wrap="truncate">
          <Ansi>{statusLineText}</Ansi>
        </Text> : isFullscreenEnvEnabled() ? <Text> </Text> : null}
    </Box>;
}

// Parent (PromptInputFooter) re-renders on every setMessages, but StatusLine's
// own props now only change when lastAssistantMessageId flips — memo keeps it
// from being dragged along (previously ~18 no-prop-change renders per session).
export const StatusLine = memo(StatusLineInner);
