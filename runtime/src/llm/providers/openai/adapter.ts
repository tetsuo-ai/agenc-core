/**
 * OpenAI provider adapter. // branding-scan: allow real OpenAI provider identifier
 *
 * Uses the new T13 wire shims rather than the compatibility `openai` SDK path.
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
  LLMTool,
  LLMToolCall,
  StreamProgressCallback,
} from "../../types.js";
import { validateToolCallDetailed } from "../../types.js";
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
import { isFallbackTriggeredError } from "../../../recovery/api-errors.js";
import {
  buildOpenAICompatibilityErrorMessage,
  classifyOpenAIHttpFailure,
  classifyOpenAINetworkFailure,
} from "../../../errors/openai-compatible.js";
import {
  buildChatCompletionsRequest,
  collectChatCompletionsRequestMetadata,
  parseChatCompletionsResponse,
  type ChatCompletionsMaxTokenField,
  type ChatCompletionsRequestMetadata,
} from "../../wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../wire/capability-gating.js";
import { decodeMcpToolNameFromWire } from "../../wire/mcp-tool-naming.js";
import {
  buildOpenAIResponsesRequest,
  parseOpenAIResponsesResponse,
} from "../../wire/responses-openai.js";
import {
  assertProviderStructuredOutputCompatibility,
} from "../../provider-capabilities.js";
import type { OpenAIProviderConfig } from "./types.js";
import { OpenAIAuthSession } from "./auth.js";
import { parseSSEFrames } from "../../_deps/sse.js";
import {
  evaluateProviderFallback,
  normalizeFallbackRetryBudget,
  type ProviderFallbackDecision,
} from "../../api/fallback-ladder.js";
import { getRetryDelay, sleepMs } from "../../api/retry.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_RESPONSES_INVALID_FUNCTION_CALL_MESSAGE =
  "OpenAI Responses stream emitted invalid function_call"; // branding-scan: allow real OpenAI provider identifier
const OPENAI_STREAM_FAILED_MESSAGE = "OpenAI stream failed"; // branding-scan: allow real OpenAI provider identifier
const OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_MESSAGE =
  "OpenAI chat-completions stream emitted invalid tool_call"; // branding-scan: allow real OpenAI provider identifier

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

function normalizePositiveInteger(
  value: number | undefined,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function isLocalBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1"
    );
  } catch {
    return false;
  }
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

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      current &&
      typeof current === "object" &&
      "code" in current &&
      typeof (current as { code?: unknown }).code === "string"
    ) {
      return (current as { code: string }).code;
    }
    if (
      current &&
      typeof current === "object" &&
      "cause" in current &&
      (current as { cause?: unknown }).cause !== current
    ) {
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return undefined;
}

function errorName(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      current &&
      typeof current === "object" &&
      "name" in current &&
      typeof (current as { name?: unknown }).name === "string"
    ) {
      return (current as { name: string }).name;
    }
    if (
      current &&
      typeof current === "object" &&
      "cause" in current &&
      (current as { cause?: unknown }).cause !== current
    ) {
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return undefined;
}

function isAbortLikeError(error: unknown): boolean {
  return errorCode(error) === "ABORT_ERR" || errorName(error) === "AbortError";
}

function isTransportFailure(error: unknown): boolean {
  if (isAbortLikeError(error)) return false;

  const code = errorCode(error);
  if (
    code &&
    [
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETDOWN",
      "ENETUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(code)
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /(?:fetch failed|network|socket|connect econn|getaddrinfo|timed out|timeout)/i.test(
    message,
  );
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
  const bodyText = providerHttpBodyToString(args.body);
  const failure = classifyOpenAIHttpFailure({
    status: args.status,
    body: `${args.message}\n${bodyText}`.trim(),
  });
  const message = buildOpenAICompatibilityErrorMessage(args.message, failure);

  if (failure.category === "rate_limited") {
    return new LLMRateLimitError(
      args.providerName,
      args.retryAfterMs ?? readRetryAfterMs(args.body),
      message,
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
  if (
    failure.category === "auth_invalid" &&
    (args.status === 401 || args.status === 403)
  ) {
    return new LLMAuthenticationError(args.providerName, args.status, message);
  }
  return new LLMProviderError(args.providerName, message, args.status);
}

function mapOpenAINetworkFailureToError(args: {
  readonly providerName: string;
  readonly error: unknown;
  readonly url: string;
}): Error | null {
  if (!isTransportFailure(args.error)) return null;
  const failure = classifyOpenAINetworkFailure(args.error, { url: args.url });
  return new LLMProviderError(
    args.providerName,
    buildOpenAICompatibilityErrorMessage(failure.message, failure),
  );
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

function openAIStreamFallbackCandidate(
  errorBody: unknown,
  fallbackMessage: string,
): Error & { status?: number } {
  const status = inferErrorStatus(errorBody);
  const bodyText = providerHttpBodyToString(errorBody);
  const message = bodyText.length > 0 ? bodyText : fallbackMessage;
  const error = new Error(message) as Error & { status?: number };
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

function validateProviderToolCallOrThrow(
  providerName: string,
  raw: unknown,
  context: string,
): LLMToolCall {
  const result = validateToolCallDetailed(raw);
  if (result.toolCall) {
    return result.toolCall;
  }
  throw new LLMProviderError(
    providerName,
    `${context}: ${result.failure?.message ?? "invalid tool call payload"}`,
  );
}

type ProviderFallbackWaitDecision = Extract<
  ProviderFallbackDecision,
  { readonly kind: "wait" }
>;

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
      model: config.model,
      defaultHeaders: config.defaultHeaders,
      resolveAuthHeaders: (context) => this.auth.resolveHeaders(context),
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
  ): OpenAIProviderConfig["providerFallback"] {
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
    const timeoutMs = resolveTimeoutMs(this.config.timeoutMs, options?.timeoutMs);
    const model = options?.model?.trim() || this.config.model;
    const requestTools = options?.tools
      ? [...options.tools]
      : this.config.tools ?? [];

    try {
      return await this.auth.withAuthorizedOperation(async () => {
        if (this.config.useResponsesApi !== false) {
          assertProviderStructuredOutputCompatibility({
            providerName: this.name,
            model,
            structuredOutput: options?.structuredOutput,
            toolsRequested: requestTools.length > 0,
            api: "responses",
          });
          const session = this.client.createTurnSession({
            wireApi: "responses",
          });
          const request = buildOpenAIResponsesRequest({
            model,
            messages,
            tools: requestTools,
            options,
            store: this.config.store,
            maxOutputTokens: this.resolveRequestMaxTokens(options),
          });
          const response = await session.requestJson<Record<string, unknown>>({
            api: "responses",
            path: this.resolvePath("/responses"),
            method: "POST",
            body: request,
            timeoutMs,
            signal: options?.signal,
            providerFallback: this.providerFallbackForModel(model),
          });
          return parseOpenAIResponsesResponse(
            model,
            response.data,
            {
              model,
              messages,
              tools: requestTools,
              options,
              store: this.config.store,
              maxOutputTokens: this.resolveRequestMaxTokens(options),
            },
          );
        }

        const session = this.client.createTurnSession({
          wireApi: "chat_completions",
        });
        assertProviderStructuredOutputCompatibility({
          providerName: this.name,
          model,
          structuredOutput: options?.structuredOutput,
          toolsRequested: requestTools.length > 0,
          api: "chat_completions",
        });
        const request = this.prepareChatCompletionsRequest({
          model,
          messages,
          tools: requestTools,
          options,
        });
        const response = await session.requestJson<Record<string, unknown>>({
          api: "chat_completions",
          path: this.resolvePath("/chat/completions"),
          method: "POST",
          body: request,
          timeoutMs,
          signal: options?.signal,
          providerFallback: this.providerFallbackForModel(model),
        });
        return parseChatCompletionsResponse(model, response.data, {
          model,
          messages,
          tools: requestTools,
          options,
          maxTokens: this.resolveRequestMaxTokens(options),
          maxTokenField: this.resolveChatCompletionsMaxTokenField(),
        });
      });
    } catch (error) {
      if (isFallbackTriggeredError(error)) {
        throw error;
      }
      if (error instanceof ProviderHttpError) {
        throw mapOpenAIHttpFailureToError({
          providerName: this.name,
          message: error.message,
          status: error.status,
          body: error.body,
          retryAfterMs: error.retryAfterMs,
        });
      }
      const networkError = mapOpenAINetworkFailureToError({
        providerName: this.name,
        error,
        url: this.config.baseURL ?? DEFAULT_BASE_URL,
      });
      if (networkError) {
        throw networkError;
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
      if (isFallbackTriggeredError(error)) {
        throw error;
      }
      if (error instanceof ProviderHttpError) {
        throw mapOpenAIHttpFailureToError({
          providerName: this.name,
          message: error.message,
          status: error.status,
          body: error.body,
          retryAfterMs: error.retryAfterMs,
        });
      }
      const networkError = mapOpenAINetworkFailureToError({
        providerName: this.name,
        error,
        url: this.config.baseURL ?? DEFAULT_BASE_URL,
      });
      if (networkError) {
        throw networkError;
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

  async getExecutionProfile() {
    return {
      provider: this.name,
      model: this.config.model,
      ...(this.config.contextWindowTokens !== undefined
        ? { contextWindowTokens: this.config.contextWindowTokens }
        : {}),
      ...(this.config.contextWindowTokens !== undefined
        ? { contextWindowSource: "explicit_config" as const }
        : {}),
      ...(this.config.maxTokens !== undefined
        ? { maxOutputTokens: this.config.maxTokens }
        : {}),
    };
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

  private resolveChatCompletionsMaxTokenField(): ChatCompletionsMaxTokenField {
    if (this.name !== "openai" || isLocalBaseURL(this.config.baseURL)) {
      return "max_tokens";
    }
    return "max_completion_tokens";
  }

  private resolveRequestMaxTokens(
    options: LLMChatOptions | undefined,
  ): number | undefined {
    return (
      normalizePositiveInteger(options?.maxOutputTokens) ??
      normalizePositiveInteger(this.config.maxTokens)
    );
  }

  private resolveContextWindowTokens(
    options: LLMChatOptions | undefined,
  ): number | undefined {
    return (
      normalizePositiveInteger(options?.contextWindowTokens) ??
      normalizePositiveInteger(this.config.contextWindowTokens)
    );
  }

  private emitRequestMetadata(
    api: "chat_completions",
    metadata: ChatCompletionsRequestMetadata,
  ): void {
    this.config.emitDiagnostic?.({
      cause: "llm_request_metadata",
      message: JSON.stringify({
        provider: this.name,
        api,
        model: metadata.model,
        messageCount: metadata.messageCount,
        roleSequence: metadata.roleSequence,
        estimatedPromptTokens: metadata.estimatedPromptTokens,
        maxTokens: metadata.maxTokens,
        maxTokenField: metadata.maxTokenField,
        toolsAttached: metadata.toolsAttached,
        toolCount: metadata.toolCount,
      }),
    });
  }

  private assertWithinContextWindow(
    metadata: ChatCompletionsRequestMetadata,
    contextWindowTokens: number | undefined,
  ): void {
    if (contextWindowTokens === undefined || metadata.maxTokens === undefined) {
      return;
    }
    const requestedTokens = metadata.estimatedPromptTokens + metadata.maxTokens;
    if (requestedTokens <= contextWindowTokens) return;
    throw new LLMContextWindowExceededError(
      this.name,
      `estimated prompt (${metadata.estimatedPromptTokens}) plus reserved output (${metadata.maxTokens}) exceeds context window (${contextWindowTokens})`,
      {
        effectiveTokens: requestedTokens,
        maxTokens: contextWindowTokens,
      },
    );
  }

  private prepareChatCompletionsRequest(args: {
    readonly model: string;
    readonly messages: readonly LLMMessage[];
    readonly tools: readonly LLMTool[];
    readonly options?: LLMChatOptions;
  }): Record<string, unknown> {
    // Resolve per-provider capability hints from `this.name` (the
    // provider slug each subclass passes via `config.providerName`).
    // Subclasses (lmstudio, ollama, openrouter, deepseek, …) inherit
    // the gating automatically: the hint matrix lives in one place
    // and keys on the slug, so adding a new openai-compat provider
    // doesn't require new override boilerplate.
    const providerCapabilityHints = chatCompletionsCapabilityHintsForProvider(
      this.name,
      args.model,
    );
    const request = buildChatCompletionsRequest({
      model: args.model,
      messages: args.messages,
      tools: args.tools,
      options: args.options,
      maxTokens: this.resolveRequestMaxTokens(args.options),
      maxTokenField: this.resolveChatCompletionsMaxTokenField(),
      providerCapabilityHints,
    });
    const metadata = collectChatCompletionsRequestMetadata(request);
    this.emitRequestMetadata("chat_completions", metadata);
    this.assertWithinContextWindow(
      metadata,
      this.resolveContextWindowTokens(args.options),
    );
    return request;
  }

  private async streamResponses(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options: LLMChatOptions | undefined,
    timeoutMs: number | undefined,
  ): Promise<LLMResponse> {
    const model = options?.model?.trim() || this.config.model;
    const requestOptions = {
      model,
      messages,
      tools: options?.tools ? [...options.tools] : this.config.tools ?? [],
      options,
      store: this.config.store,
      maxOutputTokens: this.resolveRequestMaxTokens(options),
    };
    assertProviderStructuredOutputCompatibility({
      providerName: this.name,
      model,
      structuredOutput: options?.structuredOutput,
      toolsRequested: requestOptions.tools.length > 0,
      api: "responses",
    });
    const request = {
      ...buildOpenAIResponsesRequest(requestOptions),
      stream: true,
    };
    let consecutiveFallbackFailures = 0;
    responseStreamAttempts: while (true) {
      let response: ProviderHttpStreamResponse;
      try {
        response = await this.requestStream({
          api: "responses",
          path: this.resolvePath("/responses"),
          body: request,
          timeoutMs,
          signal: options?.signal,
          providerFallback: this.providerFallbackForModel(model),
        });
      } catch (error) {
        if (isFallbackTriggeredError(error)) throw error;
        const fallbackDecision = this.evaluateConfiguredFallback(
          error,
          consecutiveFallbackFailures,
          model,
        );
        if (
          fallbackDecision?.kind === "wait" &&
          await this.waitForConfiguredFallbackRetry(
            fallbackDecision,
            options?.signal,
          )
        ) {
          consecutiveFallbackFailures = fallbackDecision.consecutiveFailures;
          continue responseStreamAttempts;
        }
        consecutiveFallbackFailures = 0;
        throw error;
      }

      let streamedContent = "";
      const streamedToolCalls = new Map<
        string,
        { id: string; name: string; arguments: string }
      >();
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
            let toolCall: LLMToolCall;
            try {
              toolCall = validateProviderToolCallOrThrow(
                this.name,
                {
                  id: String(item.call_id ?? item.id ?? "").trim(),
                  // Streaming-path decode (mirrors the non-streaming
                  // path in `parseOpenAIResponsesResponse`). Without
                  // this, mid-stream `onChunk(toolCalls)` carries the
                  // wire-form `mcp__server__tool` straight into the
                  // dispatcher, which keys on the dotted internal form
                  // and reports a silent dispatch miss.
                  name: decodeMcpToolNameFromWire(
                    String(item.name ?? "").trim(),
                  ),
                  arguments: String(item.arguments ?? "{}"),
                },
                OPENAI_RESPONSES_INVALID_FUNCTION_CALL_MESSAGE,
              );
            } catch (validationError) {
              // A single malformed function_call must not discard output
              // already forwarded to the consumer. When nothing has been
              // emitted yet, rethrow so the outer fallback/retry path can
              // act; otherwise surface a partial response (mirrors the
              // Anthropic adapter's partial-recovery and the in-stream
              // `response.failed` branch below).
              if (
                streamedContent.length === 0 &&
                streamedToolCalls.size === 0
              ) {
                throw validationError;
              }
              const partialError =
                validationError instanceof Error
                  ? validationError
                  : new LLMProviderError(
                    this.name,
                    OPENAI_RESPONSES_INVALID_FUNCTION_CALL_MESSAGE,
                  );
              const recoveredToolCalls = Array.from(streamedToolCalls.values());
              onChunk({
                content: "",
                done: true,
                ...(recoveredToolCalls.length > 0
                  ? { toolCalls: recoveredToolCalls }
                  : {}),
              });
              return {
                content: streamedContent,
                toolCalls: recoveredToolCalls,
                usage: {
                  promptTokens: 0,
                  completionTokens: 0,
                  totalTokens: 0,
                },
                model,
                finishReason: "error",
                error: partialError,
                partial: true,
              };
            }
            streamedToolCalls.set(toolCall.id, toolCall);
            onChunk({ content: "", done: false, toolCalls: [toolCall] });
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
                : OPENAI_STREAM_FAILED_MESSAGE;
          const errorBody = failedError ?? eventError ?? failedResponse;
          const streamError = mapOpenAIStreamError({
            providerName: this.name,
            errorBody,
            fallbackMessage: message,
          });
          if (streamedContent.length === 0 && streamedToolCalls.size === 0) {
            const fallbackDecision = this.evaluateConfiguredFallback(
              openAIStreamFallbackCandidate(errorBody, message),
              consecutiveFallbackFailures,
              model,
            );
            if (
              fallbackDecision?.kind === "wait" &&
              await this.waitForConfiguredFallbackRetry(
                fallbackDecision,
                options?.signal,
              )
            ) {
              consecutiveFallbackFailures = fallbackDecision.consecutiveFailures;
              continue responseStreamAttempts;
            }
          }
          consecutiveFallbackFailures = 0;
          throw streamError;
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
          model,
          completedResponse,
          requestOptions,
        ),
      );
      const toolCalls =
        parsed.toolCalls.length > 0
          ? parsed.toolCalls
          : Array.from(streamedToolCalls.values());
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
  }

  private async streamChatCompletions(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options: LLMChatOptions | undefined,
    timeoutMs: number | undefined,
  ): Promise<LLMResponse> {
    const requestModel = options?.model?.trim() || this.config.model;
    const requestOptions = {
      model: requestModel,
      messages,
      tools: options?.tools ? [...options.tools] : this.config.tools ?? [],
      options,
      maxTokens: this.resolveRequestMaxTokens(options),
      maxTokenField: this.resolveChatCompletionsMaxTokenField(),
    };
    assertProviderStructuredOutputCompatibility({
      providerName: this.name,
      model: requestModel,
      structuredOutput: options?.structuredOutput,
      toolsRequested: requestOptions.tools.length > 0,
      api: "chat_completions",
    });
    // Gate `stream_options.include_usage` on the same per-provider
    // capability matrix that buildChatCompletionsRequest consults.
    // Some local openai-compat servers (older Ollama versions, custom
    // proxies) reject unknown `stream_options` keys and tear down the
    // SSE stream — strip the field for those providers up-front.
    const streamCapabilityHints = chatCompletionsCapabilityHintsForProvider(
      this.name,
      requestModel,
    );
    const request = {
      ...this.prepareChatCompletionsRequest(requestOptions),
      stream: true,
      ...(streamCapabilityHints.acceptsStreamUsage !== false
        ? { stream_options: { include_usage: true } }
        : {}),
    };
    let consecutiveFallbackFailures = 0;
    chatStreamAttempts: while (true) {
      let response: ProviderHttpStreamResponse;
      try {
        response = await this.requestStream({
          api: "chat_completions",
          path: this.resolvePath("/chat/completions"),
          body: request,
          timeoutMs,
          signal: options?.signal,
          providerFallback: this.providerFallbackForModel(requestModel),
        });
      } catch (error) {
        if (isFallbackTriggeredError(error)) throw error;
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
          continue chatStreamAttempts;
        }
        consecutiveFallbackFailures = 0;
        throw error;
      }

      let content = "";
      // DeepSeek-reasoner / openai-compat reasoning models stream
      // chain-of-thought on `delta.reasoning_content` rather than
      // `delta.content`. Accumulate it alongside content so it is not
      // dropped from the streamed path (the non-streaming path in
      // `parseChatCompletionsResponse` already falls back to it).
      let reasoningContent = "";
      let model = requestModel;
      let finishReason: LLMResponse["finishReason"] = "stop";
      let usage: Record<string, unknown> = {};
      const toolCallAccumulator = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      for await (const event of this.readSseEvents(response)) {
        const chunk = event.data;
        if (chunk.error && typeof chunk.error === "object") {
          const streamError = mapOpenAIStreamError({
            providerName: this.name,
            errorBody: chunk.error,
            fallbackMessage: OPENAI_STREAM_FAILED_MESSAGE,
          });
          if (content.length === 0 && toolCallAccumulator.size === 0) {
            const fallbackDecision = this.evaluateConfiguredFallback(
              openAIStreamFallbackCandidate(
                chunk.error,
                OPENAI_STREAM_FAILED_MESSAGE,
              ),
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
              continue chatStreamAttempts;
            }
          }
          consecutiveFallbackFailures = 0;
          throw streamError;
        }

        if (typeof chunk.model === "string" && chunk.model.length > 0) {
          model = chunk.model;
        }
        if (chunk.usage && typeof chunk.usage === "object") {
          usage = chunk.usage as Record<string, unknown>;
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
          if (
            typeof delta.reasoning_content === "string" &&
            delta.reasoning_content.length > 0
          ) {
            reasoningContent += delta.reasoning_content;
            onChunk({ content: delta.reasoning_content, done: false });
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

      const includeToolCalls = finishReason !== "length";
      const toolCalls = includeToolCalls
        ? Array.from(toolCallAccumulator.values()).map((toolCall) =>
          validateProviderToolCallOrThrow(
            this.name,
            toolCall,
            OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_MESSAGE,
          ))
        : [];
      const parsed = withStreamingMetrics(
        parseChatCompletionsResponse(
          requestModel,
          {
            model,
            choices: [
              {
                message: {
                  role: "assistant",
                  // Pass an explicit non-string `content` when only
                  // reasoning was streamed so `parseChatCompletionsResponse`
                  // reaches its `reasoning_content` fallback instead of
                  // short-circuiting on an empty string.
                  content:
                    content.length > 0 || reasoningContent.length === 0
                      ? content
                      : null,
                  ...(reasoningContent.length > 0
                    ? { reasoning_content: reasoningContent }
                    : {}),
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
        ...(includeToolCalls && parsed.toolCalls.length > 0
          ? { toolCalls: parsed.toolCalls }
          : {}),
      });
      return parsed;
    }
  }

  private async *readSseEvents(
    response: ProviderHttpStreamResponse,
  ): AsyncGenerator<OpenAISseEvent> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response) {
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSSEFrames(buffer, this.name);
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
    const parsed = parseSSEFrames(buffer, this.name);
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
    readonly providerFallback?: OpenAIProviderConfig["providerFallback"];
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
      providerFallback: args.providerFallback,
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
