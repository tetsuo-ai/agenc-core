import { c as _c } from "react-compiler-runtime";
import React, { useMemo } from 'react';
import { selectAgenCTuiGlyphs } from '../glyphs.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import type { ThemeName } from '../../utils/theme.js';
import type { Command } from '../../commands.js';
import { Box, Text, useTheme } from '../ink.js';
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js';
import { findToolByName, type Tool, type ToolProgressData, type Tools } from '../../tools/Tool';
import type { ProgressMessage } from '../../types/message';
import { useIsClassifierChecking } from '../../utils/classifierApprovalsHook.js';
import { logError } from '../../utils/log.js';
import type { buildMessageLookups } from '../../utils/messages.js';
import type { AgenCToolUseBlockParam } from '../../types/message.js';
import { MessageResponse } from '../components/MessageResponse';
import { useSelectedMessageBg } from '../components/messageActions';
import { SentryErrorBoundary } from '../components/SentryErrorBoundary';
import { HookProgressMessage } from './HookProgressMessage';
import { Tool as V2Tool, type ToolKind, type ToolState } from '../components/v2/primitives.js';
type Props = {
  param: AgenCToolUseBlockParam;
  addMargin: boolean;
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  inProgressToolUseIDs: Set<string>;
  progressMessagesForMessage: ProgressMessage[];
  shouldAnimate: boolean;
  shouldShowDot: boolean;
  inProgressToolCallCount?: number;
  lookups: ReturnType<typeof buildMessageLookups>;
  isTranscriptMode?: boolean;
};
export function getAssistantToolUsePendingText(
  state: 'permission' | 'auto-classifier' | 'bash-classifier',
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  const ellipsis = selectAgenCTuiGlyphs(env).ellipsis;
  switch (state) {
    case 'permission':
      return `Waiting for permission${ellipsis}`;
    case 'auto-classifier':
      return `Auto classifier checking${ellipsis}`;
    case 'bash-classifier':
      return `Bash classifier checking${ellipsis}`;
  }
}
export function AssistantToolUseMessage(t0) {
  const $ = _c(81);
  const {
    param,
    addMargin,
    tools,
    commands,
    verbose,
    inProgressToolUseIDs,
    progressMessagesForMessage,
    inProgressToolCallCount,
    lookups,
    isTranscriptMode
  } = t0;
  const terminalSize = useTerminalSize();
  const [theme] = useTheme();
  const bg = useSelectedMessageBg();
  const pendingWorkerRequest = useAppStateMaybeOutsideOfProvider(_temp);
  const isClassifierCheckingRaw = useIsClassifierChecking(param.id);
  const permissionMode = useAppStateMaybeOutsideOfProvider(_temp2);
  const hasStrippedRules = useAppStateMaybeOutsideOfProvider(_temp3);
  const isAutoClassifier = permissionMode === "auto" || permissionMode === "plan" && hasStrippedRules;
  const isClassifierChecking = isClassifierCheckingRaw;
  let t1;
  if ($[0] !== param.input || $[1] !== param.name || $[2] !== tools) {
    bb0: {
      if (!tools) {
        t1 = null;
        break bb0;
      }
      const tool = findToolByName(tools, param.name);
      if (!tool) {
        t1 = null;
        break bb0;
      }
      const input = tool.inputSchema.safeParse(param.input);
      const data = input.success ? input.data : undefined;
      t1 = {
        tool,
        input,
        userFacingToolName: tool.userFacingName(data),
        userFacingToolNameBackgroundColor: tool.userFacingNameBackgroundColor?.(data),
        isTransparentWrapper: tool.isTransparentWrapper?.() ?? false
      };
    }
    $[0] = param.input;
    $[1] = param.name;
    $[2] = tools;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  const parsed = t1;
  if (!parsed) {
    logError(new Error(tools ? `Tool ${param.name} not found` : `Tools array is undefined for tool ${param.name}`));
    return <ToolUseRecoveryMessage addMargin={addMargin} backgroundColor={bg} title="Tool use unavailable" detail={tools ? "This transcript references a tool that is not available in this version of AgenC." : "Tool definitions were unavailable while rendering this transcript."} toolName={param.name} />;
  }
  const {
    tool: tool_0,
    input: input_0,
    userFacingToolName,
    isTransparentWrapper
  } = parsed;
  if (!input_0.success) {
    logError(new Error(`Invalid input for tool ${param.name}`));
    return <ToolUseRecoveryMessage addMargin={addMargin} backgroundColor={bg} title="Invalid tool input" detail="This transcript contains tool input that no longer matches the tool schema." toolName={param.name} />;
  }
  let t2;
  if ($[4] !== lookups.resolvedToolUseIDs || $[5] !== param.id) {
    t2 = lookups.resolvedToolUseIDs.has(param.id);
    $[4] = lookups.resolvedToolUseIDs;
    $[5] = param.id;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  const isResolved = t2;
  let t3;
  if ($[7] !== inProgressToolUseIDs || $[8] !== isResolved || $[9] !== param.id) {
    t3 = !inProgressToolUseIDs.has(param.id) && !isResolved;
    $[7] = inProgressToolUseIDs;
    $[8] = isResolved;
    $[9] = param.id;
    $[10] = t3;
  } else {
    t3 = $[10];
  }
  const isQueued = t3;
  const isWaitingForPermission = pendingWorkerRequest?.toolUseId === param.id;
  if (isTransparentWrapper) {
    if (isQueued || isResolved) {
      return null;
    }
    let t4;
    if ($[11] !== inProgressToolCallCount || $[12] !== isTranscriptMode || $[13] !== lookups || $[14] !== param.id || $[15] !== progressMessagesForMessage || $[16] !== terminalSize || $[17] !== tool_0 || $[18] !== tools || $[19] !== verbose) {
      t4 = renderToolUseProgressMessage(tool_0, tools, lookups, param.id, progressMessagesForMessage, {
        verbose,
        inProgressToolCallCount,
        isTranscriptMode
      }, terminalSize);
      $[11] = inProgressToolCallCount;
      $[12] = isTranscriptMode;
      $[13] = lookups;
      $[14] = param.id;
      $[15] = progressMessagesForMessage;
      $[16] = terminalSize;
      $[17] = tool_0;
      $[18] = tools;
      $[19] = verbose;
      $[20] = t4;
    } else {
      t4 = $[20];
    }
    let t5;
    if ($[21] !== bg || $[22] !== t4) {
      t5 = <Box flexDirection="column" width="100%" backgroundColor={bg}>{t4}</Box>;
      $[21] = bg;
      $[22] = t4;
      $[23] = t5;
    } else {
      t5 = $[23];
    }
    return t5;
  }
  if (userFacingToolName === "") {
    return null;
  }
  let t4;
  if ($[24] !== commands || $[25] !== input_0.data || $[26] !== input_0.success || $[27] !== theme || $[28] !== tool_0 || $[29] !== verbose) {
    t4 = input_0.success ? renderToolUseMessage(tool_0, input_0.data, {
      theme,
      verbose,
      commands
    }) : null;
    $[24] = commands;
    $[25] = input_0.data;
    $[26] = input_0.success;
    $[27] = theme;
    $[28] = tool_0;
    $[29] = verbose;
    $[30] = t4;
  } else {
    t4 = $[30];
  }
  const renderedToolUseMessage = t4;
  if (renderedToolUseMessage === null) {
    return <ToolUseRecoveryMessage addMargin={addMargin} backgroundColor={bg} title="Tool details unavailable" detail="AgenC could not render this tool-use row, but the transcript entry is preserved." toolName={param.name} />;
  }
  const t5 = addMargin ? 1 : 0;
  let t11;
  if ($[44] !== input_0.data || $[45] !== input_0.success || $[46] !== tool_0) {
    t11 = input_0.success && tool_0.renderToolUseTag && tool_0.renderToolUseTag(input_0.data);
    $[44] = input_0.data;
    $[45] = input_0.success;
    $[46] = tool_0;
    $[47] = t11;
  } else {
    t11 = $[47];
  }
  const t13 = !isResolved && !isQueued && (isWaitingForPermission ? <MessageResponse height={1}><Text dimColor={true}>{getAssistantToolUsePendingText('permission')}</Text></MessageResponse> : isClassifierChecking ? <MessageResponse height={1}><Text dimColor={true}>{isAutoClassifier ? getAssistantToolUsePendingText('auto-classifier') : getAssistantToolUsePendingText('bash-classifier')}</Text></MessageResponse> : renderToolUseProgressMessage(tool_0, tools, lookups, param.id, progressMessagesForMessage, {
      verbose,
      inProgressToolCallCount,
      isTranscriptMode
    }, terminalSize));
  let t14;
  if ($[69] !== isQueued || $[70] !== isResolved || $[71] !== tool_0) {
    t14 = !isResolved && isQueued && renderToolUseQueuedMessage(tool_0);
    $[69] = isQueued;
    $[70] = isResolved;
    $[71] = tool_0;
    $[72] = t14;
  } else {
    t14 = $[72];
  }
  const toolState: ToolState = lookups.erroredToolUseIDs.has(param.id) ? "failed" : isResolved ? "done" : isQueued ? "queued" : "running";
  const toolArgs = typeof renderedToolUseMessage === "string" && renderedToolUseMessage.length > 0 ? renderedToolUseMessage : summarizeToolInput(input_0.data);
  const extraDetail = typeof renderedToolUseMessage === "string" ? null : renderedToolUseMessage;
  let t15;
  if ($[73] !== extraDetail || $[74] !== t11 || $[75] !== t13 || $[76] !== t14) {
    t15 = extraDetail || t11 || t13 || t14 ? <Box flexDirection="column">{extraDetail}{t11}{t13}{t14}</Box> : null;
    $[73] = extraDetail;
    $[74] = t11;
    $[75] = t13;
    $[76] = t14;
    $[77] = t15;
  } else {
    t15 = $[77];
  }
  return <Box flexDirection="column" marginTop={t5} width="100%" backgroundColor={bg}><V2Tool kind={toolKindForName(param.name, userFacingToolName)} label={userFacingToolName} state={toolState} args={toolArgs} detail={t15} expanded={t15 !== null} /></Box>;
}
function _temp3(state_1) {
  return !!state_1.toolPermissionContext.strippedDangerousRules;
}

function toolKindForName(name: string, label: string): ToolKind {
  const value = `${name} ${label}`.toLowerCase();
  if (value.includes("bash") || value.includes("shell") || value.includes("powershell")) return "bash";
  if (value.includes("grep") || value.includes("glob") || value.includes("search")) return "grep";
  if (value.includes("edit") || value.includes("write") || value.includes("patch")) return "edit";
  if (value.includes("delegate") || value.includes("agent") || value.includes("task")) return "delegate";
  if (value.includes("proof")) return "proof";
  if (value.includes("claim")) return "claim";
  if (value.includes("settle")) return "settle";
  if (value.includes("stake")) return "stake";
  return "read";
}

function summarizeToolInput(input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "query", "pattern", "description", "prompt"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

function _temp2(state_0) {
  return state_0.toolPermissionContext.mode;
}
function _temp(state) {
  return state.pendingWorkerRequest;
}
function renderToolUseMessage(tool: Tool, input: unknown, {
  theme,
  verbose,
  commands
}: {
  theme: ThemeName;
  verbose: boolean;
  commands: Command[];
}): React.ReactNode {
  try {
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return '';
    }
    return tool.renderToolUseMessage(parsed.data, {
      theme,
      verbose,
      commands
    });
  } catch (error) {
    logError(new Error(`Error rendering tool use message for ${tool.name}: ${error}`));
    return '';
  }
}
function renderToolUseProgressMessage(tool: Tool, tools: Tools, lookups: ReturnType<typeof buildMessageLookups>, toolUseID: string, progressMessagesForMessage: ProgressMessage[], {
  verbose,
  inProgressToolCallCount,
  isTranscriptMode
}: {
  verbose: boolean;
  inProgressToolCallCount?: number;
  isTranscriptMode?: boolean;
}, terminalSize: {
  columns: number;
  rows: number;
}): React.ReactNode {
  const toolProgressMessages = progressMessagesForMessage.filter((msg): msg is ProgressMessage<ToolProgressData> => msg.data.type !== 'hook_progress');
  try {
    const toolMessages = tool.renderToolUseProgressMessage?.(toolProgressMessages, {
      tools,
      verbose,
      terminalSize,
      inProgressToolCallCount: inProgressToolCallCount ?? 1,
      isTranscriptMode
    }) ?? null;
    return <>
        <SentryErrorBoundary>
          <HookProgressMessage hookEvent="PreToolUse" lookups={lookups} toolUseID={toolUseID} verbose={verbose} isTranscriptMode={isTranscriptMode} />
        </SentryErrorBoundary>
        {toolMessages}
      </>;
  } catch (error) {
    logError(new Error(`Error rendering tool use progress message for ${tool.name}: ${error}`));
    return null;
  }
}
function renderToolUseQueuedMessage(tool: Tool): React.ReactNode {
  try {
    return tool.renderToolUseQueuedMessage?.();
  } catch (error) {
    logError(new Error(`Error rendering tool use queued message for ${tool.name}: ${error}`));
    return null;
  }
}
function ToolUseRecoveryMessage({
  addMargin,
  backgroundColor,
  title,
  detail,
  toolName
}: {
  addMargin: boolean;
  backgroundColor: string | undefined;
  title: string;
  detail: string;
  toolName: string;
}): React.ReactElement {
  return <Box flexDirection="column" justifyContent="space-between" marginTop={addMargin ? 1 : 0} width="100%" borderStyle="single" borderColor="error" paddingX={1} backgroundColor={backgroundColor}>
      <Text bold={true} color="error">{title}</Text>
      <Text dimColor={true}>{detail}</Text>
      <Text dimColor={true}>Tool: {toolName}</Text>
    </Box>;
}
