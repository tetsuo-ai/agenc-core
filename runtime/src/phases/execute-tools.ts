/**
 * Phase 5 — Execute Tools.
 *
 * Dispatches tool calls produced by the stream phase through the
 * StreamingToolExecutor, collects results, and appends `tool` messages
 * to `state.messages` so the next iteration provides them to the
 * model.
 *
 * Mirrors openclaude `query.ts:1467-1635`. The executor accepts tool
 * calls mid-stream (openclaude query.ts:572 starts the executor
 * BEFORE streamModel returns and feeds tool_use blocks as they
 * arrive). T5's stream-model captures the complete tool-use block
 * list at stream end and hands them to the executor here; T7 rewires
 * the mid-stream `addTool()` path.
 *
 * Invariants touched:
 *   I-8  (every error site emits a typed event) — tool errors emit
 *        `tool_call_completed{isError}` events.
 *   I-21 (approval modal ⊥ abort race) — T7 wires the modal race via
 *        the executor's sibling-abort hook.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import { StreamingToolExecutor } from "../tools/streaming-executor.js";
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

  // Construct (or reuse) the streaming executor. T7 will reuse the
  // one built by stream-model mid-stream; T5 builds one here because
  // stream-model is non-streaming-tool-execution today.
  let executor = state.streamingToolExecutor as StreamingToolExecutor | null;
  if (!executor) {
    executor = new StreamingToolExecutor({
      registry: session.services.registry,
      abortSignal: signal,
      onSiblingAbort: (reason) => {
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: {
              cause: "sibling_tool_abort",
              message: `sibling tools cancelled: ${reason}`,
            },
          },
        });
      },
    });
    state.streamingToolExecutor = executor;
  }

  // Queue every tool_use block into the executor. The queue dispatches
  // sequentially (T5); T7 parallel-dispatches by ConcurrencyClass.
  for (let i = 0; i < assistant.toolCalls.length; i += 1) {
    const block = state.toolUseBlocks[i];
    const call = assistant.toolCalls[i];
    if (!block || !call) continue;
    if (signal?.aborted) break;

    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "tool_call_started",
        payload: {
          callId: call.id,
          toolName: call.name,
          args: call.arguments,
        },
      },
    });
    executor.addTool(block, call);
  }

  // Signal the executor that no more tools will arrive; drain results.
  executor.close();

  for await (const { toolCall, result } of executor.getRemainingResults()) {
    if (signal?.aborted) break;
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

  // Clear the executor from state so commit starts a fresh one next
  // iteration. Matches openclaude query.ts's per-iteration
  // `streamingToolExecutor = new StreamingToolExecutor(...)`.
  state.streamingToolExecutor = null;

  return state;
}
