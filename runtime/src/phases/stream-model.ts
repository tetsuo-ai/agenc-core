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
 *   - Calls `provider.chat()` synchronously (non-streaming). Streaming
 *     (`chatStream`) + the I-11 watchdog are wired in T7.
 *   - Emits `assistant_text` into the shared event channel via
 *     `session.emit()`.
 *   - Propagates provider errors as an abortive turn completion.
 *
 * @module
 */

import type { LLMMessage, LLMResponse } from "../llm/types.js";
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
  let response: LLMResponse;
  try {
    response = await session.services.provider.chat(messages, { signal });
  } catch (error) {
    throw new StreamModelError(error);
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
