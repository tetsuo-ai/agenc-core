/**
 * Memory trust scoring — defense against memory poisoning (R29).
 *
 * Implements composite trust scoring across multiple orthogonal signals
 * and trust-aware retrieval with temporal decay, per:
 * - R29: Memory Poisoning Attack and Defense on Memory-Based LLM-Agents
 * - R30: MINJA — Memory Injection Attacks via Query-Only Interaction
 * - R39: InjecMEM — Memory Injection Attack on LLM Agent Memory
 *
 * Trust score = weighted combination of:
 * 1. Source provenance trust (system > tool > user > external)
 * 2. Temporal trust (newer entries from established sessions > new sessions)
 * 3. Consistency trust (entries consistent with existing knowledge > contradictions)
 * 4. Confidence score from the entry itself
 *
 * @module
 */

/** Trust level based on entry source provenance. */
export type TrustSource =
  | "system"     // System-generated (consolidation, compaction summaries)
  | "tool"       // Tool execution results (grounded in tool output)
  | "user"       // Direct user input (trusted but may contain errors)
  | "agent"      // Agent-generated (LLM output, may hallucinate)
  | "external"   // External sources (MCP, imports — lowest trust)
  | "unknown";   // No provenance information

const SOURCE_TRUST_WEIGHTS: Record<TrustSource, number> = {
  system: 1.0,
  tool: 0.9,
  user: 0.8,
  agent: 0.6,
  external: 0.4,
  unknown: 0.3,
};

/**
 * Compute composite trust score for a memory entry.
 * Returns a value in [0, 1] where 1 = fully trusted.
 *
 * Per R29: composite scoring across multiple orthogonal signals
 * prevents single-signal bypass attacks.
 */
export function computeTrustScore(params: {
  /** Source provenance of the entry. */
  readonly source: TrustSource;
  /** Entry's own confidence score [0, 1]. */
  readonly confidence: number;
  /** Age of the entry in ms. */
  readonly ageMs: number;
  /** Number of times this entry has been retrieved (activation). */
  readonly accessCount: number;
  /** Whether the entry has been confirmed by other sources. */
  readonly confirmed: boolean;
}): number {
  const { source, confidence, ageMs, accessCount, confirmed } = params;

  // 1. Source provenance trust (40% weight)
  const sourceTrust = SOURCE_TRUST_WEIGHTS[source] ?? SOURCE_TRUST_WEIGHTS.unknown;

  // 2. Confidence trust (20% weight)
  const confTrust = Math.max(0, Math.min(1, confidence));

  // 3. Temporal trust — newer entries from established patterns get higher trust
  //    Per R29: temporal decay prevents old poisoned entries from persisting
  const TEMPORAL_HALF_LIFE_MS = 30 * 86_400_000; // 30 days
  const temporalDecay = Math.exp((-Math.LN2 * ageMs) / TEMPORAL_HALF_LIFE_MS);
  const temporalTrust = 0.3 + 0.7 * temporalDecay; // Never drops below 0.3

  // 4. Activation trust — frequently accessed entries are more likely legitimate
  const activationTrust = Math.min(1, 0.5 + 0.1 * Math.log(accessCount + 1));

  // 5. Confirmation bonus — entries confirmed by multiple sources
  const confirmationBonus = confirmed ? 0.1 : 0;

  // Composite score (weighted combination)
  const composite =
    sourceTrust * 0.4 +
    confTrust * 0.2 +
    temporalTrust * 0.15 +
    activationTrust * 0.15 +
    confirmationBonus +
    0.1; // Base trust — every entry starts with some trust

  return Math.max(0, Math.min(1, composite));
}

/**
 * Determine trust source from entry metadata.
 */
export function inferTrustSource(
  metadata: Record<string, unknown> | undefined,
  role: string,
): TrustSource {
  if (!metadata) return role === "system" ? "system" : "unknown";

  const provenance = String(metadata.provenance ?? "");
  const type = String(metadata.type ?? "");

  if (
    type === "session_summary" ||
    type === "compaction_summary" ||
    type === "consolidated_fact" ||
    provenance.startsWith("consolidation:")
  ) {
    return "system";
  }

  if (
    provenance.startsWith("ingestion:turn") ||
    type === "conversation_turn" ||
    type === "conversation_turn_index"
  ) {
    return role === "user" ? "user" : "agent";
  }

  if (provenance.includes("tool") || type === "entity_fact") {
    return "tool";
  }

  if (provenance.includes("external") || provenance.includes("import")) {
    return "external";
  }

  return "unknown";
}

/** Default trust threshold for retrieval. Entries below this are excluded. */
export const DEFAULT_TRUST_THRESHOLD = 0.3;
