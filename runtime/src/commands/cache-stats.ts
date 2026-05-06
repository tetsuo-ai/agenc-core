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

const MAX_RECENT_ROWS = 20;

interface CacheMetrics {
  readonly read: number;
  readonly created: number;
  readonly total: number;
  readonly hitRate: number | null;
  readonly supported: boolean;
}

interface CacheStatsEntry {
  readonly timestamp: number;
  readonly label: string;
  readonly metrics: CacheMetrics;
}

interface CacheStatsTracker {
  getCacheStatsHistory(): CacheStatsEntry[];
  getCurrentTurnCacheMetrics(): CacheMetrics;
  getSessionCacheMetrics(): CacheMetrics;
}

async function loadCacheStatsTracker(): Promise<CacheStatsTracker> {
  const trackerModulePath: string =
    "../services/api/cacheStatsTracker.js";
  return import(trackerModulePath) as Promise<CacheStatsTracker>;
}

function formatCompactNumber(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function formatCacheMetricsCompact(metrics: CacheMetrics | undefined | null): string {
  if (!metrics?.supported) return "[Cache: N/A]";
  if (metrics.read === 0 && metrics.created === 0) return "[Cache: cold]";
  const parts = [`${formatCompactNumber(metrics.read)} read`];
  if (metrics.hitRate !== null) {
    parts.push(`hit ${Math.round(metrics.hitRate * 100)}%`);
  }
  return `[Cache: ${parts.join(" • ")}]`;
}

function formatCacheMetricsFull(metrics: CacheMetrics | undefined | null): string {
  if (!metrics?.supported) return "[Cache: N/A]";
  const parts = [
    `read=${formatCompactNumber(metrics.read)}`,
    `created=${formatCompactNumber(metrics.created)}`,
    `hit=${metrics.hitRate === null ? "n/a" : `${Math.round(metrics.hitRate * 100)}%`}`,
  ];
  return `[Cache: ${parts.join(" ")}]`;
}

function formatCacheStatsRow(entry: CacheStatsEntry, idx: number): string {
  const iso = new Date(entry.timestamp).toISOString();
  const ts = `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
  const cache = formatCacheMetricsCompact(entry.metrics);
  return `  #${String(idx + 1).padStart(3)}  ${ts}  ${entry.label.padEnd(28).slice(0, 28)}  ${cache}`;
}

function summarizeCacheMetrics(label: string, metrics: CacheMetrics): string {
  return `${label.padEnd(18)}${formatCacheMetricsFull(metrics)}`;
}

export async function formatCacheStats(): Promise<string> {
  let tracker: CacheStatsTracker;
  try {
    tracker = await loadCacheStatsTracker();
  } catch {
    return [
      "Cache stats",
      "  No API requests yet this session.",
      "  Start a turn and re-run /cache-stats to see results.",
    ].join("\n");
  }
  const history = tracker.getCacheStatsHistory();
  if (history.length === 0) {
    return [
      "Cache stats",
      "  No API requests yet this session.",
      "  Start a turn and re-run /cache-stats to see results.",
    ].join("\n");
  }

  const recent = history.slice(-MAX_RECENT_ROWS);
  const omitted = history.length - recent.length;
  return [
    "Cache stats",
    "",
    summarizeCacheMetrics("Current turn:", tracker.getCurrentTurnCacheMetrics()),
    summarizeCacheMetrics("Session total:", tracker.getSessionCacheMetrics()),
    "",
    `Recent requests (${recent.length}${omitted > 0 ? ` of ${history.length}, ${omitted} older omitted` : ""}):`,
    "  #     time                 model                         cache",
    ...recent.map((entry, i) =>
      formatCacheStatsRow(entry, history.length - recent.length + i),
    ),
    ...(recent.some(entry => !entry.metrics.supported)
      ? [
          "",
          "  N/A rows: provider API does not expose cache usage.",
          "  The request still ran normally; only the metric is unavailable.",
        ]
      : []),
  ].join("\n");
}

export const cacheStatsCommand: SlashCommand = {
  name: "cache-stats",
  description: "Show session token cache counters",
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      void ctx;
      return { kind: "text", text: await formatCacheStats() };
    }),
};

export default cacheStatsCommand;
