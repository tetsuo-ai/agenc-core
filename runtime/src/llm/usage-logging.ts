import { createHash } from "node:crypto";
import type { Logger } from "../utils/logger.js";

export interface LlmUsageLoggingConfig {
  readonly enabled?: boolean;
  readonly level?: "debug" | "info";
  readonly includeIdentifiers?: boolean;
  readonly includeCallContext?: boolean;
  readonly includePromptShape?: boolean;
  readonly includeBudgetDiagnostics?: boolean;
  readonly sampleRate?: number;
}

export interface ResolvedLlmUsageLoggingConfig {
  readonly enabled: boolean;
  readonly level: "debug" | "info";
  readonly includeIdentifiers: boolean;
  readonly includeCallContext: boolean;
  readonly includePromptShape: boolean;
  readonly includeBudgetDiagnostics: boolean;
  readonly sampleRate: number;
}

export interface ChatRuntimeIdentifiers {
  readonly traceId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly parentSessionId?: string;
}

interface UsageLike {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

interface PromptShapeLike {
  readonly messageCount: number;
  readonly systemMessages: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolMessages: number;
  readonly estimatedChars: number;
  readonly systemPromptChars: number;
}

interface PromptBudgetSectionStatsLike {
  readonly droppedMessages: number;
  readonly truncatedMessages: number;
}

interface PromptBudgetDiagnosticsLike {
  readonly constrained: boolean;
  readonly totalBeforeChars: number;
  readonly totalAfterChars: number;
  readonly droppedSections: readonly string[];
  readonly sections: Record<string, PromptBudgetSectionStatsLike>;
}

export interface LlmCallUsageRecordLike {
  readonly callIndex: number;
  readonly phase: string;
  readonly provider: string;
  readonly model?: string;
  readonly finishReason: string;
  readonly usage: UsageLike;
  readonly durationMs: number;
  readonly beforeBudget: PromptShapeLike;
  readonly afterBudget: PromptShapeLike;
  readonly budgetDiagnostics?: PromptBudgetDiagnosticsLike;
}

export const DEFAULT_LLM_USAGE_LOGGING_CONFIG: ResolvedLlmUsageLoggingConfig = {
  enabled: false,
  level: "info",
  includeIdentifiers: true,
  includeCallContext: true,
  includePromptShape: false,
  includeBudgetDiagnostics: false,
  sampleRate: 1,
};

function normalizeSampleRate(sampleRate: number | undefined): number {
  if (sampleRate === undefined || Number.isNaN(sampleRate)) {
    return DEFAULT_LLM_USAGE_LOGGING_CONFIG.sampleRate;
  }
  if (sampleRate <= 0) return 0;
  if (sampleRate >= 1) return 1;
  return sampleRate;
}

function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicSample(key: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  const value = Number.parseInt(hashHex(key).slice(0, 8), 16);
  return value / 0xffff_ffff < sampleRate;
}

function normalizeUsageCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function trimOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function summarizePromptShape(shape: PromptShapeLike): Record<string, number> {
  return {
    messageCount: shape.messageCount,
    systemMessages: shape.systemMessages,
    userMessages: shape.userMessages,
    assistantMessages: shape.assistantMessages,
    toolMessages: shape.toolMessages,
    estimatedChars: shape.estimatedChars,
    systemPromptChars: shape.systemPromptChars,
  };
}

function summarizeBudgetDiagnostics(
  diagnostics: PromptBudgetDiagnosticsLike,
): Record<string, unknown> {
  let droppedMessages = 0;
  let truncatedMessages = 0;
  for (const stats of Object.values(diagnostics.sections)) {
    droppedMessages += stats.droppedMessages;
    truncatedMessages += stats.truncatedMessages;
  }
  return {
    constrained: diagnostics.constrained,
    totalBeforeChars: diagnostics.totalBeforeChars,
    totalAfterChars: diagnostics.totalAfterChars,
    droppedSections: [...diagnostics.droppedSections],
    droppedMessages,
    truncatedMessages,
  };
}

export function resolveLlmUsageLoggingConfig(
  config?: LlmUsageLoggingConfig,
): ResolvedLlmUsageLoggingConfig {
  if (!config?.enabled) {
    return DEFAULT_LLM_USAGE_LOGGING_CONFIG;
  }
  return {
    enabled: true,
    level: config.level ?? DEFAULT_LLM_USAGE_LOGGING_CONFIG.level,
    includeIdentifiers:
      config.includeIdentifiers ??
      DEFAULT_LLM_USAGE_LOGGING_CONFIG.includeIdentifiers,
    includeCallContext:
      config.includeCallContext ??
      DEFAULT_LLM_USAGE_LOGGING_CONFIG.includeCallContext,
    includePromptShape:
      config.includePromptShape ??
      DEFAULT_LLM_USAGE_LOGGING_CONFIG.includePromptShape,
    includeBudgetDiagnostics:
      config.includeBudgetDiagnostics ??
      DEFAULT_LLM_USAGE_LOGGING_CONFIG.includeBudgetDiagnostics,
    sampleRate: normalizeSampleRate(config.sampleRate),
  };
}

export function usageMetadataAvailable(usage: UsageLike): boolean {
  return (
    normalizeUsageCount(usage.promptTokens) > 0 ||
    normalizeUsageCount(usage.completionTokens) > 0 ||
    normalizeUsageCount(usage.totalTokens) > 0
  );
}

export function shouldEmitLlmUsageLog(
  config: ResolvedLlmUsageLoggingConfig,
  sampleKey: string,
): boolean {
  if (!config.enabled) return false;
  return deterministicSample(sampleKey, config.sampleRate);
}

export function buildLlmCallUsageLogPayload(params: {
  readonly sessionId: string;
  readonly identifiers?: ChatRuntimeIdentifiers;
  readonly record: LlmCallUsageRecordLike;
  readonly usedFallback: boolean;
  readonly rerouted: boolean;
  readonly downgraded: boolean;
  readonly config: ResolvedLlmUsageLoggingConfig;
}): Record<string, unknown> {
  const { sessionId, identifiers, record, usedFallback, rerouted, downgraded, config } = params;
  const usage = {
    promptTokens: normalizeUsageCount(record.usage.promptTokens),
    completionTokens: normalizeUsageCount(record.usage.completionTokens),
    totalTokens: normalizeUsageCount(record.usage.totalTokens),
  };
  const payload: Record<string, unknown> = {
    event: "llm.call_usage",
    provider: record.provider,
    model: trimOptionalString(record.model) ?? null,
    usageAvailable: usageMetadataAvailable(record.usage),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    durationMs: record.durationMs,
    finishReason: record.finishReason,
  };

  if (config.includeIdentifiers) {
    payload.sessionId = sessionId;
    const traceId = trimOptionalString(identifiers?.traceId);
    const runId = trimOptionalString(identifiers?.runId);
    const taskId = trimOptionalString(identifiers?.taskId);
    const parentSessionId = trimOptionalString(identifiers?.parentSessionId);
    if (traceId) payload.traceId = traceId;
    if (runId) payload.runId = runId;
    if (taskId) payload.taskId = taskId;
    if (parentSessionId) payload.parentSessionId = parentSessionId;
  }

  if (config.includeCallContext) {
    payload.callIndex = record.callIndex;
    payload.phase = record.phase;
    payload.usedFallback = usedFallback;
    payload.rerouted = rerouted;
    payload.downgraded = downgraded;
  }

  if (config.includePromptShape) {
    payload.promptShape = {
      before: summarizePromptShape(record.beforeBudget),
      after: summarizePromptShape(record.afterBudget),
    };
  }

  if (config.includeBudgetDiagnostics && record.budgetDiagnostics) {
    payload.budgetDiagnostics = summarizeBudgetDiagnostics(
      record.budgetDiagnostics,
    );
  }

  return payload;
}

export function emitLlmCallUsageLog(params: {
  readonly logger: Logger;
  readonly config: ResolvedLlmUsageLoggingConfig;
  readonly payload: Record<string, unknown>;
}): void {
  const { logger, config, payload } = params;
  if (config.level === "debug") {
    logger.debug("llm.call_usage", payload);
    return;
  }
  logger.info("llm.call_usage", payload);
}
