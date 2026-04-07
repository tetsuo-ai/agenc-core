/**
 * GoalManager — lifecycle controller over durable strategic memory.
 *
 * Keeps the old public GoalManager API, but its source of truth is now the
 * structured strategic goal store rather than generic KV arrays.
 *
 * @module
 */

import type { MemoryBackend } from "../memory/types.js";
import {
  GoalStore,
  type GoalStoreInput,
  type StrategicGoalRecord,
  type StrategicGoalResult,
} from "./goal-store.js";
import { goalSimilarity } from "./goal-consolidation.js";

export type ManagedGoal = StrategicGoalRecord;

export interface GoalManagerConfig {
  readonly memory?: MemoryBackend;
  readonly goalStore?: GoalStore;
  readonly maxActiveGoals?: number;
  readonly maxHistoryGoals?: number;
  readonly deduplicationWindowMs?: number;
}

export class GoalManager {
  private readonly goalStore: GoalStore;
  private readonly maxActiveGoals: number;
  private readonly maxHistoryGoals: number;
  private readonly deduplicationWindowMs: number;

  constructor(config: GoalManagerConfig) {
    this.maxActiveGoals = config.maxActiveGoals ?? 10;
    this.maxHistoryGoals = config.maxHistoryGoals ?? 50;
    this.deduplicationWindowMs = config.deduplicationWindowMs ?? 3_600_000;
    if (config.goalStore) {
      this.goalStore = config.goalStore;
      return;
    }
    if (!config.memory) {
      throw new Error("GoalManager requires either memory or goalStore");
    }
    this.goalStore = new GoalStore({ memory: config.memory });
  }

  get store(): GoalStore {
    return this.goalStore;
  }

  async addGoal(input: GoalStoreInput): Promise<ManagedGoal> {
    const activeGoals = await this.goalStore.getActiveGoals();
    if (activeGoals.length >= this.maxActiveGoals) {
      const evictable = activeGoals.filter(g => g.status !== "executing");
      const lowestPriority = [...evictable].sort((left, right) => {
        // Audit S1.7: include a default branch so an unrecognized
        // priority value (e.g. from a future schema migration or a
        // corrupted persisted goal) does not return undefined and
        // produce NaN inside the comparator. NaN comparators break
        // sort stability and can drop or duplicate elements.
        const weight = (priority: ManagedGoal["priority"]): number => {
          switch (priority) {
            case "critical":
              return 4;
            case "high":
              return 3;
            case "medium":
              return 2;
            case "low":
              return 1;
            default:
              return 0;
          }
        };
        const delta = weight(left.priority) - weight(right.priority);
        if (delta !== 0) {
          return delta;
        }
        return right.createdAt - left.createdAt;
      })[0];
      if (lowestPriority) {
        await this.goalStore.cancelGoal(lowestPriority.id);
      }
    }
    const result = await this.goalStore.addGoal(input);
    return result.goal;
  }

  async getActiveGoals(): Promise<ManagedGoal[]> {
    return this.goalStore.getActiveGoals();
  }

  async getNextGoal(
    filter?: (goal: ManagedGoal) => boolean,
  ): Promise<ManagedGoal | undefined> {
    let pending = (await this.goalStore.getActiveGoals()).filter(
      (goal) => goal.status === "pending",
    );
    if (filter) {
      pending = pending.filter(filter);
    }
    return pending[0];
  }

  async markExecuting(goalId: string): Promise<void> {
    await this.goalStore.markExecuting(goalId);
  }

  async markCompleted(
    goalId: string,
    result: StrategicGoalResult,
  ): Promise<void> {
    await this.goalStore.markCompleted(goalId, result);
  }

  async markFailed(
    goalId: string,
    result: StrategicGoalResult,
  ): Promise<void> {
    await this.goalStore.markFailed(goalId, result);
  }

  async cancelGoal(goalId: string): Promise<void> {
    await this.goalStore.cancelGoal(goalId);
  }

  async getHistory(limit?: number): Promise<ManagedGoal[]> {
    const effectiveLimit = limit ?? this.maxHistoryGoals;
    return this.goalStore.getHistoryGoals(effectiveLimit);
  }

  isDuplicate(description: string, existingGoals: ManagedGoal[]): boolean {
    const now = Date.now();
    return existingGoals.some((goal) => {
      if (now - goal.createdAt > this.deduplicationWindowMs) {
        return false;
      }
      return (
        goalSimilarity(
          goal.title,
          goal.description,
          goal.title,
          description,
        ) >= 0.82
      );
    });
  }
}
