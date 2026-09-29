import type { ModelCostEntry } from "../session/cost.js";
import type { ChildTerminalReason } from "./child-terminal.js";

export const CHILD_TASK_KINDS = ["extraction", "review", "coding", "reasoning", "research", "general"] as const;
export type ChildTaskKind = (typeof CHILD_TASK_KINDS)[number];
export const CHILD_TASK_COMPLEXITIES = ["simple", "standard", "hard"] as const;
export type ChildTaskComplexity = (typeof CHILD_TASK_COMPLEXITIES)[number];

export interface ChildSelectionTask {
  readonly kind: ChildTaskKind;
  readonly complexity: ChildTaskComplexity;
  readonly requiresTools: boolean;
  readonly requiresVision?: boolean;
  readonly requiresReasoning?: boolean;
  /** Include task, system prompt, tool definitions and expected tool results. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly expectedModelCalls?: number;
  readonly maxCostUsd?: number;
  readonly latencyPreference?: "balanced" | "fast";
}

/** Sanitized local evidence only. Credential material is never accepted. */
export interface ChildProviderCandidate {
  readonly provider: string;
  readonly model: string;
  readonly connected: boolean;
  readonly allowed: boolean;
  readonly supportsToolUse: boolean;
  readonly supportsVision: boolean;
  readonly supportsReasoning: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly cost?: Readonly<ModelCostEntry>;
  readonly serviceTier?: string;
}

export interface ChildRoutingAggregate {
  readonly provider: string;
  readonly model: string;
  readonly taskKind: ChildTaskKind;
  readonly complexity: ChildTaskComplexity;
  readonly profileRevision: string;
  readonly attempts: number;
  readonly successes: number;
  readonly infrastructureFailures: number;
  readonly qualityObservations: number;
  readonly qualitySuccesses: number;
  readonly latencySamples: number;
  readonly latencyTotalMs: number;
  readonly costSamples: number;
  readonly costTotalUsd: number;
  readonly lastObservedAtMs: number;
}

export interface ChildProviderHealth {
  readonly provider: string;
  readonly cooldownUntilMs: number;
  readonly consecutiveFailures: number;
  readonly lastObservedAtMs?: number;
  readonly blockedReason?: "insufficient_funds" | "auth_required";
}

export interface ChildRoutingSnapshot {
  readonly aggregates: readonly ChildRoutingAggregate[];
  readonly health: readonly ChildProviderHealth[];
}

/** Execution completion and independently verified quality are separate signals. */
export interface ChildRoutingOutcome {
  readonly receiptId: string;
  readonly provider: string;
  readonly model: string;
  readonly taskKind: ChildTaskKind;
  readonly complexity: ChildTaskComplexity;
  readonly terminalReason: ChildTerminalReason;
  /** Clean execution completion only. It does not prove the task was correct. */
  readonly success: boolean;
  /** Set only from an independent task verifier, never just a completed turn. */
  readonly verifiedSuccess?: boolean;
  readonly latencyMs: number;
  /** Reconciled dollars only. Omit when usage remains unknown. */
  readonly costUsd?: number;
  readonly atMs: number;
  readonly retryAfterMs?: number;
}

export interface RankedChildCandidate {
  readonly provider: string;
  readonly model: string;
  readonly estimatedCostUsd?: number;
  readonly estimatedLatencyMs: number;
  /** A routing prior/posterior, not a measured benchmark score. */
  readonly quality: number;
  readonly score: number;
  readonly reason: string;
}

export interface ChildSelectionResult {
  readonly selected?: RankedChildCandidate;
  readonly ranked: readonly RankedChildCandidate[];
  readonly rejected: readonly { readonly provider: string; readonly model: string; readonly reason: string }[];
  readonly reason: string;
}
