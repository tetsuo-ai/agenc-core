import React from 'react';
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

export function AssistantToolUseMessage({
  param,
  addMargin,
  tools,
  commands,
  verbose,
  inProgressToolUseIDs,
  progressMessagesForMessage,
  inProgressToolCallCount,
  lookups,
  isTranscriptMode,
}: Props): React.ReactNode {
  const terminalSize = useTerminalSize();
  const [theme] = useTheme();
  const bg = useSelectedMessageBg();
  const pendingWorkerRequest = useAppStateMaybeOutsideOfProvider(
    selectPendingWorkerRequest,
  );
  const isClassifierCheckingRaw = useIsClassifierChecking(param.id);
  const permissionMode = useAppStateMaybeOutsideOfProvider(
    selectPermissionMode,
  );
  const hasStrippedRules = useAppStateMaybeOutsideOfProvider(
    selectHasStrippedRules,
  );
  const isAutoClassifier =
    permissionMode === "auto" ||
    (permissionMode === "plan" && hasStrippedRules);
  const isClassifierChecking = isClassifierCheckingRaw;

  const parsed = parseToolUse(param, tools);
  if (!parsed) {
    logError(
      new Error(
        tools
          ? `Tool ${param.name} not found`
          : `Tools array is undefined for tool ${param.name}`,
      ),
    );
    return (
      <ToolUseRecoveryMessage
        addMargin={addMargin}
        backgroundColor={bg}
        title="Tool use unavailable"
        detail={
          tools
            ? "This transcript references a tool that is not available in this version of AgenC."
            : "Tool definitions were unavailable while rendering this transcript."
        }
        toolName={param.name}
      />
    );
  }

  const {
    tool,
    input,
  } = parsed;
  if (!input.success) {
    logError(new Error(`Invalid input for tool ${param.name}`));
    return (
      <ToolUseRecoveryMessage
        addMargin={addMargin}
        backgroundColor={bg}
        title="Invalid tool input"
        detail="This transcript contains tool input that no longer matches the tool schema."
        toolName={param.name}
      />
    );
  }

  const userFacingToolName = tool.userFacingName(input.data);
  const isTransparentWrapper = tool.isTransparentWrapper?.() ?? false;
  const isResolved = lookups.resolvedToolUseIDs.has(param.id);
  const isQueued = !inProgressToolUseIDs.has(param.id) && !isResolved;
  const isWaitingForPermission = pendingWorkerRequest?.toolUseId === param.id;

  if (isTransparentWrapper) {
    if (isQueued || isResolved) {
      return null;
    }
    const progressDetail = renderToolUseProgressMessage(
      tool,
      tools,
      lookups,
      param.id,
      progressMessagesForMessage,
      {
        verbose,
        inProgressToolCallCount,
        isTranscriptMode,
      },
      terminalSize,
    );

    return (
      <Box flexDirection="column" width="100%" backgroundColor={bg}>
        {progressDetail}
      </Box>
    );
  }

  if (userFacingToolName === "") {
    return null;
  }

  const renderedToolUseMessage = renderToolUseMessage(tool, input.data, {
    theme,
    verbose,
    commands,
  });
  if (renderedToolUseMessage === null) {
    return (
      <ToolUseRecoveryMessage
        addMargin={addMargin}
        backgroundColor={bg}
        title="Tool details unavailable"
        detail="AgenC could not render this tool-use row, but the transcript entry is preserved."
        toolName={param.name}
      />
    );
  }

  const marginTop = addMargin ? 1 : 0;
  const toolUseTag = tool.renderToolUseTag?.(input.data);
  const progressDetail = !isResolved && !isQueued ? (
    isWaitingForPermission ? (
      <MessageResponse height={1}>
        <Text dimColor={true}>{getAssistantToolUsePendingText('permission')}</Text>
      </MessageResponse>
    ) : isClassifierChecking ? (
      <MessageResponse height={1}>
        <Text dimColor={true}>
          {isAutoClassifier
            ? getAssistantToolUsePendingText('auto-classifier')
            : getAssistantToolUsePendingText('bash-classifier')}
        </Text>
      </MessageResponse>
    ) : renderToolUseProgressMessage(
      tool,
      tools,
      lookups,
      param.id,
      progressMessagesForMessage,
      {
        verbose,
        inProgressToolCallCount,
        isTranscriptMode,
      },
      terminalSize,
    )
  ) : null;
  const queuedMessage =
    !isResolved && isQueued ? renderToolUseQueuedMessage(tool) : null;
  const queuedDetail =
    typeof queuedMessage === "string"
      ? <Text dimColor={true}>{queuedMessage}</Text>
      : queuedMessage;
  const toolState: ToolState = lookups.erroredToolUseIDs.has(param.id)
    ? "failed"
    : isResolved
      ? "done"
      : isQueued
        ? "queued"
        : "running";
  const toolArgs =
    typeof renderedToolUseMessage === "string" &&
    renderedToolUseMessage.length > 0
      ? renderedToolUseMessage
      : summarizeToolInput(input.data);
  const extraDetail = typeof renderedToolUseMessage === "string" ? null : renderedToolUseMessage;
  const detail = extraDetail || toolUseTag || progressDetail || queuedDetail
    ? (
      <Box flexDirection="column">
        {extraDetail}
        {toolUseTag}
        {progressDetail}
        {queuedDetail}
      </Box>
    )
    : null;

  return (
    <Box flexDirection="column" marginTop={marginTop} width="100%" backgroundColor={bg}>
      <V2Tool
        kind={toolKindForName(param.name, userFacingToolName)}
        label={userFacingToolName}
        state={toolState}
        args={toolArgs}
        detail={detail}
        expanded={detail !== null}
      />
    </Box>
  );
}

function parseToolUse(
  param: AgenCToolUseBlockParam,
  tools: Tools | undefined,
): {
  tool: Tool;
  input: ReturnType<Tool['inputSchema']['safeParse']>;
} | null {
  if (!tools) {
    return null;
  }

  const tool = findToolByName(tools, param.name);
  if (!tool) {
    return null;
  }

  return {
    tool,
    input: tool.inputSchema.safeParse(param.input),
  };
}

function selectHasStrippedRules(state: {
  toolPermissionContext: { strippedDangerousRules?: unknown };
}): boolean {
  return !!state.toolPermissionContext.strippedDangerousRules;
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

function selectPermissionMode(state: {
  toolPermissionContext: { mode: string };
}): string {
  return state.toolPermissionContext.mode;
}
function selectPendingWorkerRequest(state: {
  pendingWorkerRequest?: { toolUseId: string };
}): { toolUseId: string } | undefined {
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
