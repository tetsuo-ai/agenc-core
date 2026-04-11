/**
 * Task Discovery Action — Heartbeat
 *
 * A HeartbeatAction that scans for on-chain tasks, scores their risk,
 * and queues viable ones as goals in GoalManager.
 *
 * @module
 */

import type {
  HeartbeatAction,
  HeartbeatContext,
  HeartbeatResult,
} from "../gateway/heartbeat.js";
import type { TaskScanner } from "./scanner.js";
import type { GoalManager, ManagedGoal } from "./goal-manager.js";
import { scoreTaskRisk, type RiskTier } from "./risk-scoring.js";
import type { Task } from "./types.js";
import {
  isMarketplaceJobSpecTaskLinkNotFoundError,
  resolveMarketplaceJobSpecForTask,
  type MarketplaceJobSpecStoreOptions,
  type ResolvedMarketplaceJobSpec,
} from "../marketplace/job-spec-store.js";
import type { Logger } from "../utils/logger.js";
import type { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import { resolveOnChainTaskJobSpecForTask } from "../marketplace/task-job-spec.js";

// ============================================================================
// Types
// ============================================================================

interface ResolvedTaskGoalJobSpec {
  readonly jobSpecHash: string;
  readonly jobSpecUri: string;
  readonly payload: ResolvedMarketplaceJobSpec["payload"];
}

export interface TaskDiscoveryActionConfig {
  scanner: TaskScanner;
  goalManager: GoalManager;
  /** Maximum tasks to evaluate per heartbeat cycle (default: 5). */
  maxTasksPerScan?: number;
  /** Maximum acceptable risk score (0-1). Tasks above this are skipped (default: 0.70). */
  maxRiskScore?: number;
  /** Local content-addressed job spec store override. */
  jobSpecStoreDir?: string;
  /** Optional on-chain program handle used to resolve task_job_spec PDAs before local fallback. */
  program?: Program<AgencCoordination>;
  /** Optional resolver for tests or remote index adapters. */
  resolveJobSpecForTask?: (
    taskPda: string,
  ) => Promise<ResolvedTaskGoalJobSpec | null>;
  logger?: Logger;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_TASKS_PER_SCAN = 5;
const DEFAULT_MAX_RISK_SCORE = 0.7;
const MAX_GOAL_DESCRIPTION_CHARS = 4_000;
const MAX_GOAL_TITLE_CHARS = 120;

const RISK_TIER_TO_PRIORITY: Record<
  RiskTier,
  ManagedGoal["priority"] | null
> = {
  low: "medium",
  medium: "low",
  high: null, // skip
};

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a heartbeat action that discovers on-chain tasks and feeds
 * them to GoalManager as goals.
 */
export function createTaskDiscoveryAction(
  config: TaskDiscoveryActionConfig,
): HeartbeatAction {
  const { scanner, goalManager } = config;
  const maxTasksPerScan =
    config.maxTasksPerScan ?? DEFAULT_MAX_TASKS_PER_SCAN;
  const maxRiskScore = config.maxRiskScore ?? DEFAULT_MAX_RISK_SCORE;
  const logger = config.logger;
  const jobSpecStoreOptions = getJobSpecStoreOptions(config.jobSpecStoreDir);
  const resolveJobSpecForTask =
    config.resolveJobSpecForTask ??
    ((taskPda: string) =>
      resolveConfiguredJobSpecForTask(
        taskPda,
        config.program,
        jobSpecStoreOptions,
      ));

  // Tracks PDAs already queued to avoid duplicates across heartbeat cycles
  const queuedPdas = new Set<string>();

  return {
    name: "task-discovery",
    enabled: true,

    async execute(_context: HeartbeatContext): Promise<HeartbeatResult> {
      let tasks;
      try {
        tasks = await scanner.scan();
      } catch (err) {
        logger?.error?.("Task discovery scan failed:", err);
        return { hasOutput: false, quiet: true };
      }

      if (tasks.length === 0) {
        return { hasOutput: false, quiet: true };
      }

      // Limit work per heartbeat
      const batch = tasks.slice(0, maxTasksPerScan);
      let queued = 0;
      let skippedRisk = 0;

      for (const task of batch) {
        const pdaKey = task.pda.toBase58();
        if (queuedPdas.has(pdaKey)) continue;

        const riskResult = scoreTaskRisk(task);

        if (riskResult.score > maxRiskScore) {
          skippedRisk++;
          continue;
        }

        const priority = RISK_TIER_TO_PRIORITY[riskResult.tier];
        if (priority === null) {
          skippedRisk++;
          continue;
        }

        try {
          const jobSpec = await resolveJobSpecForGoal(
            pdaKey,
            resolveJobSpecForTask,
            logger,
          );
          await goalManager.addGoal({
            title: buildTaskGoalTitle(jobSpec),
            description: buildTaskGoalDescription(task, pdaKey, jobSpec),
            priority,
            source: "meta-planner",
            maxAttempts: 2,
          });
          queuedPdas.add(pdaKey);
          queued++;
        } catch (err) {
          logger?.warn?.(
            `Failed to queue goal for task ${pdaKey}:`,
            err,
          );
        }
      }

      const output = `Discovered ${tasks.length} tasks, queued ${queued} goals (skipped ${skippedRisk} high-risk)`;
      logger?.debug?.(output);

      return {
        hasOutput: queued > 0,
        output,
        quiet: true,
      };
    },
  };
}

function getJobSpecStoreOptions(
  rootDir?: string,
): MarketplaceJobSpecStoreOptions {
  return rootDir ? { rootDir } : {};
}

async function resolveLocalJobSpecForTask(
  taskPda: string,
  options: MarketplaceJobSpecStoreOptions,
): Promise<ResolvedMarketplaceJobSpec | null> {
  try {
    return await resolveMarketplaceJobSpecForTask(taskPda, options);
  } catch (error) {
    if (isMarketplaceJobSpecTaskLinkNotFoundError(error)) return null;
    throw error;
  }
}

async function resolveConfiguredJobSpecForTask(
  taskPda: string,
  program: Program<AgencCoordination> | undefined,
  options: MarketplaceJobSpecStoreOptions,
): Promise<ResolvedTaskGoalJobSpec | null> {
  let onChainError: unknown = null;

  if (program) {
    try {
      const resolved = await resolveOnChainTaskJobSpecForTask(
        program,
        new PublicKey(taskPda),
        options,
      );
      if (resolved) return resolved;
    } catch (error) {
      onChainError = error;
    }
  }

  try {
    return await resolveLocalJobSpecForTask(taskPda, options);
  } catch (error) {
    if (onChainError) throw onChainError;
    throw error;
  }
}

async function resolveJobSpecForGoal(
  taskPda: string,
  resolver: (taskPda: string) => Promise<ResolvedTaskGoalJobSpec | null>,
  logger?: Logger,
): Promise<ResolvedTaskGoalJobSpec | null> {
  try {
    return await resolver(taskPda);
  } catch (error) {
    logger?.warn?.(
      `Failed to resolve task job spec for task ${taskPda}:`,
      error,
    );
    return null;
  }
}

function buildTaskGoalTitle(jobSpec: ResolvedTaskGoalJobSpec | null): string {
  if (!jobSpec) return "On-chain task";
  return truncateText(
    `On-chain task: ${jobSpec.payload.title}`,
    MAX_GOAL_TITLE_CHARS,
  );
}

function buildTaskGoalDescription(
  task: Task,
  taskPda: string,
  jobSpec: ResolvedTaskGoalJobSpec | null,
): string {
  if (!jobSpec) {
    return `Task PDA: ${taskPda}, reward: ${task.reward}`;
  }

  const payload = jobSpec.payload;
  const lines = [
    `Task PDA: ${taskPda}`,
    `Reward: ${task.reward}`,
    `Job spec URI: ${jobSpec.jobSpecUri}`,
    `Job spec hash: ${jobSpec.jobSpecHash}`,
    `Title: ${payload.title}`,
  ];

  if (payload.fullDescription) {
    lines.push(`Full description: ${payload.fullDescription}`);
  }
  if (payload.acceptanceCriteria.length > 0) {
    lines.push(
      `Acceptance criteria:
${formatGoalList(payload.acceptanceCriteria)}`,
    );
  }
  if (payload.deliverables.length > 0) {
    lines.push(`Deliverables:
${formatGoalList(payload.deliverables)}`);
  }
  if (payload.constraints !== null) {
    lines.push(`Constraints: ${JSON.stringify(payload.constraints)}`);
  }
  if (payload.attachments.length > 0) {
    lines.push(
      `Attachments:
${formatGoalList(
        payload.attachments.map((attachment) =>
          attachment.label
            ? `${attachment.label}: ${attachment.uri}`
            : attachment.uri,
        ),
      )}`,
    );
  }

  return truncateText(lines.join("\n"), MAX_GOAL_DESCRIPTION_CHARS);
}

function formatGoalList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
