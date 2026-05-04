import type { Session } from "../session/session.js";
import {
  readTokenUsageSummary,
  type TokenUsageSummary,
} from "./cache-stats.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

function formatRemaining(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "unlimited"
    : String(value);
}

export function formatUsage(session: Session): string {
  const usage: TokenUsageSummary = readTokenUsageSummary(session);
  const budget = session.budgetTracker;
  return [
    "Usage",
    `  total tokens: ${usage.totalTokens}`,
    `  prompt tokens: ${usage.promptTokens}`,
    `  completion tokens: ${usage.completionTokens}`,
    `  cached input tokens: ${usage.cachedInputTokens}`,
    `  budget emitted: ${budget ? budget.emitted : "n/a"}`,
    `  budget remaining: ${budget ? formatRemaining(budget.remaining) : "n/a"}`,
  ].join("\n");
}

export const usageCommand: SlashCommand = {
  name: "usage",
  description: "Show session token usage and budget state",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({ kind: "text", text: formatUsage(ctx.session) })),
};

export default usageCommand;
