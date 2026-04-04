/**
 * Structured-output helpers shared by provider adapters and planner/verifier flows.
 *
 * xAI MCP source of truth:
 * - Structured outputs are supported by all language models.
 * - Structured outputs with tools are only supported by the Grok 4 family.
 *
 * @module
 */

import type {
  LLMResponse,
  LLMStructuredOutputResult,
} from "./types.js";
import { parseJsonObjectFromText } from "./chat-executor-text.js";

export function supportsXaiStructuredOutputsWithTools(
  model: string | undefined,
): boolean {
  if (typeof model !== "string") return false;
  return /^grok-4(?:[.-]|$)/i.test(model.trim());
}

export function parseStructuredOutputText(
  rawText: string,
  schemaName?: string,
): LLMStructuredOutputResult {
  const trimmed = rawText.trim();
  let parsed: unknown;
  if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      parsed = undefined;
    }
  }
  return {
    type: "json_schema",
    ...(schemaName ? { name: schemaName } : {}),
    rawText,
    ...(parsed !== undefined ? { parsed } : {}),
  };
}

export function extractStructuredOutputObject(
  result: Pick<LLMResponse, "content" | "structuredOutput">,
): Record<string, unknown> | undefined {
  const parsed = result.structuredOutput?.parsed;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  const rawText = result.structuredOutput?.rawText;
  if (typeof rawText === "string" && rawText.trim().length > 0) {
    return parseJsonObjectFromText(rawText);
  }
  return parseJsonObjectFromText(result.content);
}
