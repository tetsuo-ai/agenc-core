/**
 * Gemini usageMetadata → AgenC LLMUsage.
 *
 * Google reports `candidatesTokenCount` and `thoughtsTokenCount` separately
 * and prices the response as candidate + thinking tokens. AgenC's cost and
 * budget contracts treat `reasoningOutputTokens` as a subset of completion
 * output, so `completionTokens` is the inclusive generated total.
 *
 * `toolUsePromptTokenCount` is prompt-side. Google sometimes folds it into
 * `totalTokenCount` without adding it to `promptTokenCount`. This mapper
 * never adds those tokens to prompt or completion; it only uses them to
 * explain a reported total. The provider `totalTokenCount` stays
 * authoritative even when the parts do not reconcile.
 *
 * @module
 */

import { coerceUsage } from "../../wire/shared.js";
import type { LLMUsage } from "../../types.js";

export type GeminiUsageDiagnosticSink = (diagnostic: {
  readonly cause: string;
  readonly message: string;
}) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

export function requestUsageFromGemini(
  usage: unknown,
  emitDiagnostic?: GeminiUsageDiagnosticSink,
): LLMUsage {
  const record = isRecord(usage) ? usage : {};
  const promptTokens = finiteTokenCount(record.promptTokenCount);
  const candidatesTokenCount = finiteTokenCount(record.candidatesTokenCount);
  const thoughtsTokenCount = finiteTokenCount(record.thoughtsTokenCount);
  const toolUsePromptTokenCount = finiteTokenCount(
    record.toolUsePromptTokenCount,
  );
  const totalTokenCount = finiteTokenCount(record.totalTokenCount);
  const cachedContentTokenCount = finiteTokenCount(
    record.cachedContentTokenCount,
  );
  const hasOutputParts =
    candidatesTokenCount !== undefined || thoughtsTokenCount !== undefined;
  const completionTokens =
    (candidatesTokenCount ?? 0) + (thoughtsTokenCount ?? 0);
  const reconstructedTotalTokenCount = (promptTokens ?? 0) + completionTokens;
  const reconstructedTotalTokenCountWithToolUsePrompt =
    reconstructedTotalTokenCount + (toolUsePromptTokenCount ?? 0);
  const hasReportedParts =
    promptTokens !== undefined ||
    candidatesTokenCount !== undefined ||
    thoughtsTokenCount !== undefined ||
    toolUsePromptTokenCount !== undefined;

  if (
    emitDiagnostic &&
    totalTokenCount !== undefined &&
    hasReportedParts &&
    totalTokenCount !== reconstructedTotalTokenCount &&
    totalTokenCount !== reconstructedTotalTokenCountWithToolUsePrompt
  ) {
    emitDiagnostic({
      cause: "gemini_usage_total_mismatch",
      message: JSON.stringify({
        ...(promptTokens !== undefined ? { promptTokenCount: promptTokens } : {}),
        ...(candidatesTokenCount !== undefined
          ? { candidatesTokenCount }
          : {}),
        ...(thoughtsTokenCount !== undefined ? { thoughtsTokenCount } : {}),
        ...(toolUsePromptTokenCount !== undefined
          ? { toolUsePromptTokenCount }
          : {}),
        reportedTotalTokenCount: totalTokenCount,
        reconstructedTotalTokenCount,
        reconstructedTotalTokenCountWithToolUsePrompt,
        inclusiveCompletionTokens: completionTokens,
      }),
    });
  }

  return coerceUsage({
    promptTokens,
    ...(hasOutputParts ? { completionTokens } : {}),
    totalTokens: totalTokenCount,
    cachedInputTokens: cachedContentTokenCount,
    ...(thoughtsTokenCount !== undefined
      ? { reasoningOutputTokens: thoughtsTokenCount }
      : {}),
  });
}
