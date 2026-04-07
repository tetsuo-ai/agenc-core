/**
 * Proof pipeline — collapsed stub (Cut 3.2).
 *
 * Replaces the previous 831-LOC async proof generation queue + ancestor
 * confirmation gating + cascade abort coordination. The speculative
 * task lane that consumed this has been deleted; the file is preserved
 * only to keep the `ProofGenerator` and `ProofPipelineConfig` types
 * alive for `proof/engine.ts` and `autonomous/types.ts`.
 *
 * @module
 */

import type {
  OnChainTask,
  TaskExecutionResult,
  PrivateTaskExecutionResult,
} from "./types.js";

export type ProofJobStatus =
  | "queued"
  | "generating"
  | "awaiting_submission"
  | "submitted"
  | "confirmed"
  | "failed";

export interface ProofGenerationJob {
  readonly taskId: Uint8Array;
  status: ProofJobStatus;
  proof?: Uint8Array;
  transactionSignature?: string;
  error?: Error;
}

export interface ProofPipelineConfig {
  readonly maxConcurrentProofs?: number;
  readonly maxProofGenerationDurationMs?: number;
  readonly maxAwaitingSubmissionAgeMs?: number;
}

export interface ProofPipelineEvents {
  onProofConfirmed?: (taskId: Uint8Array) => void;
  onProofFailed?: (taskId: Uint8Array, error: Error) => void;
}

export interface ProofGenerator {
  generatePublicProof(
    task: OnChainTask,
    result: TaskExecutionResult,
  ): Promise<Uint8Array>;
  generatePrivateProof(
    task: OnChainTask,
    result: PrivateTaskExecutionResult,
  ): Promise<Uint8Array>;
}

export interface DependencyGraphLike {
  getUnconfirmedAncestors(taskId: Uint8Array): Array<{ taskId: Uint8Array }>;
  isConfirmed(taskId: Uint8Array): boolean;
}

export interface ProofPipelineStats {
  queued: number;
  generating: number;
  awaitingSubmission: number;
  confirmed: number;
  failed: number;
}

export class ProofPipeline {
  constructor(_config?: ProofPipelineConfig) {}

  on(_events: ProofPipelineEvents): void {}

  async shutdown(): Promise<void> {}

  enqueue(_task: OnChainTask, _result: unknown): void {}

  getJob(_taskId: Uint8Array): ProofGenerationJob | undefined {
    return undefined;
  }

  getStats(): ProofPipelineStats {
    return {
      queued: 0,
      generating: 0,
      awaitingSubmission: 0,
      confirmed: 0,
      failed: 0,
    };
  }
}

export class DefaultProofGenerator implements ProofGenerator {
  async generatePublicProof(
    _task: OnChainTask,
    _result: TaskExecutionResult,
  ): Promise<Uint8Array> {
    return new Uint8Array(0);
  }

  async generatePrivateProof(
    _task: OnChainTask,
    _result: PrivateTaskExecutionResult,
  ): Promise<Uint8Array> {
    return new Uint8Array(0);
  }
}
