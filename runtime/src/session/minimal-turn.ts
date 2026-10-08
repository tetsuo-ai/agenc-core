/** One-shot bypass turn loop. Session data is finalized once at the terminal boundary. */
import type { LLMMessage } from "../llm/types.js";
import type { PhaseEvent } from "../phases/events.js";
import { buildProviderOptions } from "../phases/stream-model.js";
import type { Terminal } from "./turn-state.js";
import type { Session } from "./session.js";
import type { TurnContext } from "./turn-context.js";
import { buildPrompt, builtTools } from "./run-turn-sampling-request.js";
import { llmMessageToResponseItem } from "./message-history-conversion.js";

const UNKNOWN_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0,
  availability: "unknown" as const, provenance: "synthetic" as const };

export async function* runMinimalTurn(
  session: Session,
  ctx: TurnContext,
  messages: LLMMessage[],
  instructions: string,
  signal: AbortSignal,
): AsyncGenerator<PhaseEvent, Terminal> {
  // Resolve the catalog, prompt, options and owner once for the whole turn.
  const request = buildPrompt(messages, builtTools(session, ctx), ctx, instructions);
  let options = buildProviderOptions(request, ctx, signal, session);
  const start = messages.length - 1;
  yield { type: "turn_start", turnIndex: 0 };
  try {
    for (;;) {
      signal.throwIfAborted();
      const response = await session.services.provider.chatStream(messages, () => {}, options);
      signal.throwIfAborted();
      messages.push({ role: "assistant", content: response.content,
        ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
        ...(response.providerReasoningContent !== undefined ? { providerReasoningContent: response.providerReasoningContent } : {}),
        ...(response.providerReasoningProvenance !== undefined ? { providerReasoningProvenance: response.providerReasoningProvenance } : {}),
      });
      if (response.toolCalls.length === 0) {
        if (response.content) {
          session.emit({ id: session.nextInternalSubId(), msg: { type: "agent_message", payload: { message: response.content } } });
          yield { type: "assistant_text", content: response.content };
        }
        yield { type: "turn_complete", content: response.content, usage: UNKNOWN_USAGE, stopReason: "completed" };
        return { reason: "completed" };
      }
      for (const call of response.toolCalls) {
        signal.throwIfAborted();
        let content: string;
        try {
          const result = await session.services.registry.dispatch(call, {
            abortSignal: signal, advertisedToolNames: options.tools?.map(tool => tool.function.name),
          });
          content = result.content;
        } catch (error) {
          signal.throwIfAborted();
          content = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        }
        messages.push({ role: "tool", toolName: call.name, toolCallId: call.id, content });
      }
      // Discovery can reveal new capabilities during this turn.
      options = { ...options, tools: builtTools(session, ctx) };
    }
  } finally {
    // The one-shot crash contract buffers this run; serialization redacts at close.
    await session.state.with(state => { state.history = messages; });
    const store = session.rolloutStore?.store;
    for (const message of messages.slice(start)) {
      store?.appendRollout({ type: "response_item", payload: llmMessageToResponseItem(message) });
    }
  }
}
