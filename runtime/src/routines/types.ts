import type { JsonObject } from "../app-server/protocol/index.js";

/** Versioned local-daemon contract. No caller-supplied credentials or runtime authority. */
export type RoutineSchedule =
  | { readonly kind: "manual" }
  | { readonly kind: "cron"; readonly expression: string };
export type RoutineRunStatus = "starting" | "running" | "waiting_permission" | "completed" | "failed" | "cancelled" | "interrupted";
export interface RoutineDesktopTools extends JsonObject {
  readonly status: "attached" | "declined" | "unavailable";
  readonly reason: string | null;
}
export interface RoutineSessionPrepareEvent extends JsonObject {
  readonly requestId: string; readonly sessionId: string; readonly routineId: string; readonly runId: string; readonly cwd: string;
}
export interface RoutineSessionPrepareResponse extends JsonObject {
  readonly requestId: string; readonly status: "attached" | "declined"; readonly reason?: string;
}
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
  readonly desktopTools?: RoutineDesktopTools;
}
/**
 * The permission mode a scheduled run starts in. Nobody is attached to a
 * scheduled run, so default and plan are read-only, acceptEdits may edit the
 * routine's workspace, and bypassPermissions skips approvals; every mode
 * writes files only inside the routine's workspace.
 */
export type RoutinePermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";
export interface RoutineConfig extends JsonObject {
  readonly name: string;
  readonly description?: string;
  readonly instructions: string;
  readonly cwd: string;
  readonly schedule: RoutineSchedule;
  readonly provider?: string;
  readonly model?: string;
  readonly permissionMode?: RoutinePermissionMode;
  readonly enabled?: boolean;
  readonly notifyOnCompletion?: boolean;
}
/** Request-only identity captured by a trusted client after workspace approval. */
export interface RoutineWorkspaceExpectation extends JsonObject {
  readonly cwd: string;
  readonly dev: string;
  readonly ino: string;
}
/**
 * Request-only: whose permissions a create or update speaks for. Never stored.
 *
 * `session` names the live session that asked (the Desktop sends the session
 * behind a model's routine tool call). Core reads that session's current mode
 * from its own permission registry; a request cannot state it. `operator` is
 * a trusted client's own Routines screen, where the user picks a mode the way
 * they pick one for a session. Without either, a request keeps the original
 * contract: default or plan only.
 */
export type RoutinePermissionAuthority =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "operator" };
export interface RoutineCreateParams extends RoutineConfig {
  readonly expectedWorkspace?: RoutineWorkspaceExpectation;
  readonly permissionAuthority?: RoutinePermissionAuthority;
}
export interface Routine extends RoutineConfig {
  readonly id: string;
  readonly description: string;
  readonly permissionMode: RoutinePermissionMode;
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
  readonly permissionAuthority?: RoutinePermissionAuthority;
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
  /**
   * All four modes for a connection that negotiated routine.permissionModes.v2;
   * the original two otherwise.
   */
  readonly permissionModes: readonly ["default", "plan", "acceptEdits", "bypassPermissions"] | readonly ["default", "plan"];
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
