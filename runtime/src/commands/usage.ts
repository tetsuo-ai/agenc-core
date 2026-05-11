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

interface DaemonUsageSnapshot {
  readonly tokenUsage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly costUsd?: number;
  };
}

function formatRemaining(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "unlimited"
    : String(value);
}

export function formatUsage(
  session: Session,
  daemonSnapshot?: DaemonUsageSnapshot,
): string {
  const usage: TokenUsageSummary = readTokenUsageSummary(session);
  const budget = session.budgetTracker;
  // Bridge sessions read zeros from the local token-usage summary
  // because the daemon-owned session is the one accruing the
  // counters. Overlay the daemon snapshot when we have it.
  const total =
    daemonSnapshot?.tokenUsage?.totalTokens ?? usage.totalTokens;
  const input =
    daemonSnapshot?.tokenUsage?.inputTokens ?? usage.promptTokens;
  const output =
    daemonSnapshot?.tokenUsage?.outputTokens ?? usage.completionTokens;
  const lines = [
    "Usage",
    `  total tokens: ${total}`,
    `  prompt tokens: ${input}`,
    `  completion tokens: ${output}`,
    `  cached input tokens: ${usage.cachedInputTokens}`,
    `  budget emitted: ${budget ? budget.emitted : "n/a"}`,
    `  budget remaining: ${budget ? formatRemaining(budget.remaining) : "n/a"}`,
  ];
  const costUsd = daemonSnapshot?.tokenUsage?.costUsd;
  if (typeof costUsd === "number" && costUsd > 0) {
    lines.push(`  cost (USD): $${costUsd.toFixed(4)}`);
  }
  return lines.join("\n");
}

export const usageCommand: SlashCommand = {
  name: "usage",
  description: "Show session token usage and budget state",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      // Best-effort daemon-snapshot overlay for bridge sessions.
      let snapshot: DaemonUsageSnapshot | undefined;
      const getSnapshot = (ctx.session as unknown as {
        getDaemonSessionSnapshot?: () => Promise<DaemonUsageSnapshot>;
      }).getDaemonSessionSnapshot;
      if (typeof getSnapshot === "function") {
        try {
          snapshot = await getSnapshot();
        } catch {
          /* best-effort */
        }
      }
      return { kind: "text", text: formatUsage(ctx.session, snapshot) };
    }),
};

export default usageCommand;
