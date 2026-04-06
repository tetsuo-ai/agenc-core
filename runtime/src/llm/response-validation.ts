/**
 * Shared validation for provider response envelopes.
 *
 * Providers and SDKs occasionally return transport-level success with a
 * malformed or incomplete payload. Fail closed with a typed provider error so
 * the fallback layer can classify the failure instead of throwing raw
 * TypeErrors later in the pipeline.
 *
 * @module
 */

import { LLMInvalidResponseError } from "./errors.js";
import type { LLMResponse, LLMToolCall, LLMUsage } from "./types.js";

const VALID_FINISH_REASONS = new Set([
  "stop",
  "tool_calls",
  "length",
  "content_filter",
  "error",
]);

function isUsageShape(value: unknown): value is LLMUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const usage = value as Record<string, unknown>;
  return ["promptTokens", "completionTokens", "totalTokens"].every((key) =>
    typeof usage[key] === "number" && Number.isFinite(usage[key] as number),
  );
}

function isToolCallShape(value: unknown): value is LLMToolCall {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const toolCall = value as Record<string, unknown>;
  return (
    typeof toolCall.id === "string" &&
    toolCall.id.length > 0 &&
    typeof toolCall.name === "string" &&
    toolCall.name.length > 0 &&
    typeof toolCall.arguments === "string"
  );
}

export function assertValidLLMResponse(
  providerName: string,
  response: unknown,
): LLMResponse {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new LLMInvalidResponseError(
      providerName,
      "Provider returned an invalid response envelope",
    );
  }

  const candidate = response as Record<string, unknown>;
  if (typeof candidate.content !== "string") {
    throw new LLMInvalidResponseError(
      providerName,
      "Provider response is missing string content",
    );
  }
  if (!Array.isArray(candidate.toolCalls) || !candidate.toolCalls.every(isToolCallShape)) {
    throw new LLMInvalidResponseError(
      providerName,
      "Provider response has invalid toolCalls",
    );
  }
  if (typeof candidate.model !== "string" || candidate.model.length === 0) {
    throw new LLMInvalidResponseError(
      providerName,
      "Provider response is missing model metadata",
    );
  }
  if (!isUsageShape(candidate.usage)) {
    throw new LLMInvalidResponseError(
      providerName,
      "Provider response is missing usage metadata",
    );
  }
  if (
    typeof candidate.finishReason !== "string" ||
    !VALID_FINISH_REASONS.has(candidate.finishReason)
  ) {
    throw new LLMInvalidResponseError(
      providerName,
      "Provider response is missing a valid finishReason",
    );
  }

  return candidate as unknown as LLMResponse;
}
