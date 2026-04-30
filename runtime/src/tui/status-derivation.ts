import type { SessionLike as StatusLineSessionLike } from "./cockpit/StatusLineConfig.js";

interface TokenUsageSnapshot {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningOutputTokens?: number;
}

interface SessionStateSnapshot {
  readonly initialTokenUsage?: TokenUsageSnapshot;
  readonly totalTokenUsage?: TokenUsageSnapshot;
  readonly previousTurnSettings?: {
    readonly contextWindow?: number;
    readonly modelInfo?: {
      readonly contextWindow?: number;
    };
  };
}

function readStateSnapshot(session: object): SessionStateSnapshot | null {
  const state = (
    session as {
      readonly state?: { unsafePeek?: () => unknown };
    }
  ).state;
  if (typeof state?.unsafePeek !== "function") {
    return null;
  }
  try {
    return (state.unsafePeek() as SessionStateSnapshot | null) ?? null;
  } catch {
    return null;
  }
}

function readTotalTokenUsage(
  snapshot: SessionStateSnapshot | null,
): TokenUsageSnapshot | undefined {
  return snapshot?.totalTokenUsage ?? snapshot?.initialTokenUsage;
}

function readContextWindow(
  session: object,
  snapshot: SessionStateSnapshot | null,
): number | undefined {
  const raw = session as {
    readonly modelInfo?: { readonly contextWindow?: unknown };
  };
  const fromSession = raw.modelInfo?.contextWindow;
  if (typeof fromSession === "number" && Number.isFinite(fromSession)) {
    return fromSession;
  }
  const fromState =
    snapshot?.previousTurnSettings?.contextWindow ??
    snapshot?.previousTurnSettings?.modelInfo?.contextWindow;
  return typeof fromState === "number" && Number.isFinite(fromState)
    ? fromState
    : undefined;
}

function readCostUsd(session: object): number | undefined {
  const services = (
    session as {
      readonly services?: {
        readonly costSidecar?: { readonly getTotalCostUsd?: () => number };
      };
    }
  ).services;
  const value = services?.costSidecar?.getTotalCostUsd?.();
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBudgetUsd(session: object): number | undefined {
  const services = (
    session as {
      readonly services?: {
        readonly configStore?: {
          readonly current?: () => { readonly max_budget_usd?: unknown };
        };
      };
    }
  ).services;
  const value = services?.configStore?.current?.().max_budget_usd;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function contextPercent(
  usedTokens: number | undefined,
  contextWindow: number | undefined,
): number | undefined {
  if (
    usedTokens === undefined ||
    contextWindow === undefined ||
    !Number.isFinite(usedTokens) ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return undefined;
  }
  return Math.max(0, Math.min(100, (usedTokens / contextWindow) * 100));
}

export function buildStatusLineSession(
  session: object,
  mode: string,
  model: string | undefined,
): StatusLineSessionLike {
  const snapshot = readStateSnapshot(session);
  const usage = readTotalTokenUsage(snapshot);
  const tokensUsed =
    typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens)
      ? usage.totalTokens
      : undefined;
  const outputTokens =
    (usage?.completionTokens ?? 0) + (usage?.reasoningOutputTokens ?? 0);
  const contextTokensUsed = tokensUsed;
  const costUsd = readCostUsd(session);
  const budgetUsd = readBudgetUsd(session);
  const percent = contextPercent(
    contextTokensUsed,
    readContextWindow(session, snapshot),
  );
  const raw = session as {
    readonly conversationId?: unknown;
    readonly model?: unknown;
  };
  return {
    model:
      model ??
      (typeof raw.model === "string" && raw.model.length > 0
        ? raw.model
        : undefined),
    mode,
    sessionId:
      typeof raw.conversationId === "string" &&
      raw.conversationId.length > 0
        ? raw.conversationId
        : undefined,
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(percent !== undefined ? { contextPercent: percent } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(budgetUsd !== undefined
      ? {
          budgetUsd,
          budgetRemainingUsd: Math.max(0, budgetUsd - (costUsd ?? 0)),
        }
      : {}),
  };
}
