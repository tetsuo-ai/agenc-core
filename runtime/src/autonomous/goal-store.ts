import { randomUUID } from "node:crypto";
import type { MemoryBackend, StrategicMemoryRecordEnvelope } from "../memory/types.js";
import { renderStructuredMemoryDigest } from "../memory/structured.js";
import {
  choosePriority,
  consolidateGoalUpdate,
  findGoalConsolidationMatch,
  normalizeGoalIdentity,
} from "./goal-consolidation.js";
import {
  ACTIVE_GOAL_TTL_MS,
  applyExecutionSummaryHygiene,
  applyGoalHygiene,
  applyWorkingNoteHygiene,
  isActiveGoalStatus,
  isTerminalGoalStatus,
} from "./goal-hygiene.js";
import { migrateStrategicMemoryState } from "../gateway/state-migrations.js";

export type StrategicGoalPriority = "critical" | "high" | "medium" | "low";

export type StrategicGoalSource =
  | "meta-planner"
  | "awareness"
  | "user"
  | "curiosity";

export type StrategicGoalStatus =
  | "proposed"
  | "pending"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected"
  | "expired"
  | "superseded";

export interface StrategicGoalResult {
  readonly success: boolean;
  readonly summary: string;
  readonly durationMs: number;
}

export interface StrategicGoalFreshness {
  readonly score: number;
  readonly lastObservedAt: number;
  readonly expiresAt: number;
}

export interface StrategicGoalRecord {
  readonly id: string;
  readonly canonicalId: string;
  readonly title: string;
  readonly description: string;
  readonly priority: StrategicGoalPriority;
  readonly status: StrategicGoalStatus;
  readonly source: StrategicGoalSource;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly freshness: StrategicGoalFreshness;
  readonly ownerRunId?: string;
  readonly dependencyGoalIds: readonly string[];
  readonly supersededByGoalId?: string;
  readonly supersedesGoalIds: readonly string[];
  readonly result?: StrategicGoalResult;
  readonly rationale?: string;
  readonly suggestedActions?: readonly string[];
  readonly estimatedComplexity?: "simple" | "moderate" | "complex";
}

export interface ManagedGoal extends StrategicGoalRecord {}

export interface GoalStoreInput {
  readonly title: string;
  readonly description: string;
  readonly priority: StrategicGoalPriority;
  readonly source: StrategicGoalSource;
  readonly maxAttempts?: number;
  readonly rationale?: string;
  readonly suggestedActions?: readonly string[];
  readonly estimatedComplexity?: "simple" | "moderate" | "complex";
  readonly ownerRunId?: string;
  readonly dependencyGoalIds?: readonly string[];
  readonly status?: "proposed" | "pending";
}

export interface GoalMutationResult {
  readonly goal: StrategicGoalRecord;
  readonly created: boolean;
  readonly accepted: boolean;
  readonly rejectedReason?: "duplicate_active" | "duplicate_recent_terminal";
}

export interface StrategicWorkingNote
  extends StrategicMemoryRecordEnvelope<{
    readonly title: string;
    readonly content: string;
    readonly source: string;
  }> {}

export interface StrategicExecutionSummary
  extends StrategicMemoryRecordEnvelope<{
    readonly goalId?: string;
    readonly goalTitle?: string;
    readonly outcome: "success" | "failure" | "cancelled";
    readonly summary: string;
    readonly durationMs?: number;
    readonly source: string;
  }> {}

export interface StrategicMemoryState {
  readonly version: "v1";
  readonly goals: readonly StrategicGoalRecord[];
  readonly workingNotes: readonly StrategicWorkingNote[];
  readonly executionSummaries: readonly StrategicExecutionSummary[];
  readonly updatedAt: number;
}

export interface StrategicPlanningSnapshot {
  readonly activeGoals: readonly StrategicGoalRecord[];
  readonly recentOutcomes: readonly StrategicExecutionSummary[];
  readonly workingNotes: readonly StrategicWorkingNote[];
  readonly learnedPatterns: {
    readonly lessons: readonly string[];
    readonly strategies: readonly string[];
  };
  readonly digest: string;
}

export interface GoalStoreConfig {
  readonly memory: MemoryBackend;
  readonly now?: () => number;
  readonly stateKey?: string;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const STATE_KEY = "strategic:memory:state";
const LEGACY_ACTIVE_KEY = "goals:active";
const LEGACY_HISTORY_KEY = "goals:history";
const LEGACY_META_ACTIVE_KEY = "goal:active";
const LEGACY_META_MANAGED_KEY = "goal:managed-active";

type LegacyManagedGoal = {
  title: string;
  description: string;
  priority: StrategicGoalPriority;
  status: string;
  source: StrategicGoalSource;
  createdAt?: number;
  updatedAt?: number;
  attempts?: number;
  maxAttempts?: number;
  rationale?: string;
  result?: StrategicGoalResult;
};

type LegacyGeneratedGoal = {
  id?: string;
  title: string;
  description: string;
  priority: StrategicGoalPriority;
  rationale?: string;
  suggestedActions?: string[];
  estimatedComplexity?: "simple" | "moderate" | "complex";
  createdAt?: number;
  status?: string;
};

export class GoalStore {
  private readonly memory: MemoryBackend;
  private readonly now: () => number;
  private readonly stateKey: string;

  constructor(config: GoalStoreConfig) {
    this.memory = config.memory;
    this.now = config.now ?? (() => Date.now());
    this.stateKey = config.stateKey ?? STATE_KEY;
  }

  async getState(): Promise<StrategicMemoryState> {
    const existing = await this.memory.get<StrategicMemoryState>(this.stateKey);
    if (existing) {
      const migration = migrateStrategicMemoryState(existing, this.now());
      if (migration.migrated) {
        await this.persistState(migration.value);
      }
      return this.normalizeState(migration.value);
    }
    const migrated = await this.migrateLegacyState();
    if (migrated) {
      await this.persistState(migrated);
      return migrated;
    }
    return this.normalizeState({
      version: "v1",
      goals: [],
      workingNotes: [],
      executionSummaries: [],
      updatedAt: this.now(),
    });
  }

  async listGoals(): Promise<readonly StrategicGoalRecord[]> {
    return (await this.getState()).goals;
  }

  async getGoal(goalId: string): Promise<StrategicGoalRecord | undefined> {
    return (await this.getState()).goals.find((goal) => goal.id === goalId);
  }

  async getActiveGoals(): Promise<StrategicGoalRecord[]> {
    const goals = (await this.getState()).goals.filter(
      (goal) =>
        isActiveGoalStatus(goal.status) && !goal.supersededByGoalId,
    );
    return goals.sort(compareActiveGoals);
  }

  async getHistoryGoals(limit?: number): Promise<StrategicGoalRecord[]> {
    const history = (await this.getState()).goals
      .filter((goal) => isTerminalGoalStatus(goal.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return limit ? history.slice(0, limit) : history;
  }

  async addGoal(input: GoalStoreInput): Promise<GoalMutationResult> {
    const state = await this.getState();
    const now = this.now();
    const match = findGoalConsolidationMatch({
      existingGoals: state.goals,
      input,
      now,
    });
    const consolidation = consolidateGoalUpdate({ match, input, now });

    let goals = [...state.goals];
    if (consolidation.refreshedExisting) {
      goals = goals.map((goal) =>
        goal.id === consolidation.refreshedExisting!.id
          ? this.refreshGoal(goal, input, now)
          : goal,
      );
      if (!consolidation.accepted) {
        const refreshed = goals.find(
          (goal) => goal.id === consolidation.refreshedExisting!.id,
        )!;
        const nextState = this.normalizeState({
          ...state,
          goals,
          updatedAt: now,
        });
        await this.persistState(nextState);
        return {
          goal: refreshed,
          created: false,
          accepted: false,
          rejectedReason: consolidation.rejectedReason,
        };
      }
    }

    // Create the new goal first so we have a real ID to point at,
    // instead of using a `"pending"` placeholder string that the
    // audit (S1.7) flagged as a corruption risk: if the placeholder
    // ever leaked to disk via a partial write or an exception thrown
    // between the two maps, the eviction logic would treat
    // `"pending"` as a real ID forever and never clear those rows.
    const created = this.createGoalRecord(input, now);
    if (consolidation.supersededGoalIds.length > 0) {
      goals = goals.map((goal) =>
        consolidation.supersededGoalIds.includes(goal.id)
          ? {
              ...goal,
              status: "superseded",
              supersededByGoalId: created.id,
              updatedAt: now,
              freshness: { ...goal.freshness, score: 0 },
            }
          : goal,
      );
    }
    goals.push(created);

    const nextState = this.normalizeState({
      ...state,
      goals,
      updatedAt: now,
    });
    await this.persistState(nextState);
    return { goal: created, created: true, accepted: true };
  }

  async markExecuting(goalId: string): Promise<StrategicGoalRecord | undefined> {
    return this.updateGoal(goalId, (goal, now) => ({
      ...goal,
      status: "executing",
      attempts: goal.attempts + 1,
      updatedAt: now,
      freshness: {
        score: 1,
        lastObservedAt: now,
        expiresAt: now + ACTIVE_GOAL_TTL_MS,
      },
    }));
  }

  async markCompleted(
    goalId: string,
    result: StrategicGoalResult,
  ): Promise<StrategicGoalRecord | undefined> {
    const goal = await this.updateGoal(goalId, (current, now) => ({
      ...current,
      status: "completed",
      result,
      updatedAt: now,
      freshness: {
        ...current.freshness,
        score: 0,
        lastObservedAt: now,
      },
    }));
    if (goal) {
      await this.recordExecutionSummary({
        goalId: goal.id,
        goalTitle: goal.title,
        outcome: "success",
        summary: result.summary,
        durationMs: result.durationMs,
        source: goal.source,
      });
    }
    return goal;
  }

  async markFailed(
    goalId: string,
    result: StrategicGoalResult,
  ): Promise<StrategicGoalRecord | undefined> {
    const state = await this.getState();
    const goal = state.goals.find((candidate) => candidate.id === goalId);
    if (!goal) {
      return undefined;
    }
    if (goal.attempts < goal.maxAttempts) {
      return this.updateGoal(goalId, (current, now) => ({
        ...current,
        status: "pending",
        result,
        updatedAt: now,
        freshness: {
          score: 1,
          lastObservedAt: now,
          expiresAt: now + ACTIVE_GOAL_TTL_MS,
        },
      }));
    }

    const failed = await this.updateGoal(goalId, (current, now) => ({
      ...current,
      status: "failed",
      result,
      updatedAt: now,
      freshness: {
        ...current.freshness,
        score: 0,
        lastObservedAt: now,
      },
    }));
    if (failed) {
      await this.recordExecutionSummary({
        goalId: failed.id,
        goalTitle: failed.title,
        outcome: "failure",
        summary: result.summary,
        durationMs: result.durationMs,
        source: failed.source,
      });
    }
    return failed;
  }

  async cancelGoal(goalId: string): Promise<StrategicGoalRecord | undefined> {
    const cancelled = await this.updateGoal(goalId, (goal, now) => ({
      ...goal,
      status: "cancelled",
      updatedAt: now,
      freshness: {
        ...goal.freshness,
        score: 0,
        lastObservedAt: now,
      },
    }));
    if (cancelled) {
      await this.recordExecutionSummary({
        goalId: cancelled.id,
        goalTitle: cancelled.title,
        outcome: "cancelled",
        summary: "Goal cancelled",
        source: cancelled.source,
      });
    }
    return cancelled;
  }

  async addWorkingNote(input: {
    readonly title: string;
    readonly content: string;
    readonly source: string;
    readonly scope?: "global" | "session" | "run";
    readonly sessionId?: string;
    readonly runId?: string;
  }): Promise<StrategicWorkingNote> {
    const state = await this.getState();
    const now = this.now();
    const note: StrategicWorkingNote = {
      id: randomUUID(),
      kind: "working_note",
      scope: input.scope ?? "global",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      createdAt: now,
      updatedAt: now,
      data: {
        title: input.title,
        content: input.content,
        source: input.source,
      },
    };
    const nextState = this.normalizeState({
      ...state,
      workingNotes: [...state.workingNotes, note],
      updatedAt: now,
    });
    await this.persistState(nextState);
    return note;
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
    const state = await this.getState();
    const now = this.now();
    const summary: StrategicExecutionSummary = {
      id: randomUUID(),
      kind: "execution_summary",
      scope: input.scope ?? "global",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      createdAt: now,
      updatedAt: now,
      data: {
        goalId: input.goalId,
        goalTitle: input.goalTitle,
        outcome: input.outcome,
        summary: input.summary,
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        source: input.source,
      },
    };
    const nextState = this.normalizeState({
      ...state,
      executionSummaries: [...state.executionSummaries, summary],
      updatedAt: now,
    });
    await this.persistState(nextState);
    return summary;
  }

  async buildPlanningSnapshot(): Promise<StrategicPlanningSnapshot> {
    const state = await this.getState();
    const learning =
      (await this.memory.get<{
        patterns?: Array<{ lesson?: string }>;
        strategies?: Array<{ name?: string; description?: string }>;
      }>("learning:latest")) ?? {};
    const activeGoals = state.goals
      .filter((goal) => isActiveGoalStatus(goal.status) && !goal.supersededByGoalId)
      .sort(compareActiveGoals)
      .slice(0, 8);
    const recentOutcomes = [...state.executionSummaries].slice(0, 8);
    const workingNotes = [...state.workingNotes].slice(0, 8);
    const digestParts: string[] = [];

    if (activeGoals.length > 0) {
      digestParts.push(
        "Strategic Goals:\n" +
          activeGoals
            .map(
              (goal) =>
                `- [${goal.priority}/${goal.status}/fresh=${goal.freshness.score.toFixed(2)}] ${goal.title}: ${goal.description}`,
            )
            .join("\n"),
      );
    }
    if (recentOutcomes.length > 0) {
      digestParts.push(
        "Recent Execution Summaries:\n" +
          renderStructuredMemoryDigest(
            recentOutcomes.map((summary) => ({
              heading: `${summary.data.outcome.toUpperCase()} ${summary.data.goalTitle ?? "untitled goal"}`,
              body: summary.data.summary,
              updatedAt: summary.updatedAt,
            })),
          ),
      );
    }
    if (workingNotes.length > 0) {
      digestParts.push(
        "Working Notes:\n" +
          renderStructuredMemoryDigest(
            workingNotes.map((note) => ({
              heading: note.data.title,
              body: note.data.content,
              updatedAt: note.updatedAt,
            })),
          ),
      );
    }

    const lessons = (learning.patterns ?? [])
      .map((pattern) => pattern.lesson?.trim() ?? "")
      .filter((lesson) => lesson.length > 0)
      .slice(0, 8);
    const strategies = (learning.strategies ?? [])
      .map((strategy) =>
        [strategy.name?.trim() ?? "", strategy.description?.trim() ?? ""]
          .filter((part) => part.length > 0)
          .join(": "),
      )
      .filter((line) => line.length > 0)
      .slice(0, 8);

    if (lessons.length > 0) {
      digestParts.push("Learned Patterns:\n" + lessons.map((lesson) => `- ${lesson}`).join("\n"));
    }
    if (strategies.length > 0) {
      digestParts.push("Known Strategies:\n" + strategies.map((line) => `- ${line}`).join("\n"));
    }

    return {
      activeGoals,
      recentOutcomes,
      workingNotes,
      learnedPatterns: { lessons, strategies },
      digest: digestParts.join("\n\n").trim(),
    };
  }

  async syncLegacyMirrors(): Promise<void> {
    await this.persistState(await this.getState());
  }

  private async updateGoal(
    goalId: string,
    updater: (
      goal: StrategicGoalRecord,
      now: number,
    ) => StrategicGoalRecord,
  ): Promise<StrategicGoalRecord | undefined> {
    const state = await this.getState();
    const now = this.now();
    let updatedGoal: StrategicGoalRecord | undefined;
    const goals = state.goals.map((goal) => {
      if (goal.id !== goalId) {
        return goal;
      }
      updatedGoal = updater(goal, now);
      return updatedGoal;
    });
    if (!updatedGoal) {
      return undefined;
    }
    const nextState = this.normalizeState({
      ...state,
      goals,
      updatedAt: now,
    });
    await this.persistState(nextState);
    return updatedGoal;
  }

  private createGoalRecord(
    input: GoalStoreInput,
    now: number,
  ): StrategicGoalRecord {
    const canonicalId = normalizeGoalIdentity(input.title, input.description);
    return {
      id: randomUUID(),
      canonicalId,
      title: input.title,
      description: input.description,
      priority: input.priority,
      status: input.status ?? "pending",
      source: input.source,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      freshness: {
        score: 1,
        lastObservedAt: now,
        expiresAt: now + ACTIVE_GOAL_TTL_MS,
      },
      ...(input.ownerRunId ? { ownerRunId: input.ownerRunId } : {}),
      dependencyGoalIds: input.dependencyGoalIds ?? [],
      supersedesGoalIds: [],
      ...(input.rationale ? { rationale: input.rationale } : {}),
      ...(input.suggestedActions ? { suggestedActions: [...input.suggestedActions] } : {}),
      ...(input.estimatedComplexity
        ? { estimatedComplexity: input.estimatedComplexity }
        : {}),
    };
  }

  private refreshGoal(
    goal: StrategicGoalRecord,
    input: GoalStoreInput,
    now: number,
  ): StrategicGoalRecord {
    return {
      ...goal,
      priority: choosePriority(goal.priority, input.priority),
      updatedAt: now,
      freshness: {
        score: 1,
        lastObservedAt: now,
        expiresAt: now + ACTIVE_GOAL_TTL_MS,
      },
      rationale: goal.rationale ?? input.rationale,
      suggestedActions: mergeStringArrays(goal.suggestedActions, input.suggestedActions),
    };
  }

  private normalizeState(state: StrategicMemoryState): StrategicMemoryState {
    const now = this.now();
    return {
      ...state,
      goals: applyGoalHygiene(state.goals, now),
      workingNotes: applyWorkingNoteHygiene(state.workingNotes, now),
      executionSummaries: applyExecutionSummaryHygiene(
        state.executionSummaries,
        now,
      ),
      updatedAt: state.updatedAt,
    };
  }

  private async persistState(state: StrategicMemoryState): Promise<void> {
    await this.memory.set(this.stateKey, state);
    await this.writeLegacyMirrors(state);
  }

  private async writeLegacyMirrors(state: StrategicMemoryState): Promise<void> {
    const active = state.goals
      .filter((goal) => isActiveGoalStatus(goal.status) && !goal.supersededByGoalId)
      .sort(compareActiveGoals);
    const history = state.goals
      .filter((goal) => isTerminalGoalStatus(goal.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    await this.memory.set(
      LEGACY_ACTIVE_KEY,
      active.map((goal) => this.toLegacyManagedGoal(goal)),
    );
    await this.memory.set(
      LEGACY_HISTORY_KEY,
      history.map((goal) => this.toLegacyManagedGoal(goal)),
    );
    await this.memory.set(
      LEGACY_META_ACTIVE_KEY,
      active.map((goal) => this.toLegacyGeneratedGoal(goal)),
    );
    if (active.length > 0) {
      await this.memory.set(
        LEGACY_META_MANAGED_KEY,
        active.map((goal) => ({
          title: goal.title,
          description: goal.description,
          priority: goal.priority,
          status: goal.status,
          source: goal.source,
        })),
      );
    } else {
      await this.memory.delete(LEGACY_META_MANAGED_KEY);
    }
  }

  private toLegacyManagedGoal(goal: StrategicGoalRecord): LegacyManagedGoal {
    const status = mapGoalStatusToLegacy(goal.status);
    return {
      title: goal.title,
      description: goal.description,
      priority: goal.priority,
      status,
      source: goal.source,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      attempts: goal.attempts,
      maxAttempts: goal.maxAttempts,
      rationale: goal.rationale,
      result: goal.result,
    };
  }

  private toLegacyGeneratedGoal(goal: StrategicGoalRecord): LegacyGeneratedGoal {
    return {
      id: goal.id,
      title: goal.title,
      description: goal.description,
      priority: goal.priority,
      rationale: goal.rationale,
      suggestedActions: goal.suggestedActions ? [...goal.suggestedActions] : [],
      estimatedComplexity: goal.estimatedComplexity,
      createdAt: goal.createdAt,
      status: mapGoalStatusToLegacy(goal.status),
    };
  }

  private async migrateLegacyState(): Promise<StrategicMemoryState | undefined> {
    const [managedActive, managedHistory, metaActive] = await Promise.all([
      this.memory.get<LegacyManagedGoal[]>(LEGACY_ACTIVE_KEY),
      this.memory.get<LegacyManagedGoal[]>(LEGACY_HISTORY_KEY),
      this.memory.get<LegacyGeneratedGoal[]>(LEGACY_META_ACTIVE_KEY),
    ]);
    const allLegacy = [
      ...(managedActive ?? []),
      ...(managedHistory ?? []),
    ];
    if (allLegacy.length === 0 && (!metaActive || metaActive.length === 0)) {
      return undefined;
    }

    const now = this.now();
    const goals = new Map<string, StrategicGoalRecord>();
    for (const goal of allLegacy) {
      const normalized = this.fromLegacyManagedGoal(goal, now);
      goals.set(normalized.canonicalId, normalized);
    }
    for (const goal of metaActive ?? []) {
      const normalized = this.fromLegacyGeneratedGoal(goal, now);
      if (!goals.has(normalized.canonicalId)) {
        goals.set(normalized.canonicalId, normalized);
      }
    }
    return this.normalizeState({
      version: "v1",
      goals: [...goals.values()],
      workingNotes: [],
      executionSummaries: [],
      updatedAt: now,
    });
  }

  private fromLegacyManagedGoal(
    goal: LegacyManagedGoal,
    now: number,
  ): StrategicGoalRecord {
    const createdAt = goal.createdAt ?? now;
    const updatedAt = goal.updatedAt ?? createdAt;
    return {
      id: randomUUID(),
      canonicalId: normalizeGoalIdentity(goal.title, goal.description),
      title: goal.title,
      description: goal.description,
      priority: goal.priority,
      status: mapLegacyStatus(goal.status),
      source: goal.source,
      createdAt,
      updatedAt,
      attempts: goal.attempts ?? 0,
      maxAttempts: goal.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      freshness: {
        score: 1,
        lastObservedAt: updatedAt,
        expiresAt: updatedAt + ACTIVE_GOAL_TTL_MS,
      },
      dependencyGoalIds: [],
      supersedesGoalIds: [],
      ...(goal.rationale ? { rationale: goal.rationale } : {}),
      ...(goal.result ? { result: goal.result } : {}),
    };
  }

  private fromLegacyGeneratedGoal(
    goal: LegacyGeneratedGoal,
    now: number,
  ): StrategicGoalRecord {
    const createdAt = goal.createdAt ?? now;
    return {
      id: goal.id ?? randomUUID(),
      canonicalId: normalizeGoalIdentity(goal.title, goal.description),
      title: goal.title,
      description: goal.description,
      priority: goal.priority,
      status: mapLegacyStatus(goal.status ?? "proposed"),
      source: "meta-planner",
      createdAt,
      updatedAt: createdAt,
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      freshness: {
        score: 1,
        lastObservedAt: createdAt,
        expiresAt: createdAt + ACTIVE_GOAL_TTL_MS,
      },
      dependencyGoalIds: [],
      supersedesGoalIds: [],
      ...(goal.rationale ? { rationale: goal.rationale } : {}),
      ...(goal.suggestedActions ? { suggestedActions: [...goal.suggestedActions] } : {}),
      ...(goal.estimatedComplexity
        ? { estimatedComplexity: goal.estimatedComplexity }
        : {}),
    };
  }
}

function compareActiveGoals(
  left: StrategicGoalRecord,
  right: StrategicGoalRecord,
): number {
  const priorityDelta = priorityWeight(right.priority) - priorityWeight(left.priority);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return left.createdAt - right.createdAt;
}

function priorityWeight(priority: StrategicGoalPriority): number {
  switch (priority) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

function mergeStringArrays(
  left?: readonly string[],
  right?: readonly string[],
): readonly string[] | undefined {
  const merged = [...new Set([...(left ?? []), ...(right ?? [])].filter(Boolean))];
  return merged.length > 0 ? merged : undefined;
}

function mapLegacyStatus(status: string): StrategicGoalStatus {
  switch (status.trim().toLowerCase()) {
    case "proposed":
      return "proposed";
    case "pending":
      return "pending";
    case "executing":
    case "in-progress":
      return "executing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "rejected":
      return "rejected";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "superseded":
      return "superseded";
    case "expired":
      return "expired";
    default:
      return "pending";
  }
}

function mapGoalStatusToLegacy(status: StrategicGoalStatus): string {
  switch (status) {
    case "superseded":
    case "expired":
      return "cancelled";
    default:
      return status;
  }
}
