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

import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import { validateToolCallsForExecution } from "../llm/stream-parser.js";
import { StreamingToolExecutor } from "../tools/streaming-executor.js";
import { ToolCallRuntime } from "../tools/concurrency.js";
import type { Tool } from "../tools/types.js";
import { runToolUse, parseToolArgsWithBigInt } from "../tools/execution.js";
import { parseToolName } from "../tools/context.js";
import type { ToolDispatchResult } from "../tool-registry.js";
import { emitError as emitErrorEvent } from "../session/event-log.js";
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
  ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
): Promise<TurnState> {
  const assistant = state.assistantMessages.at(-1);
  if (!assistant || assistant.toolCalls.length === 0) return state;

  // I-54: validate every tool_use block shape BEFORE dispatch. Malformed
  // blocks (missing id/name/non-string arguments) emit stream_error
  // and are removed from the batch so dispatch only sees valid calls.
  const batch = validateToolCallsForExecution(assistant.toolCalls);
  if (batch.failures.length > 0) {
    for (const failure of batch.failures) {
      emitErrorEvent(session.eventLog, session.nextInternalSubId(), {
        cause: "malformed_tool_call",
        message: `provider returned malformed tool_use (${failure.cause})`,
        streamError: true,
        provider: session.services.provider.name,
      });
    }
  }
  const validCallIds = new Set(batch.valid.map((c) => c.id));
  const filteredToolCalls = assistant.toolCalls.filter((c) =>
    validCallIds.has(c.id),
  );
  if (filteredToolCalls.length === 0) {
    // All calls malformed — nothing to dispatch. Return so post-
    // sample recovery / continuation can route via the normal
    // `needsFollowUp` flow.
    state.needsFollowUp = false;
    return state;
  }

  // T7: shared ToolCallRuntime per-executor so ConcurrencyClass
  // dispatch (RwLock + per-serverId semaphore) gates the tool calls.
  const runtime = new ToolCallRuntime();

  // Construct (or reuse) the streaming executor. T7 upgrades the
  // T5 shell to a full openclaude port with ConcurrencyClass-aware
  // parallelism + Bash-only sibling abort + I-41 re-entrance guard.
  let executor = state.streamingToolExecutor as StreamingToolExecutor | null;
  if (!executor) {
    executor = new StreamingToolExecutor({
      registry: session.services.registry,
      abortSignal: signal,
      runtime,
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
      // T7: route dispatch through `runToolUse` so I-9 timeout +
      // I-15 cap + I-79 BigInt reviver are applied to every tool.
      runToolUseFn: async (
        toolCall: LLMToolCall,
        childSignal: AbortSignal,
      ): Promise<ToolDispatchResult> => {
        const tool = session.services.registry.tools.find(
          (t) => t.name === toolCall.name,
        ) as Tool | undefined;
        if (!tool) {
          return {
            content: JSON.stringify({ error: `unknown tool: ${toolCall.name}` }),
            isError: true,
          };
        }
        const parsed = parseToolArgsWithBigInt(toolCall.arguments ?? "");
        if (parsed === null) {
          return {
            content: JSON.stringify({
              error: `invalid JSON arguments for tool ${toolCall.name}`,
            }),
            isError: true,
          };
        }
        void parsed; // runToolUse re-parses; kept for early validation.
        const output = await runToolUse(toolCall.arguments ?? "", {
          ...(childSignal !== undefined ? { signal: childSignal } : {}),
          currentTurnId: ctx.subId,
          tool,
          invocation: {
            session,
            turn: ctx,
            tracker: {
              appendFileDiff: () => {},
              snapshot: () => [],
              clear: () => {},
            },
            callId: toolCall.id,
            toolName: parseToolName(toolCall.name),
            payload: { kind: "function", arguments: toolCall.arguments ?? "" },
            source: "direct",
          },
          eventLog: session.eventLog,
          subId: toolCall.id,
        });
        return { content: output.content, isError: output.isError };
      },
    });
    state.streamingToolExecutor = executor;
  }

  // Queue every VALID tool_use block (I-54 gate) into the executor.
  // ConcurrencyClass dispatch gates parallelism per tool.
  for (const call of filteredToolCalls) {
    const i = assistant.toolCalls.indexOf(call);
    const block = state.toolUseBlocks[i];
    if (!block) continue;
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
