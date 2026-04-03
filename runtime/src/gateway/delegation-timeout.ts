/**
 * Shared delegation timeout and budget-hint parsing helpers.
 *
 * Keeps planner-emitted sub-agent budgets and direct execute_with_agent calls
 * on the same timeout contract.
 *
 * @module
 */

// Floor: sub-agents always get at least 5 minutes.  The planner's LLM
// sometimes emits aggressive budgets (e.g. "30s") that starve coding tasks
// before the first tool call even completes.  Complex multi-file tasks
// regularly need 3-4 minutes per sub-agent.  0 = unlimited (no timer).
export const MIN_DELEGATION_TIMEOUT_MS = 300_000;
// Ceiling: 0 = unlimited.  The runtime should support indefinite sub-agent
// work for long-running coding tasks.
export const MAX_DELEGATION_TIMEOUT_MS = 0;

const EXPLICIT_BUDGET_HINT_RE =
  /^(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr)$/i;
const BARE_NUMERIC_BUDGET_HINT_RE = /^(\d+(?:\.\d+)?)$/;
const QUALITATIVE_BUDGET_HINT_RE =
  /^(minimal|small|medium|large|short|long)$/i;

export type DelegationBudgetHintInspection =
  | {
    readonly kind: "explicit";
    readonly durationMs: number;
    readonly rawValue: number;
    readonly unit: string;
  }
  | {
    readonly kind: "ambiguous_numeric";
    readonly durationMs: number;
    readonly rawValue: number;
  }
  | {
    readonly kind: "qualitative";
    readonly label: string;
  }
  | {
    readonly kind: "invalid";
  };

function convertBudgetHintToMs(value: number, unit: string): number {
  const normalizedUnit = unit.trim().toLowerCase();
  if (normalizedUnit === "ms") return value;
  if (normalizedUnit === "s" || normalizedUnit === "sec") {
    return value * 1_000;
  }
  if (normalizedUnit === "h" || normalizedUnit === "hr") {
    return value * 60 * 60 * 1_000;
  }
  return value * 60 * 1_000;
}

export function inspectDelegationBudgetHint(
  hint: string,
): DelegationBudgetHintInspection {
  const normalized = hint.trim().toLowerCase();
  if (normalized.length === 0) {
    return { kind: "invalid" };
  }

  const explicitMatch = normalized.match(EXPLICIT_BUDGET_HINT_RE);
  if (explicitMatch) {
    const rawValue = Number.parseFloat(explicitMatch[1] ?? "0");
    const unit = explicitMatch[2] ?? "m";
    if (!Number.isFinite(rawValue) || rawValue <= 0) {
      return { kind: "invalid" };
    }
    return {
      kind: "explicit",
      rawValue,
      unit,
      durationMs: convertBudgetHintToMs(rawValue, unit),
    };
  }

  const bareNumericMatch = normalized.match(BARE_NUMERIC_BUDGET_HINT_RE);
  if (bareNumericMatch) {
    const rawValue = Number.parseFloat(bareNumericMatch[1] ?? "0");
    if (!Number.isFinite(rawValue) || rawValue <= 0) {
      return { kind: "invalid" };
    }
    return {
      kind: "ambiguous_numeric",
      rawValue,
      durationMs: convertBudgetHintToMs(rawValue, "m"),
    };
  }

  if (QUALITATIVE_BUDGET_HINT_RE.test(normalized)) {
    return {
      kind: "qualitative",
      label: normalized,
    };
  }

  return { kind: "invalid" };
}

export function normalizeDelegationTimeoutMs(
  timeoutMs: number | undefined,
): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return undefined;
  }
  const normalized = Math.floor(timeoutMs);
  if (normalized <= 0) {
    return 0; // unlimited
  }
  if (MIN_DELEGATION_TIMEOUT_MS > 0 && normalized < MIN_DELEGATION_TIMEOUT_MS) {
    return MIN_DELEGATION_TIMEOUT_MS;
  }
  if (MAX_DELEGATION_TIMEOUT_MS > 0) {
    return Math.min(MAX_DELEGATION_TIMEOUT_MS, normalized);
  }
  return normalized;
}

export function resolveDelegationBudgetHintMs(
  hint: string,
  fallbackMs: number,
): number {
  const inspection = inspectDelegationBudgetHint(hint);
  if (
    inspection.kind === "qualitative" ||
    inspection.kind === "invalid"
  ) {
    return fallbackMs;
  }
  return normalizeDelegationTimeoutMs(inspection.durationMs) ?? fallbackMs;
}
