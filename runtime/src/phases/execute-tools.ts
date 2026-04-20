/**
 * Phase 5 — Execute Tools.
 *
 * Dispatches tool calls produced by the stream phase, collects results,
 * and appends `tool` messages to `state.messages` so the next iteration
 * provides them to the model.
 *
 * Mirrors openclaude query.ts:1467-1635 (the tool-dispatch loop — when
 * streaming-tool-execution is on, this awaits the pre-dispatched
 * StreamingToolExecutor; when off, it iterates tool-use blocks
 * sequentially).
 *
 * T5 scope:
 *   - Sequential dispatch via `session.services.registry.dispatch`.
 *   - Emits `tool_call_started` / `tool_call_completed` events.
 *   - No StreamingToolExecutor, no parallelism, no cancellation cascade.
 *   - T7 (tool runtime) wires the real parallel executor + I-11 +
 *     per-tool approval gate.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type { ToolDispatchResult } from "../tool-registry.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState, UserMessage } from "../session/turn-state.js";

function toolResultMessage(
  callId: string,
  result: ToolDispatchResult,
): LLMMessage {
  return {
    role: "tool",
    toolCallId: callId,
    content: result.content,
  };
}

function toolResultUserRecord(
  callId: string,
  toolName: string,
  result: ToolDispatchResult,
): UserMessage {
  return {
    uuid: crypto.randomUUID(),
    role: "user",
    toolCallId: callId,
    toolName,
    content: result.content,
  };
}

export async function executeTools(
  state: TurnState,
  _ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
): Promise<TurnState> {
  const assistant = state.assistantMessages.at(-1);
  if (!assistant || assistant.toolCalls.length === 0) return state;

  for (const toolCall of assistant.toolCalls) {
    if (signal?.aborted) return state;

    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "tool_call_started",
        payload: {
          callId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,
        },
      },
    });

    let result: ToolDispatchResult;
    try {
      result = await session.services.registry.dispatch(toolCall);
    } catch (error) {
      result = {
        content: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        isError: true,
      };
    }

    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: toolCall.id,
          result: result.content,
          isError: result.isError === true,
        },
      },
    });

    state.toolResults.push(
      toolResultUserRecord(toolCall.id, toolCall.name, result),
    );
    state.messages.push(toolResultMessage(toolCall.id, result));
  }

  return state;
}
