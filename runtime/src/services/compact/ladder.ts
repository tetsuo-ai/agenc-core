/**
 * Degraded compaction ladder (#2497).
 *
 * When the standard auto-compaction declines to shrink the context, a turn
 * used to end with `compact_failed`. Interactive sessions recover when the
 * user sends another prompt; unattended runs (`agenc -p`, routines) have no
 * next prompt and lost hours of work. The ladder tries two progressively
 * more aggressive compactions before giving up:
 *
 *   1. `aggressive_summary`: the real summarizer again, keeping no verbatim
 *      tail (the image- and tool-heavy tail is what defeats the shrink
 *      floor) and a terse focus.
 *   2. `emergency_local`: the same durable transaction driven by a
 *      runtime-local, model-free summarizer. Every invariant (pin, intent,
 *      plan, byte limits, provenance, shrink floor, commit, authenticated
 *      boundary) is unchanged; only the summary text is produced locally.
 *
 * Model-free eviction of old context is standard practice for long-running
 * agents (MemGPT eviction, SWE-agent observation masking, condensers), so
 * both tiers run in every mode; `compaction.emergency_mode = "never"` is the
 * only switch.
 */

import type { CompactionCannotReduceError, CompactionFailureReason } from "./transaction-types.js";

export type CompactionLadderTier = "standard" | "aggressive_summary" | "emergency_local";

export const COMPACTION_LADDER_TIERS: readonly CompactionLadderTier[] = [
  "standard",
  "aggressive_summary",
  "emergency_local",
];

/**
 * Focus strings double as the tier's identity in the durable configuration
 * digest (`requested_focus`), so the transaction's failure guard counts each
 * tier separately without any digest change.
 */
export const AGGRESSIVE_COMPACTION_FOCUS =
  "agenc.compaction.ladder/aggressive_summary v1: keep only the original task, " +
  "decisions made, file paths touched, the current state of the work and the " +
  "immediate next step; be terse.";
export const EMERGENCY_COMPACTION_FOCUS =
  "agenc.compaction.ladder/emergency_local v1: runtime-local summary; no model call.";

export type CompactionEmergencyMode = "always" | "never";

export interface CompactionLadderConfig {
  readonly emergency_mode?: CompactionEmergencyMode;
}

export interface CompactionLadderPolicy {
  readonly emergencyEnabled: boolean;
}

export function resolveCompactionLadderPolicy(
  config: { readonly compaction?: CompactionLadderConfig } | undefined,
): CompactionLadderPolicy {
  return { emergencyEnabled: config?.compaction?.emergency_mode !== "never" };
}

/** The decline facts a compaction attempt reports back to the turn. */
export interface CompactionDecline {
  readonly wasCompacted: boolean;
  readonly consecutiveFailures?: number;
  readonly skippedReason?: string;
  readonly skippedCode?: CompactionCannotReduceError["code"];
  readonly skippedFailureReason?: CompactionFailureReason;
  readonly advisoryFailure?: "summary_rejected";
}

/** Compaction reasons the ladder may act on; manual and downshift compactions never escalate. */
export function ladderAppliesToReason(reason: string): boolean {
  return reason === "context_limit" || reason === "reactive_recovery";
}

/**
 * A ladder applies to a decline that an attempt actually made and lost:
 * a disabled feature, a below-threshold check or a missing rollout owner
 * (`pin_failed`) is not something a more aggressive plan can fix.
 */
export function ladderAppliesToDecline(decline: CompactionDecline): boolean {
  return (
    decline.wasCompacted !== true &&
    decline.skippedReason !== undefined &&
    decline.consecutiveFailures !== undefined &&
    decline.skippedFailureReason !== "pin_failed" &&
    decline.skippedFailureReason !== "aborted"
  );
}

/** Failures after which asking the same provider again is not worth a second wall budget. */
const PROVIDER_SIDE_FAILURES: ReadonlySet<CompactionFailureReason> = new Set([
  "wall_time_exceeded",
  "provider_timeout",
  "provider_unavailable",
  "provider_error",
  "provider_rate_limited",
]);

function tierAllowed(tier: CompactionLadderTier, policy: CompactionLadderPolicy): boolean {
  return tier !== "emergency_local" || policy.emergencyEnabled;
}

/** Tiers still worth trying after `decline`, strongest last, excluding any already attempted this episode. */
export function nextLadderTiers(
  policy: CompactionLadderPolicy,
  decline: CompactionDecline,
  attempted: readonly CompactionLadderTier[],
): CompactionLadderTier[] {
  const tiers: CompactionLadderTier[] = [];
  const skipSummarizer =
    decline.skippedFailureReason !== undefined &&
    PROVIDER_SIDE_FAILURES.has(decline.skippedFailureReason);
  if (!skipSummarizer && !attempted.includes("aggressive_summary") && tierAllowed("aggressive_summary", policy)) {
    tiers.push("aggressive_summary");
  }
  if (!attempted.includes("emergency_local") && tierAllowed("emergency_local", policy)) {
    tiers.push("emergency_local");
  }
  return tiers;
}

/** The next stronger tier after a committed `tier`, or undefined at the top of the ladder. */
export function strongerTierThan(
  tier: CompactionLadderTier,
  policy: CompactionLadderPolicy,
  attempted: readonly CompactionLadderTier[],
): CompactionLadderTier | undefined {
  const index = COMPACTION_LADDER_TIERS.indexOf(tier);
  for (const candidate of COMPACTION_LADDER_TIERS.slice(index + 1)) {
    if (!attempted.includes(candidate) && tierAllowed(candidate, policy)) return candidate;
  }
  return undefined;
}

export function describeCompactionDecline(decline: CompactionDecline): string {
  return (
    decline.skippedFailureReason ??
    decline.skippedCode ??
    decline.advisoryFailure ??
    (decline.skippedReason !== undefined ? decline.skippedReason.slice(0, 120) : "declined")
  );
}

/** Terminal text for a turn whose compaction ladder ran out of tiers. */
export function compactionExhaustedReasonText(params: {
  readonly tiersAttempted: readonly CompactionLadderTier[];
  readonly lastSamplePromptTokens: number;
  readonly limit: number;
  readonly interactive: boolean;
}): string {
  const measure = `lastSamplePromptTokens=${params.lastSamplePromptTokens} limit=${params.limit}`;
  const base =
    params.tiersAttempted.length > 0
      ? `compact_ladder_exhausted: tiers=[${params.tiersAttempted.join(",")}]; ${measure}`
      : `mid_turn_compact_skipped: ${measure}`;
  return params.interactive ? `${base}; run /compact to retry manually` : base;
}
