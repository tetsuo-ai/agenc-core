/**
 * Dependency graph — collapsed stub (Cut 3.2).
 *
 * Replaces the previous 821-LOC DAG implementation that backed the
 * deleted speculative executor. The autonomous Solana task lane no
 * longer tracks dependency chains; the class is preserved as an
 * empty graph implementation so `SpeculativeExecutor.getDependencyGraph()`
 * still has something to return.
 *
 * @module
 */

import { PublicKey } from "@solana/web3.js";
import type { OnChainTask } from "./types.js";

export enum DependencyType {
  Data = 0,
  Order = 1,
  Resource = 2,
}

export type TaskNodeStatus = "pending" | "executing" | "completed" | "failed";

export interface TaskNode {
  readonly taskPda: PublicKey;
  readonly taskId: Uint8Array;
  readonly dependsOn: PublicKey | null;
  readonly dependencyType: DependencyType;
  depth: number;
  status: TaskNodeStatus;
}

export interface DependencyEdge {
  readonly from: PublicKey;
  readonly to: PublicKey;
  readonly type: DependencyType;
}

export interface DependencyGraphStats {
  nodeCount: number;
  edgeCount: number;
  maxDepth: number;
  rootCount: number;
}

export interface GraphConsistencyResult {
  valid: boolean;
  cycles: PublicKey[][];
  danglingEdges: Array<{ from: string; to: string }>;
  depthMismatches: Array<{ taskPda: string; expected: number; actual: number }>;
}

export class DependencyGraph {
  addTask(_task: OnChainTask, _taskPda: PublicKey): void {}

  addTaskWithParent(
    _task: OnChainTask,
    _taskPda: PublicKey,
    _parentPda: PublicKey,
    _type?: DependencyType,
  ): void {}

  hasTask(_taskPda: PublicKey): boolean {
    return false;
  }

  getNode(_taskPda: PublicKey): TaskNode | undefined {
    return undefined;
  }

  getDepth(_taskPda: PublicKey): number {
    return 0;
  }

  getDescendants(_taskPda: PublicKey): TaskNode[] {
    return [];
  }

  getAncestors(_taskPda: PublicKey): TaskNode[] {
    return [];
  }

  updateStatus(_taskPda: PublicKey, _status: TaskNodeStatus): void {}

  getStats(): DependencyGraphStats {
    return { nodeCount: 0, edgeCount: 0, maxDepth: 0, rootCount: 0 };
  }

  validateConsistency(): GraphConsistencyResult {
    return {
      valid: true,
      cycles: [],
      danglingEdges: [],
      depthMismatches: [],
    };
  }

  clear(): void {}
}
