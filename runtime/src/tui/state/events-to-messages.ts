/**
 * Transcript event reduction for the AgenC TUI.
 *
 * The live runtime emits two related streams:
 *   - `PhaseEvent` values used by the one-shot CLI path.
 *   - `EventMsg` values on `session.eventLog`, which are the richer,
 *     codex-aligned source of truth for user messages, streaming deltas,
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

type TranscriptEventMsg = Extract<
  EventMsg,
  {
    readonly type:
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
    return JSON.parse(input);
  } catch {
    return input;
  }
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
      ? ` ${payload.preCompactTokens} -> ${payload.postCompactTokens} tokens`
      : "";
  const summary =
    typeof payload.summary === "string" && payload.summary.trim().length > 0
      ? payload.summary.trim()
      : "context compacted";
  return `${summary}${tokens}`;
}

function formatWarning(
  payload: Extract<TranscriptEventMsg, { readonly type: "warning" }>["payload"],
): { kind: TranscriptMessage["kind"]; label?: string; content: string } {
  if (payload.cause === "system_resumed_from") {
    return {
      kind: "meta",
      label: "resume",
      content: payload.message,
    };
  }
  if (payload.cause.includes("compact")) {
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
  return `${payload.subject}${replacement}: ${payload.reason}`;
}

export function eventsToMessages(
  events: readonly TranscriptSourceEvent[],
): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const toolMessageIndexByCallId = new Map<string, number>();
  const activityIndexById = new Map<string, number>();
  const planIndexByTurnId = new Map<string, number>();
  const pendingExecOutputByCallId = new Map<string, PendingExecOutput>();

  const fallbackTurnCounter = { value: 0 };
  let currentTurnId = `${FALLBACK_TURN_PREFIX}${fallbackTurnCounter.value}`;
  let activeAssistantIndex: number | null = null;

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
      messages.push({
        id,
        turnId,
        kind: "activity",
        label,
        content: chunk,
        timestamp,
        isComplete: false,
        ...(stream ? { progressStream: stream } : {}),
      });
      activityIndexById.set(id, messages.length - 1);
      return;
    }
    const prev = messages[existingIndex]!;
    messages[existingIndex] = {
      ...prev,
      content: prev.content.length > 0 ? `${prev.content}\n${chunk}` : chunk,
      timestamp,
      ...(stream ? { progressStream: stream } : {}),
    };
  };

  const markAssistantComplete = (): void => {
    if (activeAssistantIndex === null) return;
    const prev = messages[activeAssistantIndex];
    if (!prev || prev.kind !== "assistant") {
      activeAssistantIndex = null;
      return;
    }
    messages[activeAssistantIndex] = { ...prev, isComplete: true };
    activeAssistantIndex = null;
  };

  const ensureTurnId = (turnId?: string | null): string => {
    if (typeof turnId === "string" && turnId.length > 0) {
      currentTurnId = turnId;
      return currentTurnId;
    }
    return currentTurnId;
  };

  const ensureToolMessage = (
    callId: string,
    patch: Omit<TranscriptMessage, "id" | "timestamp"> & {
      readonly timestamp: number;
    },
  ): number => {
    const existingIndex = toolMessageIndexByCallId.get(callId);
    if (existingIndex !== undefined) {
      messages[existingIndex] = {
        ...messages[existingIndex]!,
        ...patch,
      };
      return existingIndex;
    }
    messages.push({
      id: callId,
      ...patch,
    });
    const index = messages.length - 1;
    toolMessageIndexByCallId.set(callId, index);
    return index;
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
          ensureToolMessage(event.toolCall.id, {
            turnId: ensureTurnId(currentTurnId),
            kind: "tool_call",
            content: event.toolCall.name,
            toolName: event.toolCall.name,
            toolArgs: safeJsonParse(event.toolCall.arguments),
            callId: event.toolCall.id,
            timestamp,
            isComplete: false,
          });
          break;
        }
        case "tool_result": {
          markAssistantComplete();
          messages.push({
            id: `tool-result-${event.toolCall.id}-${timestamp}`,
            turnId: ensureTurnId(currentTurnId),
            kind: "tool_result",
            content: event.result.content,
            toolName: event.toolCall.name,
            isError: event.result.isError === true,
            timestamp,
          });
          const callIndex = toolMessageIndexByCallId.get(event.toolCall.id);
          if (callIndex !== undefined) {
            messages[callIndex] = {
              ...messages[callIndex]!,
              isComplete: true,
            };
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
        messages.push({
          id: event.id ?? `user-${timestamp}`,
          turnId: ensureTurnId(currentTurnId),
          kind: "user",
          content: event.payload.message,
          timestamp,
        });
        break;
      }
      case "agent_message_delta": {
        const turnId = ensureTurnId(currentTurnId);
        if (
          activeAssistantIndex === null ||
          messages[activeAssistantIndex]?.kind !== "assistant" ||
          messages[activeAssistantIndex]?.turnId !== turnId
        ) {
          messages.push({
            id: event.id ?? `assistant-${turnId}-${timestamp}`,
            turnId,
            kind: "assistant",
            content: event.payload.delta,
            timestamp,
            isComplete: false,
          });
          activeAssistantIndex = messages.length - 1;
        } else {
          const prev = messages[activeAssistantIndex]!;
          messages[activeAssistantIndex] = {
            ...prev,
            content: `${prev.content}${event.payload.delta}`,
            timestamp,
            isComplete: false,
          };
        }
        break;
      }
      case "agent_message": {
        const turnId = ensureTurnId(currentTurnId);
        if (
          activeAssistantIndex !== null &&
          messages[activeAssistantIndex]?.kind === "assistant" &&
          messages[activeAssistantIndex]?.turnId === turnId
        ) {
          const prev = messages[activeAssistantIndex]!;
          messages[activeAssistantIndex] = {
            ...prev,
            content:
              event.payload.message.length > 0
                ? event.payload.message
                : prev.content,
            timestamp,
            isComplete: true,
          };
          activeAssistantIndex = null;
        } else {
          messages.push({
            id: event.id ?? `assistant-${turnId}-${timestamp}`,
            turnId,
            kind: "assistant",
            content: event.payload.message,
            timestamp,
            isComplete: true,
          });
        }
        break;
      }
      case "tool_call_started": {
        markAssistantComplete();
        ensureToolMessage(event.payload.callId, {
          turnId: ensureTurnId(currentTurnId),
          kind: "tool_call",
          content: event.payload.toolName,
          toolName: event.payload.toolName,
          toolArgs: safeJsonParse(event.payload.args),
          callId: event.payload.callId,
          timestamp,
          isComplete: false,
        });
        break;
      }
      case "tool_progress": {
        const stream = event.payload.stream;
        const chunk = event.payload.chunk;
        if (
          (stream === "stdout" || stream === "stderr") &&
          toolMessageIndexByCallId.has(event.payload.callId)
        ) {
          const toolIndex = toolMessageIndexByCallId.get(event.payload.callId)!;
          const prev = messages[toolIndex]!;
          messages[toolIndex] = {
            ...prev,
            ...(stream === "stdout"
              ? {
                  execStdout: `${prev.execStdout ?? ""}${chunk}`,
                }
              : {
                  execStderr: `${prev.execStderr ?? ""}${chunk}`,
                }),
            timestamp,
          };
          break;
        }
        if (stream === "stdout" || stream === "stderr") {
          const pending = pendingExecOutputByCallId.get(
            event.payload.callId,
          ) ?? {
            stdout: "",
            stderr: "",
          };
          if (stream === "stdout") {
            pending.stdout += chunk;
          } else {
            pending.stderr += chunk;
          }
          pendingExecOutputByCallId.set(event.payload.callId, pending);
          break;
        }
        upsertActivity(
          `activity:${event.payload.callId}`,
          ensureTurnId(currentTurnId),
          event.payload.toolName,
          chunk,
          timestamp,
          stream,
        );
        break;
      }
      case "exec_command_begin": {
        const buffered = pendingExecOutputByCallId.get(event.payload.callId);
        ensureToolMessage(event.payload.callId, {
          turnId: ensureTurnId(currentTurnId),
          kind: "tool_call",
          content: event.payload.command,
          toolName: "system.bash",
          callId: event.payload.callId,
          execCommand: event.payload.command,
          execStdout: buffered?.stdout ?? "",
          execStderr: buffered?.stderr ?? "",
          timestamp,
          isComplete: false,
        });
        break;
      }
      case "exec_command_end": {
        const buffered = pendingExecOutputByCallId.get(event.payload.callId);
        ensureToolMessage(event.payload.callId, {
          turnId: ensureTurnId(currentTurnId),
          kind: "tool_call",
          content: event.payload.stdout ?? "",
          toolName: "system.bash",
          callId: event.payload.callId,
          execCommand:
            messages[toolMessageIndexByCallId.get(event.payload.callId) ?? -1]
              ?.execCommand ?? "",
          execStdout:
            event.payload.stdout ??
            buffered?.stdout ??
            messages[toolMessageIndexByCallId.get(event.payload.callId) ?? -1]
              ?.execStdout ??
            "",
          execStderr:
            event.payload.stderr ??
            buffered?.stderr ??
            messages[toolMessageIndexByCallId.get(event.payload.callId) ?? -1]
              ?.execStderr ??
            "",
          execExitCode: event.payload.exitCode,
          execDurationMs: event.payload.durationMs,
          timestamp,
          isComplete: true,
        });
        pendingExecOutputByCallId.delete(event.payload.callId);
        break;
      }
      case "tool_call_completed": {
        const toolIndex = toolMessageIndexByCallId.get(event.payload.callId);
        const toolMessage =
          toolIndex !== undefined ? messages[toolIndex] : undefined;
        if (toolMessage) {
          messages[toolIndex!] = {
            ...toolMessage,
            isComplete: true,
            timestamp,
          };
        }
        if (toolMessage?.execCommand) {
          break;
        }
        messages.push({
          id: event.id ?? `tool-result-${event.payload.callId}-${timestamp}`,
          turnId: ensureTurnId(currentTurnId),
          kind: "tool_result",
          content: event.payload.result,
          toolName: toolMessage?.toolName,
          callId: event.payload.callId,
          isError: event.payload.isError,
          timestamp,
        });
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
        const warning = formatWarning(event.payload);
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

  markAssistantComplete();
  return messages;
}
