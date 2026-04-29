/**
 * Token-stat analysis compact emits to telemetry. The gut runtime does
 * not own a Statsig/GrowthBook telemetry pipeline; `analyzeContext`
 * returns a deterministic shape with zeros so callers can still
 * compute ratios without crashes, and `tokenStatsToStatsigMetrics`
 * returns an empty record.
 */

import { roughTokenCountEstimationForMessages } from "./token-counts.js";

interface MessageLike {
  readonly type?: string;
  readonly content?: unknown;
  readonly message?: { readonly content?: unknown };
}

export interface TokenStats {
  readonly totalTokens: number;
  readonly userTokens: number;
  readonly assistantTokens: number;
  readonly toolResultTokens: number;
  readonly systemTokens: number;
  readonly attachmentTokens: number;
  readonly messageCount: number;
}

export function analyzeContext(
  messages: ReadonlyArray<MessageLike>,
  ..._rest: unknown[]
): TokenStats {
  let userTokens = 0;
  let assistantTokens = 0;
  let toolResultTokens = 0;
  let systemTokens = 0;
  let attachmentTokens = 0;
  for (const m of messages) {
    const tokens = roughTokenCountEstimationForMessages([m]);
    switch (m.type) {
      case "user":
        userTokens += tokens;
        break;
      case "assistant":
        assistantTokens += tokens;
        break;
      case "tool_result":
        toolResultTokens += tokens;
        break;
      case "system":
        systemTokens += tokens;
        break;
      case "attachment":
        attachmentTokens += tokens;
        break;
      default:
        break;
    }
  }
  return {
    totalTokens:
      userTokens +
      assistantTokens +
      toolResultTokens +
      systemTokens +
      attachmentTokens,
    userTokens,
    assistantTokens,
    toolResultTokens,
    systemTokens,
    attachmentTokens,
    messageCount: messages.length,
  };
}

export function tokenStatsToStatsigMetrics(
  _stats: TokenStats,
): Record<string, number> {
  return {};
}
