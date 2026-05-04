import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export interface TokenUsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly reasoningOutputTokens: number;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readTokenUsageSummary(session: Session): TokenUsageSummary {
  const state = session.state.unsafePeek() as {
    totalTokenUsage?: Record<string, unknown>;
    initialTokenUsage?: Record<string, unknown>;
  };
  const usage = state.totalTokenUsage ?? state.initialTokenUsage ?? {};
  return {
    promptTokens: numberOrZero(usage.promptTokens),
    completionTokens: numberOrZero(usage.completionTokens),
    totalTokens: numberOrZero(usage.totalTokens),
    cachedInputTokens: numberOrZero(usage.cachedInputTokens),
    cacheCreationInputTokens: numberOrZero(usage.cacheCreationInputTokens),
    reasoningOutputTokens: numberOrZero(usage.reasoningOutputTokens),
  };
}

export function formatCacheStats(session: Session): string {
  const usage = readTokenUsageSummary(session);
  if (
    usage.totalTokens === 0 &&
    usage.cachedInputTokens === 0 &&
    usage.cacheCreationInputTokens === 0
  ) {
    return [
      "Cache stats",
      "  No token usage has been reported for this session yet.",
      "  Start a turn and re-run /cache-stats to see cache counters.",
    ].join("\n");
  }

  return [
    "Cache stats",
    `  prompt tokens: ${usage.promptTokens}`,
    `  completion tokens: ${usage.completionTokens}`,
    `  total tokens: ${usage.totalTokens}`,
    `  cached input tokens: ${usage.cachedInputTokens}`,
    `  cache creation input tokens: ${usage.cacheCreationInputTokens}`,
    `  reasoning output tokens: ${usage.reasoningOutputTokens}`,
  ].join("\n");
}

export const cacheStatsCommand: SlashCommand = {
  name: "cache-stats",
  description: "Show session token cache counters",
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({ kind: "text", text: formatCacheStats(ctx.session) })),
};

export default cacheStatsCommand;
