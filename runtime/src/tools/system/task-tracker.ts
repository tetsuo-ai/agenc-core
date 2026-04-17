/**
 * Task tracker tools for @tetsuo-ai/runtime.
 *
 * The public `task.*` tool family stays session-scoped, but the backing store
 * is now durable when the daemon provides a MemoryBackend. Records survive
 * daemon restarts, carry runtime linkage for delegated/verifier work, and can
 * expose canonical wait/output retrieval without relying on assistant prose.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import type { MemoryBackend, DurabilityLevel } from "../../memory/types.js";
import type {
  DelegatedRuntimeResult,
  RuntimeExecutionLocation,
  RuntimeVerifierVerdict,
} from "../../runtime-contract/types.js";
import { silentLogger, type Logger } from "../../utils/logger.js";
import {
  normalizeRequestTaskRuntimeMetadata,
} from "../../workflow/request-task-runtime.js";

const SESSION_TASK_LIST_KEY_PREFIX = "session_task_list:";
const TASK_LIST_KEY_PREFIX = "runtime_task_list:";
const TASK_OUTPUT_SCHEMA_VERSION = 1;
const SESSION_TASK_LIST_SCHEMA_VERSION = 1;
const TASK_LIST_SCHEMA_VERSION = 2;
const SESSION_TASK_LIST_DIRNAME = "session-task-lists";
const TASK_OUTPUT_DIRNAME = "runtime-task-outputs";
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_POLL_MS = 100;
const DEFAULT_OUTPUT_MAX_BYTES = 64 * 1024;
const MAX_OUTPUT_MAX_BYTES = 512 * 1024;

/**
 * Magic arg key used by the gateway to thread the current session id
 * into task tools.
 */
export const TASK_LIST_ARG = "__agencTaskListId";
export const TASK_ACTOR_KIND_ARG = "__agencTaskActorKind";
export const TASK_ACTOR_NAME_ARG = "__agencTaskActorName";

/**
 * Default task list id used when the gateway has not injected a
 * session id.
 */
export const DEFAULT_TASK_LIST_ID = "default";

/**
 * Tool names that should receive the injected session task-list id.
 */
export const TASK_TRACKER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "task.create",
  "task.list",
  "task.get",
  "task.update",
]);

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "deleted";

export type TaskKind =
  | "manual"
  | "worker_assignment"
  | "subagent"
  | "verifier"
  | "background_run"
  | "remote_job"
  | "remote_session";

export type TaskEventType =
  | "created"
  | "started"
  | "ref_attached"
  | "updated"
  | "output_ready"
  | "completed"
  | "failed"
  | "cancelled"
  | "deleted";

export interface TaskExternalRef {
  readonly kind: Exclude<TaskKind, "manual" | "worker_assignment">;
  readonly id: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly label?: string;
}

export interface TaskOutputRef {
  readonly path: string;
  readonly sizeBytes: number;
  readonly updatedAt: number;
}

export interface TaskEventRecord {
  readonly id: string;
  readonly type: TaskEventType;
  readonly summary: string;
  readonly timestamp: number;
  readonly data?: Record<string, unknown>;
}

export interface Task {
  readonly id: string;
  readonly kind: TaskKind;
  readonly ownerSessionId: string;
  readonly parentTaskId?: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
  summary?: string;
  externalRef?: TaskExternalRef;
  outputRef?: TaskOutputRef;
  outputReady?: boolean;
  usage?: Record<string, unknown>;
  verifierVerdict?: RuntimeVerifierVerdict;
  ownedArtifacts?: string[];
  workingDirectory?: string;
  isolation?: string;
  executionLocation?: RuntimeExecutionLocation;
  events: TaskEventRecord[];
  readonly createdAt: number;
  updatedAt: number;
}

export interface TaskCreateInput {
  readonly subject: string;
  readonly description: string;
  readonly activeForm?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SessionTask {
  readonly id: string;
  subject: string;
  description: string;
  status: PublicTaskStatus | "deleted";
  activeForm?: string;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
  readonly createdAt: number;
  updatedAt: number;
}

export interface TaskUpdatePatch {
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string | null;
  metadata?: Record<string, unknown>;
  addBlocks?: readonly string[];
  addBlockedBy?: readonly string[];
}

export interface RuntimeTaskCreateParams extends TaskCreateInput {
  readonly listId: string;
  readonly kind: TaskKind;
  readonly parentTaskId?: string;
  readonly owner?: string;
  readonly status?: Exclude<TaskStatus, "deleted">;
  readonly summary?: string;
  readonly externalRef?: TaskExternalRef;
  readonly usage?: Record<string, unknown>;
  readonly verifierVerdict?: RuntimeVerifierVerdict;
  readonly ownedArtifacts?: readonly string[];
  readonly workingDirectory?: string;
  readonly isolation?: string;
  readonly executionLocation?: RuntimeExecutionLocation;
}

export interface RuntimeTaskFinalizeParams {
  readonly listId: string;
  readonly taskId: string;
  readonly status: Extract<TaskStatus, "completed" | "failed" | "cancelled">;
  readonly summary: string;
  readonly output?: string;
  readonly structuredOutput?: unknown;
  readonly runtimeResult?: DelegatedRuntimeResult;
  readonly usage?: Record<string, unknown>;
  readonly verifierVerdict?: RuntimeVerifierVerdict;
  readonly ownedArtifacts?: readonly string[];
  readonly workingDirectory?: string;
  readonly isolation?: string;
  readonly externalRef?: TaskExternalRef;
  readonly executionLocation?: RuntimeExecutionLocation;
  readonly eventData?: Record<string, unknown>;
}

export interface TaskWaitOptions {
  readonly timeoutMs?: number;
  readonly until?: "terminal" | "output_ready";
}

export interface TaskOutputResult {
  readonly ready: boolean;
  readonly task: Record<string, unknown>;
  readonly summary?: string;
  readonly output?: string;
  readonly structuredOutput?: unknown;
  readonly runtimeResult?: DelegatedRuntimeResult;
  readonly usage?: Record<string, unknown>;
  readonly verifierVerdict?: RuntimeVerifierVerdict;
  readonly ownedArtifacts?: readonly string[];
  readonly workingDirectory?: string;
  readonly isolation?: string;
  readonly externalRef?: TaskExternalRef;
  readonly executionLocation?: RuntimeExecutionLocation;
  readonly outputRef?: TaskOutputRef;
  readonly events?: readonly TaskEventRecord[];
}

interface TaskOutputEnvelope {
  readonly version: number;
  readonly listId: string;
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly summary: string;
  readonly output?: string;
  readonly structuredOutput?: unknown;
  readonly runtimeResult?: DelegatedRuntimeResult;
  readonly usage?: Record<string, unknown>;
  readonly verifierVerdict?: RuntimeVerifierVerdict;
  readonly ownedArtifacts?: readonly string[];
  readonly workingDirectory?: string;
  readonly isolation?: string;
  readonly externalRef?: TaskExternalRef;
  readonly executionLocation?: RuntimeExecutionLocation;
  readonly createdAt: number;
}

interface StoredTask extends Task {
  revision: number;
}

interface StoredSessionTask extends SessionTask {
  revision: number;
}

interface SessionTaskListEntry {
  readonly version: number;
  readonly id: string;
  tasks: StoredSessionTask[];
  nextTaskId: number;
}

interface SessionTaskStoreOptions {
  readonly memoryBackend?: MemoryBackend;
  readonly persistenceRootDir?: string;
  readonly logger?: Logger;
  readonly now?: () => number;
}

interface TaskListEntry {
  readonly version: number;
  readonly id: string;
  tasks: StoredTask[];
  nextTaskId: number;
}

export interface TaskCompletionGuardResult {
  readonly outcome: "allow" | "block";
  readonly message?: string;
}

export interface RuntimeTaskLayerSnapshot {
  readonly configured: boolean;
  readonly effective: boolean;
  readonly backend: string;
  readonly durability: DurabilityLevel | "unknown";
  readonly totalTasks: number;
  readonly activeCount: number;
  readonly publicHandleCount: number;
  readonly inactiveReason?: string;
}

export interface TaskTrackerNotification {
  readonly type:
    | "task_created"
    | "task_started"
    | "task_updated"
    | "task_output_ready"
    | "task_completed"
    | "task_failed"
    | "task_cancelled";
  readonly listId: string;
  readonly taskId: string;
  readonly task: Task;
  readonly timestamp: number;
}

export interface TaskTrackerAccessNotification {
  readonly type:
    | "task_wait_started"
    | "task_wait_finished"
    | "task_output_read";
  readonly listId: string;
  readonly taskId: string;
  readonly timestamp: number;
  readonly until?: "terminal" | "output_ready";
  readonly timeoutMs?: number;
  readonly ready?: boolean;
  readonly includeEvents?: boolean;
  readonly maxBytes?: number;
  readonly task?: Task;
}

export interface TaskTrackerToolOptions {
  readonly onBeforeTaskComplete?: (params: {
    readonly listId: string;
    readonly taskId: string;
    readonly task: SessionTask;
    readonly patch: TaskUpdatePatch;
  }) => Promise<TaskCompletionGuardResult | void>;
  readonly onTaskAccessEvent?: (
    event: TaskTrackerAccessNotification,
  ) => void | Promise<void>;
  readonly resolveActingOwner?: (params: {
    readonly listId: string;
    readonly args: Record<string, unknown>;
    readonly task: SessionTask;
    readonly actorKind: "main" | "subagent";
    readonly actorName?: string;
  }) => string | undefined | Promise<string | undefined>;
}

interface TaskStoreOptions {
  readonly memoryBackend?: MemoryBackend;
  readonly persistenceRootDir?: string;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly onTaskEvent?: (event: TaskTrackerNotification) => void | Promise<void>;
}

function hashPathSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function cloneSessionTask(task: SessionTask | StoredSessionTask): SessionTask {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...(task.activeForm !== undefined ? { activeForm: task.activeForm } : {}),
    ...(task.owner !== undefined ? { owner: task.owner } : {}),
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    ...(task.metadata !== undefined ? { metadata: { ...task.metadata } } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function cloneStoredSessionTask(task: StoredSessionTask): StoredSessionTask {
  return {
    ...cloneSessionTask(task),
    revision: task.revision,
  };
}

function cloneTaskEvent(event: TaskEventRecord): TaskEventRecord {
  return {
    id: event.id,
    type: event.type,
    summary: event.summary,
    timestamp: event.timestamp,
    ...(event.data ? { data: { ...event.data } } : {}),
  };
}

function cloneExecutionLocation(
  location: RuntimeExecutionLocation,
): RuntimeExecutionLocation {
  return {
    mode: location.mode,
    ...(location.workspaceRoot !== undefined
      ? { workspaceRoot: location.workspaceRoot }
      : {}),
    ...(location.workingDirectory !== undefined
      ? { workingDirectory: location.workingDirectory }
      : {}),
    ...(location.fallbackReason !== undefined
      ? { fallbackReason: location.fallbackReason }
      : {}),
    ...(location.gitRoot !== undefined ? { gitRoot: location.gitRoot } : {}),
    ...(location.worktreePath !== undefined
      ? { worktreePath: location.worktreePath }
      : {}),
    ...(location.worktreeRef !== undefined
      ? { worktreeRef: location.worktreeRef }
      : {}),
    ...(location.lifecycle !== undefined
      ? { lifecycle: location.lifecycle }
      : {}),
    ...(location.handleId !== undefined ? { handleId: location.handleId } : {}),
    ...(location.serverName !== undefined
      ? { serverName: location.serverName }
      : {}),
    ...(location.remoteSessionId !== undefined
      ? { remoteSessionId: location.remoteSessionId }
      : {}),
    ...(location.remoteJobId !== undefined
      ? { remoteJobId: location.remoteJobId }
      : {}),
  };
}

function cloneTask(task: Task | StoredTask): Task {
  return {
    id: task.id,
    kind: task.kind,
    ownerSessionId: task.ownerSessionId,
    ...(task.parentTaskId !== undefined ? { parentTaskId: task.parentTaskId } : {}),
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...(task.activeForm !== undefined ? { activeForm: task.activeForm } : {}),
    ...(task.owner !== undefined ? { owner: task.owner } : {}),
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    ...(task.metadata !== undefined ? { metadata: { ...task.metadata } } : {}),
    ...(task.summary !== undefined ? { summary: task.summary } : {}),
    ...(task.externalRef !== undefined
      ? { externalRef: { ...task.externalRef } }
      : {}),
    ...(task.outputRef !== undefined
      ? { outputRef: { ...task.outputRef } }
      : {}),
    ...(task.outputReady !== undefined ? { outputReady: task.outputReady } : {}),
    ...(task.usage !== undefined ? { usage: { ...task.usage } } : {}),
    ...(task.verifierVerdict !== undefined
      ? { verifierVerdict: { ...task.verifierVerdict } }
      : {}),
    ...(task.ownedArtifacts !== undefined
      ? { ownedArtifacts: [...task.ownedArtifacts] }
      : {}),
    ...(task.workingDirectory !== undefined
      ? { workingDirectory: task.workingDirectory }
      : {}),
    ...(task.isolation !== undefined ? { isolation: task.isolation } : {}),
    ...(task.executionLocation !== undefined
      ? { executionLocation: cloneExecutionLocation(task.executionLocation) }
      : {}),
    events: task.events.map(cloneTaskEvent),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function cloneStoredTask(task: StoredTask): StoredTask {
  return {
    ...cloneTask(task),
    revision: task.revision,
  };
}

function isExplicitCompletionFlow(params: {
  readonly task: SessionTask;
  readonly patch: TaskUpdatePatch;
}): boolean {
  const mergedMetadata =
    params.patch.metadata !== undefined
      ? {
          ...(params.task.metadata ?? {}),
          ...params.patch.metadata,
        }
      : params.task.metadata;
  return normalizeRequestTaskRuntimeMetadata(mergedMetadata).verification;
}

function cloneTaskList(list: TaskListEntry): TaskListEntry {
  return {
    version: list.version,
    id: list.id,
    nextTaskId: list.nextTaskId,
    tasks: list.tasks.map(cloneStoredTask),
  };
}

function cloneSessionTaskList(list: SessionTaskListEntry): SessionTaskListEntry {
  return {
    version: list.version,
    id: list.id,
    nextTaskId: list.nextTaskId,
    tasks: list.tasks.map(cloneStoredSessionTask),
  };
}

function createEmptyTaskList(listId: string): TaskListEntry {
  return {
    version: TASK_LIST_SCHEMA_VERSION,
    id: listId,
    tasks: [],
    nextTaskId: 1,
  };
}

function createEmptySessionTaskList(listId: string): SessionTaskListEntry {
  return {
    version: SESSION_TASK_LIST_SCHEMA_VERSION,
    id: listId,
    tasks: [],
    nextTaskId: 1,
  };
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "deleted"
  );
}

function asPlainObject(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function resolveListId(args: Record<string, unknown>): string {
  const value = args[TASK_LIST_ARG];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return DEFAULT_TASK_LIST_ID;
}

function resolveTaskActor(
  args: Record<string, unknown>,
): { readonly kind: "main" | "subagent"; readonly name?: string } {
  const kind = args[TASK_ACTOR_KIND_ARG] === "subagent" ? "subagent" : "main";
  const name = asNonEmptyString(args[TASK_ACTOR_NAME_ARG]);
  return name ? { kind, name } : { kind };
}

function shouldEmitVerificationNudge(params: {
  readonly tasks: readonly SessionTask[];
  readonly actorKind: "main" | "subagent";
}): boolean {
  if (params.actorKind !== "main" || params.tasks.length < 3) {
    return false;
  }
  if (!params.tasks.every((task) => task.status === "completed")) {
    return false;
  }
  return !params.tasks.some((task) => {
    const runtimeMetadata = normalizeRequestTaskRuntimeMetadata(task.metadata);
    return runtimeMetadata.verification || /verif/i.test(task.subject);
  });
}

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function okResult(data: unknown): ToolResult {
  return { content: safeStringify(data) };
}

type PublicTaskStatus = "pending" | "in_progress" | "completed";

function isPublicTaskStatus(status: TaskStatus): status is PublicTaskStatus {
  return (
    status === "pending" ||
    status === "in_progress" ||
    status === "completed"
  );
}

function isPublicSessionTask(task: SessionTask): boolean {
  return isPublicTaskStatus(task.status) && task.metadata?._internal !== true;
}

function summarizePublicTask(task: SessionTask): Record<string, unknown> {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    ...(task.owner !== undefined ? { owner: task.owner } : {}),
    blockedBy: task.blockedBy,
  };
}

function detailPublicTask(task: SessionTask): Record<string, unknown> {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blocks: task.blocks,
    blockedBy: task.blockedBy,
  };
}

function fullTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    kind: task.kind,
    ownerSessionId: task.ownerSessionId,
    ...(task.parentTaskId !== undefined ? { parentTaskId: task.parentTaskId } : {}),
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...(task.activeForm !== undefined ? { activeForm: task.activeForm } : {}),
    ...(task.owner !== undefined ? { owner: task.owner } : {}),
    blocks: task.blocks,
    blockedBy: task.blockedBy,
    ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
    ...(task.summary !== undefined ? { summary: task.summary } : {}),
    ...(task.externalRef !== undefined ? { externalRef: task.externalRef } : {}),
    ...(task.outputRef !== undefined ? { outputRef: task.outputRef } : {}),
    ...(task.outputReady !== undefined ? { outputReady: task.outputReady } : {}),
    ...(task.usage !== undefined ? { usage: task.usage } : {}),
    ...(task.verifierVerdict !== undefined
      ? { verifierVerdict: task.verifierVerdict }
      : {}),
    ...(task.ownedArtifacts !== undefined
      ? { ownedArtifacts: task.ownedArtifacts }
      : {}),
    ...(task.workingDirectory !== undefined
      ? { workingDirectory: task.workingDirectory }
      : {}),
    ...(task.isolation !== undefined ? { isolation: task.isolation } : {}),
    ...(task.executionLocation !== undefined
      ? { executionLocation: task.executionLocation }
      : {}),
    events: task.events,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function taskRuntime(task: Task): Record<string, unknown> {
  return {
    fullTask: fullTask(task),
    runtimeMetadata: normalizeRequestTaskRuntimeMetadata(task.metadata),
  };
}

function coerceTaskEvent(value: unknown): TaskEventRecord | undefined {
  const raw = asPlainObject(value);
  const id = asNonEmptyString(raw?.id);
  const type = asNonEmptyString(raw?.type) as TaskEventType | undefined;
  const summary = asNonEmptyString(raw?.summary);
  const timestamp =
    typeof raw?.timestamp === "number" && Number.isFinite(raw.timestamp)
      ? raw.timestamp
      : undefined;
  if (!id || !type || !summary || timestamp === undefined) {
    return undefined;
  }
  return {
    id,
    type,
    summary,
    timestamp,
    ...(asPlainObject(raw?.data) ? { data: asPlainObject(raw?.data) } : {}),
  };
}

function coerceExternalRef(value: unknown): TaskExternalRef | undefined {
  const raw = asPlainObject(value);
  const kind = asNonEmptyString(raw?.kind) as TaskExternalRef["kind"] | undefined;
  const id = asNonEmptyString(raw?.id);
  if (!kind || !id) {
    return undefined;
  }
  return {
    kind,
    id,
    ...(asNonEmptyString(raw?.sessionId)
      ? { sessionId: asNonEmptyString(raw?.sessionId) }
      : {}),
    ...(asNonEmptyString(raw?.runId)
      ? { runId: asNonEmptyString(raw?.runId) }
      : {}),
    ...(asNonEmptyString(raw?.label)
      ? { label: asNonEmptyString(raw?.label) }
      : {}),
  };
}

function coerceOutputRef(value: unknown): TaskOutputRef | undefined {
  const raw = asPlainObject(value);
  const path = asNonEmptyString(raw?.path);
  const sizeBytes =
    typeof raw?.sizeBytes === "number" && Number.isFinite(raw.sizeBytes)
      ? raw.sizeBytes
      : undefined;
  const updatedAt =
    typeof raw?.updatedAt === "number" && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : undefined;
  if (!path || sizeBytes === undefined || updatedAt === undefined) {
    return undefined;
  }
  return { path, sizeBytes, updatedAt };
}

function coerceExecutionLocation(
  value: unknown,
): RuntimeExecutionLocation | undefined {
  const raw = asPlainObject(value);
  const mode =
    raw?.mode === "local" ||
      raw?.mode === "worktree" ||
      raw?.mode === "remote_session" ||
      raw?.mode === "remote_job"
      ? raw.mode
      : undefined;
  if (!raw || !mode) {
    return undefined;
  }
  const lifecycle =
    raw.lifecycle === "active" ||
      raw.lifecycle === "removed" ||
      raw.lifecycle === "retained_dirty"
      ? raw.lifecycle
      : undefined;
  return {
    mode,
    ...(typeof raw.workspaceRoot === "string"
      ? { workspaceRoot: raw.workspaceRoot }
      : {}),
    ...(typeof raw.workingDirectory === "string"
      ? { workingDirectory: raw.workingDirectory }
      : {}),
    ...(typeof raw.fallbackReason === "string"
      ? { fallbackReason: raw.fallbackReason }
      : {}),
    ...(typeof raw.gitRoot === "string" ? { gitRoot: raw.gitRoot } : {}),
    ...(typeof raw.worktreePath === "string"
      ? { worktreePath: raw.worktreePath }
      : {}),
    ...(typeof raw.worktreeRef === "string"
      ? { worktreeRef: raw.worktreeRef }
      : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(typeof raw.handleId === "string" ? { handleId: raw.handleId } : {}),
    ...(typeof raw.serverName === "string"
      ? { serverName: raw.serverName }
      : {}),
    ...(typeof raw.remoteSessionId === "string"
      ? { remoteSessionId: raw.remoteSessionId }
      : {}),
    ...(typeof raw.remoteJobId === "string"
      ? { remoteJobId: raw.remoteJobId }
      : {}),
  };
}

function coerceStoredTask(value: unknown, ownerSessionId: string): StoredTask | undefined {
  const raw = asPlainObject(value);
  if (!raw) {
    return undefined;
  }
  const id = asNonEmptyString(raw.id);
  const kind = asNonEmptyString(raw.kind) as TaskKind | undefined;
  const subject = asNonEmptyString(raw.subject);
  const description = asNonEmptyString(raw.description);
  const status = raw.status;
  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : undefined;
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : undefined;
  const revision =
    typeof raw.revision === "number" && Number.isInteger(raw.revision)
      ? raw.revision
      : 1;
  if (
    !id ||
    !kind ||
    !subject ||
    !description ||
    !isTaskStatus(status) ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return undefined;
  }
  return {
    id,
    kind,
    ownerSessionId:
      asNonEmptyString(raw.ownerSessionId) ?? ownerSessionId,
    ...(asNonEmptyString(raw.parentTaskId)
      ? { parentTaskId: asNonEmptyString(raw.parentTaskId) }
      : {}),
    subject,
    description,
    status,
    ...(typeof raw.activeForm === "string" ? { activeForm: raw.activeForm } : {}),
    ...(typeof raw.owner === "string" ? { owner: raw.owner } : {}),
    blocks: Array.isArray(raw.blocks)
      ? raw.blocks.filter((entry): entry is string => typeof entry === "string")
      : [],
    blockedBy: Array.isArray(raw.blockedBy)
      ? raw.blockedBy.filter((entry): entry is string => typeof entry === "string")
      : [],
    ...(asPlainObject(raw.metadata) ? { metadata: asPlainObject(raw.metadata) } : {}),
    ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
    ...(coerceExternalRef(raw.externalRef)
      ? { externalRef: coerceExternalRef(raw.externalRef) }
      : {}),
    ...(coerceOutputRef(raw.outputRef)
      ? { outputRef: coerceOutputRef(raw.outputRef) }
      : {}),
    ...(typeof raw.outputReady === "boolean" ? { outputReady: raw.outputReady } : {}),
    ...(asPlainObject(raw.usage) ? { usage: asPlainObject(raw.usage) } : {}),
    ...(asPlainObject(raw.verifierVerdict)
      ? {
          verifierVerdict:
            raw.verifierVerdict as RuntimeVerifierVerdict,
        }
      : {}),
    ...(Array.isArray(raw.ownedArtifacts)
      ? {
          ownedArtifacts: raw.ownedArtifacts.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    ...(typeof raw.workingDirectory === "string"
      ? { workingDirectory: raw.workingDirectory }
      : {}),
    ...(typeof raw.isolation === "string" ? { isolation: raw.isolation } : {}),
    ...(coerceExecutionLocation(raw.executionLocation)
      ? { executionLocation: coerceExecutionLocation(raw.executionLocation) }
      : {}),
    events: Array.isArray(raw.events)
      ? raw.events
          .map(coerceTaskEvent)
          .filter((entry): entry is TaskEventRecord => entry !== undefined)
      : [],
    createdAt,
    updatedAt,
    revision,
  };
}

function coerceTaskListEntry(value: unknown, listId: string): TaskListEntry | undefined {
  const raw = asPlainObject(value);
  if (!raw) {
    return createEmptyTaskList(listId);
  }
  const id = asNonEmptyString(raw.id) ?? listId;
  const nextTaskId =
    typeof raw.nextTaskId === "number" && Number.isInteger(raw.nextTaskId)
      ? raw.nextTaskId
      : 1;
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks
        .map((entry) => coerceStoredTask(entry, id))
        .filter((entry): entry is StoredTask => entry !== undefined)
    : [];
  return {
    version: TASK_LIST_SCHEMA_VERSION,
    id,
    tasks,
    nextTaskId: Math.max(nextTaskId, 1),
  };
}

function coerceStoredSessionTask(
  value: unknown,
): StoredSessionTask | undefined {
  const raw = asPlainObject(value);
  if (!raw) {
    return undefined;
  }
  const id = asNonEmptyString(raw.id);
  const subject = asNonEmptyString(raw.subject);
  const description = asNonEmptyString(raw.description);
  const status =
    raw.status === "pending" ||
    raw.status === "in_progress" ||
    raw.status === "completed" ||
    raw.status === "deleted"
      ? raw.status
      : undefined;
  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : undefined;
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : undefined;
  const revision =
    typeof raw.revision === "number" && Number.isInteger(raw.revision)
      ? raw.revision
      : 1;
  if (!id || !subject || !description || !status || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  return {
    id,
    subject,
    description,
    status,
    ...(typeof raw.activeForm === "string" ? { activeForm: raw.activeForm } : {}),
    ...(typeof raw.owner === "string" ? { owner: raw.owner } : {}),
    blocks: Array.isArray(raw.blocks)
      ? raw.blocks.filter((entry): entry is string => typeof entry === "string")
      : [],
    blockedBy: Array.isArray(raw.blockedBy)
      ? raw.blockedBy.filter((entry): entry is string => typeof entry === "string")
      : [],
    ...(asPlainObject(raw.metadata) ? { metadata: asPlainObject(raw.metadata) } : {}),
    createdAt,
    updatedAt,
    revision,
  };
}

function coerceSessionTaskListEntry(
  value: unknown,
  listId: string,
): SessionTaskListEntry | undefined {
  const raw = asPlainObject(value);
  if (!raw) {
    return createEmptySessionTaskList(listId);
  }
  const id = asNonEmptyString(raw.id) ?? listId;
  const nextTaskId =
    typeof raw.nextTaskId === "number" && Number.isInteger(raw.nextTaskId)
      ? raw.nextTaskId
      : 1;
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks
        .map((entry) => coerceStoredSessionTask(entry))
        .filter((entry): entry is StoredSessionTask => entry !== undefined)
    : [];
  return {
    version: SESSION_TASK_LIST_SCHEMA_VERSION,
    id,
    tasks,
    nextTaskId: Math.max(nextTaskId, 1),
  };
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "deleted"
  );
}

function terminalEventTypeForStatus(
  status: Extract<TaskStatus, "completed" | "failed" | "cancelled">,
): Extract<TaskEventType, "completed" | "failed" | "cancelled"> {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "completed";
}

function coerceTaskOutputEnvelope(value: unknown): TaskOutputEnvelope | undefined {
  const raw = asPlainObject(value);
  if (!raw) {
    return undefined;
  }
  const version =
    typeof raw.version === "number" && Number.isInteger(raw.version)
      ? raw.version
      : undefined;
  const listId = asNonEmptyString(raw.listId);
  const taskId = asNonEmptyString(raw.taskId);
  const status = raw.status;
  const summary = asNonEmptyString(raw.summary);
  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : undefined;
  if (
    version !== TASK_OUTPUT_SCHEMA_VERSION ||
    !listId ||
    !taskId ||
    !isTaskStatus(status) ||
    !summary ||
    createdAt === undefined
  ) {
    return undefined;
  }
  return {
    version,
    listId,
    taskId,
    status,
    summary,
    ...(typeof raw.output === "string" ? { output: raw.output } : {}),
    ...(raw.structuredOutput !== undefined
      ? { structuredOutput: raw.structuredOutput }
      : {}),
    ...(asPlainObject(raw.runtimeResult)
      ? { runtimeResult: raw.runtimeResult as DelegatedRuntimeResult }
      : {}),
    ...(asPlainObject(raw.usage) ? { usage: asPlainObject(raw.usage) } : {}),
    ...(asPlainObject(raw.verifierVerdict)
      ? { verifierVerdict: raw.verifierVerdict as RuntimeVerifierVerdict }
      : {}),
    ...(Array.isArray(raw.ownedArtifacts)
      ? {
          ownedArtifacts: raw.ownedArtifacts.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    ...(typeof raw.workingDirectory === "string"
      ? { workingDirectory: raw.workingDirectory }
      : {}),
    ...(typeof raw.isolation === "string" ? { isolation: raw.isolation } : {}),
    ...(coerceExternalRef(raw.externalRef)
      ? { externalRef: coerceExternalRef(raw.externalRef) }
      : {}),
    ...(coerceExecutionLocation(raw.executionLocation)
      ? { executionLocation: coerceExecutionLocation(raw.executionLocation) }
      : {}),
    createdAt,
  };
}

export class SessionTaskStore {
  private readonly memoryBackend?: MemoryBackend;
  private readonly persistenceRootDir?: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly lists = new Map<string, SessionTaskListEntry>();
  private readonly loadedLists = new Set<string>();
  private readonly queue = new Map<string, Promise<void>>();

  constructor(options?: SessionTaskStoreOptions) {
    this.memoryBackend = options?.memoryBackend;
    this.persistenceRootDir = options?.persistenceRootDir
      ? resolve(options.persistenceRootDir, SESSION_TASK_LIST_DIRNAME)
      : undefined;
    this.logger = options?.logger ?? silentLogger;
    this.now = options?.now ?? (() => Date.now());
  }

  private listKey(listId: string): string {
    return `${SESSION_TASK_LIST_KEY_PREFIX}${listId}`;
  }

  private async runExclusive<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queue.get(key) ?? Promise.resolve();
    let release!: () => void;
    const barrier = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const chain = previous.catch(() => undefined).then(() => barrier);
    this.queue.set(key, chain);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.queue.get(key) === chain) {
        this.queue.delete(key);
      }
    }
  }

  private getOrCreateCachedList(listId: string): SessionTaskListEntry {
    let list = this.lists.get(listId);
    if (!list) {
      list = createEmptySessionTaskList(listId);
      this.lists.set(listId, list);
    }
    return list;
  }

  private listDirFor(listId: string): string | undefined {
    if (!this.persistenceRootDir) return undefined;
    return join(this.persistenceRootDir, hashPathSegment(listId));
  }

  private listPathFor(listId: string): string | undefined {
    const dir = this.listDirFor(listId);
    return dir ? join(dir, "tasks.json") : undefined;
  }

  private async loadPersistedList(
    listId: string,
  ): Promise<SessionTaskListEntry | undefined> {
    const listPath = this.listPathFor(listId);
    if (!listPath) return undefined;
    try {
      const payload = await readFile(listPath, "utf8");
      return (
        coerceSessionTaskListEntry(JSON.parse(payload), listId) ??
        createEmptySessionTaskList(listId)
      );
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code === "ENOENT") {
        return undefined;
      }
      this.logger.debug?.("Failed to load persisted session task list", {
        listId,
        path: listPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async ensureListLoaded(listId: string): Promise<SessionTaskListEntry> {
    if (this.loadedLists.has(listId) || !this.memoryBackend) {
      if (this.loadedLists.has(listId)) {
        return this.getOrCreateCachedList(listId);
      }
      const persisted = await this.loadPersistedList(listId);
      const list = persisted ?? this.getOrCreateCachedList(listId);
      this.lists.set(listId, list);
      this.loadedLists.add(listId);
      return list;
    }
    const persisted = await this.memoryBackend.get(this.listKey(listId));
    const list =
      coerceSessionTaskListEntry(persisted, listId) ??
      (await this.loadPersistedList(listId)) ??
      createEmptySessionTaskList(listId);
    this.lists.set(listId, list);
    this.loadedLists.add(listId);
    return list;
  }

  private async persistList(list: SessionTaskListEntry): Promise<void> {
    if (!this.memoryBackend) {
      await this.persistListToDisk(list);
      return;
    }
    await this.memoryBackend.set(this.listKey(list.id), cloneSessionTaskList(list));
    await this.persistListToDisk(list);
  }

  private async persistListToDisk(list: SessionTaskListEntry): Promise<void> {
    const listPath = this.listPathFor(list.id);
    const listDir = this.listDirFor(list.id);
    if (!listPath || !listDir) {
      return;
    }
    await mkdir(listDir, { recursive: true });
    const payload = safeStringify(cloneSessionTaskList(list));
    const tempPath = `${listPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, listPath);
  }

  list(listId: string): SessionTask[] {
    const list = this.lists.get(listId);
    if (!list) return [];
    return list.tasks
      .filter((task) => task.status !== "deleted")
      .map(cloneSessionTask);
  }

  get(listId: string, taskId: string): SessionTask | undefined {
    const list = this.lists.get(listId);
    if (!list) return undefined;
    const task = list.tasks.find(
      (entry) => entry.id === taskId && entry.status !== "deleted",
    );
    return task ? cloneSessionTask(task) : undefined;
  }

  readState(
    listId: string,
    taskId: string,
  ): { readonly task: SessionTask; readonly revision: number } | undefined {
    const list = this.lists.get(listId);
    if (!list) return undefined;
    const task = list.tasks.find(
      (entry) => entry.id === taskId && entry.status !== "deleted",
    );
    if (!task) return undefined;
    return {
      task: cloneSessionTask(task),
      revision: task.revision,
    };
  }

  async createTask(listId: string, input: TaskCreateInput): Promise<SessionTask> {
    return this.runExclusive(listId, async () => {
      const list = await this.ensureListLoaded(listId);
      const id = String(list.nextTaskId);
      list.nextTaskId += 1;
      const now = this.now();
      const task: StoredSessionTask = {
        id,
        subject: input.subject,
        description: input.description,
        status: "pending",
        ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
        blocks: [],
        blockedBy: [],
        ...(input.metadata !== undefined ? { metadata: { ...input.metadata } } : {}),
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      list.tasks.push(task);
      await this.persistList(list);
      return cloneSessionTask(task);
    });
  }

  async listTasks(listId: string): Promise<SessionTask[]> {
    await this.ensureListLoaded(listId);
    return this.list(listId);
  }

  async getTask(listId: string, taskId: string): Promise<SessionTask | undefined> {
    await this.ensureListLoaded(listId);
    return this.get(listId, taskId);
  }

  async readTaskState(
    listId: string,
    taskId: string,
  ): Promise<{ readonly task: SessionTask; readonly revision: number } | undefined> {
    await this.ensureListLoaded(listId);
    return this.readState(listId, taskId);
  }

  async updateTask(
    listId: string,
    taskId: string,
    patch: Pick<
      TaskUpdatePatch,
      | "status"
      | "subject"
      | "description"
      | "activeForm"
      | "owner"
      | "metadata"
      | "addBlocks"
      | "addBlockedBy"
    >,
    expectedRevision?: number,
  ): Promise<SessionTask | undefined> {
    return this.runExclusive(listId, async () => {
      const list = await this.ensureListLoaded(listId);
      const task = list.tasks.find((entry) => entry.id === taskId);
      if (!task || task.status === "deleted") {
        return undefined;
      }
      if (
        expectedRevision !== undefined &&
        task.revision !== expectedRevision
      ) {
        return undefined;
      }
      if (
        patch.status !== undefined &&
        patch.status !== "pending" &&
        patch.status !== "in_progress" &&
        patch.status !== "completed" &&
        patch.status !== "deleted"
      ) {
        return undefined;
      }
      if (patch.status !== undefined) task.status = patch.status;
      if (patch.subject !== undefined) task.subject = patch.subject;
      if (patch.description !== undefined) task.description = patch.description;
      if (patch.activeForm !== undefined) task.activeForm = patch.activeForm;
      if (patch.owner !== undefined) {
        if (patch.owner === null) {
          delete task.owner;
        } else {
          task.owner = patch.owner;
        }
      }
      if (patch.metadata !== undefined) {
        const merged: Record<string, unknown> = { ...(task.metadata ?? {}) };
        for (const [key, value] of Object.entries(patch.metadata)) {
          if (value === null) {
            delete merged[key];
          } else {
            merged[key] = value;
          }
        }
        task.metadata = Object.keys(merged).length > 0 ? merged : undefined;
      }
      if (patch.addBlocks && patch.addBlocks.length > 0) {
        task.blocks = Array.from(new Set([...task.blocks, ...patch.addBlocks]));
      }
      if (patch.addBlockedBy && patch.addBlockedBy.length > 0) {
        task.blockedBy = Array.from(new Set([...task.blockedBy, ...patch.addBlockedBy]));
      }
      task.updatedAt = this.now();
      task.revision += 1;
      await this.persistList(list);
      return cloneSessionTask(task);
    });
  }

  dropList(listId: string): boolean {
    const hadCached = this.lists.delete(listId);
    this.loadedLists.delete(listId);
    return hadCached;
  }

  reset(): void {
    this.lists.clear();
    this.loadedLists.clear();
    this.queue.clear();
  }
}

/**
 * Durable task store keyed by session-scoped list id.
 *
 * The public tool family still scopes list/get/list operations by session id,
 * but runtime-managed tasks now survive daemon restarts when a MemoryBackend is
 * provided. Direct store methods remain cache-backed and synchronous for local
 * tests; the tool surface and runtime integration use the async methods.
 */
export class TaskStore {
  private readonly memoryBackend?: MemoryBackend;
  private readonly outputRootDir: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly onTaskEvent?: TaskStoreOptions["onTaskEvent"];
  private readonly lists = new Map<string, TaskListEntry>();
  private readonly loadedLists = new Set<string>();
  private readonly queue = new Map<string, Promise<void>>();

  constructor(options?: TaskStoreOptions) {
    this.memoryBackend = options?.memoryBackend;
    this.outputRootDir = resolve(
      options?.persistenceRootDir ?? "/tmp/agenc-runtime",
      TASK_OUTPUT_DIRNAME,
    );
    this.logger = options?.logger ?? silentLogger;
    this.now = options?.now ?? (() => Date.now());
    this.onTaskEvent = options?.onTaskEvent;
  }

  private listKey(listId: string): string {
    return `${TASK_LIST_KEY_PREFIX}${listId}`;
  }

  private outputDirFor(listId: string, taskId: string): string {
    return join(this.outputRootDir, hashPathSegment(listId), taskId);
  }

  private outputPathFor(listId: string, taskId: string): string {
    return join(this.outputDirFor(listId, taskId), "output.json");
  }

  getTaskOutputPath(listId: string, taskId: string): string {
    return this.outputPathFor(listId, taskId);
  }

  private async runExclusive<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queue.get(key) ?? Promise.resolve();
    let release!: () => void;
    const barrier = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const chain = previous.catch(() => undefined).then(() => barrier);
    this.queue.set(key, chain);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.queue.get(key) === chain) {
        this.queue.delete(key);
      }
    }
  }

  private getOrCreateCachedList(listId: string): TaskListEntry {
    let list = this.lists.get(listId);
    if (!list) {
      list = createEmptyTaskList(listId);
      this.lists.set(listId, list);
    }
    return list;
  }

  private async ensureListLoaded(listId: string): Promise<TaskListEntry> {
    if (this.loadedLists.has(listId) || !this.memoryBackend) {
      return this.getOrCreateCachedList(listId);
    }
    const persisted = await this.memoryBackend.get(this.listKey(listId));
    const list = coerceTaskListEntry(persisted, listId) ?? createEmptyTaskList(listId);
    this.lists.set(listId, list);
    this.loadedLists.add(listId);
    return list;
  }

  private async persistList(list: TaskListEntry): Promise<void> {
    if (!this.memoryBackend) {
      return;
    }
    await this.memoryBackend.set(this.listKey(list.id), cloneTaskList(list));
  }

  private buildEvent(
    type: TaskEventType,
    summary: string,
    data?: Record<string, unknown>,
  ): TaskEventRecord {
    const timestamp = this.now();
    return {
      id: `${timestamp.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      summary,
      timestamp,
      ...(data ? { data: { ...data } } : {}),
    };
  }

  private async emitTaskEvent(
    type: TaskTrackerNotification["type"],
    listId: string,
    task: Task,
  ): Promise<void> {
    try {
      await this.onTaskEvent?.({
        type,
        listId,
        taskId: task.id,
        task,
        timestamp: this.now(),
      });
    } catch (error) {
      this.logger.debug("Task event listener failed", {
        listId,
        taskId: task.id,
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private mutateTaskInList(
    list: TaskListEntry,
    taskId: string,
    mutate: (task: StoredTask) => void,
  ): StoredTask | undefined {
    const task = list.tasks.find((entry) => entry.id === taskId);
    if (!task || task.status === "deleted") {
      return undefined;
    }
    mutate(task);
    task.updatedAt = this.now();
    task.revision += 1;
    return task;
  }

  private async writeOutputFile(
    listId: string,
    taskId: string,
    payload: TaskOutputEnvelope,
  ): Promise<TaskOutputRef> {
    const dir = this.outputDirFor(listId, taskId);
    await mkdir(dir, { recursive: true });
    const finalPath = this.outputPathFor(listId, taskId);
    const tempPath = join(
      dir,
      `output.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    const serialized = JSON.stringify(payload, null, 2);
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, finalPath);
    return {
      path: finalPath,
      sizeBytes: Buffer.byteLength(serialized, "utf8"),
      updatedAt: this.now(),
    };
  }

  list(listId: string, filter?: { readonly status?: TaskStatus }): Task[] {
    const list = this.lists.get(listId);
    if (!list) return [];
    const visible = list.tasks.filter((entry) => entry.status !== "deleted");
    const filtered =
      filter?.status !== undefined
        ? visible.filter((entry) => entry.status === filter.status)
        : visible;
    return filtered.map(cloneTask);
  }

  get(listId: string, taskId: string): Task | undefined {
    const list = this.lists.get(listId);
    if (!list) return undefined;
    const task = list.tasks.find(
      (entry) => entry.id === taskId && entry.status !== "deleted",
    );
    return task ? cloneTask(task) : undefined;
  }

  readState(
    listId: string,
    taskId: string,
  ): { readonly task: Task; readonly revision: number } | undefined {
    const list = this.lists.get(listId);
    if (!list) return undefined;
    const task = list.tasks.find(
      (entry) => entry.id === taskId && entry.status !== "deleted",
    );
    if (!task) return undefined;
    return {
      task: cloneTask(task),
      revision: task.revision,
    };
  }

  update(
    listId: string,
    taskId: string,
    patch: TaskUpdatePatch,
    expectedRevision?: number,
  ): Task | undefined {
    const list = this.lists.get(listId);
    if (!list) return undefined;
    const task = list.tasks.find((entry) => entry.id === taskId);
    if (!task || task.status === "deleted") return undefined;
    if (
      expectedRevision !== undefined &&
      task.revision !== expectedRevision
    ) {
      return undefined;
    }
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.subject !== undefined) task.subject = patch.subject;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.activeForm !== undefined) task.activeForm = patch.activeForm;
    if (patch.owner !== undefined) {
      if (patch.owner === null) {
        delete task.owner;
      } else {
        task.owner = patch.owner;
      }
    }
    if (patch.metadata !== undefined) {
      const merged: Record<string, unknown> = { ...(task.metadata ?? {}) };
      for (const [key, value] of Object.entries(patch.metadata)) {
        if (value === null) {
          delete merged[key];
        } else {
          merged[key] = value;
        }
      }
      task.metadata = Object.keys(merged).length > 0 ? merged : undefined;
    }
    if (patch.addBlocks && patch.addBlocks.length > 0) {
      task.blocks = Array.from(new Set([...task.blocks, ...patch.addBlocks]));
    }
    if (patch.addBlockedBy && patch.addBlockedBy.length > 0) {
      task.blockedBy = Array.from(new Set([...task.blockedBy, ...patch.addBlockedBy]));
    }
    task.updatedAt = this.now();
    task.revision += 1;
    task.events.push(
      this.buildEvent("updated", `Task updated: ${task.subject}`),
    );
    return cloneTask(task);
  }

  dropList(listId: string): boolean {
    const hadCached = this.lists.delete(listId);
    this.loadedLists.delete(listId);
    return hadCached;
  }

  reset(): void {
    this.lists.clear();
    this.loadedLists.clear();
    this.queue.clear();
  }

  async createTask(listId: string, input: TaskCreateInput): Promise<Task> {
    return this.runExclusive(listId, async () => {
      const list = await this.ensureListLoaded(listId);
      const id = String(list.nextTaskId);
      list.nextTaskId += 1;
      const now = this.now();
      const task: StoredTask = {
        id,
        kind: "manual",
        ownerSessionId: listId,
        subject: input.subject,
        description: input.description,
        status: "pending",
        ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
        blocks: [],
        blockedBy: [],
        ...(input.metadata !== undefined ? { metadata: { ...input.metadata } } : {}),
        events: [
          this.buildEvent("created", `Task created: ${input.subject}`),
        ],
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      list.tasks.push(task);
      await this.persistList(list);
      return cloneTask(task);
    });
  }

  async listTasks(
    listId: string,
    filter?: { readonly status?: TaskStatus },
  ): Promise<Task[]> {
    await this.ensureListLoaded(listId);
    return this.list(listId, filter);
  }

  async getTask(listId: string, taskId: string): Promise<Task | undefined> {
    await this.ensureListLoaded(listId);
    return this.get(listId, taskId);
  }

  async readTaskState(
    listId: string,
    taskId: string,
  ): Promise<{ readonly task: Task; readonly revision: number } | undefined> {
    await this.ensureListLoaded(listId);
    return this.readState(listId, taskId);
  }

  async updateTask(
    listId: string,
    taskId: string,
    patch: TaskUpdatePatch,
    expectedRevision?: number,
  ): Promise<Task | undefined> {
    return this.runExclusive(listId, async () => {
      const list = await this.ensureListLoaded(listId);
      const task = list.tasks.find((entry) => entry.id === taskId);
      if (!task || task.status === "deleted") {
        return undefined;
      }
      if (
        expectedRevision !== undefined &&
        task.revision !== expectedRevision
      ) {
        return undefined;
      }
      const updated = this.update(listId, taskId, patch, expectedRevision);
      if (!updated) {
        return undefined;
      }
      const nextList = this.lists.get(listId);
      if (nextList) {
        await this.persistList(nextList);
      }
      const notificationType =
        updated.status === "completed"
          ? "task_completed"
          : updated.status === "failed"
            ? "task_failed"
            : updated.status === "cancelled"
              ? "task_cancelled"
              : updated.status === "in_progress"
                ? "task_started"
                : "task_updated";
      await this.emitTaskEvent(notificationType, listId, updated);
      return updated;
    });
  }

  async createRuntimeTask(params: RuntimeTaskCreateParams): Promise<Task> {
    return this.runExclusive(params.listId, async () => {
      const list = await this.ensureListLoaded(params.listId);
      const id = String(list.nextTaskId);
      list.nextTaskId += 1;
      const now = this.now();
      const task: StoredTask = {
        id,
        kind: params.kind,
        ownerSessionId: params.listId,
        ...(params.parentTaskId ? { parentTaskId: params.parentTaskId } : {}),
        subject: params.subject,
        description: params.description,
        status: params.status ?? "in_progress",
        ...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
        ...(params.owner !== undefined ? { owner: params.owner } : {}),
        blocks: [],
        blockedBy: [],
        ...(params.metadata !== undefined ? { metadata: { ...params.metadata } } : {}),
        ...(params.summary !== undefined ? { summary: params.summary } : {}),
        ...(params.externalRef !== undefined
          ? { externalRef: { ...params.externalRef } }
          : {}),
        ...(params.usage !== undefined ? { usage: { ...params.usage } } : {}),
        ...(params.verifierVerdict !== undefined
          ? { verifierVerdict: { ...params.verifierVerdict } }
          : {}),
        ...(params.ownedArtifacts !== undefined
          ? { ownedArtifacts: [...params.ownedArtifacts] }
          : {}),
        ...(params.workingDirectory !== undefined
          ? { workingDirectory: params.workingDirectory }
          : {}),
        ...(params.isolation !== undefined ? { isolation: params.isolation } : {}),
        ...(params.executionLocation !== undefined
          ? { executionLocation: cloneExecutionLocation(params.executionLocation) }
          : {}),
        outputReady: false,
        events: [
          this.buildEvent("created", `Task created: ${params.subject}`, {
            kind: params.kind,
          }),
          this.buildEvent(
            params.status === "pending" ? "created" : "started",
            params.summary ??
              `Task ${params.status === "pending" ? "created" : "started"}: ${params.subject}`,
            { kind: params.kind },
          ),
        ],
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      list.tasks.push(task);
      await this.persistList(list);
      const cloned = cloneTask(task);
      await this.emitTaskEvent("task_created", params.listId, cloned);
      await this.emitTaskEvent(
        task.status === "in_progress" ? "task_started" : "task_updated",
        params.listId,
        cloned,
      );
      return cloned;
    });
  }

  async attachExternalRef(
    listId: string,
    taskId: string,
    externalRef: TaskExternalRef,
    summary?: string,
  ): Promise<Task | undefined> {
    return this.runExclusive(listId, async () => {
      const list = await this.ensureListLoaded(listId);
      const task = this.mutateTaskInList(list, taskId, (entry) => {
        entry.externalRef = { ...externalRef };
        if (summary !== undefined) {
          entry.summary = summary;
        }
        entry.events.push(
          this.buildEvent("ref_attached", summary ?? "Attached runtime handle", {
            kind: externalRef.kind,
            id: externalRef.id,
          }),
        );
      });
      if (!task) return undefined;
      await this.persistList(list);
      const cloned = cloneTask(task);
      await this.emitTaskEvent("task_updated", listId, cloned);
      return cloned;
    });
  }

  async recordRuntimeProgress(params: {
    readonly listId: string;
    readonly taskId: string;
    readonly status?: Exclude<TaskStatus, "deleted">;
    readonly summary: string;
    readonly data?: Record<string, unknown>;
  }): Promise<Task | undefined> {
    return this.runExclusive(params.listId, async () => {
      const list = await this.ensureListLoaded(params.listId);
      const task = this.mutateTaskInList(list, params.taskId, (entry) => {
        if (params.status !== undefined) {
          entry.status = params.status;
        }
        entry.summary = params.summary;
        entry.events.push(
          this.buildEvent("updated", params.summary, params.data),
        );
      });
      if (!task) return undefined;
      await this.persistList(list);
      const cloned = cloneTask(task);
      await this.emitTaskEvent(
        cloned.status === "in_progress" ? "task_started" : "task_updated",
        params.listId,
        cloned,
      );
      return cloned;
    });
  }

  async claimTask(params: {
    readonly listId: string;
    readonly taskId: string;
    readonly owner: string;
    readonly summary?: string;
    readonly data?: Record<string, unknown>;
  }): Promise<Task | undefined> {
    return this.runExclusive(params.listId, async () => {
      const list = await this.ensureListLoaded(params.listId);
      const task = list.tasks.find((entry) => entry.id === params.taskId);
      if (!task || task.status === "deleted" || task.status !== "pending") {
        return undefined;
      }
      if (task.owner !== undefined || task.blockedBy.length > 0) {
        return undefined;
      }
      task.owner = params.owner;
      task.status = "in_progress";
      if (params.summary !== undefined) {
        task.summary = params.summary;
      }
      task.updatedAt = this.now();
      task.revision += 1;
      task.events.push(
        this.buildEvent(
          "started",
          params.summary ?? `Task claimed by ${params.owner}`,
          params.data,
        ),
      );
      await this.persistList(list);
      const cloned = cloneTask(task);
      await this.emitTaskEvent("task_started", params.listId, cloned);
      return cloned;
    });
  }

  async releaseTaskClaim(params: {
    readonly listId: string;
    readonly taskId: string;
    readonly owner?: string;
    readonly summary?: string;
    readonly data?: Record<string, unknown>;
  }): Promise<Task | undefined> {
    return this.runExclusive(params.listId, async () => {
      const list = await this.ensureListLoaded(params.listId);
      const task = list.tasks.find((entry) => entry.id === params.taskId);
      if (!task || task.status === "deleted" || isTerminalTaskStatus(task.status)) {
        return undefined;
      }
      if (
        params.owner !== undefined &&
        task.owner !== undefined &&
        task.owner !== params.owner
      ) {
        return undefined;
      }
      delete task.owner;
      task.status = "pending";
      if (params.summary !== undefined) {
        task.summary = params.summary;
      }
      task.updatedAt = this.now();
      task.revision += 1;
      task.events.push(
        this.buildEvent(
          "updated",
          params.summary ?? "Task claim released",
          params.data,
        ),
      );
      await this.persistList(list);
      const cloned = cloneTask(task);
      await this.emitTaskEvent("task_updated", params.listId, cloned);
      return cloned;
    });
  }

  async finalizeRuntimeTask(
    params: RuntimeTaskFinalizeParams,
  ): Promise<Task | undefined> {
    const outputRef = params.output !== undefined ||
        params.structuredOutput !== undefined ||
        params.runtimeResult !== undefined ||
        params.usage !== undefined ||
        params.verifierVerdict !== undefined ||
        params.externalRef !== undefined
      ? await this.writeOutputFile(params.listId, params.taskId, {
          version: TASK_OUTPUT_SCHEMA_VERSION,
          listId: params.listId,
          taskId: params.taskId,
          status: params.status,
          summary: params.summary,
          ...(params.output !== undefined ? { output: params.output } : {}),
          ...(params.structuredOutput !== undefined
            ? { structuredOutput: params.structuredOutput }
            : {}),
          ...(params.runtimeResult !== undefined
            ? { runtimeResult: params.runtimeResult }
            : {}),
          ...(params.usage !== undefined ? { usage: { ...params.usage } } : {}),
          ...(params.verifierVerdict !== undefined
            ? { verifierVerdict: { ...params.verifierVerdict } }
            : {}),
          ...(params.ownedArtifacts !== undefined
            ? { ownedArtifacts: [...params.ownedArtifacts] }
            : {}),
          ...(params.workingDirectory !== undefined
            ? { workingDirectory: params.workingDirectory }
            : {}),
          ...(params.isolation !== undefined ? { isolation: params.isolation } : {}),
          ...(params.externalRef !== undefined
            ? { externalRef: { ...params.externalRef } }
            : {}),
          ...(params.executionLocation !== undefined
            ? { executionLocation: cloneExecutionLocation(params.executionLocation) }
            : {}),
          createdAt: this.now(),
        })
      : undefined;

    return this.runExclusive(params.listId, async () => {
      const list = await this.ensureListLoaded(params.listId);
      const task = this.mutateTaskInList(list, params.taskId, (entry) => {
        entry.status = params.status;
        entry.summary = params.summary;
        if (params.externalRef !== undefined) {
          entry.externalRef = { ...params.externalRef };
        }
        if (outputRef) {
          entry.outputRef = outputRef;
          entry.outputReady = true;
          entry.events.push(
            this.buildEvent("output_ready", `Output ready: ${params.summary}`),
          );
        }
        if (params.usage !== undefined) {
          entry.usage = { ...params.usage };
        }
        if (params.verifierVerdict !== undefined) {
          entry.verifierVerdict = { ...params.verifierVerdict };
        }
        if (params.ownedArtifacts !== undefined) {
          entry.ownedArtifacts = [...params.ownedArtifacts];
        }
        if (params.workingDirectory !== undefined) {
          entry.workingDirectory = params.workingDirectory;
        }
        if (params.isolation !== undefined) {
          entry.isolation = params.isolation;
        }
        if (params.executionLocation !== undefined) {
          entry.executionLocation = cloneExecutionLocation(params.executionLocation);
        }
        entry.events.push(
          this.buildEvent(
            terminalEventTypeForStatus(params.status),
            params.summary,
            params.eventData,
          ),
        );
      });
      if (!task) return undefined;
      await this.persistList(list);
      const cloned = cloneTask(task);
      if (outputRef) {
        await this.emitTaskEvent("task_output_ready", params.listId, cloned);
      }
      await this.emitTaskEvent(
        params.status === "completed"
          ? "task_completed"
          : params.status === "failed"
            ? "task_failed"
            : "task_cancelled",
        params.listId,
        cloned,
      );
      return cloned;
    });
  }

  async waitForTask(
    listId: string,
    taskId: string,
    options: TaskWaitOptions = {},
  ): Promise<Task | undefined> {
    const timeoutMs = Math.max(
      0,
      Math.floor(options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    );
    const until = options.until ?? "terminal";
    const deadline = this.now() + timeoutMs;
    while (true) {
      const task = await this.getTask(listId, taskId);
      if (!task) return undefined;
      if (
        (until === "terminal" && isTerminalTaskStatus(task.status)) ||
        (until === "output_ready" && task.outputReady === true)
      ) {
        return task;
      }
      if (this.now() >= deadline) {
        return task;
      }
      await sleep(Math.min(DEFAULT_WAIT_POLL_MS, Math.max(1, deadline - this.now())));
    }
  }

  async readTaskOutput(
    listId: string,
    taskId: string,
    options?: {
      readonly includeEvents?: boolean;
      readonly maxBytes?: number;
    },
  ): Promise<TaskOutputResult | undefined> {
    const task = await this.getTask(listId, taskId);
    if (!task) {
      return undefined;
    }
    const outputRef = task.outputRef;
    let outputEnvelope: TaskOutputEnvelope | undefined;
    if (outputRef?.path) {
      try {
        const content = await readFile(outputRef.path, "utf8");
        outputEnvelope = coerceTaskOutputEnvelope(JSON.parse(content));
      } catch {
        outputEnvelope = undefined;
      }
    }
    let output = outputEnvelope?.output;
    if (typeof output === "string") {
      const maxBytes = Math.max(
        1,
        Math.min(
          MAX_OUTPUT_MAX_BYTES,
          Math.floor(options?.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES),
        ),
      );
      const outputBuffer = Buffer.from(output, "utf8");
      if (outputBuffer.byteLength > maxBytes) {
        output = outputBuffer.subarray(0, maxBytes).toString("utf8");
      }
    }
    return {
      ready: Boolean(task.outputReady),
      task: fullTask(task),
      ...(outputEnvelope?.summary ? { summary: outputEnvelope.summary } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(outputEnvelope?.structuredOutput !== undefined
        ? { structuredOutput: outputEnvelope.structuredOutput }
        : {}),
      ...(outputEnvelope?.runtimeResult !== undefined
        ? { runtimeResult: outputEnvelope.runtimeResult }
        : {}),
      ...(outputEnvelope?.usage ? { usage: outputEnvelope.usage } : {}),
      ...(outputEnvelope?.verifierVerdict
        ? { verifierVerdict: outputEnvelope.verifierVerdict }
        : {}),
      ...(outputEnvelope?.ownedArtifacts
        ? { ownedArtifacts: outputEnvelope.ownedArtifacts }
        : {}),
      ...(outputEnvelope?.workingDirectory
        ? { workingDirectory: outputEnvelope.workingDirectory }
        : {}),
      ...(outputEnvelope?.isolation
        ? { isolation: outputEnvelope.isolation }
        : {}),
      ...(outputEnvelope?.externalRef
        ? { externalRef: outputEnvelope.externalRef }
        : {}),
      ...(outputEnvelope?.executionLocation
        ? { executionLocation: outputEnvelope.executionLocation }
        : {}),
      ...(outputRef ? { outputRef } : {}),
      ...(options?.includeEvents ? { events: task.events } : {}),
    };
  }

  async taskOutput(
    listId: string,
    taskId: string,
    options?: {
      readonly block?: boolean;
      readonly timeoutMs?: number;
      readonly includeEvents?: boolean;
      readonly maxBytes?: number;
    },
  ): Promise<TaskOutputResult | undefined> {
    if (options?.block) {
      await this.waitForTask(listId, taskId, {
        timeoutMs: options.timeoutMs,
        until: "output_ready",
      });
    }
    return this.readTaskOutput(listId, taskId, {
      includeEvents: options?.includeEvents,
      maxBytes: options?.maxBytes,
    });
  }

  async repairRuntimeState(): Promise<void> {
    if (!this.memoryBackend) {
      return;
    }
    const keys = await this.memoryBackend.listKeys(TASK_LIST_KEY_PREFIX);
    for (const key of keys) {
      const listId = key.slice(TASK_LIST_KEY_PREFIX.length);
      await this.runExclusive(listId, async () => {
        const list = await this.ensureListLoaded(listId);
        let changed = false;
        for (const task of list.tasks) {
          if (
            isTerminalTaskStatus(task.status) &&
            task.outputRef === undefined
          ) {
            const candidatePath = this.outputPathFor(listId, task.id);
            try {
              const info = await stat(candidatePath);
              if (info.isFile()) {
                task.outputRef = {
                  path: candidatePath,
                  sizeBytes: info.size,
                  updatedAt: info.mtimeMs,
                };
                task.outputReady = true;
                task.updatedAt = this.now();
                task.revision += 1;
                changed = true;
              }
            } catch {
              // no-op
            }
          }
          if (
            !isTerminalTaskStatus(task.status) &&
            task.kind === "worker_assignment"
          ) {
            task.status = "pending";
            delete task.owner;
            task.summary =
              task.summary ??
              "Worker assignment was returned to the queue after runtime restart.";
            task.events.push(
              this.buildEvent(
                "updated",
                task.summary,
                { reason: "worker_runtime_unavailable_after_restart" },
              ),
            );
            task.updatedAt = this.now();
            task.revision += 1;
            changed = true;
            continue;
          }
          if (
            !isTerminalTaskStatus(task.status) &&
            (task.kind === "subagent" || task.kind === "verifier")
          ) {
            task.status = "failed";
            task.summary =
              task.summary ??
              "Task runtime became unavailable before completion.";
            task.events.push(
              this.buildEvent(
                "failed",
                task.summary,
                { reason: "runtime_unavailable_after_restart" },
              ),
            );
            task.updatedAt = this.now();
            task.revision += 1;
            changed = true;
          }
        }
        if (changed) {
          await this.persistList(list);
        }
      });
    }
  }

  async describeRuntimeTaskLayer(
    sessionId: string,
    configured: boolean,
  ): Promise<RuntimeTaskLayerSnapshot> {
    await this.ensureListLoaded(sessionId);
    const tasks = this.list(sessionId);
    const durability = this.memoryBackend?.getDurability().level ?? "unknown";
    return {
      configured,
      effective: configured && Boolean(this.memoryBackend),
      backend: this.memoryBackend?.name ?? "memory",
      durability,
      totalTasks: tasks.length,
      activeCount: tasks.filter((task) => !isTerminalTaskStatus(task.status)).length,
      publicHandleCount: tasks.filter(
        (task) =>
          task.kind !== "manual" &&
          task.status !== "deleted",
      ).length,
      ...(configured && !this.memoryBackend
        ? { inactiveReason: "memory_backend_unavailable" }
        : !configured
          ? { inactiveReason: "flag_disabled" }
          : {}),
    };
  }
}

const TASK_CREATE_DESCRIPTION = `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: What needs to be done
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- After creating tasks, use task.update to set up dependencies (blocks/blockedBy) if needed
- Check task.list first to avoid creating duplicate tasks
`;

const TASK_LIST_DESCRIPTION =
  "List tasks in the current session's task list. Returns each task's id, subject, status, " +
  "optional owner, and unresolved blockedBy ids.";

const TASK_GET_DESCRIPTION =
  "Fetch a single task by id with its description, status, blocks, and blockedBy ids. " +
  "Returns null when the task does not exist.";

const TASK_UPDATE_DESCRIPTION = `Use this tool to update a task in the task list.

## When to Use This Tool

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call task.list to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`task.get\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\`
`;

const TASK_WAIT_DESCRIPTION =
  "Wait for a task to reach a terminal state or to make output ready. Use this for async " +
  "delegation or verification work that returned only a task handle.";

const TASK_OUTPUT_DESCRIPTION =
  "Read the canonical output blob for a task handle. Optionally block until the output is " +
  "ready, include lifecycle events, and cap the returned output size.";

/**
 * Build the task tracker tools sharing a single store.
 */
export function createTaskTrackerTools(
  store?: SessionTaskStore,
  options: TaskTrackerToolOptions = {},
): Tool[] {
  const taskStore = store ?? new SessionTaskStore();

  const taskCreate: Tool = {
    name: "task.create",
    description: TASK_CREATE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description:
            "A brief, actionable title in imperative form.",
        },
        description: {
          type: "string",
          description:
            "What needs to be done. Include enough detail to act on later. Optional; when omitted, the runtime reuses the subject.",
        },
        activeForm: {
          type: "string",
          description:
            "Present continuous form shown when the task is in_progress.",
        },
        metadata: {
          type: "object",
          description: "Arbitrary metadata to attach to the task.",
        },
      },
      required: ["subject"],
    },
    async execute(args) {
      const subject = asNonEmptyString(args.subject);
      if (!subject) return errorResult("subject must be a non-empty string");
      const description = asNonEmptyString(args.description) ?? subject;
      const activeForm = asNonEmptyString(args.activeForm);
      const metadata = asPlainObject(args.metadata);

      const task = await taskStore.createTask(resolveListId(args), {
        subject,
        description,
        ...(activeForm !== undefined ? { activeForm } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      });

      return okResult({
        task: {
          id: task.id,
          subject: task.subject,
        },
      });
    },
  };

  const taskList: Tool = {
    name: "task.list",
    description: TASK_LIST_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {},
    },
    async execute(args) {
      const tasks = (await taskStore.listTasks(resolveListId(args))).filter(
        isPublicSessionTask,
      );
      const resolvedTaskIds = new Set(
        tasks.filter((task) => task.status === "completed").map((task) => task.id),
      );
      return okResult({
        tasks: tasks.map((task) => ({
          ...summarizePublicTask(task),
          blockedBy: task.blockedBy.filter((id) => !resolvedTaskIds.has(id)),
        })),
      });
    },
  };

  const taskGet: Tool = {
    name: "task.get",
    description: TASK_GET_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Task id returned by task.create or task.list.",
        },
      },
      required: ["taskId"],
    },
    async execute(args) {
      const taskId = asNonEmptyString(args.taskId);
      if (!taskId) return errorResult("taskId must be a non-empty string");
      const task = await taskStore.getTask(resolveListId(args), taskId);
      if (!task || !isPublicSessionTask(task)) {
        return okResult({
          task: null,
        });
      }
      return okResult({
        task: detailPublicTask(task),
      });
    },
  };

  const taskUpdate: Tool = {
    name: "task.update",
    description: TASK_UPDATE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Task id to update.",
        },
        status: {
          type: "string",
          enum: [
            "pending",
            "in_progress",
            "completed",
            "failed",
            "cancelled",
            "deleted",
          ],
        },
        subject: { type: "string" },
        description: { type: "string" },
        activeForm: { type: "string" },
        owner: { type: "string" },
        metadata: {
          type: "object",
          description:
            "Merged into existing metadata; values of null delete the key.",
        },
        addBlocks: {
          type: "array",
          items: { type: "string" },
          description: "Append unique task ids to the blocks array.",
        },
        addBlockedBy: {
          type: "array",
          items: { type: "string" },
          description: "Append unique task ids to the blockedBy array.",
        },
      },
      required: ["taskId"],
    },
    async execute(args) {
      const taskId = asNonEmptyString(args.taskId);
      if (!taskId) return errorResult("taskId must be a non-empty string");
      const listId = resolveListId(args);
      const actor = resolveTaskActor(args);
      const patch: TaskUpdatePatch = {};
      const updatedFields: string[] = [];

      if (args.status !== undefined) {
        if (
          args.status !== "pending" &&
          args.status !== "in_progress" &&
          args.status !== "completed" &&
          args.status !== "deleted"
        ) {
          return errorResult(
            "status must be one of: pending, in_progress, completed, deleted",
          );
        }
        patch.status = args.status;
        updatedFields.push("status");
      }
      if (args.subject !== undefined) {
        const next = asNonEmptyString(args.subject);
        if (next === undefined) return errorResult("subject must be a non-empty string");
        patch.subject = next;
        updatedFields.push("subject");
      }
      if (args.description !== undefined) {
        const next = asNonEmptyString(args.description);
        if (next === undefined) {
          return errorResult("description must be a non-empty string");
        }
        patch.description = next;
        updatedFields.push("description");
      }
      if (args.activeForm !== undefined) {
        if (typeof args.activeForm !== "string") {
          return errorResult("activeForm must be a string");
        }
        patch.activeForm = args.activeForm;
        updatedFields.push("activeForm");
      }
      if (args.owner !== undefined) {
        if (typeof args.owner !== "string") {
          return errorResult("owner must be a string");
        }
        patch.owner = args.owner;
        updatedFields.push("owner");
      }
      if (args.metadata !== undefined) {
        const metadata = asPlainObject(args.metadata);
        if (metadata === undefined) {
          return errorResult("metadata must be a plain object");
        }
        patch.metadata = metadata;
        updatedFields.push("metadata");
      }
      if (args.addBlocks !== undefined) {
        if (!Array.isArray(args.addBlocks) ||
            args.addBlocks.some((entry) => typeof entry !== "string")) {
          return errorResult("addBlocks must be an array of strings");
        }
        patch.addBlocks = args.addBlocks as string[];
        updatedFields.push("addBlocks");
      }
      if (args.addBlockedBy !== undefined) {
        if (!Array.isArray(args.addBlockedBy) ||
            args.addBlockedBy.some((entry) => typeof entry !== "string")) {
          return errorResult("addBlockedBy must be an array of strings");
        }
        patch.addBlockedBy = args.addBlockedBy as string[];
        updatedFields.push("addBlockedBy");
      }

      const current = await taskStore.readTaskState(listId, taskId);
      if (!current) {
        return okResult({
          success: false,
          taskId,
          updatedFields: [],
          error: "Task not found",
        });
      }

      if (
        patch.status === "in_progress" &&
        patch.owner === undefined &&
        current.task.owner === undefined
      ) {
        const autoOwner =
          (await options.resolveActingOwner?.({
            listId,
            args,
            task: current.task,
            actorKind: actor.kind,
            actorName: actor.name,
          })) ??
          (actor.kind === "subagent" ? actor.name : undefined);
        if (autoOwner) {
          patch.owner = autoOwner;
          if (!updatedFields.includes("owner")) {
            updatedFields.push("owner");
          }
        }
      }

      const isTransitioningToCompleted =
        patch.status === "completed" && current.task.status !== "completed";
      const shouldGuardCompletion =
        isTransitioningToCompleted &&
        isExplicitCompletionFlow({
          task: current.task,
          patch,
        });
      if (shouldGuardCompletion && options.onBeforeTaskComplete) {
        const guardResult = await options.onBeforeTaskComplete({
          listId,
          taskId,
          task: current.task,
          patch,
        });
        if (guardResult?.outcome === "block") {
          return errorResult(
            guardResult.message ??
              "Task completion was blocked by the runtime stop-hook chain.",
          );
        }
        const refreshed = await taskStore.readTaskState(listId, taskId);
        if (!refreshed) {
          return errorResult(`task ${taskId} not found`);
        }
        if (
          refreshed.revision !== current.revision ||
          refreshed.task.status === "completed"
        ) {
          return errorResult(
            `task ${taskId} changed while completion hook was running; reread and retry`,
          );
        }
      }

      const task = await taskStore.updateTask(
        listId,
        taskId,
        patch,
        isTransitioningToCompleted ? current.revision : undefined,
      );
      if (!task) {
        return okResult({
          success: false,
          taskId,
          updatedFields: [],
          error: "Task not found",
        });
      }
      const allTasks =
        patch.status === "completed"
          ? (await taskStore.listTasks(listId)).filter(isPublicSessionTask)
          : [];
      const verificationNudgeNeeded = shouldEmitVerificationNudge({
        tasks: allTasks,
        actorKind: actor.kind,
      });
      const baseMessage = `Updated task #${task.id}: ${updatedFields.join(", ")}`;
      const nudgeNote = verificationNudgeNeeded
        ? "\n\nNOTE: You just closed out 3+ tasks and none of them was a " +
          "verification step. Before writing your final summary, spawn the " +
          "verifier with execute_with_agent and set " +
          "delegationAdmission.verifierObligations to the checks you want " +
          "verified. You cannot self-assign PARTIAL by listing caveats in " +
          "your summary \u2014 only the verifier issues a verdict."
        : "";
      return okResult({
        success: true,
        taskId: task.id,
        updatedFields,
        message: baseMessage + nudgeNote,
        ...(patch.status !== undefined
          ? {
              statusChange: {
                from: current.task.status,
                to: patch.status,
              },
            }
          : {}),
        ...(verificationNudgeNeeded ? { verificationNudgeNeeded: true } : {}),
      });
    },
  };

  return [taskCreate, taskList, taskGet, taskUpdate];
}

/** Shape returned by {@link listOpenTasksForSession}. */
export interface OpenTaskSummary {
  readonly id: string;
  readonly status: "pending" | "in_progress";
  readonly subject: string;
}

/**
 * True when a {@link SessionTask.status} should be treated as "still open"
 * for scheduling / reminder purposes. Completed, failed, cancelled, and
 * deleted tasks are all treated as closed.
 */
export function isOpenTaskStatus(
  status: SessionTask["status"],
): status is "pending" | "in_progress" {
  return status === "pending" || status === "in_progress";
}

/**
 * Return a summary of the session's currently-open tasks, ordered by
 * insertion order of the underlying list (which matches the caller's
 * mental model — tasks surface in the order they were created).
 *
 * The session's list id is the session id, matching the convention
 * established in {@link tool-handler-factory.applyTaskListContext}.
 */
export async function listOpenTasksForSession(
  store: SessionTaskStore,
  sessionId: string,
  limit = 20,
): Promise<OpenTaskSummary[]> {
  const all = await store.listTasks(sessionId);
  const open: OpenTaskSummary[] = [];
  for (const task of all) {
    if (!isOpenTaskStatus(task.status)) continue;
    open.push({
      id: task.id,
      status: task.status,
      subject: task.subject,
    });
    if (open.length >= limit) break;
  }
  return open;
}

export function createRuntimeTaskHandleTools(
  store?: TaskStore,
  options: Pick<TaskTrackerToolOptions, "onTaskAccessEvent"> = {},
): Tool[] {
  const taskStore = store ?? new TaskStore();
  const emitTaskAccessEvent = async (
    event: TaskTrackerAccessNotification,
  ): Promise<void> => {
    try {
      await options.onTaskAccessEvent?.(event);
    } catch {
      // Access tracing must not affect tool behavior.
    }
  };

  const taskWait: Tool = {
    name: "task.wait",
    description: TASK_WAIT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Task id to wait on.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          description: "Maximum time to wait before returning the current task state.",
        },
        until: {
          type: "string",
          enum: ["terminal", "output_ready"],
          description: "Wait until the task is terminal or until output is ready.",
        },
      },
      required: ["taskId"],
    },
    async execute(args) {
      const taskId = asNonEmptyString(args.taskId);
      if (!taskId) return errorResult("taskId must be a non-empty string");
      const timeoutMs =
        args.timeoutMs === undefined
          ? undefined
          : asPositiveInt(args.timeoutMs) ?? 0;
      const until =
        args.until === "terminal" || args.until === "output_ready"
          ? args.until
          : undefined;
      const effectiveUntil = until ?? "terminal";
      const listId = resolveListId(args);
      await emitTaskAccessEvent({
        type: "task_wait_started",
        listId,
        taskId,
        timestamp: Date.now(),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        until: effectiveUntil,
      });
      const task = await taskStore.waitForTask(listId, taskId, {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(until ? { until } : {}),
      });
      if (!task) return errorResult(`task ${taskId} not found`);
      await emitTaskAccessEvent({
        type: "task_wait_finished",
        listId,
        taskId,
        timestamp: Date.now(),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        until: effectiveUntil,
        ready:
          effectiveUntil === "output_ready"
            ? task.outputReady === true
            : isTerminalTaskStatus(task.status),
        task,
      });
      return okResult({
        ready:
          (until ?? "terminal") === "output_ready"
            ? task.outputReady === true
            : isTerminalTaskStatus(task.status),
        task: fullTask(task),
        taskRuntime: taskRuntime(task),
      });
    },
  };

  const taskOutput: Tool = {
    name: "task.output",
    description: TASK_OUTPUT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Task id to inspect.",
        },
        block: {
          type: "boolean",
          description: "When true, wait for output_ready before returning.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          description: "Maximum time to wait when block=true.",
        },
        includeEvents: {
          type: "boolean",
          description: "Include the task event stream in the response.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          description: "Maximum output bytes to return inline.",
        },
      },
      required: ["taskId"],
    },
    async execute(args) {
      const taskId = asNonEmptyString(args.taskId);
      if (!taskId) return errorResult("taskId must be a non-empty string");
      const listId = resolveListId(args);
      const timeoutMs =
        args.timeoutMs !== undefined ? asPositiveInt(args.timeoutMs) ?? 0 : undefined;
      const includeEvents = args.includeEvents === true;
      const maxBytes =
        args.maxBytes !== undefined
          ? asPositiveInt(args.maxBytes) ?? DEFAULT_OUTPUT_MAX_BYTES
          : undefined;
      const output = await taskStore.taskOutput(listId, taskId, {
        block: args.block === true,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        includeEvents,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      });
      if (!output) return errorResult(`task ${taskId} not found`);
      await emitTaskAccessEvent({
        type: "task_output_read",
        listId,
        taskId,
        timestamp: Date.now(),
        ...(args.block === true ? { until: "output_ready" as const } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        includeEvents,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ready: output.ready === true,
        task: (output.task as unknown as Task | undefined) ?? undefined,
      });
      return okResult(output);
    },
  };

  return [taskWait, taskOutput];
}
