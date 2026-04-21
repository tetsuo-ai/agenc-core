/**
 * OpenAI provider adapter.
 *
 * Uses the new T13 wire shims rather than the legacy `openai` SDK path.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMStoredResponse,
  LLMStoredResponseDeleteResult,
  StreamProgressCallback,
} from "../../types.js";
import { validateToolCall } from "../../types.js";
import {
  LLMAuthenticationError,
  LLMContextWindowExceededError,
  LLMInvalidResponseError,
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
  mapLLMError,
} from "../../errors.js";
import { ProviderHttpClient } from "../../client.js";
import {
  ProviderHttpError,
  type ProviderHttpStreamResponse,
} from "../../client-session.js";
import {
  buildOpenAICompatibilityErrorMessage,
  classifyOpenAIHttpFailure,
} from "../../../services/api/openaiErrorClassification.js";
import {
  buildChatCompletionsRequest,
  parseChatCompletionsResponse,
} from "../../wire/chat-completions.js";
import {
  buildOpenAIResponsesRequest,
  parseOpenAIResponsesResponse,
} from "../../wire/responses-openai.js";
import type { OpenAIProviderConfig } from "./types.js";
import { OpenAIAuthSession } from "./auth.js";
import { parseSSEFrames } from "../../../transport/sse-post.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface OpenAISseEvent {
  readonly event?: string;
  readonly data: Record<string, unknown>;
}

function resolveTimeoutMs(
  providerTimeoutMs: number | undefined,
  callTimeoutMs: number | undefined,
): number | undefined {
  if (typeof callTimeoutMs === "number") return callTimeoutMs;
  return providerTimeoutMs;
}

function normalizeTimeoutMs(
  value: number | undefined,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value <= 0) return undefined;
  return Math.max(1, Math.floor(value));
}

function providerHttpBodyToString(body: unknown): string {
  if (typeof body === "string") return body;
  if (body === undefined) return "";
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function withStreamingMetrics(response: LLMResponse): LLMResponse {
  return {
    ...response,
    requestMetrics: response.requestMetrics
      ? { ...response.requestMetrics, stream: true }
      : response.requestMetrics,
  };
}

function readRetryAfterMs(errorBody: unknown): number | undefined {
  if (!errorBody || typeof errorBody !== "object") return undefined;
  const record = errorBody as Record<string, unknown>;
  const candidate =
    record.retry_after_ms ??
    record.retry_after ??
    (record.error &&
    typeof record.error === "object"
      ? (record.error as Record<string, unknown>).retry_after_ms ??
        (record.error as Record<string, unknown>).retry_after
      : undefined);
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return undefined;
  }
  return candidate > 0 && candidate < 1_000 ? candidate * 1_000 : candidate;
}

function inferErrorStatus(
  errorBody: unknown,
): number | undefined {
  if (!errorBody || typeof errorBody !== "object") return undefined;
  const record = errorBody as Record<string, unknown>;
  const candidates = [
    record.status,
    record.status_code,
    record.code,
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>).status
      : undefined,
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>).status_code
      : undefined,
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>).code
      : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string") {
      const parsed = Number.parseInt(candidate, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function mapOpenAIHttpFailureToError(args: {
  readonly providerName: string;
  readonly message: string;
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterMs?: number;
}): Error {
  const failure = classifyOpenAIHttpFailure({
    status: args.status,
    body: providerHttpBodyToString(args.body),
  });
  const message = buildOpenAICompatibilityErrorMessage(args.message, failure);

  if (failure.category === "rate_limited") {
    return new LLMRateLimitError(
      args.providerName,
      args.retryAfterMs ?? readRetryAfterMs(args.body),
    );
  }
  if (failure.category === "provider_unavailable") {
    return new LLMServerError(args.providerName, args.status, message);
  }
  if (failure.category === "context_overflow") {
    return new LLMContextWindowExceededError(args.providerName, message);
  }
  if (failure.category === "malformed_provider_response") {
    return new LLMInvalidResponseError(args.providerName, message);
  }
  if (failure.category === "auth_invalid" && args.status === 401) {
    return new LLMAuthenticationError(args.providerName, args.status);
  }
  return new LLMProviderError(args.providerName, message, args.status);
}

function mapOpenAIStreamError(args: {
  readonly providerName: string;
  readonly errorBody: unknown;
  readonly fallbackMessage: string;
}): Error {
  const status = inferErrorStatus(args.errorBody);
  const message =
    typeof (args.errorBody as { message?: unknown })?.message === "string"
      ? String((args.errorBody as { message: string }).message)
      : typeof (
          args.errorBody &&
          typeof args.errorBody === "object" &&
          "error" in (args.errorBody as Record<string, unknown>) &&
          (args.errorBody as Record<string, unknown>).error &&
          typeof (args.errorBody as Record<string, unknown>).error === "object" &&
          (args.errorBody as {
            error: { message?: unknown };
          }).error.message
        ) === "string"
        ? String(
            (args.errorBody as {
              error: { message: string };
            }).error.message,
          )
        : args.fallbackMessage;
  if (typeof status === "number") {
    return mapOpenAIHttpFailureToError({
      providerName: args.providerName,
      message,
      status,
      body: args.errorBody,
    });
  }
  return new LLMProviderError(args.providerName, message);
}

export class OpenAIProvider implements LLMProvider {
  readonly name: string;

  private readonly config: OpenAIProviderConfig;
  private readonly client: ProviderHttpClient;
  private readonly auth: OpenAIAuthSession;

  constructor(config: OpenAIProviderConfig) {
    this.name = config.providerName ?? "openai";
    this.config = config;
    this.auth = new OpenAIAuthSession(config);
    this.client = new ProviderHttpClient({
      providerName: this.name,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
      defaultHeaders: config.defaultHeaders,
      resolveAuthHeaders: (context) => this.auth.resolveHeaders(context),
      timeoutMs: config.timeoutMs,
      fetchImpl: config.fetchImpl,
    });
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const timeoutMs = resolveTimeoutMs(this.config.timeoutMs, options?.timeoutMs);

    try {
      return await this.auth.withAuthorizedOperation(async () => {
        if (this.config.useResponsesApi !== false) {
          const session = this.client.createTurnSession({
            wireApi: "responses",
          });
          const request = buildOpenAIResponsesRequest({
            model: this.config.model,
            messages,
            tools: this.config.tools ?? [],
            options,
            store: this.config.store,
          });
          const response = await session.requestJson<Record<string, unknown>>({
            api: "responses",
            path: this.resolvePath("/responses"),
            method: "POST",
            body: request,
            timeoutMs,
            signal: options?.signal,
          });
          return parseOpenAIResponsesResponse(
            this.config.model,
            response.data,
            {
              model: this.config.model,
              messages,
              tools: this.config.tools ?? [],
              options,
              store: this.config.store,
            },
          );
        }

        const session = this.client.createTurnSession({
          wireApi: "chat_completions",
        });
        const request = buildChatCompletionsRequest({
          model: this.config.model,
          messages,
          tools: this.config.tools ?? [],
          options,
        });
        const response = await session.requestJson<Record<string, unknown>>({
          api: "chat_completions",
          path: this.resolvePath("/chat/completions"),
          method: "POST",
          body: request,
          timeoutMs,
          signal: options?.signal,
        });
        return parseChatCompletionsResponse(this.config.model, response.data, {
          model: this.config.model,
          messages,
          tools: this.config.tools ?? [],
          options,
        });
      });
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        throw mapOpenAIHttpFailureToError({
          providerName: this.name,
          message: error.message,
          status: error.status,
          body: error.body,
          retryAfterMs: error.retryAfterMs,
        });
      }
      throw mapLLMError(this.name, error, timeoutMs ?? 0);
    }
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const timeoutMs = resolveTimeoutMs(this.config.timeoutMs, options?.timeoutMs);

    try {
      return await this.auth.withAuthorizedOperation(async () => {
        if (this.config.useResponsesApi !== false) {
          return await this.streamResponses(messages, onChunk, options, timeoutMs);
        }
        return await this.streamChatCompletions(
          messages,
          onChunk,
          options,
          timeoutMs,
        );
      });
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        throw mapOpenAIHttpFailureToError({
          providerName: this.name,
          message: error.message,
          status: error.status,
          body: error.body,
          retryAfterMs: error.retryAfterMs,
        });
      }
      throw mapLLMError(this.name, error, timeoutMs ?? 0);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const session = this.client.createTurnSession();
      await this.auth.withAuthorizedOperation(async () => {
        await session.requestJson<Record<string, unknown>>({
          path: this.resolvePath("/models"),
          method: "GET",
        });
      });
      return true;
    } catch {
      return false;
    }
  }

  async retrieveStoredResponse(responseId: string): Promise<LLMStoredResponse> {
    const session = this.client.createTurnSession({
      wireApi: "responses",
    });
    const response = await this.auth.withAuthorizedOperation(async () =>
      session.requestJson<Record<string, unknown>>({
        path: this.resolvePath(`/responses/${encodeURIComponent(responseId)}`),
        method: "GET",
      }));
    const parsed = parseOpenAIResponsesResponse(this.config.model, response.data, {
      model: this.config.model,
      messages: [],
      tools: [],
      store: this.config.store,
    });
    return {
      id: String(response.data.id ?? responseId),
      provider: this.name,
      model:
        typeof response.data.model === "string"
          ? response.data.model
          : this.config.model,
      status:
        typeof response.data.status === "string"
          ? response.data.status
          : undefined,
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      usage: parsed.usage,
      output: Array.isArray(response.data.output)
        ? (response.data.output as Array<Record<string, unknown>>)
        : undefined,
      raw: response.data,
    };
  }

  async deleteStoredResponse(
    responseId: string,
  ): Promise<LLMStoredResponseDeleteResult> {
    const session = this.client.createTurnSession({
      wireApi: "responses",
    });
    const response = await this.auth.withAuthorizedOperation(async () =>
      session.requestJson<Record<string, unknown>>({
        path: this.resolvePath(`/responses/${encodeURIComponent(responseId)}`),
        method: "DELETE",
      }));
    return {
      id: String(response.data.id ?? responseId),
      provider: this.name,
      deleted: response.data.deleted === true,
      raw: response.data,
    };
  }

  private async streamResponses(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options: LLMChatOptions | undefined,
    timeoutMs: number | undefined,
  ): Promise<LLMResponse> {
    const requestOptions = {
      model: this.config.model,
      messages,
      tools: this.config.tools ?? [],
      options,
      store: this.config.store,
    };
    const request = {
      ...buildOpenAIResponsesRequest(requestOptions),
      stream: true,
    };
    const response = await this.requestStream({
      api: "responses",
      path: this.resolvePath("/responses"),
      body: request,
      timeoutMs,
      signal: options?.signal,
    });

    let streamedContent = "";
    const streamedToolCalls = new Map<string, { id: string; name: string; arguments: string }>();
    let completedResponse: Record<string, unknown> | null = null;

    for await (const event of this.readSseEvents(response)) {
      const eventType = event.event ?? String(event.data.type ?? "");

      if (eventType === "response.output_text.delta") {
        const delta =
          typeof event.data.delta === "string" ? event.data.delta : "";
        if (delta.length > 0) {
          streamedContent += delta;
          onChunk({ content: delta, done: false });
        }
        continue;
      }

      if (eventType === "response.output_item.done") {
        const item =
          event.data.item && typeof event.data.item === "object"
            ? (event.data.item as Record<string, unknown>)
            : undefined;
        if (item?.type === "function_call") {
          const toolCall = validateToolCall({
            id: String(item.call_id ?? item.id ?? "").trim(),
            name: String(item.name ?? "").trim(),
            arguments: String(item.arguments ?? "{}"),
          });
          if (toolCall) {
            streamedToolCalls.set(toolCall.id, toolCall);
            onChunk({ content: "", done: false, toolCalls: [toolCall] });
          }
        }
        continue;
      }

      if (
        eventType === "response.completed" ||
        eventType === "response.incomplete"
      ) {
        completedResponse =
          event.data.response && typeof event.data.response === "object"
            ? (event.data.response as Record<string, unknown>)
            : null;
        break;
      }

      if (eventType === "response.failed") {
        const failedResponse =
          event.data.response && typeof event.data.response === "object"
            ? (event.data.response as Record<string, unknown>)
            : {};
        const failedError =
          failedResponse.error && typeof failedResponse.error === "object"
            ? (failedResponse.error as Record<string, unknown>)
            : undefined;
        const eventError =
          event.data.error && typeof event.data.error === "object"
            ? (event.data.error as Record<string, unknown>)
            : undefined;
        const message =
          typeof failedError?.message === "string"
            ? String(failedError.message)
            : typeof eventError?.message === "string"
              ? String(eventError.message)
              : "OpenAI stream failed";
        throw mapOpenAIStreamError({
          providerName: this.name,
          errorBody: failedError ?? eventError ?? failedResponse,
          fallbackMessage: message,
        });
      }
    }

    if (!completedResponse) {
      throw new LLMProviderError(
        this.name,
        "Stream closed without a response.completed payload",
      );
    }

    const parsed = withStreamingMetrics(
      parseOpenAIResponsesResponse(
        this.config.model,
        completedResponse,
        requestOptions,
      ),
    );
    const toolCalls =
      parsed.toolCalls.length > 0
        ? parsed.toolCalls
        : Array.from(streamedToolCalls.values())
          .map((toolCall) => validateToolCall(toolCall))
          .filter((toolCall): toolCall is NonNullable<ReturnType<typeof validateToolCall>> => toolCall !== null);
    const finalResponse: LLMResponse = {
      ...parsed,
      content: parsed.content.length > 0 ? parsed.content : streamedContent,
      toolCalls,
      finishReason:
        toolCalls.length > 0 && parsed.finishReason === "stop"
          ? "tool_calls"
          : parsed.finishReason,
    };
    onChunk({
      content: "",
      done: true,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
    return finalResponse;
  }

  private async streamChatCompletions(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options: LLMChatOptions | undefined,
    timeoutMs: number | undefined,
  ): Promise<LLMResponse> {
    const requestOptions = {
      model: this.config.model,
      messages,
      tools: this.config.tools ?? [],
      options,
    };
    const request = {
      ...buildChatCompletionsRequest(requestOptions),
      stream: true,
      stream_options: { include_usage: true },
    };
    const response = await this.requestStream({
      api: "chat_completions",
      path: this.resolvePath("/chat/completions"),
      body: request,
      timeoutMs,
      signal: options?.signal,
    });

    let content = "";
    let model = this.config.model;
    let finishReason: LLMResponse["finishReason"] = "stop";
    let usage: Record<string, number> = {};
    const toolCallAccumulator = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const event of this.readSseEvents(response)) {
      const chunk = event.data;
      if (chunk.error && typeof chunk.error === "object") {
        throw mapOpenAIStreamError({
          providerName: this.name,
          errorBody: chunk.error,
          fallbackMessage: "OpenAI stream failed",
        });
      }

      if (typeof chunk.model === "string" && chunk.model.length > 0) {
        model = chunk.model;
      }
      if (chunk.usage && typeof chunk.usage === "object") {
        usage = chunk.usage as Record<string, number>;
      }

      const choices = Array.isArray(chunk.choices)
        ? (chunk.choices as Array<Record<string, unknown>>)
        : [];
      for (const choice of choices) {
        const delta =
          choice.delta && typeof choice.delta === "object"
            ? (choice.delta as Record<string, unknown>)
            : {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          content += delta.content;
          onChunk({ content: delta.content, done: false });
        }

        const deltaToolCalls = Array.isArray(delta.tool_calls)
          ? (delta.tool_calls as Array<Record<string, unknown>>)
          : [];
        for (const toolCall of deltaToolCalls) {
          const index =
            typeof toolCall.index === "number"
              ? toolCall.index
              : toolCallAccumulator.size;
          const fn =
            toolCall.function && typeof toolCall.function === "object"
              ? (toolCall.function as Record<string, unknown>)
              : {};
          const existing = toolCallAccumulator.get(index) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (typeof toolCall.id === "string" && toolCall.id.length > 0) {
            existing.id = toolCall.id;
          }
          if (typeof fn.name === "string" && fn.name.length > 0) {
            existing.name = fn.name;
          }
          if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
            existing.arguments += fn.arguments;
          }
          toolCallAccumulator.set(index, existing);
        }

        if (typeof choice.finish_reason === "string") {
          switch (choice.finish_reason) {
            case "tool_calls":
              finishReason = "tool_calls";
              break;
            case "length":
              finishReason = "length";
              break;
            case "content_filter":
              finishReason = "content_filter";
              break;
            case "error":
              finishReason = "error";
              break;
            default:
              finishReason = "stop";
              break;
          }
        }
      }
    }

    const toolCalls = Array.from(toolCallAccumulator.values()).filter(
      (toolCall) => toolCall.id.length > 0 && toolCall.name.length > 0,
    );
    const parsed = withStreamingMetrics(
      parseChatCompletionsResponse(
        this.config.model,
        {
          model,
          choices: [
            {
              message: {
                role: "assistant",
                content,
                ...(toolCalls.length > 0
                  ? {
                    tool_calls: toolCalls.map((toolCall) => ({
                      id: toolCall.id,
                      type: "function",
                      function: {
                        name: toolCall.name,
                        arguments:
                          toolCall.arguments.length > 0
                            ? toolCall.arguments
                            : "{}",
                      },
                    })),
                  }
                  : {}),
              },
              finish_reason:
                finishReason === "tool_calls"
                  ? "tool_calls"
                  : finishReason === "length"
                    ? "length"
                    : finishReason === "content_filter"
                      ? "content_filter"
                      : finishReason === "error"
                        ? "error"
                        : "stop",
            },
          ],
          usage,
        },
        requestOptions,
      ),
    );
    onChunk({
      content: "",
      done: true,
      ...(parsed.toolCalls.length > 0 ? { toolCalls: parsed.toolCalls } : {}),
    });
    return parsed;
  }

  private async *readSseEvents(
    response: ProviderHttpStreamResponse,
  ): AsyncGenerator<OpenAISseEvent> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response) {
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSSEFrames(buffer);
      buffer = parsed.remaining;

      for (const frame of parsed.frames) {
        if (!frame.data || frame.data === "[DONE]") {
          if (frame.data === "[DONE]") return;
          continue;
        }
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
      if (!frame.data || frame.data === "[DONE]") {
        if (frame.data === "[DONE]") return;
        continue;
      }
      try {
        const data = JSON.parse(frame.data) as Record<string, unknown>;
        yield { event: frame.event, data };
      } catch {
        continue;
      }
    }
  }

  private async requestStream(args: {
    readonly api: "responses" | "chat_completions";
    readonly path: string;
    readonly body: Record<string, unknown>;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<ProviderHttpStreamResponse> {
    const session = this.client.createTurnSession({
      wireApi: args.api,
    });
    return await session.requestStream({
      api: args.api,
      path: args.path,
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: args.body,
      timeoutMs: normalizeTimeoutMs(args.timeoutMs),
      signal: args.signal,
      // Provider SSE streams do not expose resumable cursors; keep the
      // shared session contract but preserve single-attempt stream semantics.
      retryBudget: { maxRetries: 0 },
    });
  }

  private resolvePath(path: string): string {
    const basePath = this.config.basePath?.trim().replace(/\/+$/u, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    if (!basePath || basePath === "/") {
      return normalizedPath;
    }
    return `${basePath}${normalizedPath}`;
  }
}
