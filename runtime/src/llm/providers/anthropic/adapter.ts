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
  mapLLMError,
} from "../../errors.js";
import { ProviderHttpClient } from "../../client.js";
import { ProviderHttpError } from "../../client-session.js";
import {
  assertNonEmptyApiKey,
  buildBearerAuthHeaders,
} from "../../auth/bearer.js";
import {
  buildAnthropicMessagesRequest,
  parseAnthropicMessagesResponse,
} from "../../wire/messages-anthropic.js";
import type { AnthropicProviderConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";

  private readonly config: AnthropicProviderConfig;
  private readonly client: ProviderHttpClient;
  private readonly authHeaders: Record<string, string>;

  constructor(config: AnthropicProviderConfig) {
    this.config = config;
    this.client = new ProviderHttpClient({
      providerName: this.name,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
      defaultHeaders: {
        ...(config.defaultHeaders ?? {}),
        "anthropic-version":
          config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
        ...(config.betaHeaders && config.betaHeaders.length > 0
          ? { "anthropic-beta": config.betaHeaders.join(",") }
          : {}),
      },
      timeoutMs: config.timeoutMs,
      fetchImpl: config.fetchImpl,
    });
    this.authHeaders = buildBearerAuthHeaders({
      apiKey: assertNonEmptyApiKey(
        this.name,
        config.apiKey,
        "ANTHROPIC_API_KEY",
      ),
      headerName: "x-api-key",
      prefix: "",
    });
    this.authHeaders["x-api-key"] = this.authHeaders["x-api-key"].trimStart();
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const session = this.client.createTurnSession();
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;

    try {
      const request = buildAnthropicMessagesRequest({
        model: this.config.model,
        messages,
        tools: this.config.tools ?? [],
        options,
        maxTokens: this.config.maxTokens,
      });
      const response = await session.requestJson<Record<string, unknown>>({
        path: "/messages",
        method: "POST",
        headers: this.authHeaders,
        body: request,
        timeoutMs,
        signal: options?.signal,
      });
      return parseAnthropicMessagesResponse(this.config.model, response.data, {
        model: this.config.model,
        messages,
        tools: this.config.tools ?? [],
        options,
        maxTokens: this.config.maxTokens,
      });
    } catch (error) {
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
    const response = await this.chat(messages, options);
    onChunk({
      content: response.content,
      done: false,
      ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
    });
    onChunk({ content: "", done: true });
    return response;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const session = this.client.createTurnSession();
      await session.requestJson<Record<string, unknown>>({
        path: "/models",
        method: "GET",
        headers: this.authHeaders,
      });
      return true;
    } catch {
      return false;
    }
  }
}
