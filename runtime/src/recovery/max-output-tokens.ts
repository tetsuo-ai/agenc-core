/**
 * Max-output-tokens recovery (escalate + continuation).
 *
 * Hand-port of agenc `query.ts:1221-1291`. When a stream's
 * assistant message is withheld because it hit the provider's
 * max_output_tokens limit, two recovery paths apply:
 *
 *   1. **Escalate** (1221-1255) — first attempt only (override
 *      unset): set `maxOutputTokensOverride = 64_000`, re-enter
 *      Phase 1. No meta message needed — same request, bigger ceiling.
 *
 *   2. **Continuation** (1257-1291) — escalate already fired (or
 *      caller opted out). Inject "Resume directly — do not apologize"
 *      meta message, bump `maxOutputTokensRecoveryCount`, re-enter
 *      Phase 1. Capped at `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`.
 *
 * After both exhaust, the turn surfaces the error.
 *
 * T8: both recovery paths discard + recreate the StreamingToolExecutor
 * before the next iteration. The truncated assistant batch that hit
 * `max_output_tokens` may have emitted partial `tool_use` blocks that
 * never reached the executor's completion state, so we treat the
 * executor as poisoned on every max-output-tokens recovery path.
 *
 * @module
 */

import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import { emitWarning } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";
import type { StreamingToolExecutor } from "./_deps/streaming-executor.js";
import {
  appendTerminalToolResults,
  buildTerminalToolResult,
} from "./terminal-tool-result.js";
import { ESCALATED_MAX_OUTPUT_TOKENS } from "../llm/openai-compatible-token-limits.js";
import {
  classifyUntrustedToolResult,
  frameUntrustedToolResultContent,
} from "../tools/untrusted-tool-result-framing.js";

export const MAX_OUTPUT_TOKENS_ESCALATED = ESCALATED_MAX_OUTPUT_TOKENS;
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

const RESUME_META_CONTENT =
  "Continue generating directly from where you left off. Do not apologize, do not restart, do not add preamble. Pick up at the next token.";

export type MaxOutputTokensOutcome =
  | { readonly kind: "escalate" }
  | { readonly kind: "continuation" }
  | { readonly kind: "exhausted"; readonly reason: string }
  | { readonly kind: "not_applicable" };

export interface RunMaxOutputTokensOpts {
  readonly session: Session;
  readonly state: TurnState;
  /** Whether this call should retry the same request at the escalated ceiling. */
  readonly escalateAllowed?: boolean;
  readonly escalatedMaxOutputTokens?: number;
}

/**
 * T8: discard the in-flight StreamingToolExecutor and null the state
 * slot so the next phase iteration builds a fresh executor. Matches
 * the model-fallback pattern. Idempotent via the I-41 re-entrance
 * guard on `executor.discard`.
 */
function discardExecutorForMaxOutputTokens(
  session: Session,
  state: TurnState,
  opts: { readonly appendCompletedHistory?: boolean } = {},
): void {
  const executor = state.streamingToolExecutor as StreamingToolExecutor | null;
  if (executor !== null && executor !== undefined) {
    emitMaxOutputCompletedExecutorResults(session, state, executor, opts);
  }
  appendTerminalToolResults(
    state,
    "aborted",
    "max_output_tokens recovery aborted in-flight tool execution",
  );
  if (executor !== null && executor !== undefined) {
    emitMaxOutputExecutorClosures(session, state, executor, opts);
    try {
      (executor as { discard: (reason?: string) => void }).discard(
        "max_output_tokens",
      );
    } catch {
      /* I-41: re-entrance guard absorbs a second discard */
    }
  }
  state.streamingToolExecutor = null;
  emitWarning(
    session.eventLog,
    session.nextInternalSubId(),
    "executor_discarded",
    "max_output_tokens",
  );
}

function emitMaxOutputCompletedExecutorResults(
  session: Session,
  state: TurnState,
  executor: StreamingToolExecutor,
  opts: { readonly appendCompletedHistory?: boolean },
): void {
  const getCompletedResults = (executor as {
    getCompletedResults?: () => Iterable<{
      readonly toolCall: {
        readonly id: string;
        readonly name: string;
        readonly arguments: string;
      };
      readonly result: {
        readonly content: string;
        readonly isError?: boolean;
        readonly metadata?: Record<string, unknown>;
      };
    }>;
  }).getCompletedResults;
  if (typeof getCompletedResults !== "function") return;

  for (const completed of getCompletedResults.call(executor)) {
    const metadata = completed.result.metadata;
    if (opts.appendCompletedHistory === true) {
      appendCompletedExecutorResultHistory(session, state, completed);
    }
    state.completedToolResults.push({
      callId: completed.toolCall.id,
      toolName: completed.toolCall.name,
      arguments: completed.toolCall.arguments,
      content: completed.result.content,
      isError: completed.result.isError === true,
      ...(metadata !== undefined ? { metadata } : {}),
    });
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: completed.toolCall.id,
          result: completed.result.content,
          isError: completed.result.isError === true,
          ...(metadata !== undefined ? { metadata } : {}),
        },
      },
    });
  }
}

function appendCompletedExecutorResultHistory(
  session: Session,
  state: TurnState,
  completed: {
    readonly toolCall: LLMToolCall;
    readonly result: { readonly content: string };
  },
): void {
  const alreadyRecorded = state.messages.some(
    (message) =>
      message.role === "tool" &&
      message.toolCallId === completed.toolCall.id,
  );
  if (alreadyRecorded) return;
  appendMissingAssistantToolCalls(state, [completed.toolCall]);
  const modelFacingContent = modelFacingToolResultContent(
    session,
    completed.toolCall.name,
    completed.result.content,
  );
  state.toolResults.push({
    uuid: crypto.randomUUID(),
    role: "user",
    toolCallId: completed.toolCall.id,
    toolName: completed.toolCall.name,
    content: modelFacingContent,
  });
  state.messages.push({
    role: "tool",
    toolCallId: completed.toolCall.id,
    toolName: completed.toolCall.name,
    content: modelFacingContent,
  });
}

function modelFacingToolResultContent(
  session: Session,
  toolName: string,
  content: LLMMessage["content"],
): LLMMessage["content"] {
  const registeredTool = session.services?.registry?.tools.find(
    (tool) => tool.name === toolName,
  );
  return frameUntrustedToolResultContent(
    toolName,
    content,
    classifyUntrustedToolResult(toolName, registeredTool),
  );
}

function appendMissingAssistantToolCalls(
  state: Pick<TurnState, "messages">,
  toolCalls: readonly LLMToolCall[],
): void {
  const missing: LLMToolCall[] = [];
  for (const toolCall of toolCalls) {
    const alreadyPresent = state.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls?.some((call) => call.id === toolCall.id) === true,
    );
    if (!alreadyPresent) {
      missing.push({ ...toolCall });
    }
  }
  if (missing.length === 0) return;
  state.messages.push({
    role: "assistant",
    content: "",
    toolCalls: missing,
  });
}

function emitMaxOutputExecutorClosures(
  session: Session,
  state: TurnState,
  executor: StreamingToolExecutor,
  opts: { readonly appendCompletedHistory?: boolean },
): void {
  const getToolStates = (executor as {
    getToolStates?: () => ReadonlyArray<{
      readonly id: string;
      readonly status: string;
      readonly toolName: string;
      readonly toolCall: {
        readonly id: string;
        readonly name: string;
        readonly arguments: string;
      };
    }>;
  }).getToolStates;
  if (typeof getToolStates !== "function") return;

  const completedIds = new Set<string>();
  for (const result of state.completedToolResults) {
    completedIds.add(result.callId);
  }
  for (const result of state.toolResults) {
    if (
      "toolCallId" in result &&
      typeof result.toolCallId === "string" &&
      result.toolCallId.length > 0
    ) {
      completedIds.add(result.toolCallId);
    }
  }
  for (const message of state.messages) {
    if (
      message.role === "tool" &&
      typeof message.toolCallId === "string" &&
      message.toolCallId.length > 0
    ) {
      completedIds.add(message.toolCallId);
    }
  }

  for (const tool of getToolStates.call(executor)) {
    if (tool.status === "yielded" || completedIds.has(tool.id)) continue;
    const result = {
      ...buildTerminalToolResult({
        toolCall: tool.toolCall,
        cause: "aborted",
        detail: "max_output_tokens recovery discarded streamed tool execution",
      }),
      metadata: { cause: "max_output_tokens" },
    };
    if (
      opts.appendCompletedHistory === true &&
      shouldAppendTerminalExecutorClosureHistory(session, tool)
    ) {
      appendTerminalExecutorClosureHistory(session, state, tool, result);
    }
    completedIds.add(tool.id);
    state.completedToolResults.push({
      callId: tool.id,
      toolName: tool.toolName,
      arguments: tool.toolCall.arguments ?? "",
      content: result.content,
      isError: true,
      metadata: result.metadata,
    });
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: tool.id,
          result: result.content,
          isError: true,
          metadata: result.metadata,
        },
      },
    });
  }
}

function shouldAppendTerminalExecutorClosureHistory(
  session: Session,
  tool: { readonly toolName: string; readonly toolCall: LLMToolCall },
): boolean {
  const services = (session as Partial<Session> & {
    readonly services?: {
      readonly registry?: {
        readonly tools?: ReadonlyArray<{
          readonly name: string;
          readonly isReadOnly?: boolean;
          readonly metadata?: { readonly mutating?: boolean };
          readonly requiresUserInteraction?: () => boolean;
        }>;
      };
    };
  }).services;
  const registeredTool = services?.registry?.tools?.find(
    (candidate) =>
      candidate.name === tool.toolName || candidate.name === tool.toolCall.name,
  );
  if (registeredTool === undefined) return true;
  try {
    if (registeredTool.requiresUserInteraction?.() === true) return true;
  } catch {
    return true;
  }
  return !(
    registeredTool.isReadOnly === true ||
    registeredTool.metadata?.mutating === false
  );
}

function appendTerminalExecutorClosureHistory(
  session: Session,
  state: TurnState,
  tool: {
    readonly id: string;
    readonly toolName: string;
    readonly toolCall: LLMToolCall;
  },
  result: { readonly content: string },
): void {
  const alreadyRecorded = state.messages.some(
    (message) => message.role === "tool" && message.toolCallId === tool.id,
  );
  if (alreadyRecorded) return;
  appendMissingAssistantToolCalls(state, [tool.toolCall]);
  const modelFacingContent = modelFacingToolResultContent(
    session,
    tool.toolName,
    result.content,
  );
  state.toolResults.push({
    uuid: crypto.randomUUID(),
    role: "user",
    toolCallId: tool.id,
    toolName: tool.toolName,
    content: modelFacingContent,
  });
  state.messages.push({
    role: "tool",
    toolCallId: tool.id,
    toolName: tool.toolName,
    content: modelFacingContent,
  });
}

function removeTruncatedAssistantForRetry(state: TurnState): void {
  // Escalation retries the same request with a larger output ceiling.
  // Do not carry the truncated assistant/tool batch into that retry.
  state.messages = [...state.messagesForQuery];
  state.assistantMessages = [];
  state.toolUseBlocks = [];
  state.toolResults = [];
  state.needsFollowUp = false;
}

/**
 * Decide + mutate state for the next iteration. Called by phase-3
 * post-sample-recovery after `isWithheldMaxOutputTokens` fires.
 *
 * State mutations:
 *   - escalate: sets `state.maxOutputTokensOverride`, marks transition
 *   - continuation: appends meta message, bumps counter, marks transition
 *   - exhausted: no state change (caller surfaces the error)
 *
 * Both escalate and continuation additionally discard+recreate the
 * StreamingToolExecutor and emit `executor_discarded` telemetry.
 */
export function runMaxOutputTokensRecovery(
  opts: RunMaxOutputTokensOpts,
): MaxOutputTokensOutcome {
  const { session, state } = opts;
  const overrideUnset = state.maxOutputTokensOverride === undefined;
  const escalateAllowed = opts.escalateAllowed !== false;

  // Step 1: escalate path — first attempt, override unset.
  if (overrideUnset && escalateAllowed) {
    state.maxOutputTokensOverride =
      opts.escalatedMaxOutputTokens ?? ESCALATED_MAX_OUTPUT_TOKENS;
    state.transition = { reason: "max_output_tokens_escalate" };
    discardExecutorForMaxOutputTokens(session, state);
    removeTruncatedAssistantForRetry(state);
    return { kind: "escalate" };
  }

  // Step 2: continuation path — bump counter if under the cap.
  if (state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    discardExecutorForMaxOutputTokens(session, state, {
      appendCompletedHistory: true,
    });
    const metaMessage: LLMMessage = {
      role: "user",
      content: RESUME_META_CONTENT,
    };
    state.messages.push(metaMessage);
    state.maxOutputTokensRecoveryCount += 1;
    state.transition = { reason: "max_output_tokens_recovery" };
    return { kind: "continuation" };
  }

  // Step 3: cap exhausted. Surface the error.
  return {
    kind: "exhausted",
    reason: `max_output_tokens_recovery_limit (${MAX_OUTPUT_TOKENS_RECOVERY_LIMIT})`,
  };
}
