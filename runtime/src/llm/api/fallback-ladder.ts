/**
 * Ports upstream `src/services/api/withRetry.ts` fallback signaling and
 * `src/services/api/providerConfig.ts` fallback-model selection onto
 * AgenC's provider-neutral model/provider fallback ladder.
 *
 * Why this lives here / shape difference from upstream:
 *   - Upstream gates fallback on a product-specific model family and emits
 *     reporting. AgenC keeps the ladder explicit and config-driven so any
 *     provider can declare ordered fallback targets.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Subscriber gates, internal-user reporting, and fast-mode cooldowns.
 */

import { FallbackTriggeredError } from "../../recovery/api-errors.js";

export interface ProviderFallbackTarget {
  readonly provider?: string;
  readonly model: string;
  readonly reason?: string;
}

export interface ProviderFallbackLadderOptions {
  readonly provider?: string;
  readonly model: string;
  readonly targets?: readonly ProviderFallbackTarget[];
  readonly maxFailures?: number;
  /**
   * Additional provider statuses that should count toward fallback. Built-in
   * overload signals (`529` and `overloaded_error`) always remain eligible.
   */
  readonly statuses?: readonly number[];
}

export type ProviderFallbackDecision =
  | {
      readonly kind: "trigger";
      readonly target: ProviderFallbackTarget;
      readonly error: FallbackTriggeredError;
      readonly consecutiveFailures: number;
    }
  | {
      readonly kind: "wait";
      readonly consecutiveFailures: number;
      readonly failuresRemaining: number;
    }
  | { readonly kind: "disabled" }
  | { readonly kind: "not_applicable"; readonly consecutiveFailures: 0 };

const DEFAULT_FALLBACK_MAX_FAILURES = 3;
const DEFAULT_FALLBACK_RETRY_BUDGET = 2;
const DEFAULT_FALLBACK_STATUSES = Object.freeze([529] as const);

function normalizeProviderKey(provider: string | undefined): string | undefined {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized === "xai" ? "grok" : normalized;
}

export function normalizeFallbackTargets(
  provider: string | undefined,
  model: string,
  targets: readonly ProviderFallbackTarget[] | undefined,
): readonly ProviderFallbackTarget[] {
  const normalized: ProviderFallbackTarget[] = [];
  const seen = new Set<string>();
  const sourceProvider = normalizeProviderKey(provider);
  const sourceModel = model.trim();
  for (const target of targets ?? []) {
    const targetModel = target.model.trim();
    if (!targetModel) continue;
    const targetProvider =
      normalizeProviderKey(target.provider) ?? sourceProvider;
    if (targetModel === sourceModel && targetProvider === sourceProvider) {
      continue;
    }
    const key = `${targetProvider ?? ""}\0${targetModel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      ...(targetProvider ? { provider: targetProvider } : {}),
      model: targetModel,
      ...(target.reason?.trim() ? { reason: target.reason.trim() } : {}),
    });
  }
  return normalized;
}

export function normalizeFallbackRetryBudget(
  maxRetries: number | undefined,
): number {
  if (typeof maxRetries !== "number" || !Number.isFinite(maxRetries)) {
    return DEFAULT_FALLBACK_RETRY_BUDGET;
  }
  return Math.max(0, Math.floor(maxRetries));
}

function selectNextFallbackTarget(
  options: ProviderFallbackLadderOptions,
): ProviderFallbackTarget | null {
  return (
    normalizeFallbackTargets(
      options.provider,
      options.model,
      options.targets,
    )[0] ?? null
  );
}

function isProviderFallbackError(
  error: unknown,
  statuses: readonly number[] = DEFAULT_FALLBACK_STATUSES,
): boolean {
  if (is529Error(error)) return true;
  const status = readStatus(error);
  return status !== undefined && statuses.includes(status);
}

function is529Error(error: unknown): boolean {
  const candidate = error as {
    body?: unknown;
    error?: unknown;
    message?: unknown;
    status?: unknown;
  };
  return (
    candidate?.status === 529 ||
    hasOverloadedErrorMarker(candidate?.message) ||
    hasOverloadedErrorMarker(candidate?.body) ||
    hasOverloadedErrorMarker(candidate?.error)
  );
}

function hasOverloadedErrorMarker(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || value === undefined) return false;
  if (typeof value === "string") return value.includes("overloaded_error");
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((entry) => hasOverloadedErrorMarker(entry, depth + 1));
  }
  return Object.values(value as Record<string, unknown>).some((entry) =>
    hasOverloadedErrorMarker(entry, depth + 1),
  );
}

export function evaluateProviderFallback(
  options: ProviderFallbackLadderOptions & {
    readonly error: unknown;
    readonly consecutiveFailures: number;
  },
): ProviderFallbackDecision {
  const maxFailures = normalizePositiveInteger(options.maxFailures) ??
    DEFAULT_FALLBACK_MAX_FAILURES;
  const target = selectNextFallbackTarget(options);
  if (!target) return { kind: "disabled" };
  if (!isProviderFallbackError(options.error, options.statuses)) {
    return { kind: "not_applicable", consecutiveFailures: 0 };
  }

  const consecutiveFailures = options.consecutiveFailures + 1;
  if (consecutiveFailures < maxFailures) {
    return {
      kind: "wait",
      consecutiveFailures,
      failuresRemaining: maxFailures - consecutiveFailures,
    };
  }

  const toProvider = target.provider ?? options.provider;
  return {
    kind: "trigger",
    target,
    consecutiveFailures,
    error: new FallbackTriggeredError(options.model, target.model, {
      ...(options.provider ? { fromProvider: options.provider } : {}),
      ...(toProvider ? { toProvider } : {}),
      reason: target.reason ?? "provider_fallback_ladder",
    }),
  };
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function readStatus(error: unknown): number | undefined {
  const raw =
    error && typeof error === "object"
      ? (error as { status?: unknown; statusCode?: unknown }).status ??
        (error as { statusCode?: unknown }).statusCode
      : undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
