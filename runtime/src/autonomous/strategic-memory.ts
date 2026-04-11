import type { MemoryBackend } from "../memory/types.js";
import {
  GoalStore,
  type GoalMutationResult,
  type GoalStoreConfig,
  type GoalStoreInput,
  type StrategicExecutionSummary,
  type StrategicGoalRecord,
  type StrategicPlanningSnapshot,
  type StrategicWorkingNote,
} from "./goal-store.js";

interface StrategicMemoryConfig extends GoalStoreConfig {}

export class StrategicMemory {
  readonly goalStore: GoalStore;

  constructor(config: StrategicMemoryConfig) {
    this.goalStore = new GoalStore(config);
  }

  static fromMemoryBackend(
    memory: MemoryBackend,
    config: Omit<StrategicMemoryConfig, "memory"> = {},
  ): StrategicMemory {
    return new StrategicMemory({
      ...config,
      memory,
    });
  }

  async addGoal(input: GoalStoreInput): Promise<GoalMutationResult> {
    return this.goalStore.addGoal(input);
  }

  async getActiveGoals(): Promise<StrategicGoalRecord[]> {
    return this.goalStore.getActiveGoals();
  }

  async getHistoryGoals(limit?: number): Promise<StrategicGoalRecord[]> {
    return this.goalStore.getHistoryGoals(limit);
  }

  async addWorkingNote(input: {
    readonly title: string;
    readonly content: string;
    readonly source: string;
    readonly scope?: "global" | "session" | "run";
    readonly sessionId?: string;
    readonly runId?: string;
  }): Promise<StrategicWorkingNote> {
    return this.goalStore.addWorkingNote(input);
  }

  async recordExecutionSummary(input: {
    readonly goalId?: string;
    readonly goalTitle?: string;
    readonly outcome: "success" | "failure" | "cancelled";
    readonly summary: string;
    readonly durationMs?: number;
    readonly source: string;
    readonly scope?: "global" | "session" | "run";
    readonly sessionId?: string;
    readonly runId?: string;
  }): Promise<StrategicExecutionSummary> {
    return this.goalStore.recordExecutionSummary(input);
  }

  async buildPlanningSnapshot(): Promise<StrategicPlanningSnapshot> {
    return this.goalStore.buildPlanningSnapshot();
  }

  async syncLegacyMirrors(): Promise<void> {
    await this.goalStore.syncLegacyMirrors();
  }
}
