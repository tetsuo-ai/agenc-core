/**
 * Candidate arbitration — collapsed stub (Cut 3.1).
 *
 * Replaces the previous 225-LOC weighted-score arbitration over
 * generated candidates. The verifier lane that consumed this
 * arbitration has been deleted; agent.ts now sees a single candidate
 * being passed through unchanged.
 *
 * @module
 */

import type { MultiCandidateConfig } from "./types.js";
import type { GeneratedExecutionCandidate } from "./candidate-generator.js";
import type {
  CandidateDisagreementReasonCode,
  InconsistencyDetectionResult,
} from "./inconsistency-detector.js";

export interface CandidateArbitrationScore {
  candidateId: string;
  score: number;
  consistency: number;
  diversity: number;
  confidence: number;
  recency: number;
  disagreements: number;
}

export type CandidateArbitrationDecision =
  | {
      outcome: "selected";
      selected: GeneratedExecutionCandidate;
      ranked: CandidateArbitrationScore[];
      metadata: {
        disagreementRate: number;
        totalDisagreements: number;
        reasonCodes: CandidateDisagreementReasonCode[];
        provenanceLinkIds: string[];
      };
    }
  | {
      outcome: "escalate";
      reason: "no_candidates" | "disagreement_threshold";
      ranked: CandidateArbitrationScore[];
      metadata: {
        disagreementRate: number;
        totalDisagreements: number;
        reasonCodes: CandidateDisagreementReasonCode[];
        provenanceLinkIds: string[];
      };
    };

export interface CandidateArbitrationInput {
  candidates: GeneratedExecutionCandidate[];
  inconsistencies: InconsistencyDetectionResult;
  config?: MultiCandidateConfig;
  confidenceByCandidateId?: Record<string, number>;
}

export function arbitrateCandidates(
  input: CandidateArbitrationInput,
): CandidateArbitrationDecision {
  const ranked: CandidateArbitrationScore[] = input.candidates.map(
    (candidate) => ({
      candidateId: candidate.id,
      score: 1,
      consistency: 1,
      diversity: 0,
      confidence: 1,
      recency: 0,
      disagreements: 0,
    }),
  );
  const metadata = {
    disagreementRate: 0,
    totalDisagreements: 0,
    reasonCodes: [] as CandidateDisagreementReasonCode[],
    provenanceLinkIds: [] as string[],
  };
  if (input.candidates.length === 0) {
    return { outcome: "escalate", reason: "no_candidates", ranked, metadata };
  }
  return {
    outcome: "selected",
    selected: input.candidates[0]!,
    ranked,
    metadata,
  };
}
