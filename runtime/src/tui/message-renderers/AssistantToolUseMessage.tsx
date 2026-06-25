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
import { Tool as V2Tool, DiffInline, type ToolKind, type ToolState } from '../components/v2/primitives.js';
import { extractTag } from '../../utils/messages.js';
import { summarizeFileEditError } from '../../tools/FileEditTool/UI.js';
import { firstLineOf } from '../../utils/stringUtils.js';
import { summarizeToolInput } from './toolRowPreview.js';
import { buildEditDiffPreview } from '../edit-diff-preview.js';
import { isFixedRerunSuccess } from './fixedRerunLink.js';
import { AURA_LIFECYCLE_GLYPHS } from '../../utils/theme.js';
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
  const toolKind = toolKindForName(param.name, userFacingToolName);
  // Number of failed retries of this same tool+target that collapseReadSearch
  // folded into this single row (>=2 means earlier attempts were dropped).
  const retriedFailureCount =
    typeof (param as { retriedFailureCount?: number }).retriedFailureCount === "number"
      ? (param as { retriedFailureCount?: number }).retriedFailureCount
      : undefined;
  // On a failed row, surface the concrete one-line failure reason inline on the
  // "✕ Tool(...)" line (verbose mode keeps the full detached error block).
  const baseReason =
    !verbose && toolState === "failed"
      ? failedToolRowReason(
          toolKind,
          rawToolResultContent(lookups, param.id),
        )
      : undefined;
  // Roll the retry count into the inline annotation, e.g.
  // "✕ Edit(lexer.c)  ×5 (last: File has not been read yet)".
  const failedReason =
    retriedFailureCount && retriedFailureCount >= 2
      ? toolState === "failed"
        ? baseReason
          ? `×${retriedFailureCount} (last: ${baseReason})`
          : `×${retriedFailureCount} attempts failed`
        : `succeeded after ${retriedFailureCount} attempts`
      : baseReason;
  // Cross-turn "fixed re-run" linkage: when THIS command row passes (`●`) and
  // the identical command most-recently FAILED (`✕`) earlier in the session,
  // annotate the passing row so the user sees the fix worked without manually
  // scroll-matching two identical command strings across user-turn boundaries.
  // Distinct from retriedFailureCount, which only folds AUTOMATIC same-turn
  // retries. Mirrors the dim, inline, non-headline tone of failedReason.
  const fixedRerunNote =
    !verbose && toolState === "done" && isFixedRerunSuccess(param, lookups)
      ? `now passing · was ${AURA_LIFECYCLE_GLYPHS.failed} above`
      : undefined;
  const toolArgs =
    typeof renderedToolUseMessage === "string" &&
    renderedToolUseMessage.length > 0
      ? renderedToolUseMessage
      : summarizeToolInput(input.data, toolKind);
  // The tool RESULT preview is rendered EXACTLY ONCE by the adjacent detached
  // UserToolSuccessMessage, via the thin-client tool's renderToolResultMessage
  // (the capped per-tool views in tool-rendering.tsx — "Read N lines", capped
  // stdout, "Found N matches", compact edit diff). Nothing is rendered on the
  // success path here, so there is no double-render and no vanish. A FAILED row
  // still surfaces its one-line reason inline (P0); the retry rollup is folded
  // into that same annotation (P1).
  const rowResult: string | React.ReactNode | undefined =
    failedReason && fixedRerunNote
      ? `${failedReason} · ${fixedRerunNote}`
      : failedReason ?? fixedRerunNote;
  const extraDetail = typeof renderedToolUseMessage === "string" ? null : renderedToolUseMessage;
  // Compact green/red diff for Edit/MultiEdit/Write, rendered HERE on the call
  // row from the tool-use INPUT (old_string/new_string for Edit/MultiEdit,
  // content for Write). The live daemon's success result carries no diff data,
  // so the result-render context can't produce it — the call row has the input
  // (param.input) and is the right place. The redundant "updated successfully"
  // result body is suppressed in tool-result-routing.ts so the diff appears
  // exactly once. A FAILED row renders no diff (the inline failure reason wins);
  // a still-running/queued row also waits until it resolves.
  const editDiffDetail =
    (param.name === "Edit" ||
      param.name === "MultiEdit" ||
      param.name === "Write") &&
    isResolved &&
    toolState !== "failed"
      ? renderEditDiffPreview(param.name, input.data)
      : null;
  const detail = extraDetail || editDiffDetail || toolUseTag || progressDetail || queuedDetail
    ? (
      <Box flexDirection="column">
        {extraDetail}
        {editDiffDetail}
        {toolUseTag}
        {progressDetail}
        {queuedDetail}
      </Box>
    )
    : null;

  return (
    <Box flexDirection="column" marginTop={marginTop} width="100%" backgroundColor={bg}>
      <V2Tool
        kind={toolKind}
        label={userFacingToolName}
        state={toolState}
        args={toolArgs}
        result={rowResult}
        detail={detail}
        expanded={detail !== null}
      />
    </Box>
  );
}

/**
 * Render the compact green/red diff for a resolved Edit/MultiEdit/Write call
 * directly under its call row, built from the tool-use INPUT. Returns null when
 * there is no diffable change (so the row stays clean). Reuses the `DiffInline`
 * primitive + the shared diff engine via `buildEditDiffPreview`.
 */
export function renderEditDiffPreview(
  toolName: string,
  input: unknown,
): React.ReactNode {
  let preview: ReturnType<typeof buildEditDiffPreview>;
  try {
    preview = buildEditDiffPreview(toolName, input);
  } catch (error) {
    logError(
      new Error(`Error building edit diff preview for ${toolName}: ${error}`),
    );
    return null;
  }
  if (preview === null) return null;
  const lines = [...preview.lines];
  if (preview.remaining > 0) {
    // State the affordance so the collapsed diff is not a dead end: the full
    // diff is reachable in the workbench via the openDiff shortcut. The count
    // leads so it survives even if the row truncates at narrow widths.
    lines.push({
      kind: "ctx",
      code: `… +${preview.remaining} more ${
        preview.remaining === 1 ? "line" : "lines"
      } · ctrl+w d for full diff`,
    });
  }
  // Distinguish a first write from an edit in the header so the two no longer
  // look identical. A Write produces a brand-new file (all additions, old
  // content empty) → CREATE; Edit/MultiEdit change an existing file → EDIT.
  const op = toolName === "Write" ? "CREATE" : "EDIT";
  return (
    <DiffInline
      file={preview.file.length > 0 ? preview.file : "file"}
      stats={preview.stats}
      lines={lines}
      op={op}
    />
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

export function toolKindForName(name: string, label: string): ToolKind {
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

/**
 * Pull the raw tool_result content string for a tool use out of the message
 * lookups. Returns null when no result block (or a non-string result) exists.
 */
function rawToolResultContent(
  lookups: ReturnType<typeof buildMessageLookups>,
  toolUseId: string,
): string | null {
  const resultMsg = lookups.toolResultByToolUseID?.get(toolUseId);
  if (resultMsg?.type !== 'user') return null;
  const content = resultMsg.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      block?.type === 'tool_result' &&
      block.tool_use_id === toolUseId &&
      typeof block.content === 'string'
    ) {
      return block.content;
    }
  }
  return null;
}

/**
 * Build a concise one-line reason to attach to a failed tool row, so the user
 * sees *why* a tool call failed directly on the "✕ Tool(...)" line instead of a
 * masked generic message or a detached block. Edit-kind failures reuse the
 * file-edit summarizer (friendly intended-behavior phrasing); other tools fall
 * back to the first non-empty line of their error text.
 */
function failedToolRowReason(
  kind: ToolKind,
  rawResult: string | null,
): string | undefined {
  if (rawResult === null) return undefined;
  if (kind === 'edit') {
    return summarizeFileEditError(rawResult) ?? undefined;
  }
  const errorText = extractTag(rawResult, 'tool_use_error') ?? rawResult;
  const cleaned = errorText.replace(/<\/?error>/g, '').trim();
  const firstLine = cleaned
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0);
  return firstLine ? firstLineOf(firstLine) : undefined;
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
