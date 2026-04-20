/**
 * Phase 2 — Stream Model.
 *
 * Calls the LLM provider for one iteration. Captures the assistant
 * output into `state.assistantMessages`, parses tool-use blocks into
 * `state.toolUseBlocks`, and updates `state.messages` with the new
 * assistant turn.
 *
 * Mirrors openclaude query.ts:561-1082.
 *
 * T5 scope:
 *   - Calls `provider.chat()` synchronously (non-streaming). T7 rewires
 *     to `chatStream` with per-chunk watchdog kicks. Until then the
 *     I-11 stream watchdog is armed as a total-call timeout around the
 *     single `chat()` promise so a silently-stalled provider aborts at
 *     `STREAM_IDLE_TIMEOUT_MS` (default 90s) rather than hanging on
 *     TCP keepalive (minutes to hours).
 *   - Emits `assistant_text` into the shared event channel via
 *     `session.emit()`.
 *   - Propagates provider errors as an abortive turn completion.
 *
 * Invariants wired here:
 *   I-11 (stream idle watchdog, default-on) — installStreamWatchdog
 *        wraps provider.chat(). Abort reason `stream_idle`.
 *
 * @module
 */

import type { LLMMessage, LLMResponse } from "../llm/types.js";
import {
  installStreamWatchdog,
  STREAM_IDLE_ABORT_REASON,
} from "../llm/stream-watchdog.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { AssistantMessage, ToolUseBlock, TurnState } from "../session/turn-state.js";

function parseToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  const calls = response.toolCalls ?? [];
  if (calls.length === 0) return [];
  return calls.map((c) => {
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
): AssistantMessage {
  return {
    uuid: crypto.randomUUID(),
    role: "assistant",
    text: response.content,
    toolCalls: response.toolCalls ?? [],
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

  // I-11: install the stream idle watchdog. For the T5 non-streaming
  // chat() call the watchdog fires as a total-call timeout; T7 will
  // call `kick()` per chunk once chatStream wires in.
  //
  // We create a scoped AbortController that is aborted either by the
  // external signal (propagated) or by the watchdog (on idle expiry).
  // The merged controller's signal is what provider.chat() observes.
  const scoped = new AbortController();
  const onExternalAbort = () => {
    if (!scoped.signal.aborted) {
      scoped.abort((signal as AbortSignal & { reason?: unknown }).reason);
    }
  };
  if (signal) {
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const watchdog = installStreamWatchdog({
    abortController: scoped,
    onFired: (info) => {
      // I-8: every error site emits a typed event.
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

  let response: LLMResponse;
  try {
    response = await session.services.provider.chat(messages, {
      signal: scoped.signal,
    });
  } catch (error) {
    // If the abort fired from the watchdog, surface it as a typed
    // stream-idle error rather than the underlying fetch abort so
    // phase 3 recovery (T8) can route correctly.
    if (scoped.signal.aborted && watchdog.firedAt !== null) {
      throw new StreamModelError(
        new Error(`stream_idle: no data for ${watchdog.timeoutMs}ms`),
      );
    }
    throw new StreamModelError(error);
  } finally {
    watchdog.stop();
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }

  // I-22: token budget check. T7 rewires per-chunk sampling during
  // chatStream; for the T5 non-streaming chat() we tally the whole
  // response at once and do a boundary check. If the cumulative tokens
  // overshoot the budget, stash the decision on state so the commit
  // phase (T8 recovery) can route to token_budget_continuation.
  if (session.budgetTracker) {
    const completion = response.usage?.completionTokens ?? 0;
    session.budgetTracker.addEmitted(completion);
    const decision = session.budgetTracker.checkBoundary();
    if (decision.kind === "exceeded") {
      state.pendingBudgetDecision = {
        kind: "stop",
        reason: `token_budget_exceeded by ${decision.overshoot}`,
      };
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "token_budget_exceeded",
            message: `token budget exceeded by ${decision.overshoot} — commit phase will route to token_budget_continuation`,
          },
        },
      });
    } else {
      state.pendingBudgetDecision = {
        kind: "continue",
        remaining: decision.remaining,
      };
    }
  }

  const assistant = assistantMessageFromResponse(response);
  state.assistantMessages = [assistant];
  state.toolUseBlocks = parseToolUseBlocks(response);
  state.needsFollowUp = state.toolUseBlocks.length > 0;

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

  // T8: stream-error classification + recovery ladder entry points.
  // T7: replace with streaming chatStream + I-11 watchdog.
  if (response.error) {
    throw new StreamModelError(response.error, response);
  }
  return state;
}
