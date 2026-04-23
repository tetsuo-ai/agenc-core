/**
 * Subagent-fork stub for compact's cache-sharing path.
 *
 * Upstream openclaude runs the compaction summary inside a forked
 * subagent so the parent's cache key is reused. The gut runtime owns
 * its own subagent surface in `runtime/src/agents/`; this stub
 * delegates straight to the configured LLM provider via
 * `_deps/api-client.ts::queryModelWithStreaming`, sacrificing cache
 * sharing for now in exchange for cutting compact off from
 * `utils/forkedAgent.js` and its transitive openclaude graph.
 */

import { queryModelWithStreaming } from "./api-client.js";

export interface CacheSafeParams {
  readonly systemPrompt: unknown;
  readonly userContext?: Record<string, string>;
  readonly systemContext?: Record<string, string>;
  readonly tools?: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
}

export interface RunForkedAgentArgs {
  readonly promptMessages: ReadonlyArray<unknown>;
  readonly cacheSafeParams: CacheSafeParams;
  readonly canUseTool?: unknown;
  readonly querySource?: string;
  readonly forkLabel?: string;
  readonly signal?: AbortSignal;
  readonly maxOutputTokensOverride?: number;
  readonly model?: string;
  readonly [key: string]: unknown;
}

export interface RunForkedAgentResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly messages: any[];
  readonly totalUsage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens: number;
    readonly cache_read_input_tokens: number;
  };
}

export async function runForkedAgent(
  args: RunForkedAgentArgs,
): Promise<RunForkedAgentResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let assistantMessage: any = null;
  let inputTokens = 0;
  let outputTokens = 0;
  const queryArgs: Parameters<typeof queryModelWithStreaming>[0] = {
    messages: args.promptMessages,
    systemPrompt: args.cacheSafeParams.systemPrompt,
    tools: args.cacheSafeParams.tools ?? [],
    ...(args.signal ? { signal: args.signal } : {}),
    options: {
      ...(args.model ? { model: args.model } : {}),
      ...(args.maxOutputTokensOverride
        ? { maxOutputTokensOverride: args.maxOutputTokensOverride }
        : {}),
      ...(args.querySource ? { querySource: args.querySource } : {}),
    },
  };
  for await (const event of queryModelWithStreaming(queryArgs)) {
    if (event && event.type === "assistant") {
      assistantMessage = event;
      inputTokens += event.message?.usage?.input_tokens ?? 0;
      outputTokens += event.message?.usage?.output_tokens ?? 0;
    }
  }
  return {
    messages: assistantMessage ? [assistantMessage] : [],
    totalUsage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}
