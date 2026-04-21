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
import {
  LLMAuthenticationError,
  mapLLMError,
} from "../../errors.js";
import { ProviderHttpClient } from "../../client.js";
import { ProviderHttpError } from "../../client-session.js";
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

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

function resolveTimeoutMs(
  providerTimeoutMs: number | undefined,
  callTimeoutMs: number | undefined,
): number | undefined {
  if (typeof callTimeoutMs === "number") return callTimeoutMs;
  return providerTimeoutMs;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";

  private readonly config: OpenAIProviderConfig;
  private readonly client: ProviderHttpClient;
  private readonly auth: OpenAIAuthSession;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    this.client = new ProviderHttpClient({
      providerName: this.name,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
      defaultHeaders: config.defaultHeaders,
      timeoutMs: config.timeoutMs,
      fetchImpl: config.fetchImpl,
    });
    this.auth = new OpenAIAuthSession(config);
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const session = this.client.createTurnSession();
    const timeoutMs = resolveTimeoutMs(this.config.timeoutMs, options?.timeoutMs);

    try {
      return await this.auth.withAuthHeaders(async (authHeaders) => {
        if (this.config.useResponsesApi !== false) {
          const request = buildOpenAIResponsesRequest({
            model: this.config.model,
            messages,
            tools: this.config.tools ?? [],
            options,
            store: this.config.store,
          });
          const response = await session.requestJson<Record<string, unknown>>({
            path: "/responses",
            method: "POST",
            headers: authHeaders,
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

        const request = buildChatCompletionsRequest({
          model: this.config.model,
          messages,
          tools: this.config.tools ?? [],
          options,
        });
        const response = await session.requestJson<Record<string, unknown>>({
          path: "/chat/completions",
          method: "POST",
          headers: authHeaders,
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
      await this.auth.withAuthHeaders(async (authHeaders) => {
        await session.requestJson<Record<string, unknown>>({
          path: "/models",
          method: "GET",
          headers: authHeaders,
        });
      });
      return true;
    } catch {
      return false;
    }
  }

  async retrieveStoredResponse(responseId: string): Promise<LLMStoredResponse> {
    const session = this.client.createTurnSession();
    const response = await this.auth.withAuthHeaders(async (authHeaders) =>
      session.requestJson<Record<string, unknown>>({
        path: `/responses/${encodeURIComponent(responseId)}`,
        method: "GET",
        headers: authHeaders,
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
    const session = this.client.createTurnSession();
    const response = await this.auth.withAuthHeaders(async (authHeaders) =>
      session.requestJson<Record<string, unknown>>({
        path: `/responses/${encodeURIComponent(responseId)}`,
        method: "DELETE",
        headers: authHeaders,
      }));
    return {
      id: String(response.data.id ?? responseId),
      provider: this.name,
      deleted: response.data.deleted === true,
      raw: response.data,
    };
  }
}
