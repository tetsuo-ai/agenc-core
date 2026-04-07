/**
 * Verifier lane (Executor + Critic) — collapsed stub (Cut 3.1).
 *
 * Replaces the previous 969-LOC bounded revision loop / adaptive
 * budget allocator / disagreement-rate counter pipeline. The
 * pre-Grok Solana task lane that consumed this verifier has been
 * deprecated; the runtime no longer runs Critic-style verification
 * inside `AutonomousAgent`.
 *
 * The exported class shape is preserved so `AutonomousAgent` (the
 * public SDK class still consumed by `builder.ts`) keeps the same
 * runtime API. `shouldVerify()` always returns false, which short-
 * circuits the entire verifier path inside agent.ts.
 *
 * @module
 */

import type { MetricsProvider } from "../task/types.js";
import type {
  RevisionInput,
  Task,
  VerifierExecutionResult,
  VerifierLaneConfig,
  VerifierVerdictPayload,
  VerifierEscalationMetadata,
} from "./types.js";

export const VERIFIER_METRIC_NAMES = {
  CHECKS_TOTAL: "agenc.verifier.checks.total",
  PASSES_TOTAL: "agenc.verifier.passes.total",
  FAILS_TOTAL: "agenc.verifier.fails.total",
  NEEDS_REVISION_TOTAL: "agenc.verifier.needs_revision.total",
  DISAGREEMENTS_TOTAL: "agenc.verifier.disagreements.total",
  REVISIONS_TOTAL: "agenc.verifier.revisions.total",
  ESCALATIONS_TOTAL: "agenc.verifier.escalations.total",
  ADDED_LATENCY_MS: "agenc.verifier.added_latency_ms",
  ADDED_LATENCY_BY_RISK_TIER_MS: "agenc.verifier.added_latency_by_risk_tier_ms",
  QUALITY_LIFT_BY_RISK_TIER: "agenc.verifier.quality_lift_by_risk_tier",
  ADAPTIVE_RISK_SCORE: "agenc.verifier.adaptive.risk_score",
  ADAPTIVE_RISK_TIER_TOTAL: "agenc.verifier.adaptive.risk_tier.total",
  ADAPTIVE_MAX_RETRIES: "agenc.verifier.adaptive.max_retries",
  ADAPTIVE_MAX_DURATION_MS: "agenc.verifier.adaptive.max_duration_ms",
  ADAPTIVE_MAX_COST_LAMPORTS: "agenc.verifier.adaptive.max_cost_lamports",
  ADAPTIVE_DISABLED_TOTAL: "agenc.verifier.adaptive.disabled.total",
} as const;

export interface VerifierLaneMetrics {
  checks: number;
  passes: number;
  fails: number;
  needsRevision: number;
  disagreements: number;
  revisions: number;
  escalations: number;
  rollbacks: number;
  addedLatencyMs: number;
}

export interface VerifierExecutorConfig {
  verifierConfig: VerifierLaneConfig;
  executeTask: (task: Task) => Promise<bigint[]>;
  reviseTask?: (input: RevisionInput) => Promise<bigint[]>;
  metrics?: MetricsProvider;
  onVerdict?: (
    task: Task,
    verdict: VerifierVerdictPayload,
    attempt: number,
  ) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class VerifierLaneEscalationError extends Error {
  readonly task: Task;
  readonly metadata: VerifierEscalationMetadata;
  readonly history: VerifierVerdictPayload[];

  constructor(
    task: Task,
    metadata: VerifierEscalationMetadata,
    history: VerifierVerdictPayload[] = [],
  ) {
    super(`Verifier lane escalated: ${metadata.reason}`);
    this.name = "VerifierLaneEscalationError";
    this.task = task;
    this.metadata = metadata;
    this.history = history;
  }
}

export class VerifierExecutor {
  private readonly executeTask: (task: Task) => Promise<bigint[]>;
  private readonly metrics: VerifierLaneMetrics = {
    checks: 0,
    passes: 0,
    fails: 0,
    needsRevision: 0,
    disagreements: 0,
    revisions: 0,
    escalations: 0,
    rollbacks: 0,
    addedLatencyMs: 0,
  };

  constructor(config: VerifierExecutorConfig) {
    this.executeTask = config.executeTask;
  }

  shouldVerify(_task: Task): boolean {
    return false;
  }

  private buildPassthroughResult(output: bigint[]): VerifierExecutionResult {
    return {
      output,
      attempts: 1,
      revisions: 0,
      durationMs: 0,
      passed: true,
      escalated: false,
      history: [],
      lastVerdict: null,
    };
  }

  async execute(task: Task): Promise<VerifierExecutionResult> {
    const output = await this.executeTask(task);
    return this.buildPassthroughResult(output);
  }

  async executeWithOutput(
    _task: Task,
    output: bigint[],
  ): Promise<VerifierExecutionResult> {
    return this.buildPassthroughResult(output);
  }

  getMetrics(): VerifierLaneMetrics {
    return { ...this.metrics };
  }
}
