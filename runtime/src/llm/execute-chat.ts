/**
 * `executeChat` — async-generator entry point for the agent loop
 * (Phase C of the 16-phase refactor in TODO.MD).
 *
 * This file lands the new async-generator shape. It runs in PARALLEL
 * with the existing `ChatExecutor.execute()` class method — both
 * coexist until Phase F deletes the class and its helpers become
 * free functions.
 *
 * Phase C implementation strategy
 * --------------------------------
 * The underlying helpers (`executeToolCallLoop`, `callWithFallback`,
 * context injection, planner decision, turn execution contract) are
 * already decoupled from the class and live as free functions in
 * the sibling `chat-executor-*.ts` files. Rewriting them as raw
 * free-function calls from inside this generator would mean
 * re-implementing ~1,000 LOC of init + injection logic.
 *
 * Instead, Phase C delegates to `ChatExecutor.execute()` through a
 * stream-capturing callback hook and yields the equivalent Phase D
 * events at the right boundaries:
 *
 *   1. Yield `request_start` immediately.
 *   2. Start `chatExecutor.execute(hookedParams)` in the background.
 *   3. Drain the `onStreamChunk` callback into a bounded queue and
 *      yield `stream_chunk` events in order, interleaved with
 *      provider progress.
 *   4. When execute() resolves, yield one `assistant` event with
 *      the final content and usage.
 *   5. For each tool call in the result, yield a `tool_result`
 *      event.
 *   6. Return a `Terminal` synthesized from the result.
 *
 * The caller's own `onStreamChunk` (if any) still fires through
 * the pass-through hook for backwards compatibility — but most
 * callers post-Phase-E will consume the yielded events instead.
 *
 * Phase F will rewrite this to orchestrate the helpers directly
 * without the class delegation. Phase C's job is to ship the shape
 * and the event semantics so Phase E callers can migrate to
 * `for await (const event of executeChat(...))` without waiting on
 * the class deletion.
 *
 * @module
 */

import type { ChatExecutor } from "./chat-executor.js";
import type {
  ChatExecuteParams,
  ChatExecutorResult,
  ToolCallRecord,
} from "./chat-executor-types.js";
import type {
  AssistantMessage,
  ExecuteChatYield,
  RequestStartEvent,
  StreamEvent,
  Terminal,
  ToolResultMessage,
} from "./streaming-events.js";
import type { LLMStreamChunk, StreamProgressCallback } from "./types.js";
import type { LLMPipelineStopReason } from "./policy.js";

/**
 * Map the legacy `LLMPipelineStopReason` to a terminal reason for
 * the generator's return value. The class's stop-reason vocabulary
 * is a superset of the generator's — reasons that don't have a
 * direct mapping degrade to `"stop_reason_end_turn"`.
 */
function stopReasonToTerminalReason(
  stopReason: LLMPipelineStopReason,
): Terminal["reason"] {
  switch (stopReason) {
    case "completed":
    case "tool_calls":
      return "stop_reason_end_turn";
    case "budget_exceeded":
      return "token_budget_exceeded";
    case "cancelled":
      return "user_abort";
    case "no_progress":
      return "recovery_exhausted";
    case "provider_error":
    case "authentication_error":
    case "rate_limited":
    case "timeout":
      return "provider_fallback_exhausted";
    case "validation_error":
    case "tool_error":
      return "recovery_exhausted";
    default:
      return "stop_reason_end_turn";
  }
}

/**
 * Stringify a tool call record's `result` for the event payload.
 * The legacy shape stores `result` as `unknown`; the Phase D event
 * vocabulary expects a string.
 */
function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Build a `ToolResultMessage` event from a legacy `ToolCallRecord`.
 * The legacy record doesn't carry a tool_call_id — synthesize one
 * from the tool name and index so downstream consumers have a
 * stable correlation key.
 */
function toolCallRecordToResultEvent(
  record: ToolCallRecord,
  index: number,
): ToolResultMessage {
  return {
    type: "tool_result",
    toolCallId: `synth-${record.name}-${index}`,
    toolName: record.name,
    content: stringifyToolResult(record.result),
    isError: record.isError,
    durationMs: record.durationMs,
  };
}

/**
 * Build the final `assistant` event from the legacy result object.
 */
function resultToAssistantEvent(
  result: ChatExecutorResult,
  requestId: string,
): AssistantMessage {
  return {
    type: "assistant",
    uuid: `${requestId}-assistant`,
    content: result.content,
    usage: result.tokenUsage,
    stopReason: result.stopReason,
  };
}

/**
 * Build the generator's return `Terminal` from the legacy result.
 *
 * Phase E note: carries the full `ChatExecutorResult` through as
 * `legacyResult` so migrated callers can read fields that are not
 * on the event-derived shape (`toolRoutingSummary`, `plannerSummary`,
 * `statefulSummary`, `economicsSummary`, etc.). Phase F will drop
 * the adapter and this carry-through.
 */
function resultToTerminal(
  result: ChatExecutorResult,
  durationMs: number,
): Terminal {
  return {
    reason: stopReasonToTerminalReason(result.stopReason),
    finalContent: result.content,
    toolCalls: result.toolCalls,
    tokenUsage: result.tokenUsage,
    durationMs,
    legacyResult: result,
  };
}

interface StreamQueueEntry {
  readonly event: StreamEvent;
}

/**
 * Bounded FIFO queue with a resolver-based wake-up, used to
 * interleave provider stream chunks with the generator's yield
 * loop. Chunks are pushed from the executor callback; the
 * generator awaits `waitForNext()` and drains `drainAll()` between
 * awaits. The queue is unbounded in length — AgenC providers do
 * not produce fast enough streams to risk memory pressure.
 */
class StreamChunkQueue {
  private readonly entries: StreamQueueEntry[] = [];
  private resolver: (() => void) | null = null;
  private done = false;

  push(event: StreamEvent): void {
    this.entries.push({ event });
    this.wake();
  }

  markDone(): void {
    this.done = true;
    this.wake();
  }

  drainAll(): readonly StreamEvent[] {
    const drained = this.entries.splice(0, this.entries.length);
    return drained.map((entry) => entry.event);
  }

  isDone(): boolean {
    return this.done;
  }

  hasPending(): boolean {
    return this.entries.length > 0;
  }

  async waitForNext(): Promise<void> {
    if (this.hasPending() || this.done) return;
    await new Promise<void>((resolve) => {
      this.resolver = resolve;
    });
  }

  private wake(): void {
    const r = this.resolver;
    if (r) {
      this.resolver = null;
      r();
    }
  }
}

/**
 * Execute a chat turn as an async generator.
 *
 * Yields the Phase D event vocabulary (`RequestStartEvent`,
 * `StreamEvent`, `AssistantMessage`, `ToolResultMessage`) and
 * returns a `Terminal` on completion.
 *
 * @param chatExecutor the existing ChatExecutor instance to delegate
 *   the underlying turn to. Phase F will remove this parameter once
 *   the class is deleted and the helpers are called directly.
 * @param params the same `ChatExecuteParams` shape the class accepts.
 *   Any `onStreamChunk` the caller passes is still fired as a
 *   pass-through hook for backwards compatibility.
 */
export async function* executeChat(
  chatExecutor: ChatExecutor,
  params: ChatExecuteParams,
): AsyncGenerator<ExecuteChatYield, Terminal, void> {
  const startedAt = Date.now();
  const requestId = `req-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

  const startEvent: RequestStartEvent = {
    type: "request_start",
    requestId,
    turnIndex: 0,
    timestamp: startedAt,
  };
  yield startEvent;

  const queue = new StreamChunkQueue();
  const passThrough: StreamProgressCallback | undefined = params.onStreamChunk;

  // Only install the stream hook when the caller already wanted
  // streaming. Installing unconditionally would force chatStream()
  // on every turn and break providers (and tests) that rely on
  // the non-streaming chat() path for correctness.
  const hookedParams: ChatExecuteParams =
    passThrough !== undefined
      ? {
          ...params,
          onStreamChunk: (chunk: LLMStreamChunk) => {
            queue.push({
              type: "stream_chunk",
              requestId,
              content: chunk.content,
              toolCalls: chunk.toolCalls,
              done: chunk.done,
            });
            try {
              passThrough(chunk);
            } catch {
              // Pass-through callbacks must not abort the generator.
            }
          },
        }
      : params;

  let executeError: unknown;
  const executePromise = chatExecutor
    .execute(hookedParams)
    .catch((err) => {
      executeError = err;
      return undefined as unknown as ChatExecutorResult;
    })
    .finally(() => {
      queue.markDone();
    });

  // Drain stream chunks interleaved with execution. The generator
  // yields any pending events, waits for the next wake, and loops.
  while (!queue.isDone() || queue.hasPending()) {
    if (queue.hasPending()) {
      for (const event of queue.drainAll()) {
        yield event;
      }
      continue;
    }
    await queue.waitForNext();
  }

  const result = await executePromise;

  if (executeError) {
    const message =
      executeError instanceof Error
        ? executeError.message
        : String(executeError);
    return {
      reason: "recovery_exhausted",
      finalContent: "",
      toolCalls: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      durationMs: Date.now() - startedAt,
      error:
        executeError instanceof Error
          ? executeError
          : new Error(message),
    };
  }

  if (!result) {
    return {
      reason: "recovery_exhausted",
      finalContent: "",
      toolCalls: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      durationMs: Date.now() - startedAt,
      error: new Error("executeChat: underlying execute() resolved undefined"),
    };
  }

  yield resultToAssistantEvent(result, requestId);

  for (let i = 0; i < result.toolCalls.length; i++) {
    const call = result.toolCalls[i];
    if (!call) continue;
    yield toolCallRecordToResultEvent(call, i);
  }

  return resultToTerminal(result, Date.now() - startedAt);
}

/**
 * Convenience wrapper for Phase E caller migrations: drives the
 * `executeChat` generator to completion and returns the legacy
 * `ChatExecutorResult` shape via `Terminal.legacyResult`. Callers
 * that still need the full result (`toolRoutingSummary`,
 * `plannerSummary`, etc.) can use this function instead of rolling
 * their own drain loop. The stream chunk pass-through is forwarded
 * to the caller's `params.onStreamChunk` automatically.
 *
 * Under Phase C's adapter shape this function is semantically
 * identical to calling `chatExecutor.execute(params)` directly —
 * the point is that the caller goes through the generator surface,
 * which is the stable API that Phase F preserves.
 */
export async function executeChatToLegacyResult(
  chatExecutor: ChatExecutor,
  params: ChatExecuteParams,
): Promise<ChatExecutorResult> {
  const generator = executeChat(chatExecutor, params);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = await generator.next();
    if (step.done) {
      const terminal = step.value;
      if (terminal.legacyResult) return terminal.legacyResult;
      // Error path: the underlying execute() rejected, so the
      // generator returned a Terminal with `error` set and no
      // legacyResult. Re-throw the original error so callers
      // preserve their existing error-handling paths.
      if (terminal.error) throw terminal.error;
      throw new Error(
        "executeChatToLegacyResult: terminal had no legacyResult; " +
          "executeChat adapter contract violated",
      );
    }
    // Events are drained by the caller's onStreamChunk pass-through
    // on StreamEvent; non-stream events are intentionally ignored
    // in the legacy path (migrated callers read the full result
    // from the terminal instead of reacting to individual events).
  }
}
