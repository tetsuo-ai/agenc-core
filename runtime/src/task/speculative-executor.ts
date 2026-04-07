/**
 * Speculative executor — collapsed stub (Cut 3.2).
 *
 * Replaces the previous 897-LOC multi-level speculative execution +
 * proof pipelining + cascade abort machinery. The autonomous Solana
 * task lane that consumed this has been deprecated; agent.ts now
 * sees a no-op implementation that exposes the same construction +
 * lifecycle API for `builder.ts` SDK compatibility.
 *
 * @module
 */

import type { PublicKey } from "@solana/web3.js";
import type { Logger } from "../utils/logger.js";
import type { TaskOperations } from "./operations.js";
import type {
  TaskExecutionResult,
  PrivateTaskExecutionResult,
  TaskHandler,
  TaskExecutorEvents,
  MetricsProvider,
} from "./types.js";
import {
  DependencyGraph,
} from "./dependency-graph.js";

export type SpeculativeTaskStatus =
  | "pending"
  | "executing"
  | "executed"
  | "proof_queued"
  | "confirmed"
  | "aborted"
  | "failed";

export interface SpeculativeTask {
  readonly taskPda: PublicKey;
  readonly taskId: Uint8Array;
  readonly parentPda: PublicKey;
  status: SpeculativeTaskStatus;
  executionResult?: TaskExecutionResult | PrivateTaskExecutionResult;
  readonly startedAt: number;
  completedAt?: number;
  abortReason?: string;
}

export interface SpeculativeExecutorConfig {
  operations: TaskOperations;
  handler: TaskHandler;
  agentId: Uint8Array;
  agentPda: PublicKey;
  logger?: Logger;
  enableSpeculation?: boolean;
  maxSpeculativeTasksPerParent?: number;
  maxSpeculationDepth?: number;
  speculatableDependencyTypes?: readonly unknown[];
  abortOnParentFailure?: boolean;
  proofPipelineConfig?: unknown;
  metrics?: MetricsProvider;
}

export interface SpeculativeExecutorEvents extends TaskExecutorEvents {
  onSpeculativeExecutionStarted?: (
    taskPda: PublicKey,
    parentPda: PublicKey,
  ) => void;
  onSpeculativeExecutionConfirmed?: (taskPda: PublicKey) => void;
  onSpeculativeExecutionAborted?: (
    taskPda: PublicKey,
    reason: string,
  ) => void;
  onParentProofConfirmed?: (parentPda: PublicKey) => void;
  onParentProofFailed?: (parentPda: PublicKey, error: Error) => void;
}

export interface SpeculativeMetrics {
  speculativeExecutionsStarted: number;
  speculativeExecutionsConfirmed: number;
  speculativeExecutionsAborted: number;
  estimatedTimeSavedMs: number;
}

export interface SpeculativeExecutorStatus {
  enabled: boolean;
  inFlight: number;
  metrics: SpeculativeMetrics;
}

export class SpeculativeExecutor {
  private readonly graph = new DependencyGraph();
  private readonly handler: TaskHandler;
  private readonly metrics: SpeculativeMetrics = {
    speculativeExecutionsStarted: 0,
    speculativeExecutionsConfirmed: 0,
    speculativeExecutionsAborted: 0,
    estimatedTimeSavedMs: 0,
  };

  constructor(config: SpeculativeExecutorConfig) {
    this.handler = config.handler;
  }

  on(_events: SpeculativeExecutorEvents): void {
    // no-op
  }

  async shutdown(): Promise<void> {
    // no-op
  }

  addTaskToGraph(_task: unknown, _taskPda: unknown): void {
    // no-op
  }

  async executeWithSpeculation(
    context: any,
  ): Promise<TaskExecutionResult | PrivateTaskExecutionResult> {
    return this.handler(context);
  }

  getProofPipeline(): undefined {
    return undefined;
  }

  getMetrics(): SpeculativeMetrics {
    return { ...this.metrics };
  }

  getDependencyGraph(): DependencyGraph {
    return this.graph;
  }
}
