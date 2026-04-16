import type { ArtifactCompactionState } from "../../memory/artifact-store.js";
import { estimateMessageChars } from "../chat-executor-text.js";
import { renderArtifactContextPrompt } from "../context-compaction.js";
import { normalizeMessagesForAPI } from "../messages.js";
import type { LLMMessage, LLMUsage } from "../types.js";
import { tokenCountWithEstimation } from "./token-count.js";

export const RESERVED_OUTPUT_TOKEN_CAP = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;
export const DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS = 120_000;

const BOUNDARY_PREFIXES = [
  "[snip]",
  "[microcompact]",
  "[context-collapse]",
  "[autocompact]",
  "[reactive-compact]",
  "[boundary]",
] as const;

export interface CurrentContextUsageSection {
  readonly id: "system" | "memory" | "history" | "tools" | "user" | "other";
  readonly label: string;
  readonly tokens: number;
  readonly percent: number;
}

export interface CurrentContextUsageSnapshot {
  readonly currentTokens: number;
  readonly effectiveContextWindowTokens?: number;
  readonly autocompactThresholdTokens: number;
  readonly warningThresholdTokens?: number;
  readonly errorThresholdTokens?: number;
  readonly blockingThresholdTokens?: number;
  readonly percentUsed?: number;
  readonly freeTokens?: number;
  readonly isAboveAutocompactThreshold: boolean;
  readonly isAtBlockingLimit: boolean;
  readonly sections: readonly CurrentContextUsageSection[];
}

function charsToTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) {
    return 0;
  }
  return Math.max(0, Math.ceil(chars / 4));
}

function normalizePositiveInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function isValidMessageCandidate(value: unknown): value is LLMMessage {
  return (
    !!value &&
    typeof value === "object" &&
    "role" in value &&
    typeof (value as { role?: unknown }).role === "string" &&
    "content" in value
  );
}

export function getReservedOutputTokens(maxOutputTokens?: number): number {
  return Math.min(
    normalizePositiveInt(maxOutputTokens) ?? RESERVED_OUTPUT_TOKEN_CAP,
    RESERVED_OUTPUT_TOKEN_CAP,
  );
}

export function getEffectiveContextWindowSize(
  contextWindowTokens?: number,
  maxOutputTokens?: number,
): number | undefined {
  const normalizedWindow = normalizePositiveInt(contextWindowTokens);
  if (!normalizedWindow) {
    return undefined;
  }
  return Math.max(1_024, normalizedWindow - getReservedOutputTokens(maxOutputTokens));
}

export function getAutoCompactThresholdTokens(params: {
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}): number {
  const effectiveWindow = getEffectiveContextWindowSize(
    params.contextWindowTokens,
    params.maxOutputTokens,
  );
  if (!effectiveWindow) {
    return DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS;
  }
  return Math.max(1_024, effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS);
}

export function getMessagesAfterCompactBoundary(
  messages: readonly LLMMessage[],
): readonly LLMMessage[] {
  const validMessages = messages.filter(isValidMessageCandidate);
  for (let index = validMessages.length - 1; index >= 0; index -= 1) {
    const message = validMessages[index];
    const content =
      message?.role === "system" && typeof message.content === "string"
        ? message.content
        : undefined;
    if (
      content &&
      BOUNDARY_PREFIXES.some((prefix) => content.startsWith(prefix))
    ) {
      return validMessages.slice(index + 1);
    }
  }
  return validMessages;
}

export function buildCurrentApiView(params: {
  readonly baseSystemPrompt?: string;
  readonly artifactContext?: ArtifactCompactionState;
  readonly summaryText?: string;
  readonly history: readonly LLMMessage[];
  readonly currentUserMessage?: string;
}): readonly LLMMessage[] {
  const apiView: LLMMessage[] = [];
  const systemPrompt = params.baseSystemPrompt?.trim();
  if (systemPrompt) {
    apiView.push({ role: "system", content: systemPrompt });
  }
  if (params.artifactContext) {
    apiView.push({
      role: "system",
      content: renderArtifactContextPrompt(params.artifactContext),
    });
  } else if (params.summaryText?.trim()) {
    apiView.push({ role: "system", content: params.summaryText.trim() });
  }
  apiView.push(...getMessagesAfterCompactBoundary(params.history));
  if (params.currentUserMessage?.trim()) {
    apiView.push({ role: "user", content: params.currentUserMessage.trim() });
  }
  return normalizeMessagesForAPI(apiView);
}

function summarizeSections(messages: readonly LLMMessage[]): readonly CurrentContextUsageSection[] {
  let systemChars = 0;
  let memoryChars = 0;
  let historyChars = 0;
  let toolChars = 0;
  let userChars = 0;
  let otherChars = 0;

  for (const message of messages) {
    const chars = estimateMessageChars(message);
    if (
      message.role === "system" &&
      typeof message.content === "string" &&
      (message.content.startsWith("Durable task state:") ||
        message.content.startsWith("Artifact refs:") ||
        message.content.includes("Unresolved work remains"))
    ) {
      memoryChars += chars;
      continue;
    }
    switch (message.role) {
      case "system":
        systemChars += chars;
        break;
      case "tool":
        toolChars += chars;
        break;
      case "user":
        userChars += chars;
        break;
      case "assistant":
        historyChars += chars;
        break;
      default:
        otherChars += chars;
        break;
    }
  }

  const sectionBases = [
    { id: "system", label: "System prompt", tokens: charsToTokens(systemChars) },
    { id: "memory", label: "Session memory", tokens: charsToTokens(memoryChars) },
    { id: "history", label: "Chat history", tokens: charsToTokens(historyChars) },
    { id: "tools", label: "Tool schema/results", tokens: charsToTokens(toolChars) },
    { id: "user", label: "Current user turn", tokens: charsToTokens(userChars) },
    { id: "other", label: "Other", tokens: charsToTokens(otherChars) },
  ] as const;
  const totalTokens = sectionBases.reduce((sum, section) => sum + section.tokens, 0);
  return sectionBases
    .filter((section) => section.tokens > 0)
    .map((section) => ({
      ...section,
      percent:
        totalTokens > 0
          ? Number(((section.tokens / totalTokens) * 100).toFixed(1))
          : 0,
    }));
}

export function buildCurrentContextUsageSnapshot(params: {
  readonly messages: readonly LLMMessage[];
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly lastResponseUsage?: LLMUsage;
}): CurrentContextUsageSnapshot {
  const currentTokens = tokenCountWithEstimation({
    messages: params.messages,
    lastResponseUsage: params.lastResponseUsage,
  });
  const effectiveContextWindowTokens = getEffectiveContextWindowSize(
    params.contextWindowTokens,
    params.maxOutputTokens,
  );
  const autocompactThresholdTokens = getAutoCompactThresholdTokens({
    contextWindowTokens: params.contextWindowTokens,
    maxOutputTokens: params.maxOutputTokens,
  });
  const warningThresholdTokens =
    effectiveContextWindowTokens !== undefined
      ? Math.max(0, autocompactThresholdTokens - WARNING_THRESHOLD_BUFFER_TOKENS)
      : undefined;
  const errorThresholdTokens =
    effectiveContextWindowTokens !== undefined
      ? Math.max(0, autocompactThresholdTokens - ERROR_THRESHOLD_BUFFER_TOKENS)
      : undefined;
  const blockingThresholdTokens =
    effectiveContextWindowTokens !== undefined
      ? Math.max(1_024, effectiveContextWindowTokens - MANUAL_COMPACT_BUFFER_TOKENS)
      : undefined;
  const freeTokens =
    effectiveContextWindowTokens !== undefined
      ? Math.max(0, effectiveContextWindowTokens - currentTokens)
      : undefined;
  const percentUsed =
    effectiveContextWindowTokens !== undefined && effectiveContextWindowTokens > 0
      ? Math.max(
          0,
          Math.min(100, Number(((currentTokens / effectiveContextWindowTokens) * 100).toFixed(1))),
        )
      : undefined;

  return {
    currentTokens,
    effectiveContextWindowTokens,
    autocompactThresholdTokens,
    warningThresholdTokens,
    errorThresholdTokens,
    blockingThresholdTokens,
    freeTokens,
    percentUsed,
    isAboveAutocompactThreshold: currentTokens >= autocompactThresholdTokens,
    isAtBlockingLimit:
      blockingThresholdTokens !== undefined &&
      currentTokens >= blockingThresholdTokens,
    sections: summarizeSections(params.messages),
  };
}
