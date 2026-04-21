/**
 * xAI Responses wire shim.
 *
 * This is a thin compatibility wrapper over the OpenAI Responses
 * request/response shape with xAI-specific option slots preserved so
 * the future Grok refactor has a concrete module boundary to target.
 *
 * @module
 */

import type { LLMChatOptions, LLMMessage, LLMResponse, LLMTool } from "../types.js";
import {
  buildOpenAIResponsesRequest,
  parseOpenAIResponsesResponse,
  type OpenAIResponsesRequestOptions,
} from "./responses-openai.js";

export interface XaiResponsesRequestOptions
  extends OpenAIResponsesRequestOptions {
  readonly promptCacheKey?: string;
  readonly reasoningEffort?: LLMChatOptions["reasoningEffort"];
}

export function buildXaiResponsesRequest(
  input: XaiResponsesRequestOptions,
): Record<string, unknown> {
  const body = buildOpenAIResponsesRequest(input);
  if (input.promptCacheKey) {
    body.prompt_cache_key = input.promptCacheKey;
  }
  if (input.reasoningEffort) {
    body.reasoning = { effort: input.reasoningEffort };
  }
  return body;
}

export function parseXaiResponsesResponse(
  model: string,
  response: Record<string, unknown>,
  request: {
    readonly model: string;
    readonly messages: readonly LLMMessage[];
    readonly tools: readonly LLMTool[];
    readonly options?: LLMChatOptions;
    readonly store?: boolean;
  },
): LLMResponse {
  return parseOpenAIResponsesResponse(model, response, request);
}
