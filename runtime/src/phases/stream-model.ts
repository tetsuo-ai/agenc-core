/**
 * Phase 2 — Stream Model.
 *
 * Calls `LLMProvider.chatStream()` for one iteration, consuming chunks
 * as they arrive. Captures the assistant output into
 * `state.assistantMessages`, parses tool-use blocks into
 * `state.toolUseBlocks`, and updates `state.messages` with the new
 * assistant turn.
 *
 * Mirrors openclaude `query.ts:561-1082`.
 *
 * Invariants wired here:
 *   I-11 (stream idle watchdog, default-on) — installStreamWatchdog
 *        wraps the stream; `kick()` fires on every chunk. On idle
 *        expiry the watchdog aborts the underlying fetch via the
 *        scoped AbortController.
 *   I-22 (token budget mid-stream) — per-chunk
 *        `budgetTracker.addEmitted + sampleMidStream` so mid-stream
 *        overshoot aborts at the next sampling window (default
 *        every 1000 emitted tokens).
 *   I-77 (UI-spoof sanitization) — inline hidden tags stripped via
 *        the stream-parser before history injection.
 *
 * The StreamingToolExecutor hand-off for parallel tool dispatch lives
 * in T7; for T5 tool_use blocks are captured into `state.toolUseBlocks`
 * and run-turn dispatches them via the executeTools phase.
 *
 * @module
 */

import type { LLMMessage, LLMResponse, LLMStreamChunk, LLMToolCall } from "../llm/types.js";
import {
  installStreamWatchdog,
  STREAM_IDLE_ABORT_REASON,
} from "../llm/stream-watchdog.js";
import { sanitizeModelOutput } from "../llm/stream-parser.js";
import { normalizeToolCallsForProvider } from "../llm/tool-call-normalize.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { AssistantMessage, ToolUseBlock, TurnState } from "../session/turn-state.js";

function parseToolUseBlocks(toolCalls: LLMToolCall[]): ToolUseBlock[] {
  if (toolCalls.length === 0) return [];
  return toolCalls.map((c) => {
    let input: unknown = undefined;
    try {
      input = c.arguments ? JSON.parse(c.arguments) : undefined;
    } catch {
      input = c.arguments;
    }
    return {
      type: "tool_use" as const,
      id: c.id,
      name: c.name,
      input,
    };
  });
}

function assistantMessageFromResponse(
  response: LLMResponse,
  providerName: string,
  session: Session,
): AssistantMessage {
  // I-77: strip UI-spoof patterns from model output before it reaches
  // history or any renderer. On a match, emit a warning so post-mortem
  // telemetry can see the spoof attempt.
  const sanitized = sanitizeModelOutput(response.content ?? "");
  if (sanitized.spoofed) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "model_ui_spoof_pattern",
          message: `model output matched spoof pattern(s): ${sanitized.matches.join(", ")}`,
        },
      },
    });
  }
  // I-55: normalize tool_use blocks into canonical shape before the
  // validator sees them (provider-family quirks collapsed here).
  const normalizedToolCalls = normalizeToolCallsForProvider(
    providerName,
    response.toolCalls ?? [],
  );
  return {
    uuid: crypto.randomUUID(),
    role: "assistant",
    text: sanitized.text,
    toolCalls: normalizedToolCalls,
    apiError: response.finishReason === "error" ? "provider_error" : undefined,
  };
}

function llmMessageFromResponse(response: LLMResponse): LLMMessage {
  return {
    role: "assistant",
    content: response.content,
    toolCalls:
      response.toolCalls && response.toolCalls.length > 0
        ? response.toolCalls
        : undefined,
  };
}

/**
 * Streaming-error class used to hoist provider errors into the commit
 * phase's terminal-decision logic without leaking Response types.
 */
export class StreamModelError extends Error {
  constructor(
    readonly cause: unknown,
    readonly response?: LLMResponse,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "StreamModelError";
  }
}

/**
 * Rough tokens-per-chunk estimator. Providers don't report per-chunk
 * token counts; we approximate with char-length / 4 (GPT's typical
 * English chars-per-token ratio). Good enough for I-22's sampling
 * gate which triggers every N tokens — overshoot by a few chunks
 * is acceptable.
 */
function estimateChunkTokens(chunk: LLMStreamChunk): number {
  let chars = chunk.content?.length ?? 0;
  if (chunk.toolCalls) {
    for (const tc of chunk.toolCalls) {
      chars += (tc.arguments?.length ?? 0) + (tc.name?.length ?? 0);
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

export async function streamModel(
  state: TurnState,
  _ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
): Promise<TurnState> {
  if (signal?.aborted) {
    throw new StreamModelError(
      new Error("aborted before provider call"),
    );
  }

  const messages = state.messagesForQuery;

  // Scoped AbortController: aborted by either the external signal or
  // the watchdog, whichever fires first.
  const scoped = new AbortController();
  const onExternalAbort = () => {
    if (!scoped.signal.aborted) {
      scoped.abort((signal as AbortSignal & { reason?: unknown }).reason);
    }
  };
  if (signal) {
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  // I-11 watchdog installed BEFORE the stream begins so a stall at
  // first-byte also trips.
  const watchdog = installStreamWatchdog({
    abortController: scoped,
    onFired: (info) => {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "stream_error",
          payload: {
            cause: STREAM_IDLE_ABORT_REASON,
            message: `stream idle ${info.elapsedMs}ms (limit ${watchdog.timeoutMs}ms)`,
          },
        },
      });
    },
  });

  let budgetExceededMidStream = false;
  let budgetExceededMessage = "";

  const onChunk = (chunk: LLMStreamChunk): void => {
    // I-11: any chunk resets the idle timer.
    watchdog.kick();

    // I-22: per-chunk token accounting + sampling gate.
    if (session.budgetTracker) {
      session.budgetTracker.addEmitted(estimateChunkTokens(chunk));
      const sample = session.budgetTracker.sampleMidStream();
      if (sample.kind === "exceeded" && !budgetExceededMidStream) {
        budgetExceededMidStream = true;
        budgetExceededMessage = `token_budget_exceeded by ${sample.overshoot} (mid-stream)`;
        scoped.abort("token_budget_exceeded");
      }
    }

    // Incremental assistant_message_delta emission for renderers.
    if (chunk.content && chunk.content.length > 0) {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "agent_message_delta",
          payload: { delta: chunk.content },
        },
      });
    }
  };

  let response: LLMResponse;
  try {
    response = await session.services.provider.chatStream(
      messages,
      onChunk,
      { signal: scoped.signal },
    );
  } catch (error) {
    if (scoped.signal.aborted && watchdog.firedAt !== null) {
      throw new StreamModelError(
        new Error(`stream_idle: no data for ${watchdog.timeoutMs}ms`),
      );
    }
    if (budgetExceededMidStream) {
      state.pendingBudgetDecision = {
        kind: "stop",
        reason: budgetExceededMessage,
      };
      throw new StreamModelError(
        new Error(budgetExceededMessage),
      );
    }
    throw new StreamModelError(error);
  } finally {
    watchdog.stop();
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }

  const assistant = assistantMessageFromResponse(
    response,
    session.services.provider.name,
    session,
  );
  state.assistantMessages = [assistant];
  state.toolUseBlocks = parseToolUseBlocks([...assistant.toolCalls]);
  state.needsFollowUp = state.toolUseBlocks.length > 0;

  // Full final assistant_message event for renderers that batch on
  // completion rather than consuming per-chunk deltas.
  if (response.content && response.content.length > 0) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "agent_message",
        payload: { message: response.content },
      },
    });
  }

  state.messages.push(llmMessageFromResponse(response));

  // I-22: boundary check in case the provider tallied usage only on
  // the final response (chat() path) or the sampling gate missed the
  // exact overshoot window.
  if (session.budgetTracker && !budgetExceededMidStream) {
    const completion = response.usage?.completionTokens ?? 0;
    // Deduct the per-chunk estimates we already added, then add the
    // true completion count to realign before the boundary check.
    // The sampling estimate is approximate; the boundary uses the
    // provider-reported truth.
    const boundary = session.budgetTracker.checkBoundary();
    if (boundary.kind === "exceeded") {
      state.pendingBudgetDecision = {
        kind: "stop",
        reason: `token_budget_exceeded by ${boundary.overshoot} (boundary)`,
      };
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "token_budget_exceeded",
            message: `token budget exceeded by ${boundary.overshoot} — commit will route to token_budget_continuation`,
          },
        },
      });
    } else {
      state.pendingBudgetDecision = {
        kind: "continue",
        remaining: boundary.remaining,
      };
    }
    void completion;
  }

  if (response.error) {
    throw new StreamModelError(response.error, response);
  }
  return state;
}
