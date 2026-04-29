/**
 * Transcript event reduction for the AgenC TUI.
 *
 * The live runtime emits two related streams:
 *   - `PhaseEvent` values used by the one-shot CLI path.
 *   - `EventMsg` values on `session.eventLog`, which are the richer,
 *     codex runtime-aligned source of truth for user messages, streaming deltas,
 *     compaction boundaries, tool progress, and shell exec lifecycle.
 *
 * The TUI transcript accepts both. `eventsToMessages` folds the mixed
 * stream into stable `TranscriptMessage` rows that `MessageList` can
 * render without needing to know which source an event came from.
 *
 * Resume / hydration contract
 * ---------------------------
 * Bootstrap reconstructs transcript-relevant rollout items and exposes
 * them through `session.initialTranscriptEvents`. The reducer accepts that
 * preloaded `TranscriptSourceEvent[]` directly, so resumed sessions and
 * live event-log updates share the same rendering path.
 *
 * @module
 */

import type { SlashCommandResult } from "../_deps/commands.js";
import type { PhaseEvent } from "../../phases/events.js";
import type { EventMsg } from "../../session/event-log.js";
import type { TranscriptMessage } from "../transcript/MessageList.js";
import type { PlanEvent } from "../transcript/PlanProgress.js";
import {
  assistantBlocksFromUnknown,
  userBlocksFromEventPayload,
} from "../transcript/content-blocks.js";
import {
  formatAgentStatusSummary,
  formatCollabAgentLabel,
  formatPromptPreview,
  formatSpawnRequestSuffix,
  formatWaitCompleteLines,
  type CollabAgentStatusEntry as RenderCollabAgentStatusEntry,
} from "../transcript/collab-agent-rendering.js";
import {
  appendBoundedTranscriptLine,
  appendBoundedTranscriptText,
  truncateTranscriptJsonArgs,
  truncateTranscriptText,
} from "./transcript-limits.js";

type TranscriptEventMsg = Extract<
  EventMsg,
  {
    readonly type:
      | "session_configured"
      | "turn_started"
      | "turn_complete"
      | "turn_aborted"
      | "user_message"
      | "agent_message"
      | "agent_message_delta"
      | "tool_call_started"
      | "tool_call_completed"
      | "tool_progress"
      | "exec_command_begin"
      | "exec_command_end"
      | "context_compacted"
      | "warning"
      | "error"
      | "stream_error"
      | "deprecation_notice"
      | "collab_agent_spawn_begin"
      | "collab_agent_spawn_end"
      | "collab_agent_interaction_begin"
      | "collab_agent_interaction_end"
      | "collab_waiting_begin"
      | "collab_waiting_end"
      | "collab_close_begin"
      | "collab_close_end"
      | "collab_resume_begin"
      | "collab_resume_end"
      | "plan_started"
      | "plan_delta"
      | "plan_item_completed"
      | "plan_exited";
  }
>;

type TranscriptPlanEventMsg = Extract<
  TranscriptEventMsg,
  {
    readonly type:
      | "plan_started"
      | "plan_delta"
      | "plan_item_completed"
      | "plan_exited";
  }
>;

export type TranscriptEventEnvelope = {
  [K in TranscriptEventMsg["type"]]: {
    readonly id?: string;
    readonly seq?: number;
    readonly type: K;
    readonly payload: Extract<TranscriptEventMsg, { readonly type: K }>["payload"];
  };
}[TranscriptEventMsg["type"]];

export interface TranscriptSlashResultEvent {
  readonly id?: string;
  readonly type: "slash_result";
  readonly input: string;
  readonly result: SlashCommandResult;
  readonly turnId?: string;
  readonly timestamp?: number;
}

export type TranscriptSourceEvent =
  | PhaseEvent
  | TranscriptEventEnvelope
  | TranscriptSlashResultEvent;

export interface EventsToMessagesOptions {
  /**
   * Include lifecycle/debug rows that are hidden from the normal prompt view.
   * This is used by transcript-focused mode, matching upstream's split between
   * a clean chat surface and a verbose transcript surface.
   */
  readonly includeHidden?: boolean;
}

interface PendingExecOutput {
  stdout: string;
  stderr: string;
}

const FALLBACK_TURN_PREFIX = "turn-";

function eventTimestamp(event: TranscriptSourceEvent, index: number): number {
  if ("timestamp" in event && typeof event.timestamp === "number") {
    return event.timestamp;
  }
  if (
    "payload" in event &&
    event.payload &&
    typeof event.payload === "object" &&
    "timestamp" in event.payload &&
    typeof event.payload.timestamp === "number"
  ) {
    return event.payload.timestamp;
  }
  if ("seq" in event && typeof event.seq === "number") {
    return event.seq;
  }
  return index;
}

function nextFallbackTurnId(counter: { value: number }): string {
  counter.value += 1;
  return `${FALLBACK_TURN_PREFIX}${counter.value}`;
}

function toPlanEvent(
  event: TranscriptPlanEventMsg,
  timestamp: number,
): PlanEvent {
  switch (event.type) {
    case "plan_started":
      return {
        kind: "plan_started",
        planItemId: event.payload.planItemId,
        title: event.payload.title,
        timestamp,
      };
    case "plan_delta":
      return {
        kind: "plan_delta",
        planItemId: event.payload.planItemId,
        delta: event.payload.delta,
        timestamp,
      };
    case "plan_item_completed":
      return {
        kind: "plan_item_completed",
        planItemId: event.payload.planItemId,
        finalText: event.payload.finalText,
        timestamp,
      };
    case "plan_exited":
      return {
        kind: "plan_exited",
        timestamp,
      };
  }
}

function safeJsonParse(input: string): unknown {
  if (typeof input !== "string" || input.trim().length === 0) return undefined;
  try {
    return JSON.parse(truncateTranscriptJsonArgs(input));
  } catch {
    return truncateTranscriptText(input);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileMutationToolName(toolName: string | undefined): boolean {
  if (typeof toolName !== "string") return false;
  const normalized = toolName.toLowerCase();
  return (
    normalized === "edit" ||
    normalized === "editfile" ||
    normalized === "edit_file" ||
    normalized === "write" ||
    normalized === "writefile" ||
    normalized === "write_file" ||
    normalized === "notebookedit" ||
    normalized === "notebook_edit"
  );
}

const FILE_MUTATION_PAYLOAD_FIELDS = new Set([
  "content",
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "new_string",
  "newString",
  "new_text",
  "newText",
  "before",
  "after",
  "edits",
]);

function sanitizeToolArgsForTranscript(
  toolName: string | undefined,
  args: unknown,
): unknown {
  if (!isFileMutationToolName(toolName) || !isRecord(args)) return args;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (FILE_MUTATION_PAYLOAD_FIELDS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function isPhaseEvent(event: TranscriptSourceEvent): event is PhaseEvent {
  return (
    event.type === "turn_start" ||
    event.type === "assistant_text" ||
    event.type === "tool_call" ||
    event.type === "tool_result" ||
    event.type === "turn_complete"
  );
}

function summarizeSlashResult(result: SlashCommandResult): string {
  switch (result.kind) {
    case "text":
    case "compact":
      return result.text;
    case "prompt":
      return result.content;
    case "skip":
      return "";
    case "exit":
      return `exit ${result.code}`;
    case "error":
      return result.message;
    default: {
      const _never: never = result;
      void _never;
      return "";
    }
  }
}

function formatCompactBoundary(
  payload: Extract<
    TranscriptEventMsg,
    { readonly type: "context_compacted" }
  >["payload"],
): string {
  const tokens =
    typeof payload.preCompactTokens === "number" &&
    typeof payload.postCompactTokens === "number"
      ? ` (${payload.preCompactTokens} -> ${payload.postCompactTokens} tokens)`
      : "";
  const summary =
    typeof payload.summary === "string" && payload.summary.trim().length > 0
      ? payload.summary.trim()
      : "";
  if (summary.length > 0) {
    return `Context compacted: ${summary}${tokens}`;
  }
  return `Context compacted${tokens}`;
}

const HIDDEN_WARNING_CAUSES = new Set([
  "model_ui_spoof_pattern",
  "orphaned_turn_recovered",
  "provider_switched",
  "snapshot_behind_rollout",
  "stream_chunk_reordered",
  "system_resumed_from",
  "tool_routing_classified",
  "compact_prompt_build_slow",
  "compact_tool_result_dropped",
  "llm_request_metadata",
  "mode_changed",
  "mode_changed_to_plan",
  "mode_exited_plan",
  "memory_extract_failed",
  "memory_extract_parse_failed",
  "memory_extract_timeout",
]);

const SILENT_TOOL_NAMES = new Set([
  "ToolSearch",
  "tool_search",
  "system.searchTools",
  // openclaude `TodoWriteTool.renderToolUseMessage` returns null and the
  // tool omits `renderToolResultMessage` entirely (see AgenC
  // `Tool.ts:572-574`: "Omit for tools whose results are surfaced
  // elsewhere (e.g., TodoWrite updates the todo panel, not the
  // transcript)"). AgenC's equivalent of the AgenC todo panel is
  // the `PlanProgress` cell wired through the `plan_started` /
  // `plan_item_completed` event pair the workflow controller emits.
  // Suppressing the generic tool-call/tool-result cells here is what
  // collapses the previously triple-rendered `update_plan` block down
  // to one cell.
  "TodoWrite",
]);

const ASSISTANT_LIFECYCLE_CHATTER = [
  "calling tool.",
  "now implementing via tools.",
] as const;

export function isHiddenTranscriptWarningCause(cause: string): boolean {
  return HIDDEN_WARNING_CAUSES.has(cause);
}

export function isSilentTranscriptToolName(toolName: string | undefined): boolean {
  return typeof toolName === "string" && SILENT_TOOL_NAMES.has(toolName);
}

function isAssistantLifecycleChatter(message: string): boolean {
  // Strict equality only. Earlier code also matched the same string with
  // its trailing period stripped ("calling tool" matched "calling tool.")
  // — which let the streaming filter drop a delta-group at the "tool"
  // delta and then leak the final "." delta as a standalone assistant
  // row (visible as a stray `● .` between tool cells). Upstream models
  // always emit the full "Calling tool." with the period; require it.
  const normalized = normalizeAssistantLifecycleCandidate(message);
  return ASSISTANT_LIFECYCLE_CHATTER.some(
    (candidate) => normalized === candidate,
  );
}

function normalizeAssistantLifecycleCandidate(message: string): string {
  return message.trim().replace(/\s+/gu, " ").toLowerCase();
}

function isAssistantLifecycleChatterPrefix(message: string): boolean {
  const normalized = normalizeAssistantLifecycleCandidate(message);
  if (normalized.length === 0) return false;
  return ASSISTANT_LIFECYCLE_CHATTER.some((candidate) =>
    candidate.startsWith(normalized),
  );
}

function formatWarning(
  payload: Extract<TranscriptEventMsg, { readonly type: "warning" }>["payload"],
  options: EventsToMessagesOptions,
): { kind: TranscriptMessage["kind"]; label?: string; content: string } | null {
  if (isHiddenTranscriptWarningCause(payload.cause) && options.includeHidden !== true) {
    return null;
  }
  if (payload.cause === "context_compacted" || payload.cause === "compact_completed") {
    return {
      kind: "meta",
      label: "compact",
      content: payload.message,
    };
  }
  return {
    kind: "warning",
    content: payload.message,
  };
}

function formatDeprecation(
  payload: Extract<
    TranscriptEventMsg,
    { readonly type: "deprecation_notice" }
  >["payload"],
): string {
  const replacement =
    typeof payload.replacement === "string" && payload.replacement.length > 0
      ? ` -> ${payload.replacement}`
      : "";
  return `Deprecated ${payload.subject}${replacement}: ${payload.reason}`;
}

function collabAgentStatusEntries(
  entries: Extract<
    TranscriptEventMsg,
    { readonly type: "collab_waiting_end" }
  >["payload"]["agentStatuses"],
): readonly RenderCollabAgentStatusEntry[] {
  return (entries ?? []).map((entry) => ({
    threadId: entry.threadId,
    nickname: entry.agentNickname,
    role: entry.agentRole,
    roleDisplayName: entry.agentRoleDisplayName,
    status: entry.status,
  }));
}

function formatSessionConfigured(
  payload: Extract<
    TranscriptEventMsg,
    { readonly type: "session_configured" }
  >["payload"],
): { kind: TranscriptMessage["kind"]; label?: string; content: string } | null {
  if (
    typeof payload.forkedFromId === "string" &&
    payload.forkedFromId.trim().length > 0
  ) {
    return {
      kind: "meta",
      label: "fork",
      content: `Thread forked from ${payload.forkedFromId.trim()}`,
    };
  }
  if (payload.historyEntryCount > 0) {
    return null;
  }
  return null;
}

const LEGACY_PLAN_SIGNAL_RE = /^\[plan:[^\]]+\]\s*/u;
const TRAILING_TODO_WRITE_JSON_FENCE_RE =
  /(?:^|\n)[ \t]*```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/u;

function isTodoStatus(value: unknown): boolean {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function isTodoWriteItem(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    typeof item.content === "string" &&
    item.content.trim().length > 0 &&
    isTodoStatus(item.status) &&
    typeof item.activeForm === "string" &&
    item.activeForm.trim().length > 0
  );
}

function isTodoWritePayload(value: unknown): boolean {
  const todos =
    Array.isArray(value)
      ? value
      : typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          Array.isArray((value as Record<string, unknown>).todos)
        ? ((value as Record<string, unknown>).todos as unknown[])
        : null;
  return todos !== null && todos.length > 0 && todos.every(isTodoWriteItem);
}

function stripTrailingTodoWriteJsonFence(content: string): string {
  const match = TRAILING_TODO_WRITE_JSON_FENCE_RE.exec(content);
  if (!match) return content;
  const rawJson = match[1];
  if (typeof rawJson !== "string" || rawJson.trim().length === 0) {
    return content;
  }
  try {
    if (!isTodoWritePayload(JSON.parse(rawJson))) {
      return content;
    }
  } catch {
    return content;
  }
  return content.slice(0, match.index).trimEnd();
}

function sanitizeAssistantTranscriptContent(content: string): string {
  return stripTrailingTodoWriteJsonFence(content);
}

function readMetadataString(
  metadata: unknown,
  key: string,
): string | undefined {
  if (!isRecord(metadata)) return undefined;
  const value = metadata[key];
  return typeof value === "string" ? truncateTranscriptText(value) : undefined;
}

function readMetadataNumber(
  metadata: unknown,
  key: string,
): number | undefined {
  if (!isRecord(metadata)) return undefined;
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readMetadataBoolean(
  metadata: unknown,
  key: string,
): boolean | undefined {
  if (!isRecord(metadata)) return undefined;
  const value = metadata[key];
  return typeof value === "boolean" ? value : undefined;
}

function readMetadataStringArray(
  metadata: unknown,
  key: string,
): readonly string[] | undefined {
  if (!isRecord(metadata)) return undefined;
  const value = metadata[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => truncateTranscriptText(item));
  return strings.length > 0 ? strings : undefined;
}

function execMetadataPatch(
  metadata: unknown,
): Partial<Pick<
  TranscriptMessage,
  | "execCommand"
  | "execStdout"
  | "execStderr"
  | "execExitCode"
  | "execDurationMs"
  | "execTimedOut"
  | "execTruncated"
  | "execCwdWasReset"
  | "execBackgroundTaskHint"
  | "execImagePaths"
  | "execNoOutputExpected"
  | "execReturnCodeInterpretation"
  | "execBackgroundTaskId"
  | "toolResultMetadata"
>> {
  if (!isRecord(metadata)) return {};
  const command = readMetadataString(metadata, "command");
  const stdout = readMetadataString(metadata, "stdout");
  const stderr = readMetadataString(metadata, "stderr");
  const exitCode = readMetadataNumber(metadata, "exitCode");
  const durationMs = readMetadataNumber(metadata, "durationMs");
  const timedOut = readMetadataBoolean(metadata, "timedOut");
  const truncated = readMetadataBoolean(metadata, "truncated");
  const cwdWasReset = readMetadataBoolean(metadata, "cwdWasReset");
  const backgroundTaskHint = readMetadataString(metadata, "backgroundTaskHint");
  const imagePaths = readMetadataStringArray(metadata, "imagePaths");
  const noOutputExpected = readMetadataBoolean(metadata, "noOutputExpected");
  const returnCodeInterpretation = readMetadataString(
    metadata,
    "returnCodeInterpretation",
  );
  const backgroundTaskId = readMetadataString(metadata, "backgroundTaskId");
  return {
    toolResultMetadata: metadata,
    ...(command !== undefined ? { execCommand: command } : {}),
    ...(stdout !== undefined ? { execStdout: stdout } : {}),
    ...(stderr !== undefined ? { execStderr: stderr } : {}),
    ...(exitCode !== undefined ? { execExitCode: exitCode } : {}),
    ...(durationMs !== undefined ? { execDurationMs: durationMs } : {}),
    ...(timedOut !== undefined ? { execTimedOut: timedOut } : {}),
    ...(truncated !== undefined ? { execTruncated: truncated } : {}),
    ...(cwdWasReset !== undefined ? { execCwdWasReset: cwdWasReset } : {}),
    ...(backgroundTaskHint !== undefined
      ? { execBackgroundTaskHint: backgroundTaskHint }
      : {}),
    ...(imagePaths !== undefined ? { execImagePaths: imagePaths } : {}),
    ...(noOutputExpected !== undefined
      ? { execNoOutputExpected: noOutputExpected }
      : {}),
    ...(returnCodeInterpretation !== undefined
      ? { execReturnCodeInterpretation: returnCodeInterpretation }
      : {}),
    ...(backgroundTaskId !== undefined
      ? { execBackgroundTaskId: backgroundTaskId }
      : {}),
  };
}

function isLegacyPlanSignal(content: string): boolean {
  return LEGACY_PLAN_SIGNAL_RE.test(content);
}

export function eventsToMessages(
  events: readonly TranscriptSourceEvent[],
  options: EventsToMessagesOptions = {},
): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const toolMessageIndexByCallId = new Map<string, number>();
  const toolCallIdByProcessId = new Map<number, string>();
  const suppressedWriteStdinCallIds = new Set<string>();
  const suppressedToolCallIds = new Set<string>();
  const activityIndexById = new Map<string, number>();
  const planIndexByTurnId = new Map<string, number>();
  const pendingExecOutputByCallId = new Map<string, PendingExecOutput>();
  const toolNameByCallId = new Map<string, string>();
  const toolArgsByCallId = new Map<string, unknown>();
  const typedPlanSeenTurnIds = new Set<string>();
  const typedPlanActiveTurnIds = new Set<string>();
  const toolActivitySeenTurnIds = new Set<string>();

  const fallbackTurnCounter = { value: 0 };
  let currentTurnId = `${FALLBACK_TURN_PREFIX}${fallbackTurnCounter.value}`;
  let activeAssistantIndex: number | null = null;
  // Per-turn last assistant row index. Survives `markAssistantComplete()`
  // (which clears `activeAssistantIndex` on `tool_call_started`) so the
  // terminal `agent_message` event for the same turn can coalesce back
  // into the streaming row instead of pushing a duplicate. Mirrors
  // AgenC's atomic streamingText→onMessage transition
  // (utils/messages.ts:2980-2985) where the streaming preview clears in
  // the same dispatch as `onMessage(message)` so the two never coexist.
  const lastAssistantIndexByTurn = new Map<string, number>();
  let pendingAssistantLifecycleText:
    | {
        readonly turnId: string;
        readonly id: string;
        readonly content: string;
        readonly timestamp: number;
      }
    | null = null;

  const upsertActivity = (
    id: string,
    turnId: string,
    label: string,
    chunk: string,
    timestamp: number,
    stream?: TranscriptMessage["progressStream"],
  ): void => {
    if (chunk.length === 0) return;
    const existingIndex = activityIndexById.get(id);
    if (existingIndex === undefined) {
      const message: TranscriptMessage = {
        id,
        turnId,
        kind: "activity",
        label,
        content: chunk,
        timestamp,
        isComplete: false,
        ...(stream ? { progressStream: stream } : {}),
      };
      const insertionIndex = finalAssistantInsertionIndex(turnId);
      if (insertionIndex === messages.length) {
        messages.push(message);
        activityIndexById.set(id, messages.length - 1);
      } else {
        messages.splice(insertionIndex, 0, message);
        reindexMessageIndexes();
      }
      return;
    }
    const prev = messages[existingIndex]!;
    messages[existingIndex] = {
      ...prev,
      content: appendBoundedTranscriptLine(prev.content, chunk),
      timestamp,
      ...(stream ? { progressStream: stream } : {}),
    };
  };

  const reindexMessageIndexes = (): void => {
    toolMessageIndexByCallId.clear();
    activityIndexById.clear();
    planIndexByTurnId.clear();
    lastAssistantIndexByTurn.clear();
    activeAssistantIndex = null;

    for (const [messageIndex, message] of messages.entries()) {
      if (
        (message.kind === "tool_call" || message.kind === "tool_result") &&
        typeof message.callId === "string" &&
        message.callId.length > 0
      ) {
        toolMessageIndexByCallId.set(message.callId, messageIndex);
      }
      if (message.kind === "activity") {
        activityIndexById.set(message.id, messageIndex);
      }
      if (message.kind === "plan_progress") {
        planIndexByTurnId.set(message.turnId, messageIndex);
      }
      if (message.kind === "assistant") {
        lastAssistantIndexByTurn.set(message.turnId, messageIndex);
        if (message.isComplete === false) {
          activeAssistantIndex = messageIndex;
        }
      }
    }
  };

  const finalAssistantInsertionIndex = (turnId: string): number => {
    const indexed = lastAssistantIndexByTurn.get(turnId);
    if (indexed !== undefined) {
      const candidate = messages[indexed];
      if (
        candidate?.kind === "assistant" &&
        candidate.turnId === turnId &&
        candidate.isComplete !== false
      ) {
        return indexed;
      }
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (
        candidate?.kind === "assistant" &&
        candidate.turnId === turnId &&
        candidate.isComplete !== false
      ) {
        return index;
      }
    }
    return messages.length;
  };

  const isToolOutputRow = (message: TranscriptMessage): boolean =>
    message.kind === "tool_call" ||
    message.kind === "tool_result" ||
    message.kind === "activity";

  const moveAssistantAfterTurnToolRows = (
    assistantIndex: number,
    turnId: string,
  ): number => {
    let lastToolIndex = -1;
    for (const [index, message] of messages.entries()) {
      if (
        index !== assistantIndex &&
        message.turnId === turnId &&
        isToolOutputRow(message)
      ) {
        lastToolIndex = index;
      }
    }
    if (lastToolIndex <= assistantIndex) return assistantIndex;

    const [assistant] = messages.splice(assistantIndex, 1);
    if (!assistant) return assistantIndex;
    const adjustedToolIndex = lastToolIndex - 1;
    const insertionIndex = adjustedToolIndex + 1;
    messages.splice(insertionIndex, 0, assistant);
    reindexMessageIndexes();
    return insertionIndex;
  };

  const replaceToolTurnAssistantWithFinal = (
    turnId: string,
    content: string,
    id: string,
    timestamp: number,
  ): void => {
    if (content.trim().length === 0) return;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.kind === "assistant" && message.turnId === turnId) {
        messages.splice(index, 1);
      }
    }
    pendingAssistantLifecycleText = null;
    activeAssistantIndex = null;
    reindexMessageIndexes();
    messages.push({
      id,
      turnId,
      kind: "assistant",
      content,
      assistantContent: assistantBlocksFromUnknown(content),
      timestamp,
      isComplete: true,
    });
    const finalIndex = moveAssistantAfterTurnToolRows(
      messages.length - 1,
      turnId,
    );
    lastAssistantIndexByTurn.set(turnId, finalIndex);
  };

  const appendAssistantDelta = (
    turnId: string,
    id: string,
    delta: string,
    timestamp: number,
  ): void => {
    if (
      activeAssistantIndex === null ||
      messages[activeAssistantIndex]?.kind !== "assistant" ||
      messages[activeAssistantIndex]?.turnId !== turnId
    ) {
      messages.push({
        id,
        turnId,
        kind: "assistant",
        content: delta,
        assistantContent: assistantBlocksFromUnknown(delta),
        timestamp,
        isComplete: false,
      });
      activeAssistantIndex = messages.length - 1;
      lastAssistantIndexByTurn.set(turnId, activeAssistantIndex);
      return;
    }
    const prev = messages[activeAssistantIndex]!;
    messages[activeAssistantIndex] = {
      ...prev,
      content: `${prev.content}${delta}`,
      assistantContent: assistantBlocksFromUnknown(`${prev.content}${delta}`),
      timestamp,
      isComplete: false,
    };
  };

  const flushPendingAssistantLifecycleText = (): void => {
    if (pendingAssistantLifecycleText === null) return;
    const pending = pendingAssistantLifecycleText;
    pendingAssistantLifecycleText = null;
    appendAssistantDelta(
      pending.turnId,
      pending.id,
      pending.content,
      pending.timestamp,
    );
  };

  const markAssistantComplete = (): void => {
    if (pendingAssistantLifecycleText !== null) {
      if (options.includeHidden === true) {
        flushPendingAssistantLifecycleText();
      } else {
        pendingAssistantLifecycleText = null;
      }
    }
    if (activeAssistantIndex === null) return;
    const prev = messages[activeAssistantIndex];
    if (!prev || prev.kind !== "assistant") {
      activeAssistantIndex = null;
      return;
    }
    messages[activeAssistantIndex] = {
      ...prev,
      content: sanitizeAssistantTranscriptContent(prev.content),
      assistantContent: assistantBlocksFromUnknown(
        sanitizeAssistantTranscriptContent(prev.content),
      ),
      isComplete: true,
    };
    activeAssistantIndex = null;
  };

  /**
   * Resolve the turn id to attach to a message row.
   *
   * Pure — does NOT mutate `currentTurnId`. Earlier code did mutate as a
   * side effect, which meant any non-turn event carrying its own
   * `payload.turnId` (e.g. a `plan_exited` event whose payload had
   * `turnId: "ExitPlanMode"` from a buggy emitter) would corrupt the
   * global turn id and tag every subsequent assistant row with the
   * wrong identity. Turn-id mutation is now reserved for the
   * `turn_started` handler (line 684), the only canonical site that
   * advances the conversation turn.
   */
  const ensureTurnId = (turnId?: string | null): string => {
    if (typeof turnId === "string" && turnId.length > 0) {
      return turnId;
    }
    return currentTurnId;
  };

  const stageAssistantDelta = (
    id: string,
    turnId: string,
    delta: string,
    timestamp: number,
  ): void => {
    if (
      options.includeHidden !== true &&
      typedPlanActiveTurnIds.has(turnId)
    ) {
      return;
    }
    if (
      options.includeHidden !== true &&
      typedPlanSeenTurnIds.has(turnId) &&
      isLegacyPlanSignal(delta)
    ) {
      typedPlanActiveTurnIds.add(turnId);
      return;
    }
    if (options.includeHidden === true) {
      flushPendingAssistantLifecycleText();
      appendAssistantDelta(turnId, id, delta, timestamp);
      return;
    }
    const candidate =
      pendingAssistantLifecycleText !== null &&
      pendingAssistantLifecycleText.turnId === turnId
        ? `${pendingAssistantLifecycleText.content}${delta}`
        : delta;
    if (isAssistantLifecycleChatter(candidate)) {
      pendingAssistantLifecycleText = null;
      return;
    }
    if (isAssistantLifecycleChatterPrefix(candidate)) {
      pendingAssistantLifecycleText = {
        turnId,
        id,
        content: candidate,
        timestamp,
      };
      return;
    }
    flushPendingAssistantLifecycleText();
    appendAssistantDelta(turnId, id, delta, timestamp);
  };

  const ensureToolMessage = (
    callId: string,
    patch: Omit<TranscriptMessage, "id" | "timestamp"> & {
      readonly timestamp: number;
    },
    ordering: { readonly placeBeforeFinalAssistant?: boolean } = {},
  ): number => {
    const existingIndex = toolMessageIndexByCallId.get(callId);
    if (existingIndex !== undefined) {
      const prev = messages[existingIndex]!;
      messages[existingIndex] = {
        ...prev,
        ...patch,
        isComplete:
          prev.isComplete === true && patch.isComplete === false
            ? true
            : patch.isComplete ?? prev.isComplete,
      };
      return existingIndex;
    }
    const message: TranscriptMessage = {
      id: callId,
      ...patch,
    };
    const insertionIndex =
      ordering.placeBeforeFinalAssistant === true
        ? finalAssistantInsertionIndex(patch.turnId)
        : messages.length;
    if (insertionIndex === messages.length) {
      messages.push(message);
      const index = messages.length - 1;
      toolMessageIndexByCallId.set(callId, index);
      return index;
    }
    messages.splice(insertionIndex, 0, message);
    reindexMessageIndexes();
    return insertionIndex;
  };

  const toolMessageForCallId = (
    callId: string,
  ): TranscriptMessage | undefined => {
    const existingIndex = toolMessageIndexByCallId.get(callId);
    return existingIndex !== undefined ? messages[existingIndex] : undefined;
  };

  const turnIdForToolCall = (
    callId: string,
    fallbackTurnId: string | null | undefined = currentTurnId,
  ): string =>
    toolMessageForCallId(callId)?.turnId ?? ensureTurnId(fallbackTurnId);

  const removeToolMessage = (callId: string): void => {
    const index = toolMessageIndexByCallId.get(callId);
    if (index === undefined) return;
    messages.splice(index, 1);
    toolMessageIndexByCallId.delete(callId);
    reindexMessageIndexes();
  };

  const suppressToolMessage = (callId: string): void => {
    suppressedToolCallIds.add(callId);
    removeToolMessage(callId);
  };

  for (const [index, event] of events.entries()) {
    const timestamp = eventTimestamp(event, index);

    if (event.type === "slash_result") {
      if (event.result.kind === "skip") continue;
      messages.push({
        id: event.id ?? `slash-${index}`,
        turnId: ensureTurnId(event.turnId),
        kind: "slash_result",
        content: summarizeSlashResult(event.result),
        slashInput: event.input,
        slashResult: event.result,
        timestamp,
      });
      continue;
    }

    if (isPhaseEvent(event)) {
      switch (event.type) {
        case "turn_start": {
          markAssistantComplete();
          currentTurnId = `${FALLBACK_TURN_PREFIX}${event.turnIndex + 1}`;
          const turnNumber = Number.parseInt(
            currentTurnId.slice(FALLBACK_TURN_PREFIX.length),
            10,
          );
          if (Number.isFinite(turnNumber)) {
            fallbackTurnCounter.value = Math.max(
              fallbackTurnCounter.value,
              turnNumber,
            );
          }
          break;
        }
        case "assistant_text": {
          if (
            isAssistantLifecycleChatter(event.content) &&
            options.includeHidden !== true
          ) {
            break;
          }
          const turnId = ensureTurnId(currentTurnId);
          if (
            activeAssistantIndex !== null &&
            messages[activeAssistantIndex]?.kind === "assistant" &&
            messages[activeAssistantIndex]?.turnId === turnId
          ) {
            messages[activeAssistantIndex] = {
              ...messages[activeAssistantIndex]!,
              content: event.content,
              timestamp,
              isComplete: false,
            };
          } else {
            messages.push({
              id: `assistant-${turnId}-${timestamp}`,
              turnId,
              kind: "assistant",
              content: event.content,
              timestamp,
              isComplete: false,
            });
            activeAssistantIndex = messages.length - 1;
          }
          break;
        }
        case "tool_call": {
          markAssistantComplete();
          toolNameByCallId.set(event.toolCall.id, event.toolCall.name);
          toolArgsByCallId.set(
            event.toolCall.id,
            sanitizeToolArgsForTranscript(
              event.toolCall.name,
              safeJsonParse(event.toolCall.arguments),
            ),
          );
          if (
            isSilentTranscriptToolName(event.toolCall.name) &&
            options.includeHidden !== true
          ) {
            suppressedToolCallIds.add(event.toolCall.id);
            break;
          }
          toolActivitySeenTurnIds.add(ensureTurnId(currentTurnId));
          ensureToolMessage(event.toolCall.id, {
            turnId: ensureTurnId(currentTurnId),
            kind: "tool_call",
            content: event.toolCall.name,
            toolName: event.toolCall.name,
            toolArgs: toolArgsByCallId.get(event.toolCall.id),
            callId: event.toolCall.id,
            timestamp,
            isComplete: false,
          });
          break;
        }
        case "tool_result": {
          markAssistantComplete();
          if (
            suppressedToolCallIds.has(event.toolCall.id) ||
            (isSilentTranscriptToolName(event.toolCall.name) &&
              options.includeHidden !== true)
          ) {
            suppressedToolCallIds.delete(event.toolCall.id);
            break;
          }
          const callIndex = toolMessageIndexByCallId.get(event.toolCall.id);
          toolActivitySeenTurnIds.add(ensureTurnId(currentTurnId));
          if (callIndex !== undefined) {
            messages[callIndex] = {
              ...messages[callIndex]!,
              toolResultContent: truncateTranscriptText(event.result.content),
              ...(event.result.metadata !== undefined
                ? { toolResultMetadata: event.result.metadata }
                : {}),
              isError: event.result.isError === true,
              isComplete: true,
              timestamp,
            };
          } else {
            const resultContent = truncateTranscriptText(event.result.content);
            ensureToolMessage(
              event.toolCall.id,
              {
                turnId: ensureTurnId(currentTurnId),
                kind: "tool_result",
                content: resultContent,
                toolName: event.toolCall.name,
                toolArgs: safeJsonParse(event.toolCall.arguments),
                callId: event.toolCall.id,
                toolResultContent: resultContent,
                ...(event.result.metadata !== undefined
                  ? { toolResultMetadata: event.result.metadata }
                  : {}),
                isError: event.result.isError === true,
                timestamp,
                isComplete: true,
              },
              { placeBeforeFinalAssistant: true },
            );
          }
          break;
        }
        case "turn_complete": {
          markAssistantComplete();
          break;
        }
      }
      continue;
    }

    switch (event.type) {
      case "session_configured": {
        const configured = formatSessionConfigured(event.payload);
        if (configured) {
          messages.push({
            id: event.id ?? `session-configured-${timestamp}`,
            turnId: ensureTurnId(currentTurnId),
            kind: configured.kind,
            ...(configured.label ? { label: configured.label } : {}),
            content: configured.content,
            timestamp,
          });
        }
        break;
      }
      case "turn_started": {
        markAssistantComplete();
        currentTurnId =
          typeof event.payload.turnId === "string" &&
          event.payload.turnId.length > 0
            ? event.payload.turnId
            : nextFallbackTurnId(fallbackTurnCounter);
        break;
      }
      case "turn_complete":
      case "turn_aborted": {
        markAssistantComplete();
        break;
      }
      case "user_message": {
        markAssistantComplete();
        const userContent = userBlocksFromEventPayload(
          event.payload.message,
          event.payload.images ?? [],
        );
        messages.push({
          id: event.id ?? `user-${timestamp}`,
          turnId: ensureTurnId(currentTurnId),
          kind: "user",
          content: userContent
            .map((block) =>
              block.type === "text"
                ? block.text
                : block.type === "image"
                  ? `[Image ${block.imageId ?? ""}]`
                  : block.type === "tool_result"
                    ? block.content
                    : block.label,
            )
            .join("\n"),
          userContent,
          timestamp,
        });
        break;
      }
      case "agent_message_delta": {
        const turnId = ensureTurnId(currentTurnId);
        stageAssistantDelta(
          event.id ?? `assistant-${turnId}-${timestamp}`,
          turnId,
          event.payload.delta,
          timestamp,
        );
        break;
      }
      case "agent_message": {
        const turnId = ensureTurnId(currentTurnId);
        if (
          options.includeHidden !== true &&
          typedPlanSeenTurnIds.has(turnId) &&
          isLegacyPlanSignal(event.payload.message)
        ) {
          pendingAssistantLifecycleText = null;
          break;
        }
        if (
          isAssistantLifecycleChatter(event.payload.message) &&
          options.includeHidden !== true
        ) {
          pendingAssistantLifecycleText = null;
          break;
        }
        if (
          options.includeHidden !== true &&
          toolActivitySeenTurnIds.has(turnId)
        ) {
          replaceToolTurnAssistantWithFinal(
            turnId,
            sanitizeAssistantTranscriptContent(event.payload.message),
            event.id ?? `assistant-${turnId}-${timestamp}`,
            timestamp,
          );
          break;
        }
        pendingAssistantLifecycleText = null;
        // Resolve the row to coalesce into. Prefer `activeAssistantIndex`
        // if still pinned to this turn; otherwise fall back to the
        // per-turn last-assistant index — which survives the
        // `markAssistantComplete()` call inside `tool_call_started` so
        // the terminal `agent_message` for this turn can still merge
        // into the streaming row instead of pushing a duplicate.
        // Mirrors openclaude's atomic streamingText→onMessage transition
        // (utils/messages.ts:2980-2985).
        let candidateIndex: number | null =
          activeAssistantIndex !== null &&
          messages[activeAssistantIndex]?.kind === "assistant" &&
          messages[activeAssistantIndex]?.turnId === turnId
            ? activeAssistantIndex
            : null;
        if (candidateIndex === null) {
          const fallback = lastAssistantIndexByTurn.get(turnId);
          if (fallback !== undefined) {
            const candidate = messages[fallback];
            if (
              candidate?.kind === "assistant" &&
              candidate.turnId === turnId
            ) {
              candidateIndex = fallback;
            }
          }
        }
        if (candidateIndex !== null) {
          const prev = messages[candidateIndex]!;
          messages[candidateIndex] = {
            ...prev,
            content:
              event.payload.message.length > 0
                ? sanitizeAssistantTranscriptContent(event.payload.message)
                : prev.content,
            assistantContent: assistantBlocksFromUnknown(
              event.payload.message.length > 0
                ? sanitizeAssistantTranscriptContent(event.payload.message)
                : prev.content,
            ),
            timestamp,
            isComplete: true,
          };
          const finalIndex = moveAssistantAfterTurnToolRows(
            candidateIndex,
            turnId,
          );
          activeAssistantIndex = null;
          lastAssistantIndexByTurn.set(turnId, finalIndex);
        } else {
          messages.push({
            id: event.id ?? `assistant-${turnId}-${timestamp}`,
            turnId,
            kind: "assistant",
            content: sanitizeAssistantTranscriptContent(event.payload.message),
            assistantContent: assistantBlocksFromUnknown(
              sanitizeAssistantTranscriptContent(event.payload.message),
            ),
            timestamp,
            isComplete: true,
          });
          const finalIndex = moveAssistantAfterTurnToolRows(
            messages.length - 1,
            turnId,
          );
          lastAssistantIndexByTurn.set(turnId, finalIndex);
        }
        break;
      }
      case "tool_call_started": {
        markAssistantComplete();
        const parsedArgs = sanitizeToolArgsForTranscript(
          event.payload.toolName,
          safeJsonParse(event.payload.args),
        );
        toolNameByCallId.set(event.payload.callId, event.payload.toolName);
        toolArgsByCallId.set(event.payload.callId, parsedArgs);
        if (
          isSilentTranscriptToolName(event.payload.toolName) &&
          options.includeHidden !== true
        ) {
          suppressedToolCallIds.add(event.payload.callId);
          break;
        }
        const toolTurnId = ensureTurnId(currentTurnId);
        toolActivitySeenTurnIds.add(toolTurnId);
        if (event.payload.toolName === "write_stdin") {
          const args = parsedArgs;
          const processId =
            args && typeof args === "object" && !Array.isArray(args)
              ? (args as { session_id?: unknown; process_id?: unknown }).session_id ??
                (args as { process_id?: unknown }).process_id
              : undefined;
          if (
            typeof processId === "number" &&
            toolCallIdByProcessId.has(processId)
          ) {
            suppressedWriteStdinCallIds.add(event.payload.callId);
            break;
          }
        }
        ensureToolMessage(event.payload.callId, {
          turnId: toolTurnId,
          kind: "tool_call",
          content: event.payload.toolName,
          toolName: event.payload.toolName,
          toolArgs: parsedArgs,
          callId: event.payload.callId,
          timestamp,
          isComplete: false,
        });
        break;
      }
      case "tool_progress": {
        const stream = event.payload.stream;
        const chunk = truncateTranscriptText(event.payload.chunk);
        if (!toolNameByCallId.has(event.payload.callId)) {
          toolNameByCallId.set(event.payload.callId, event.payload.toolName);
        }
        if (suppressedToolCallIds.has(event.payload.callId)) {
          break;
        }
        const targetCallId =
          event.payload.processId !== undefined
            ? toolCallIdByProcessId.get(event.payload.processId) ??
              event.payload.callId
            : event.payload.callId;
        const targetTurnId = turnIdForToolCall(targetCallId);
        toolActivitySeenTurnIds.add(targetTurnId);
        if (
          (stream === "stdout" || stream === "stderr") &&
          toolMessageIndexByCallId.has(targetCallId)
        ) {
          const toolIndex = toolMessageIndexByCallId.get(targetCallId)!;
          const prev = messages[toolIndex]!;
          messages[toolIndex] = {
            ...prev,
            ...(stream === "stdout"
              ? {
                  execStdout: appendBoundedTranscriptText(
                    prev.execStdout ?? "",
                    chunk,
                  ),
                }
              : {
                  execStderr: appendBoundedTranscriptText(
                    prev.execStderr ?? "",
                    chunk,
                  ),
                }),
            timestamp,
          };
          break;
        }
        if (stream === "stdout" || stream === "stderr") {
          const pending = pendingExecOutputByCallId.get(
            targetCallId,
          ) ?? {
            stdout: "",
            stderr: "",
          };
          if (stream === "stdout") {
            pending.stdout = appendBoundedTranscriptText(pending.stdout, chunk);
          } else {
            pending.stderr = appendBoundedTranscriptText(pending.stderr, chunk);
          }
          pendingExecOutputByCallId.set(targetCallId, pending);
          break;
        }
        if (toolMessageIndexByCallId.has(targetCallId)) {
          const toolIndex = toolMessageIndexByCallId.get(targetCallId)!;
          const prev = messages[toolIndex]!;
          const prior = prev.toolProgressContent ?? "";
          messages[toolIndex] = {
            ...prev,
            toolProgressContent: appendBoundedTranscriptLine(prior, chunk),
            timestamp,
          };
          break;
        }
        upsertActivity(
          `activity:${event.payload.callId}`,
          targetTurnId,
          event.payload.toolName,
          chunk,
          timestamp,
          stream,
        );
        break;
      }
      case "exec_command_begin": {
        const existing = toolMessageForCallId(event.payload.callId);
        const execTurnId = existing?.turnId ?? ensureTurnId(currentTurnId);
        toolActivitySeenTurnIds.add(execTurnId);
        toolNameByCallId.set(event.payload.callId, "exec_command");
        toolArgsByCallId.set(event.payload.callId, {
          cmd: event.payload.command,
          cwd: event.payload.cwd,
        });
        if (event.payload.processId !== undefined) {
          toolCallIdByProcessId.set(event.payload.processId, event.payload.callId);
        }
        const buffered = pendingExecOutputByCallId.get(event.payload.callId);
        ensureToolMessage(event.payload.callId, {
          turnId: execTurnId,
          kind: "tool_call",
          content: event.payload.command,
          toolName: "exec_command",
          callId: event.payload.callId,
          execCommand: event.payload.command,
          execStdout: existing?.execStdout ?? buffered?.stdout ?? "",
          execStderr: existing?.execStderr ?? buffered?.stderr ?? "",
          timestamp,
          isComplete: existing?.isComplete ?? false,
        });
        break;
      }
      case "exec_command_end": {
        const existing = toolMessageForCallId(event.payload.callId);
        const execTurnId = existing?.turnId ?? ensureTurnId(currentTurnId);
        toolActivitySeenTurnIds.add(execTurnId);
        toolNameByCallId.set(event.payload.callId, "exec_command");
        if (event.payload.processId !== undefined) {
          toolCallIdByProcessId.set(event.payload.processId, event.payload.callId);
        }
        const buffered = pendingExecOutputByCallId.get(event.payload.callId);
        const stdout =
          event.payload.stdout !== undefined
            ? truncateTranscriptText(event.payload.stdout)
            : undefined;
        const stderr =
          event.payload.stderr !== undefined
            ? truncateTranscriptText(event.payload.stderr)
            : undefined;
        ensureToolMessage(
          event.payload.callId,
          {
            turnId: execTurnId,
            kind: "tool_call",
            content: stdout ?? "",
            toolName: "exec_command",
            callId: event.payload.callId,
            execCommand: existing?.execCommand ?? "",
            execStdout: stdout ?? buffered?.stdout ?? existing?.execStdout ?? "",
            execStderr: stderr ?? buffered?.stderr ?? existing?.execStderr ?? "",
            ...(event.payload.exitCode !== null
              ? { execExitCode: event.payload.exitCode }
              : {}),
            execDurationMs: event.payload.durationMs,
            timestamp,
            isComplete: true,
          },
          { placeBeforeFinalAssistant: true },
        );
        pendingExecOutputByCallId.delete(event.payload.callId);
        break;
      }
      case "tool_call_completed": {
        if (suppressedToolCallIds.has(event.payload.callId)) {
          suppressedToolCallIds.delete(event.payload.callId);
          break;
        }
        if (suppressedWriteStdinCallIds.has(event.payload.callId)) {
          suppressedWriteStdinCallIds.delete(event.payload.callId);
          break;
        }
        const toolIndex = toolMessageIndexByCallId.get(event.payload.callId);
        const toolMessage =
          toolIndex !== undefined ? messages[toolIndex] : undefined;
        toolActivitySeenTurnIds.add(toolMessage?.turnId ?? ensureTurnId(currentTurnId));
        if (toolMessage) {
          messages[toolIndex!] = {
            ...toolMessage,
            isComplete: true,
            timestamp,
          };
        }
        const execPatch = execMetadataPatch(event.payload.metadata);
        if (
          toolMessage?.execCommand ||
          typeof execPatch.execCommand === "string"
        ) {
          const resultContent = truncateTranscriptText(event.payload.result);
          if (toolMessage) {
            messages[toolIndex!] = {
              ...toolMessage,
              ...execPatch,
              toolResultContent: resultContent,
              isError: event.payload.isError,
              isComplete: true,
              timestamp,
            };
          } else {
            const toolName = toolNameByCallId.get(event.payload.callId);
            ensureToolMessage(
              event.payload.callId,
              {
                turnId: ensureTurnId(currentTurnId),
                kind: "tool_call",
                content: resultContent,
                toolName: toolName ?? "exec_command",
                callId: event.payload.callId,
                ...execPatch,
                toolResultContent: resultContent,
                isError: event.payload.isError,
                timestamp,
                isComplete: true,
              },
              { placeBeforeFinalAssistant: true },
            );
          }
          break;
        }
        if (toolMessage) {
          messages[toolIndex!] = {
            ...toolMessage,
            toolResultContent: truncateTranscriptText(event.payload.result),
            ...(event.payload.metadata !== undefined
              ? { toolResultMetadata: event.payload.metadata }
              : {}),
            isError: event.payload.isError,
            isComplete: true,
            timestamp,
          };
        } else {
          const toolName = toolNameByCallId.get(event.payload.callId);
          const resultContent = truncateTranscriptText(event.payload.result);
          ensureToolMessage(
            event.payload.callId,
            {
              turnId: ensureTurnId(currentTurnId),
              kind: "tool_result",
              content: resultContent,
              callId: event.payload.callId,
              ...(toolName !== undefined ? { toolName } : {}),
              ...(toolArgsByCallId.has(event.payload.callId)
                ? { toolArgs: toolArgsByCallId.get(event.payload.callId) }
                : {}),
              toolResultContent: resultContent,
              ...(event.payload.metadata !== undefined
                ? { toolResultMetadata: event.payload.metadata }
                : {}),
              isError: event.payload.isError,
              timestamp,
              isComplete: true,
            },
            { placeBeforeFinalAssistant: true },
          );
        }
        break;
      }
      case "context_compacted": {
        markAssistantComplete();
        messages.push({
          id: event.id ?? `compact-${timestamp}`,
          turnId: ensureTurnId(currentTurnId),
          kind: "meta",
          label: "compact",
          content: formatCompactBoundary(event.payload),
          timestamp,
        });
        break;
      }
      case "warning": {
        const warning = formatWarning(event.payload, options);
        if (warning === null) {
          break;
        }
        messages.push({
          id: event.id ?? `warning-${timestamp}`,
          turnId: ensureTurnId(currentTurnId),
          kind: warning.kind,
          ...(warning.label ? { label: warning.label } : {}),
          content: warning.content,
          timestamp,
        });
        break;
      }
      case "deprecation_notice": {
        messages.push({
          id: event.id ?? `deprecated-${timestamp}`,
          turnId: ensureTurnId(currentTurnId),
          kind: "meta",
          label: "deprecated",
          content: formatDeprecation(event.payload),
          timestamp,
        });
        break;
      }
      case "collab_agent_spawn_begin": {
        suppressToolMessage(event.payload.callId);
        if (options.includeHidden === true) {
          const prompt = formatPromptPreview(event.payload.prompt);
          messages.push({
            id: event.id ?? `agent-spawn-begin-${event.payload.callId}`,
            turnId: ensureTurnId(currentTurnId),
            kind: "meta",
            label: "agent",
            content:
              prompt !== undefined
                ? `Spawning agent\n  └ ${prompt}`
                : "Spawning agent",
            timestamp,
          });
        }
        break;
      }
      case "collab_agent_spawn_end": {
        const label = event.payload.newThreadId
          ? formatCollabAgentLabel({
              threadId: event.payload.newThreadId,
              nickname: event.payload.newAgentNickname,
              role: event.payload.newAgentRole,
              roleDisplayName: event.payload.newAgentRoleDisplayName,
            })
          : "agent";
        const prompt = formatPromptPreview(event.payload.prompt);
        const suffix = formatSpawnRequestSuffix({
          model: event.payload.model,
          reasoningEffort: event.payload.reasoningEffort,
        });
        messages.push({
          id: event.id ?? `agent-spawn-end-${event.payload.callId}`,
          turnId: ensureTurnId(currentTurnId),
          kind:
            event.payload.status.status === "errored" ? "error" : "meta",
          label: "agent",
          content:
            event.payload.newThreadId === undefined
              ? "Agent spawn failed"
              : prompt !== undefined
                ? `Spawned ${label}${suffix}\n  └ ${prompt}`
                : `Spawned ${label}${suffix}`,
          timestamp,
        });
        break;
      }
      case "collab_agent_interaction_begin": {
        suppressToolMessage(event.payload.callId);
        if (options.includeHidden === true) {
          const prompt = formatPromptPreview(event.payload.prompt);
          messages.push({
            id: event.id ?? `agent-interaction-begin-${event.payload.callId}`,
            turnId: ensureTurnId(currentTurnId),
            kind: "meta",
            label: "agent",
            content:
              prompt !== undefined
                ? `Sending input to ${event.payload.receiverThreadId}\n  └ ${prompt}`
                : `Sending input to ${event.payload.receiverThreadId}`,
            timestamp,
          });
        }
        break;
      }
      case "collab_agent_interaction_end": {
        const label = formatCollabAgentLabel({
          threadId: event.payload.receiverThreadId,
          nickname: event.payload.receiverAgentNickname,
          role: event.payload.receiverAgentRole,
          roleDisplayName: event.payload.receiverAgentRoleDisplayName,
        });
        const prompt = formatPromptPreview(event.payload.prompt);
        messages.push({
          id: event.id ?? `agent-interaction-end-${event.payload.callId}`,
          turnId: ensureTurnId(currentTurnId),
          kind: "meta",
          label: "agent",
          content:
            prompt !== undefined
              ? `Sent input to ${label}\n  └ ${prompt}`
              : `Sent input to ${label}`,
          timestamp,
        });
        break;
      }
      case "collab_waiting_begin": {
        suppressToolMessage(event.payload.callId);
        const receiverAgents = event.payload.receiverAgents ?? [];
        const labels =
          receiverAgents.length > 0
            ? receiverAgents.map((agent) =>
                formatCollabAgentLabel({
                  threadId: agent.threadId,
                  nickname: agent.agentNickname,
                  role: agent.agentRole,
                  roleDisplayName: agent.agentRoleDisplayName,
                }),
              )
            : event.payload.receiverThreadIds.map((threadId) =>
                formatCollabAgentLabel({ threadId }),
              );
        const title =
          labels.length === 1
            ? `Waiting for ${labels[0]}`
            : labels.length === 0
              ? "Waiting for agents"
              : `Waiting for ${labels.length} agents`;
        const detail =
          labels.length > 1 ? `\n  └ ${labels.join("\n    ")}` : "";
        messages.push({
          id: event.id ?? `agent-wait-begin-${event.payload.callId}`,
          turnId: ensureTurnId(currentTurnId),
          kind: "meta",
          label: "agent",
          content: `${title}${detail}`,
          timestamp,
        });
        break;
      }
      case "collab_waiting_end": {
        const lines = formatWaitCompleteLines(
          event.payload.statuses,
          collabAgentStatusEntries(event.payload.agentStatuses),
        );
        messages.push({
          id: event.id ?? `agent-wait-end-${event.payload.callId}`,
          turnId: ensureTurnId(currentTurnId),
          kind: "meta",
          label: "agent",
          content: `Finished waiting\n  └ ${lines.join("\n    ")}`,
          timestamp,
        });
        break;
      }
      case "collab_close_begin": {
        suppressToolMessage(event.payload.callId);
        if (options.includeHidden === true) {
          messages.push({
            id: event.id ?? `agent-close-begin-${event.payload.callId}`,
            turnId: ensureTurnId(currentTurnId),
            kind: "meta",
            label: "agent",
            content: `Closing ${event.payload.receiverThreadId}`,
            timestamp,
          });
        }
        break;
      }
      case "collab_close_end": {
        const label = formatCollabAgentLabel({
          threadId: event.payload.receiverThreadId,
          nickname: event.payload.receiverAgentNickname,
          role: event.payload.receiverAgentRole,
          roleDisplayName: event.payload.receiverAgentRoleDisplayName,
        });
        messages.push({
          id: event.id ?? `agent-close-end-${event.payload.callId}`,
          turnId: ensureTurnId(currentTurnId),
          kind: "meta",
          label: "agent",
          content: `Closed ${label}`,
          timestamp,
        });
        break;
      }
      case "collab_resume_begin": {
        suppressToolMessage(event.payload.callId);
        const label = formatCollabAgentLabel({
          threadId: event.payload.receiverThreadId,
          nickname: event.payload.receiverAgentNickname,
          role: event.payload.receiverAgentRole,
          roleDisplayName: event.payload.receiverAgentRoleDisplayName,
        });
        messages.push({
          id: event.id ?? `agent-resume-begin-${event.payload.callId}`,
          turnId: ensureTurnId(currentTurnId),
          kind: "meta",
          label: "agent",
          content: `Resuming ${label}`,
          timestamp,
        });
        break;
      }
      case "collab_resume_end": {
        const label = formatCollabAgentLabel({
          threadId: event.payload.receiverThreadId,
          nickname: event.payload.receiverAgentNickname,
          role: event.payload.receiverAgentRole,
          roleDisplayName: event.payload.receiverAgentRoleDisplayName,
        });
        messages.push({
          id: event.id ?? `agent-resume-end-${event.payload.callId}`,
          turnId: ensureTurnId(currentTurnId),
          kind: "meta",
          label: "agent",
          content: `Resumed ${label}\n  └ ${formatAgentStatusSummary(event.payload.status)}`,
          timestamp,
        });
        break;
      }
      case "error":
      case "stream_error": {
        const suffix =
          event.type === "stream_error" &&
          typeof event.payload.provider === "string"
            ? ` (${event.payload.provider})`
            : "";
        messages.push({
          id: event.id ?? `error-${timestamp}`,
          turnId: ensureTurnId(currentTurnId),
          kind: "error",
          content: `${event.payload.cause}${suffix}: ${event.payload.message}`,
          timestamp,
        });
        break;
      }
      case "plan_started": {
        const turnId = ensureTurnId(event.payload.turnId);
        typedPlanSeenTurnIds.add(turnId);
        typedPlanActiveTurnIds.add(turnId);
        messages.push({
          id: event.id ?? `plan-progress-${turnId}`,
          turnId,
          kind: "plan_progress",
          content: "",
          planEvents: [toPlanEvent(event, timestamp)],
          timestamp,
        });
        planIndexByTurnId.set(turnId, messages.length - 1);
        break;
      }
      case "plan_delta": {
        const turnId = ensureTurnId(event.payload.turnId);
        typedPlanSeenTurnIds.add(turnId);
        typedPlanActiveTurnIds.add(turnId);
        const existingIndex = planIndexByTurnId.get(turnId);
        if (existingIndex === undefined) {
          messages.push({
            id: `plan-progress-${turnId}`,
            turnId,
            kind: "plan_progress",
            content: "",
            planEvents: [toPlanEvent(event, timestamp)],
            timestamp,
          });
          planIndexByTurnId.set(turnId, messages.length - 1);
        } else {
          const prev = messages[existingIndex]!;
          messages[existingIndex] = {
            ...prev,
            planEvents: [...(prev.planEvents ?? []), toPlanEvent(event, timestamp)],
            timestamp,
          };
        }
        break;
      }
      case "plan_item_completed": {
        const turnId = ensureTurnId(event.payload.turnId);
        typedPlanSeenTurnIds.add(turnId);
        typedPlanActiveTurnIds.delete(turnId);
        const existingIndex = planIndexByTurnId.get(turnId);
        if (existingIndex === undefined) {
          messages.push({
            id: `plan-progress-${turnId}`,
            turnId,
            kind: "plan_progress",
            content: "",
            planEvents: [toPlanEvent(event, timestamp)],
            timestamp,
          });
          planIndexByTurnId.set(turnId, messages.length - 1);
        } else {
          messages[existingIndex] = {
            ...messages[existingIndex]!,
            planEvents: [
              ...(messages[existingIndex]!.planEvents ?? []),
              toPlanEvent(event, timestamp),
            ],
            timestamp,
          };
        }
        break;
      }
      case "plan_exited": {
        const turnId = ensureTurnId(event.payload.turnId);
        typedPlanSeenTurnIds.add(turnId);
        typedPlanActiveTurnIds.delete(turnId);
        const existingIndex = planIndexByTurnId.get(turnId);
        if (existingIndex === undefined) {
          messages.push({
            id: event.id ?? `plan-progress-${turnId}`,
            turnId,
            kind: "plan_progress",
            content: "",
            planEvents: [toPlanEvent(event, timestamp)],
            timestamp,
          });
          planIndexByTurnId.set(turnId, messages.length - 1);
        } else {
          const previous = messages[existingIndex]!;
          messages[existingIndex] = {
            ...previous,
            planEvents: [
              ...(previous.planEvents ?? []),
              toPlanEvent(event, timestamp),
            ],
            timestamp,
          };
        }
        break;
      }
    }
  }

  return messages;
}
