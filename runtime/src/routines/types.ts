import type { JsonObject } from "../app-server/protocol/index.js";

/** Versioned local-daemon contract. No caller-supplied credentials or runtime authority. */
export type RoutineSchedule =
  | { readonly kind: "manual" }
  | { readonly kind: "cron"; readonly expression: string };
export type RoutineRunStatus = "starting" | "running" | "waiting_permission" | "completed" | "failed" | "cancelled" | "interrupted";
export interface RoutineRun extends JsonObject {
  readonly id: string;
  readonly routineId: string;
  readonly status: RoutineRunStatus;
  readonly trigger: "manual" | "schedule";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly agentId: string | null;
  readonly sessionId: string | null;
  readonly coreRunId: string | null;
  readonly error: string | null;
}
export interface RoutineConfig extends JsonObject {
  readonly name: string;
  readonly description?: string;
  readonly instructions: string;
  readonly cwd: string;
  readonly schedule: RoutineSchedule;
  readonly provider?: string;
  readonly model?: string;
  readonly permissionMode?: "default" | "plan";
  readonly enabled?: boolean;
  readonly notifyOnCompletion?: boolean;
}
/** Request-only identity captured by a trusted client after workspace approval. */
export interface RoutineWorkspaceExpectation extends JsonObject {
  readonly cwd: string;
  readonly dev: string;
  readonly ino: string;
}
export interface RoutineCreateParams extends RoutineConfig {
  readonly expectedWorkspace?: RoutineWorkspaceExpectation;
}
export interface Routine extends RoutineConfig {
  readonly id: string;
  readonly description: string;
  readonly permissionMode: "default" | "plan";
  readonly enabled: boolean;
  readonly notifyOnCompletion: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextRunAt: string | null;
  readonly lastRun: RoutineRun | null;
}
export interface RoutineIdParams extends JsonObject { readonly id: string }
export interface RoutineUpdateParams extends RoutineIdParams {
  readonly patch: Partial<RoutineConfig>;
  readonly expectedUpdatedAt?: string;
  /** Only valid when patch.cwd supplies a new workspace. */
  readonly expectedWorkspace?: RoutineWorkspaceExpectation;
}
export interface RoutineDeleteParams extends RoutineIdParams { readonly expectedUpdatedAt?: string }
/** Optional for legacy callers; binds a reviewed definition to its manual run. */
export interface RoutineRunParams extends RoutineIdParams { readonly expectedUpdatedAt?: string }
export interface RoutineRunsParams extends RoutineIdParams { readonly limit?: number }
export interface RoutineCancelParams extends RoutineIdParams { readonly runId?: string }
export interface RoutineCapabilities extends JsonObject {
  readonly version: 1;
  readonly available: true;
  readonly scheduleKinds: readonly ["manual", "cron"];
  readonly permissionModes: readonly ["default", "plan"];
  readonly timezone: string;
  readonly executionMode: "local";
  readonly maxRoutines: number;
  readonly maxRunsPerRoutine: number;
}
export interface RoutineResult extends JsonObject { readonly routine: Routine }
export interface RoutineRunResult extends JsonObject { readonly run: RoutineRun }
export interface RoutineListResult extends JsonObject { readonly routines: readonly Routine[] }
export interface RoutineRunsResult extends JsonObject { readonly runs: readonly RoutineRun[] }
export interface RoutineDeleteResult extends JsonObject { readonly deleted: true }
/** Invalidation only: clients refresh list/detail; no instructions or results are broadcast. */
export interface RoutineUpdatedEvent extends JsonObject {
  readonly id: string;
  readonly reason: "created" | "updated" | "deleted" | "run";
}
