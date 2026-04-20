/**
 * `query` — the single agent loop.
 *
 * Mirrors the shape of `openclaude/src/query.ts`: one `while(true)`
 * generator that calls the provider, dispatches tool calls, feeds
 * results back as tool messages, and terminates when the model stops
 * requesting tools or a budget is exhausted.
 *
 * No nested scopes, no `shouldContinueAfterStopGate` boolean gate, no
 * separate `evaluateTurnEndStopGate` dispatch. Continuation decisions
 * live inline as plain early-returns.
 *
 * The caller gets an async generator yielding streaming events. The
 * final yielded event is always a `turn_complete` carrying the final
 * assistant content + usage.
 *
 * @module
 */

import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMTool,
  LLMToolCall,
  LLMUsage,
} from "./llm/types.js";
import type { ToolRegistry, ToolDispatchResult } from "./tool-registry.js";

export interface QueryParams {
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly history?: readonly LLMMessage[];
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
}

export type QueryEvent =
  | { type: "turn_start"; turnIndex: number }
  | {
      type: "assistant_text";
      content: string;
      usage?: LLMUsage;
      model?: string;
    }
  | { type: "tool_call"; toolCall: LLMToolCall }
  | { type: "tool_result"; toolCall: LLMToolCall; result: ToolDispatchResult }
  | {
      type: "turn_complete";
      content: string;
      usage: LLMUsage;
      stopReason:
        | "completed"
        | "max_turns"
        | "cancelled"
        | "error"
        | "empty_response";
      error?: Error;
    };

const DEFAULT_MAX_TURNS = 100;

function cumulativeUsage(
  accumulator: LLMUsage,
  next: LLMUsage | undefined,
): LLMUsage {
  if (!next) return accumulator;
  return {
    promptTokens: accumulator.promptTokens + (next.promptTokens ?? 0),
    completionTokens:
      accumulator.completionTokens + (next.completionTokens ?? 0),
    totalTokens: accumulator.totalTokens + (next.totalTokens ?? 0),
  };
}

function assistantMessageFromResponse(response: LLMResponse): LLMMessage {
  return {
    role: "assistant",
    content: response.content,
    toolCalls:
      response.toolCalls && response.toolCalls.length > 0
        ? response.toolCalls
        : undefined,
  };
}

function toolResultMessage(
  toolCall: LLMToolCall,
  result: ToolDispatchResult,
): LLMMessage {
  return {
    role: "tool",
    toolCallId: toolCall.id,
    content: result.content,
  };
}

export async function* query(params: QueryParams): AsyncGenerator<QueryEvent> {
  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS;

  // Tools come from the registry but are passed to the provider at
  // construction time (see `GrokProviderConfig.tools`). The query loop
  // does not re-advertise them per-call — the provider already holds
  // the catalog. Keeping a reference here lets future tranches swap
  // the advertised subset mid-loop if we need a plan-mode restriction
  // or tool-search expansion.
  const _tools: LLMTool[] = params.registry.toLLMTools();
  void _tools;

  const messages: LLMMessage[] = [
    { role: "system", content: params.systemPrompt },
    ...(params.history ?? []),
    { role: "user", content: params.userMessage },
  ];

  let usage: LLMUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let turnIndex = 0;
  let lastContent = "";

  while (true) {
    if (params.signal?.aborted) {
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "cancelled",
      };
      return;
    }

    if (turnIndex >= maxTurns) {
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "max_turns",
      };
      return;
    }

    yield { type: "turn_start", turnIndex };

    let response: LLMResponse;
    try {
      response = await params.provider.chat(messages, {
        signal: params.signal,
      });
    } catch (error) {
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
      return;
    }

    usage = cumulativeUsage(usage, response.usage);
    if (response.content && response.content.length > 0) {
      lastContent = response.content;
      yield {
        type: "assistant_text",
        content: response.content,
        usage: response.usage,
        model: response.model,
      };
    }

    messages.push(assistantMessageFromResponse(response));

    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) {
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason:
          response.finishReason === "error"
            ? "error"
            : response.content.length === 0
              ? "empty_response"
              : "completed",
        error: response.error,
      };
      return;
    }

    for (const toolCall of toolCalls) {
      yield { type: "tool_call", toolCall };
      let result: ToolDispatchResult;
      try {
        result = await params.registry.dispatch(toolCall);
      } catch (error) {
        result = {
          content: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
          isError: true,
        };
      }
      yield { type: "tool_result", toolCall, result };
      messages.push(toolResultMessage(toolCall, result));
    }

    turnIndex += 1;
  }
}
