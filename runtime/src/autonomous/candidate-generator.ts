/**
 * Multi-candidate generation — collapsed stub (Cut 3.1).
 *
 * Replaces the previous 222-LOC bounded multi-candidate executor.
 * The verifier lane that consumed candidate generation has been
 * deleted; agent.ts now only calls executeCandidate once.
 *
 * @module
 */

import type { MultiCandidateConfig, Task } from "./types.js";

export interface GeneratedExecutionCandidate {
  id: string;
  attempt: number;
  output: bigint[];
  fingerprint: string;
  noveltyScore: number;
  tokenEstimate: number;
  cumulativeCostLamports: bigint;
}

export interface CandidateGenerationAttemptContext {
  attempt: number;
  accepted: number;
  projectedCostLamports: bigint;
  projectedTokenUnits: number;
}

export interface CandidateGenerationResult {
  candidates: GeneratedExecutionCandidate[];
  budget: {
    maxCandidates: number;
    maxExecutionCostLamports: bigint;
    maxTokenBudget: number;
    attempts: number;
    accepted: number;
    consumedCostLamports: bigint;
    consumedTokenUnits: number;
    stoppedReason:
      | "target_reached"
      | "attempt_budget_reached"
      | "cost_budget_reached"
      | "token_budget_reached";
  };
}

export interface CandidateGenerationInput {
  task: Task;
  config?: MultiCandidateConfig;
  executeCandidate: (task: Task) => Promise<bigint[]>;
  estimateTokenUnits?: (output: bigint[]) => number;
  onBeforeAttempt?: (
    context: CandidateGenerationAttemptContext,
  ) => Promise<void> | void;
}

export async function generateExecutionCandidates(
  input: CandidateGenerationInput,
): Promise<CandidateGenerationResult> {
  const output = await input.executeCandidate(input.task);
  const candidate: GeneratedExecutionCandidate = {
    id: "candidate-0",
    attempt: 1,
    output,
    fingerprint: "stub",
    noveltyScore: 1,
    tokenEstimate: input.estimateTokenUnits?.(output) ?? 0,
    cumulativeCostLamports: 0n,
  };
  return {
    candidates: [candidate],
    budget: {
      maxCandidates: 1,
      maxExecutionCostLamports: 0n,
      maxTokenBudget: 0,
      attempts: 1,
      accepted: 1,
      consumedCostLamports: 0n,
      consumedTokenUnits: candidate.tokenEstimate,
      stoppedReason: "target_reached",
    },
  };
}
