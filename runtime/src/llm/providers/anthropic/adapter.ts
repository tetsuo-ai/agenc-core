/**
 * Messages API provider adapter.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMToolCall,
  StreamProgressCallback,
} from "../../types.js";
import {
  LLMAuthenticationError,
  LLMProviderError,
  mapLLMError,
} from "../../errors.js";
import { ProviderHttpClient } from "../../client.js";
import {
  ProviderHttpError,
  type ProviderHttpStreamResponse,
} from "../../client-session.js";
import { isFallbackTriggeredError } from "../../../recovery/api-errors.js";
import {
  assertNonEmptyApiKey,
  buildBearerAuthHeaders,
} from "../../auth/bearer.js";
import {
  buildAnthropicMessagesRequest,
  parseAnthropicMessagesResponse,
} from "../../wire/messages-anthropic.js";
import { decodeMcpToolNameFromWire } from "../../wire/mcp-tool-naming.js";
import { coerceUsage } from "../../wire/shared.js";
import {
  assertProviderStructuredOutputCompatibility,
} from "../../provider-capabilities.js";
import {
  ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
} from "../../structured-output.js";
import type { AnthropicProviderConfig } from "./types.js";
import { parseSSEFrames } from "../../_deps/sse.js";
import { CONTEXT_MANAGEMENT_BETA_HEADER } from "../../_deps/betas.js";
import {
  evaluateProviderFallback,
  normalizeFallbackRetryBudget,
  type ProviderFallbackDecision,
} from "../../api/fallback-ladder.js";
import { getRetryDelay, sleepMs } from "../../api/retry.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicSseEvent {
  readonly event?: string;
  readonly data: Record<string, unknown>;
}

interface AnthropicUsageAccumulator {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly reported: boolean;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly reasoning_output_tokens?: number;
  readonly server_tool_use?: {
    readonly web_search_requests?: number;
  };
}

function withStreamingMetrics(response: LLMResponse): LLMResponse {
  return {
    ...response,
    requestMetrics: response.requestMetrics
      ? { ...response.requestMetrics, stream: true }
      : response.requestMetrics,
  };
}

function resolveMaxTokens(
  options: LLMChatOptions | undefined,
  fallback: number | undefined,
): number | undefined {
  const value = options?.maxOutputTokens ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function mergeAnthropicUsage(
  usage: AnthropicUsageAccumulator,
  partUsage: unknown,
): AnthropicUsageAccumulator {
  if (!partUsage || typeof partUsage !== "object") return usage;
  const record = partUsage as Record<string, unknown>;
  const serverToolUse =
    record.server_tool_use &&
      typeof record.server_tool_use === "object" &&
      !Array.isArray(record.server_tool_use)
      ? (record.server_tool_use as Record<string, unknown>)
      : undefined;
  const webSearchRequests =
    typeof serverToolUse?.web_search_requests === "number" &&
      Number.isFinite(serverToolUse.web_search_requests)
      ? serverToolUse.web_search_requests
      : undefined;
  const reported =
    usage.reported ||
    (typeof record.input_tokens === "number" &&
      Number.isFinite(record.input_tokens)) ||
    (typeof record.output_tokens === "number" &&
      Number.isFinite(record.output_tokens));
  return {
    reported,
    input_tokens:
      typeof record.input_tokens === "number" &&
      Number.isFinite(record.input_tokens) &&
      record.input_tokens >= 0
        ? record.input_tokens
        : usage.input_tokens,
    output_tokens:
      typeof record.output_tokens === "number"
        ? record.output_tokens
        : usage.output_tokens,
    ...(typeof record.cache_read_input_tokens === "number"
      ? { cache_read_input_tokens: record.cache_read_input_tokens }
      : usage.cache_read_input_tokens !== undefined
        ? { cache_read_input_tokens: usage.cache_read_input_tokens }
        : {}),
    ...(typeof record.cache_creation_input_tokens === "number"
      ? { cache_creation_input_tokens: record.cache_creation_input_tokens }
      : usage.cache_creation_input_tokens !== undefined
        ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
        : {}),
    ...(typeof record.reasoning_output_tokens === "number"
      ? { reasoning_output_tokens: record.reasoning_output_tokens }
      : usage.reasoning_output_tokens !== undefined
        ? { reasoning_output_tokens: usage.reasoning_output_tokens }
        : {}),
    ...(webSearchRequests !== undefined
      ? { server_tool_use: { web_search_requests: webSearchRequests } }
      : usage.server_tool_use !== undefined
        ? { server_tool_use: usage.server_tool_use }
        : {}),
  };
}

function parseToolInputObject(
  argumentsJson: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function anthropicStreamFallbackCandidate(
  errorRecord: Record<string, unknown>,
  fallbackMessage: string,
): Error & { status?: number } {
  const status =
    typeof errorRecord.status === "number"
      ? errorRecord.status
      : errorRecord.type === "overloaded_error"
        ? 529
        : undefined;
  const message = JSON.stringify(errorRecord) || fallbackMessage;
  const error = new Error(message) as Error & { status?: number };
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

type ProviderFallbackWaitDecision = Extract<
  ProviderFallbackDecision,
  { readonly kind: "wait" }
>;

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";

  private readonly config: AnthropicProviderConfig;
  private readonly client: ProviderHttpClient;

  constructor(config: AnthropicProviderConfig) {
    this.config = config;
    const authHeaders = buildBearerAuthHeaders({
      apiKey: assertNonEmptyApiKey(
        this.name,
        config.apiKey,
        "ANTHROPIC_API_KEY",
      ),
      headerName: "x-api-key",
      prefix: "",
    });
    authHeaders["x-api-key"] = authHeaders["x-api-key"].trimStart();
    const betaHeaders = new Set(config.betaHeaders ?? []);
    if (config.contextManagement) {
      betaHeaders.add(CONTEXT_MANAGEMENT_BETA_HEADER);
    }
    this.client = new ProviderHttpClient({
      providerName: this.name,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
      model: config.model,
      defaultHeaders: {
        ...(config.defaultHeaders ?? {}),
        "anthropic-version":
          config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
        ...(betaHeaders.size > 0
          ? { "anthropic-beta": [...betaHeaders].join(",") }
          : {}),
      },
      authHeaders,
      timeoutMs: config.timeoutMs,
      fetchImpl: config.fetchImpl,
      providerFallback: config.providerFallback,
      emitWarning: config.emitWarning,
      onCapabilityDrift: config.onCapabilityDrift,
    });
  }

  private evaluateConfiguredFallback(
    error: unknown,
    consecutiveFailures: number,
    model: string = this.config.model,
  ): ProviderFallbackDecision | null {
    if (!this.config.providerFallback) return null;
    const decision = evaluateProviderFallback({
      ...this.config.providerFallback,
      model,
      error,
      consecutiveFailures,
    });
    if (decision.kind === "trigger") {
      throw decision.error;
    }
    return decision;
  }

  private providerFallbackForModel(
    model: string,
    singleWireAttempt = false,
  ): AnthropicProviderConfig["providerFallback"] {
    return this.config.providerFallback
      ? {
          ...this.config.providerFallback,
          model,
          ...(singleWireAttempt ? { maxFailures: 1 } : {}),
        }
      : undefined;
  }

  private async waitForConfiguredFallbackRetry(
    decision: ProviderFallbackWaitDecision,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (
      decision.consecutiveFailures >
      normalizeFallbackRetryBudget(this.config.maxRetries)
    ) {
      return false;
    }
    await sleepMs(getRetryDelay(decision.consecutiveFailures), signal);
    return true;
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const session = this.client.createTurnSession({
      wireApi: "messages",
    });
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    const requestTools = options?.tools
      ? [...options.tools]
      : this.config.tools ?? [];
    const model = options?.model?.trim() || this.config.model;

    try {
      assertProviderStructuredOutputCompatibility({
        providerName: this.name,
        model,
        structuredOutput: options?.structuredOutput,
        toolsRequested: requestTools.length > 0,
        api: "messages",
      });
      const request = buildAnthropicMessagesRequest({
        model,
        messages,
        tools: requestTools,
        options,
        maxTokens: resolveMaxTokens(options, this.config.maxTokens),
        contextManagement: this.config.contextManagement,
      });
      const response = await session.requestJson<Record<string, unknown>>({
        api: "messages",
        method: "POST",
        body: request,
        timeoutMs,
        signal: options?.signal,
        providerFallback: this.providerFallbackForModel(
          model,
          options?.singleWireAttempt,
        ),
        singleWireAttempt: options?.singleWireAttempt,
      });
      return parseAnthropicMessagesResponse(model, response.data, {
        model,
        messages,
        tools: requestTools,
        options,
        maxTokens: resolveMaxTokens(options, this.config.maxTokens),
      });
    } catch (error) {
      if (isFallbackTriggeredError(error)) {
        throw error;
      }
      if (error instanceof ProviderHttpError && error.status === 401) {
        throw new LLMAuthenticationError(this.name, error.status);
      }
      throw mapLLMError(this.name, error, timeoutMs ?? 0);
    }
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const requestModel = options?.model?.trim() || this.config.model;
    const requestOptions = {
      model: requestModel,
      messages,
      tools: options?.tools ? [...options.tools] : this.config.tools ?? [],
      options,
      maxTokens: resolveMaxTokens(options, this.config.maxTokens),
      contextManagement: this.config.contextManagement,
    };
    assertProviderStructuredOutputCompatibility({
      providerName: this.name,
      model: requestModel,
      structuredOutput: options?.structuredOutput,
      toolsRequested: requestOptions.tools.length > 0,
      api: "messages",
    });
    const request = {
      ...buildAnthropicMessagesRequest(requestOptions),
      stream: true,
    };
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    const session = this.client.createTurnSession({
      wireApi: "messages",
    });

    let consecutiveFallbackFailures = 0;
    streamAttempts: while (true) {
      let content = "";
      let model = requestModel;
      let finishReason: LLMResponse["finishReason"] = "stop";
      let sawMessageStop = false;
      let usage: AnthropicUsageAccumulator = {
        input_tokens: 0,
        output_tokens: 0,
        reported: false,
      };
      const toolBlocks = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      const completedToolCalls: Array<{
        id: string;
        name: string;
        arguments: string;
      }> = [];
      const thinkingBlocks = new Map<
        number,
        { text: string; signature: string; redacted: boolean }
      >();
      const completedThinkingBlocks: Array<{
        text: string;
        signature?: string;
        redacted: boolean;
      }> = [];
    try {
      const response = await session.requestStream({
        api: "messages",
        method: "POST",
        headers: { accept: "text/event-stream" },
        body: request,
        timeoutMs,
        signal: options?.signal,
        providerFallback: this.providerFallbackForModel(
          requestModel,
          options?.singleWireAttempt,
        ),
        singleWireAttempt: options?.singleWireAttempt,
        // Provider SSE streams are not resumable; preserve single-attempt
        // stream semantics while using the shared session transport contract.
        retryBudget: { maxRetries: 0 },
      });

      for await (const event of this.readSseEvents(response)) {
        const eventType = event.event ?? String(event.data.type ?? "");

        if (eventType === "message_start") {
          const message =
            event.data.message && typeof event.data.message === "object"
              ? (event.data.message as Record<string, unknown>)
              : {};
          if (typeof message.model === "string" && message.model.length > 0) {
            model = message.model;
          }
          usage = mergeAnthropicUsage(usage, message.usage);
          continue;
        }

        if (eventType === "content_block_start") {
          const index =
            typeof event.data.index === "number" ? event.data.index : -1;
          const block =
            event.data.content_block &&
            typeof event.data.content_block === "object"
              ? (event.data.content_block as Record<string, unknown>)
              : {};
          if (block.type === "tool_use" && index >= 0) {
            const id = String(block.id ?? "");
            // Streaming-path decode (mirrors `parseAnthropicMessagesResponse`).
            // Without this, every downstream emit carries the wire-form
            // `mcp__server__tool` and the dispatcher misses (registry
            // keys on the dotted internal form). Decoding once at the
            // accumulator boundary covers both `toolInputBlockStart`
            // mid-stream emit and the `completedToolCall` emit at
            // content_block_stop.
            const name = decodeMcpToolNameFromWire(String(block.name ?? ""));
            toolBlocks.set(index, {
              id,
              name,
              arguments: "",
            });
            if (name === ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME) {
              continue;
            }
            // Forward a streaming-tool-use start signal alongside the
            // normal accumulator. Downstream consumers translate this
            // into a `tool_input_block_start` session event for the
            // TUI bridge (see runtime/src/phases/stream-model.ts and
            // the TUI message adapter). Mirrors upstream
            // content_block_start handling.
            onChunk({
              content: "",
              done: false,
              toolInputBlockStart: {
                callId: id,
                index,
                contentBlock: {
                  type: "tool_use",
                  id,
                  name,
                  input: {},
                },
              },
            });
          } else if (
            (block.type === "thinking" || block.type === "redacted_thinking") &&
            index >= 0
          ) {
            // Extended-thinking block opening. The block's content arrives
            // via `content_block_delta` with delta.type === 'thinking_delta'
            // (or no deltas at all for redacted_thinking blocks). Initialise
            // the accumulator and forward a start signal so the TUI bridge
            // can mount its streamingThinking row before the first delta.
            const redacted = block.type === "redacted_thinking";
            const initialText =
              redacted && typeof block.data === "string" ? block.data : "";
            thinkingBlocks.set(index, {
              text: initialText,
              signature: "",
              redacted,
            });
            onChunk({
              content: "",
              done: false,
              thinkingBlockStart: { index, redacted },
            });
          }
          continue;
        }

        if (eventType === "content_block_delta") {
          const index =
            typeof event.data.index === "number" ? event.data.index : -1;
          const delta =
            event.data.delta && typeof event.data.delta === "object"
              ? (event.data.delta as Record<string, unknown>)
              : {};
          if (delta.type === "text_delta") {
            const text =
              typeof delta.text === "string" ? delta.text : "";
            if (text.length > 0) {
              content += text;
              onChunk({ content: text, done: false });
            }
            continue;
          }
          if (delta.type === "input_json_delta" && index >= 0) {
            const block = toolBlocks.get(index);
            if (block && typeof delta.partial_json === "string") {
              block.arguments += delta.partial_json;
              if (block.name === ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME) {
                continue;
              }
              // Forward the partial JSON delta so the TUI bridge can
              // render the synthetic streaming-tool-use cell as the
              // arguments arrive. Mirrors the upstream input_json_delta
              // handler.
              onChunk({
                content: "",
                done: false,
                toolInputDelta: {
                  callId: block.id,
                  index,
                  partialJson: delta.partial_json,
                },
              });
            }
            continue;
          }
          if (delta.type === "thinking_delta" && index >= 0) {
            const block = thinkingBlocks.get(index);
            const text = typeof delta.thinking === "string" ? delta.thinking : "";
            if (block && text.length > 0 && !block.redacted) {
              block.text += text;
              onChunk({
                content: "",
                done: false,
                thinkingDelta: { delta: text, index },
              });
            }
            continue;
          }
          if (delta.type === "signature_delta" && index >= 0) {
            // Cryptographic signature for the thinking block — required for
            // round-tripping the block back to the provider on the next
            // request, but not assistant content. Capture on the block; do
            // NOT forward through onChunk (the TUI must not display it, and
            // it must not inflate the streaming token counter — donor
            // parity: runtime/src/utils/messages.ts:3080-3084 explicitly
            // excludes signatures from onUpdateLength).
            const block = thinkingBlocks.get(index);
            const sig = typeof delta.signature === "string" ? delta.signature : "";
            if (block && sig.length > 0) {
              block.signature += sig;
            }
            continue;
          }
          continue;
        }

        if (eventType === "content_block_stop") {
          const index =
            typeof event.data.index === "number" ? event.data.index : -1;
          const block = toolBlocks.get(index);
          if (block) {
            const completedToolCall = {
              ...block,
              arguments: block.arguments.length > 0 ? block.arguments : "{}",
            };
            const parsedInput = parseToolInputObject(
              completedToolCall.arguments,
            );
            if (!parsedInput) {
              throw new LLMProviderError(
                this.name,
                `Provider stream emitted invalid tool_use JSON for ${completedToolCall.name || completedToolCall.id}`,
              );
            }
            completedToolCalls.push(completedToolCall);
            if (
              completedToolCall.name !== ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME
            ) {
              onChunk({
                content: "",
                done: false,
                toolCalls: [completedToolCall],
              });
            }
            toolBlocks.delete(index);
            continue;
          }
          const thinkingBlock = thinkingBlocks.get(index);
          if (thinkingBlock) {
            completedThinkingBlocks.push({
              text: thinkingBlock.text,
              ...(thinkingBlock.signature.length > 0
                ? { signature: thinkingBlock.signature }
                : {}),
              redacted: thinkingBlock.redacted,
            });
            onChunk({
              content: "",
              done: false,
              thinkingBlockStop: { index },
            });
            thinkingBlocks.delete(index);
          }
          continue;
        }

        if (eventType === "message_delta") {
          const delta =
            event.data.delta && typeof event.data.delta === "object"
              ? (event.data.delta as Record<string, unknown>)
              : {};
          usage = mergeAnthropicUsage(usage, event.data.usage);
          switch (String(delta.stop_reason ?? "")) {
            case "tool_use":
              finishReason = "tool_calls";
              break;
            case "max_tokens":
              finishReason = "length";
              break;
            case "content_filter":
            case "refusal":
              finishReason = "content_filter";
              break;
            case "error":
              finishReason = "error";
              break;
            default:
              finishReason = "stop";
              break;
          }
          continue;
        }

        if (eventType === "message_stop") {
          sawMessageStop = true;
          break;
        }

        if (eventType === "error") {
          const errorRecord =
            event.data.error && typeof event.data.error === "object"
              ? (event.data.error as Record<string, unknown>)
              : event.data;
          const message =
            typeof errorRecord.message === "string"
              ? errorRecord.message
              : "Provider stream failed";
          if (
            content.length === 0 &&
            completedToolCalls.length === 0 &&
            toolBlocks.size === 0
          ) {
            const fallbackDecision = this.evaluateConfiguredFallback(
              anthropicStreamFallbackCandidate(errorRecord, message),
              consecutiveFallbackFailures,
              requestModel,
            );
            if (
              options?.singleWireAttempt !== true &&
              fallbackDecision?.kind === "wait" &&
              await this.waitForConfiguredFallbackRetry(
                fallbackDecision,
                options?.signal,
              )
            ) {
              consecutiveFallbackFailures = fallbackDecision.consecutiveFailures;
              continue streamAttempts;
            }
          }
          consecutiveFallbackFailures = 0;
          throw new LLMProviderError(this.name, message);
        }
      }

      if (!sawMessageStop) {
        throw new LLMProviderError(
          this.name,
          "Stream closed without a message_stop event",
        );
      }

      const parsed = withStreamingMetrics(
        parseAnthropicMessagesResponse(
          requestModel,
          {
            model,
            content: [
              ...completedThinkingBlocks.flatMap(
                (block): Array<Record<string, unknown>> => {
                  if (block.redacted) {
                    return [{
                      type: "redacted_thinking",
                      data: block.text,
                    }];
                  }
                  return [{
                    type: "thinking",
                    thinking: block.text,
                    ...(block.signature !== undefined
                      ? { signature: block.signature }
                      : {}),
                  }];
                },
              ),
              ...(content.length > 0 ? [{ type: "text", text: content }] : []),
              ...completedToolCalls.flatMap((toolCall) => {
                const input = parseToolInputObject(toolCall.arguments);
                if (!input) return [];
                return [{
                  type: "tool_use",
                  id: toolCall.id,
                  name: toolCall.name,
                  input,
                }];
              }),
            ],
            stop_reason:
              finishReason === "tool_calls"
                ? "tool_use"
                : finishReason === "length"
                  ? "max_tokens"
                  : finishReason === "content_filter"
                    ? "content_filter"
                    : finishReason === "error"
                      ? "error"
                      : "end_turn",
            usage,
          },
          requestOptions,
        ),
      );
      const finalResponse: LLMResponse = {
        ...parsed,
        usage: {
          ...parsed.usage,
          totalTokens:
            parsed.usage.promptTokens + parsed.usage.completionTokens,
          availability: usage.reported ? "reported" : "unknown",
          provenance: usage.reported ? "provider" : "synthetic",
        },
      };
      onChunk({
        content: "",
        done: true,
        ...(finalResponse.toolCalls.length > 0
          ? { toolCalls: finalResponse.toolCalls }
          : {}),
      });
      return finalResponse;
    } catch (error) {
      if (isFallbackTriggeredError(error)) {
        throw error;
      }
      // Only retry the stream from scratch when nothing has been emitted to the
      // consumer yet. Once partial text or tool calls have been forwarded via
      // onChunk, re-running the attempt would replay (and thus duplicate) the
      // already-rendered output and inflate mid-stream token estimates, so we
      // surface a partial response instead (mirrors the in-stream `error`
      // branch and the grok adapter).
      const hasEmittedOutput =
        content.length > 0 ||
        completedToolCalls.length > 0 ||
        toolBlocks.size > 0;
      if (!hasEmittedOutput) {
        const fallbackDecision = this.evaluateConfiguredFallback(
          error,
          consecutiveFallbackFailures,
          requestModel,
        );
        if (
          options?.singleWireAttempt !== true &&
          fallbackDecision?.kind === "wait" &&
          await this.waitForConfiguredFallbackRetry(
            fallbackDecision,
            options?.signal,
          )
        ) {
          consecutiveFallbackFailures = fallbackDecision.consecutiveFailures;
          continue streamAttempts;
        }
      }
      consecutiveFallbackFailures = 0;
      if (error instanceof ProviderHttpError && error.status === 401) {
        throw new LLMAuthenticationError(this.name, error.status);
      }
      const mappedError = mapLLMError(this.name, error, timeoutMs ?? 0);
      if (content.length > 0) {
        const partialToolCalls: LLMToolCall[] = completedToolCalls.flatMap(
          (toolCall) => {
            if (!parseToolInputObject(toolCall.arguments)) return [];
            return [{
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            }];
          },
        );
        onChunk({
          content: "",
          done: true,
          ...(partialToolCalls.length > 0
            ? { toolCalls: partialToolCalls }
            : {}),
        });
        return {
          content,
          toolCalls: partialToolCalls,
          usage: coerceUsage({
            promptTokens: usage.input_tokens,
            completionTokens: usage.output_tokens,
            cachedInputTokens: usage.cache_read_input_tokens,
            cacheCreationInputTokens: usage.cache_creation_input_tokens,
            reasoningOutputTokens: usage.reasoning_output_tokens,
            webSearchRequests: usage.server_tool_use?.web_search_requests,
            availability: "unknown",
            provenance: "synthetic",
          }),
          model,
          finishReason: "error",
          error: mappedError,
          partial: true,
        };
      }
      throw mappedError;
    }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const session = this.client.createTurnSession();
      await session.requestJson<Record<string, unknown>>({
        path: "/models",
        method: "GET",
      });
      return true;
    } catch {
      return false;
    }
  }

  async getExecutionProfile() {
    const maxOutputTokens = resolveMaxTokens(undefined, this.config.maxTokens);
    return {
      provider: this.name,
      model: this.config.model,
      usageReporting: "authoritative" as const,
      supportsMaxOutputTokens: true,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    };
  }

  private async *readSseEvents(
    response: ProviderHttpStreamResponse,
  ): AsyncGenerator<AnthropicSseEvent> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response) {
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSSEFrames(buffer, this.name);
      buffer = parsed.remaining;

      for (const frame of parsed.frames) {
        if (!frame.data) continue;
        try {
          const data = JSON.parse(frame.data) as Record<string, unknown>;
          yield { event: frame.event, data };
        } catch {
          continue;
        }
      }
    }

    buffer += decoder.decode();
    const parsed = parseSSEFrames(buffer, this.name);
    for (const frame of parsed.frames) {
      if (!frame.data) continue;
      try {
        const data = JSON.parse(frame.data) as Record<string, unknown>;
        yield { event: frame.event, data };
      } catch {
        continue;
      }
    }
  }
}
