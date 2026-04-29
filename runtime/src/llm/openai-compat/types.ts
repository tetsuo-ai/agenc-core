/**
 * OpenAI-compatible local LLM provider configuration types.
 *
 * Used by any server exposing the OpenAI /v1/chat/completions interface —
 * LM Studio, llama.cpp server, vLLM — without requiring xAI credentials.
 *
 * @module
 */

import type { LLMProviderConfig } from "../types.js";
import { LLMProviderError } from "../errors.js";
import type { LLMFailureClass, LLMPipelineStopReason } from "../policy.js";

/**
 * Configuration for the openai-compat local inference provider.
 */
export interface OpenAICompatProviderConfig extends LLMProviderConfig {
  /**
   * Base URL of the OpenAI-compatible server (e.g. "http://127.0.0.1:1234/v1").
   * Required. Validated on startup to resolve to a local or LAN address.
   */
  baseUrl: string;
  /**
   * API key passed in the Authorization header. Local servers do not
   * validate this value; any non-empty string is accepted.
   */
  apiKey: string;
  /**
   * Model context window in tokens, used for prompt budget sizing.
   * Required because local servers do not expose this via a standard API field.
   */
  contextWindowTokens: number;
  /**
   * End-to-end timeout in milliseconds for one chat request execution.
   * 0 or undefined = unlimited.
   */
  requestTimeoutMs?: number;
  /**
   * Timeout in milliseconds for a single tool execution call.
   * 0 or undefined = unlimited.
   */
  toolCallTimeoutMs?: number;
}

/**
 * Thrown when the startup reachability check against GET /v1/models fails —
 * either connection refused, network error, or 5s timeout.
 *
 * Maps to `failureClass: "provider_error"` for retry/circuit-breaker handling.
 */
export class OpenAICompatServerUnreachableError extends LLMProviderError {
  public readonly failureClass: LLMFailureClass = "provider_error";
  public readonly stopReason: LLMPipelineStopReason = "provider_error";
  public readonly baseUrl: string;

  constructor(baseUrl: string, cause: string) {
    super(
      "openai-compat",
      `Local server at "${baseUrl}" is unreachable. ` +
        `Ensure the server is running before starting the daemon. ` +
        `Cause: ${cause}`,
      503,
    );
    this.name = "OpenAICompatServerUnreachableError";
    this.baseUrl = baseUrl;
  }
}

/**
 * Thrown when the configured model is not present in the server's
 * GET /v1/models response.
 *
 * Maps to `failureClass: "provider_error"` — the server is reachable but
 * the requested model has not been loaded.
 */
export class OpenAICompatUnknownModelError extends LLMProviderError {
  public readonly failureClass: LLMFailureClass = "provider_error";
  public readonly stopReason: LLMPipelineStopReason = "provider_error";
  public readonly requestedModel: string;

  constructor(requestedModel: string, baseUrl: string) {
    super(
      "openai-compat",
      `Model "${requestedModel}" is not available at "${baseUrl}". ` +
        `Check GET /v1/models on the running server and set llm.model in ` +
        `config.json to one of the returned model IDs.`,
      404,
    );
    this.name = "OpenAICompatUnknownModelError";
    this.requestedModel = requestedModel;
  }
}
