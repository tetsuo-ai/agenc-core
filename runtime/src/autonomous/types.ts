/**
 * Types for the Autonomous Agent system
 *
 * @module
 */

import { PublicKey } from "@solana/web3.js";

/**
 * On-chain task data
 */
export interface Task {
  /** Task PDA */
  pda: PublicKey;
  /** Task ID (32 bytes) */
  taskId: Uint8Array;
  /** Creator's public key */
  creator: PublicKey;
  /** Required capabilities bitmask */
  requiredCapabilities: bigint;
  /** Reward amount in lamports */
  reward: bigint;
  /** Task description (64 bytes) */
  description: Uint8Array;
  /** Constraint hash for private tasks (32 bytes, all zeros for public) */
  constraintHash: Uint8Array;
  /** Deadline timestamp (0 = no deadline) */
  deadline: number;
  /** Maximum workers allowed */
  maxWorkers: number;
  /** Current number of claims */
  currentClaims: number;
  /** Task status */
  status: TaskStatus;
  /** SPL token mint for reward denomination (null = SOL) */
  rewardMint: PublicKey | null;
  /**
   * Optional on-chain task type.
   * Present when the scanner/account parser includes this field.
   */
  taskType?: number;
}

export enum TaskStatus {
  Open = 0,
  InProgress = 1,
  Completed = 2,
  Cancelled = 3,
  Disputed = 4,
}

/**
 * Filter for which tasks an agent should consider
 */
export interface TaskFilter {
  /** Only consider tasks matching these capabilities */
  capabilities?: bigint;
  /** Minimum reward in lamports */
  minReward?: bigint;
  /** Maximum reward in lamports (avoid honeypots) */
  maxReward?: bigint;
  /** Only accept tasks from these creators */
  trustedCreators?: PublicKey[];
  /** Reject tasks from these creators */
  blockedCreators?: PublicKey[];
  /** Only private tasks (non-zero constraint hash) */
  privateOnly?: boolean;
  /** Only public tasks (zero constraint hash) */
  publicOnly?: boolean;
  /**
   * Reward mint filter.
   * - `null` = SOL-only tasks
   * - `PublicKey` = one SPL mint
   * - `PublicKey[]` = any of the listed SPL mints
   */
  rewardMint?: PublicKey | PublicKey[] | null;
  /**
   * Accepted reward mints. null means SOL, PublicKey means that mint.
   * Undefined (or omitted) means accept all mints.
   * @deprecated Since v0.1.0. Use {@link TaskFilter.rewardMint} instead.
   * Will be removed in v0.2.0.
   */
  acceptedMints?: (PublicKey | null)[];
  /** Custom filter function */
  custom?: (task: Task) => boolean;
}

/**
 * Strategy for deciding which tasks to claim
 */
export interface ClaimStrategy {
  /**
   * Decide whether to claim a task
   * @param task - The task to consider
   * @param pendingTasks - Number of tasks currently being worked on
   * @returns true to claim, false to skip
   */
  shouldClaim(task: Task, pendingTasks: number): boolean;

  /**
   * Priority for claiming (higher = claim first)
   * Used when multiple tasks are available
   */
  priority(task: Task): number;
}

/**
 * Interface for task executors
 */
export interface TaskExecutor {
  /**
   * Execute a task and return the output
   *
   * The output is an array of 4 field elements (bigint) that will be
   * used to generate the ZK proof. For public tasks, this is hashed
   * on-chain. For private tasks, only the commitment is revealed.
   *
   * @param task - The task to execute
   * @returns Array of 4 bigints representing the output
   */
  execute(task: Task): Promise<bigint[]>;

  /**
   * Optional: Validate that this executor can handle a task
   */
  canExecute?(task: Task): boolean;
}

/**
 * Alias for TaskExecutor used in autonomous agent context
 */
export type AutonomousTaskExecutor = TaskExecutor;

/**
 * Discovery mode for finding tasks
 */
export type DiscoveryMode = "polling" | "events" | "hybrid";

/**
 * Default claim strategy - claim one task at a time, prioritize by reward
 */
export const DefaultClaimStrategy: ClaimStrategy = {
  shouldClaim: (_task: Task, pendingTasks: number) => pendingTasks === 0,
  priority: (task: Task) => Number(task.reward),
};
