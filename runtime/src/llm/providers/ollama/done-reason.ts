/**
 * Normalize Ollama `done_reason` into AgenC's finish-reason contract.
 *
 * Known values (Ollama chat API):
 * - `length` → AgenC `length` (truncation; callers must withhold tool calls)
 * - `stop` → AgenC `stop`, or `tool_calls` when complete calls are present
 * - `load` / `unload` → AgenC `stop` (documented non-generation terminals)
 *
 * Missing or blank reasons keep the current successful fallback (`stop` /
 * `tool_calls`) and are labeled `missing` in diagnostics. Unknown non-empty
 * reasons become AgenC `error` and preserve the raw value instead of silently
 * mapping to a natural stop.
 *
 * @module
 */

import { LLMInvalidResponseError } from "../../errors.js";
import type { LLMResponse } from "../../types.js";

export type OllamaDoneReasonKind = "mapped" | "missing" | "unknown";
export type OllamaMappedDoneReason = "stop" | "length" | "error";

export interface OllamaDoneReasonNormalization {
  readonly rawReason: string | undefined;
  readonly kind: OllamaDoneReasonKind;
  readonly truncated: boolean;
  readonly mappedReason: OllamaMappedDoneReason;
}

function readOllamaDoneReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function mapKnownOllamaDoneReason(reason: string): OllamaMappedDoneReason | undefined {
  switch (reason) {
    case "length":
      return "length";
    case "stop":
    case "load":
    case "unload":
      return "stop";
    default:
      return undefined;
  }
}

export function normalizeOllamaDoneReason(raw: unknown): OllamaDoneReasonNormalization {
  const rawReason = readOllamaDoneReason(raw);
  if (rawReason === undefined) {
    return {
      rawReason,
      kind: "missing",
      truncated: false,
      mappedReason: "stop",
    };
  }
  const mappedReason = mapKnownOllamaDoneReason(rawReason);
  if (mappedReason === undefined) {
    return {
      rawReason,
      kind: "unknown",
      truncated: false,
      mappedReason: "error",
    };
  }
  return {
    rawReason,
    kind: "mapped",
    truncated: mappedReason === "length",
    mappedReason,
  };
}

export function ollamaFinishReason(
  normalized: OllamaDoneReasonNormalization,
  toolCallCount: number,
): LLMResponse["finishReason"] {
  if (normalized.truncated) return "length";
  if (normalized.mappedReason === "error") return "error";
  return toolCallCount > 0 ? "tool_calls" : "stop";
}

export function ollamaAcceptsToolCalls(normalized: OllamaDoneReasonNormalization): boolean {
  return !normalized.truncated && normalized.mappedReason === "stop";
}

export function ollamaDoneReasonTrace(
  normalized: OllamaDoneReasonNormalization,
): Record<string, unknown> {
  return {
    done_reason: normalized.rawReason ?? null,
    done_reason_kind: normalized.kind,
    ...(normalized.kind === "mapped"
      ? {}
      : { done_reason_fallback: normalized.mappedReason }),
  };
}

export function ollamaUnknownDoneReasonError(
  providerName: string,
  rawReason: string,
): LLMInvalidResponseError {
  return new LLMInvalidResponseError(
    providerName,
    `Unknown Ollama done_reason ${JSON.stringify(rawReason)}`,
  );
}
