/**
 * State-map accessors extracted from `ChatExecutor` (Phase F
 * PR-1 of the plan in TODO.MD).
 *
 * These functions operate on the three mutable per-instance Maps
 * that `ChatExecutor` owns:
 *   - `cooldowns: Map<string, CooldownEntry>` — provider cooldown
 *     state for the fallback chain
 *   - `sessionTokens: Map<string, number>` — per-session token
 *     budget tracking (LRU ordered)
 *   - (tool result budget state lives in a third Map that is not
 *     touched by this module)
 *
 * They are exposed as free functions that take the Map (plus any
 * companion config like budget thresholds) as explicit arguments
 * (the state-as-argument pattern). The class keeps the Maps as
 * private fields and calls these helpers via 1-line delegators until
 * PR-8 eliminates the delegators.
 *
 * @module
 */

import {
  hasRuntimeLimit,
  isRuntimeLimitReached,
} from "./runtime-limit-policy.js";
import type { CooldownEntry } from "./chat-executor-types.js";

/**
 * Compute the list of provider names that are currently in
 * cooldown (i.e. `availableAt > now`). Matches the shape
 * `chat-executor-fallback.callWithFallback` expects for the
 * `degradedProviderNames` diagnostic field.
 *
 * Phase F extraction (PR-1). Previously
 * `ChatExecutor.buildDegradedProviderNames`.
 */
export function buildDegradedProviderNames(
  cooldowns: ReadonlyMap<string, CooldownEntry>,
  nowMs: number = Date.now(),
): readonly string[] {
  const names: string[] = [];
  for (const [providerName, cooldown] of cooldowns.entries()) {
    if (cooldown.availableAt > nowMs) {
      names.push(providerName);
    }
  }
  return names;
}

/**
 * Return the session's compaction signals: how many tokens have
 * been recorded, whether the hard session budget has been reached,
 * and whether the soft compaction threshold has been reached.
 *
 * Both thresholds accept `undefined` to indicate "unlimited". When
 * both are unlimited, the return is always
 * `{ used, hardBudgetReached: false, softThresholdReached: false }`.
 *
 * Phase F extraction (PR-1). Previously
 * `ChatExecutor.getSessionCompactionState`.
 */
export function getSessionCompactionState(
  sessionTokens: ReadonlyMap<string, number>,
  sessionId: string,
  sessionTokenBudget: number | undefined,
  sessionCompactionThreshold: number | undefined,
): {
  readonly used: number;
  readonly hardBudgetReached: boolean;
  readonly softThresholdReached: boolean;
} {
  const used = sessionTokens.get(sessionId) ?? 0;
  return {
    used,
    hardBudgetReached: isRuntimeLimitReached(used, sessionTokenBudget),
    softThresholdReached:
      hasRuntimeLimit(sessionCompactionThreshold) &&
      isRuntimeLimitReached(used, sessionCompactionThreshold),
  };
}

/**
 * Record new token usage against a session, maintaining the
 * Map's LRU ordering (delete-then-reinsert) and evicting the
 * oldest entry when the tracked-session cap is exceeded. Eviction
 * also clears the companion circuit-breaker state for the evicted
 * session so zombie breaker entries do not accumulate.
 *
 * Phase F extraction (PR-1). Previously
 * `ChatExecutor.trackTokenUsage`.
 */
export function trackTokenUsage(
  sessionTokens: Map<string, number>,
  sessionId: string,
  tokens: number,
  maxTrackedSessions: number,
): void {
  const current = sessionTokens.get(sessionId) ?? 0;

  // Delete-then-reinsert to maintain LRU order (most recent at end)
  sessionTokens.delete(sessionId);
  sessionTokens.set(sessionId, current + tokens);

  // Evict least-recently-used entries if over capacity
  if (sessionTokens.size > maxTrackedSessions) {
    const oldest = sessionTokens.keys().next().value;
    if (oldest !== undefined) {
      sessionTokens.delete(oldest);
    }
  }
}
