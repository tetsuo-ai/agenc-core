/**
 * Anthropic provider adapter.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
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
  type ProviderFallbackDecision,
} from "../../api/fallback-ladder.js";
import { getRetryDelay, sleepMs } from "../../api/retry.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicSseEvent {
  readonly event?: string;
  readonly data: Record<string, unknown>;
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
  usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  },
  partUsage: unknown,
): { readonly input_tokens: number; readonly output_tokens: number } {
  if (!partUsage || typeof partUsage !== "object") return usage;
  const record = partUsage as Record<string, unknown>;
  return {
    input_tokens:
      typeof record.input_tokens === "number" && record.input_tokens > 0
        ? record.input_tokens
        : usage.input_tokens,
    output_tokens:
      typeof record.output_tokens === "number"
        ? record.output_tokens
        : usage.output_tokens,
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

function normalizeFallbackRetryBudget(maxRetries: number | undefined): number {
  if (typeof maxRetries !== "number" || !Number.isFinite(maxRetries)) return 2;
  return Math.max(0, Math.floor(maxRetries));
}

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
  ): AnthropicProviderConfig["providerFallback"] {
    return this.config.providerFallback
      ? { ...this.config.providerFallback, model }
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
        providerFallback: this.providerFallbackForModel(model),
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
    try {
      const response = await session.requestStream({
        api: "messages",
        method: "POST",
        headers: { accept: "text/event-stream" },
        body: request,
        timeoutMs,
        signal: options?.signal,
        providerFallback: this.providerFallbackForModel(requestModel),
        // Anthropic SSE streams are not resumable; preserve single-attempt
        // stream semantics while using the shared session transport contract.
        retryBudget: { maxRetries: 0 },
      });
      let content = "";
      let model = requestModel;
      let finishReason: LLMResponse["finishReason"] = "stop";
      let sawMessageStop = false;
      let usage = { input_tokens: 0, output_tokens: 0 };
      const toolBlocks = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      const completedToolCalls: Array<{
        id: string;
        name: string;
        arguments: string;
      }> = [];

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
            const name = String(block.name ?? "");
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
            completedToolCalls.push(completedToolCall);
            if (
              completedToolCall.name !== ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME &&
              parseToolInputObject(completedToolCall.arguments)
            ) {
              onChunk({
                content: "",
                done: false,
                toolCalls: [completedToolCall],
              });
            }
            toolBlocks.delete(index);
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
              : "Anthropic stream failed";
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
      const fallbackDecision = this.evaluateConfiguredFallback(
        error,
        consecutiveFallbackFailures,
        requestModel,
      );
      if (
        fallbackDecision?.kind === "wait" &&
        await this.waitForConfiguredFallbackRetry(
          fallbackDecision,
          options?.signal,
        )
      ) {
        consecutiveFallbackFailures = fallbackDecision.consecutiveFailures;
        continue streamAttempts;
      }
      consecutiveFallbackFailures = 0;
      if (error instanceof ProviderHttpError && error.status === 401) {
        throw new LLMAuthenticationError(this.name, error.status);
      }
      throw mapLLMError(this.name, error, timeoutMs ?? 0);
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

  private async *readSseEvents(
    response: ProviderHttpStreamResponse,
  ): AsyncGenerator<AnthropicSseEvent> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response) {
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSSEFrames(buffer);
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
    const parsed = parseSSEFrames(buffer);
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
