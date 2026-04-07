/**
 * Candidate inconsistency detector — collapsed stub (Cut 3.1).
 *
 * Replaces the previous 236-LOC pairwise candidate disagreement
 * detector with provenance link tracking. The verifier lane has been
 * deleted; agent.ts now sees an empty disagreement set.
 *
 * @module
 */

import type { MemoryGraph } from "../memory/graph.js";
import type { Task } from "./types.js";
import type { GeneratedExecutionCandidate } from "./candidate-generator.js";

export type CandidateDisagreementReasonCode =
  | "length_mismatch"
  | "value_mismatch"
  | "semantic_distance";

export interface CandidateDisagreementReason {
  code: CandidateDisagreementReasonCode;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface CandidateDisagreement {
  leftCandidateId: string;
  rightCandidateId: string;
  semanticDistance: number;
  reasons: CandidateDisagreementReason[];
  provenanceLinkIds: string[];
}

export interface CandidateProvenanceLink {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  fromCandidateId: string;
  toCandidateId: string;
  reasonCodes: CandidateDisagreementReasonCode[];
}

export interface InconsistencyDetectionResult {
  totalPairs: number;
  totalDisagreements: number;
  disagreementRate: number;
  disagreements: CandidateDisagreement[];
  provenanceLinks: CandidateProvenanceLink[];
}

export interface InconsistencyDetectorInput {
  task: Task;
  candidates: GeneratedExecutionCandidate[];
  semanticDistanceThreshold?: number;
  memoryGraph?: MemoryGraph;
  sessionId?: string;
}

export async function detectCandidateInconsistencies(
  _input: InconsistencyDetectorInput,
): Promise<InconsistencyDetectionResult> {
  return {
    totalPairs: 0,
    totalDisagreements: 0,
    disagreementRate: 0,
    disagreements: [],
    provenanceLinks: [],
  };
}
