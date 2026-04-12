import { createHash } from "node:crypto";

import type { ExecutionEffectClass } from "./execution-envelope.js";
import { inferToolAccess } from "../policy/tool-governance.js";

export type EffectLedgerVersion = "v1";

export type EffectStatus =
  | "intent_recorded"
  | "pending_approval"
  | "approved"
  | "denied"
  | "executing"
  | "succeeded"
  | "failed"
  | "compensated"
  | "compensation_failed";

export type EffectKind =
  | "filesystem_write"
  | "filesystem_append"
  | "filesystem_delete"
  | "filesystem_move"
  | "filesystem_mkdir"
  | "shell_command"
  | "process_start"
  | "server_start"
  | "desktop_editor"
  | "other_mutation";

type EffectTargetKind =
  | "path"
  | "process"
  | "server"
  | "command";

export interface EffectScope {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly subagentSessionId?: string;
  readonly pipelineId?: string;
  readonly stepName?: string;
  readonly stepIndex?: number;
  readonly runId?: string;
  readonly channel?: string;
}

export interface EffectTarget {
  readonly kind: EffectTargetKind;
  readonly path?: string;
  readonly processId?: string;
  readonly serverId?: string;
  readonly label?: string;
  readonly cwd?: string;
  readonly command?: string;
}

export interface EffectApprovalRef {
  readonly requestId?: string;
  readonly disposition?: "yes" | "no" | "always";
  readonly requestedAt?: number;
  readonly resolvedAt?: number;
  readonly approvedBy?: string;
  readonly resolverSessionId?: string;
  readonly resolverRoles?: readonly string[];
}

export type EffectFilesystemEntryType =
  | "file"
  | "directory"
  | "missing"
  | "other";

export interface EffectFilesystemSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly entryType: EffectFilesystemEntryType;
  readonly sizeBytes?: number;
  readonly sha256?: string;
  readonly utf8Text?: string;
  readonly base64?: string;
}

type EffectCompensationActionKind =
  | "restore_snapshot"
  | "delete_created_path"
  | "reverse_move"
  | "process_stop"
  | "server_stop";

export interface EffectCompensationAction {
  readonly id: string;
  readonly kind: EffectCompensationActionKind;
  readonly supported: boolean;
  readonly reason?: string;
  readonly path?: string;
  readonly sourcePath?: string;
  readonly destinationPath?: string;
  readonly snapshot?: EffectFilesystemSnapshot;
  readonly processId?: string;
  readonly serverId?: string;
  readonly label?: string;
  readonly idempotencyKey?: string;
}

export interface EffectCompensationState {
  readonly status: "not_available" | "available" | "completed" | "failed";
  readonly actions: readonly EffectCompensationAction[];
  readonly lastAttemptAt?: number;
  readonly lastError?: string;
}

export interface EffectAttemptRecord {
  readonly attempt: number;
  readonly recordedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly status: EffectStatus;
  readonly error?: string;
  readonly durationMs?: number;
  readonly resultSnippet?: string;
}

export interface EffectResultSummary {
  readonly success: boolean;
  readonly isError: boolean;
  readonly completedAt: number;
  readonly durationMs?: number;
  readonly resultSnippet?: string;
  readonly observedMutationsUnknown?: boolean;
  readonly error?: string;
}

export interface EffectRecord {
  readonly version: EffectLedgerVersion;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly scope: EffectScope;
  readonly kind: EffectKind;
  readonly effectClass: ExecutionEffectClass;
  readonly status: EffectStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly intentSummary: string;
  readonly targets: readonly EffectTarget[];
  readonly attempts: readonly EffectAttemptRecord[];
  readonly approval?: EffectApprovalRef;
  readonly preExecutionSnapshots?: readonly EffectFilesystemSnapshot[];
  readonly postExecutionSnapshots?: readonly EffectFilesystemSnapshot[];
  readonly result?: EffectResultSummary;
  readonly compensation: EffectCompensationState;
  readonly metadata?: Record<string, unknown>;
}

export interface EffectRecordInput {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly scope: EffectScope;
  readonly kind: EffectKind;
  readonly effectClass: ExecutionEffectClass;
  readonly intentSummary: string;
  readonly targets: readonly EffectTarget[];
  readonly createdAt: number;
  readonly requiresApproval: boolean;
  readonly preExecutionSnapshots?: readonly EffectFilesystemSnapshot[];
  readonly metadata?: Record<string, unknown>;
}

const FILESYSTEM_WRITE_TOOL_NAMES = new Set([
  "system.writeFile",
  "system.applyPatch",
  "desktop.text_editor",
]);
const FILESYSTEM_APPEND_TOOL_NAMES = new Set(["system.appendFile"]);
const FILESYSTEM_DELETE_TOOL_NAMES = new Set(["system.delete"]);
const FILESYSTEM_MOVE_TOOL_NAMES = new Set(["system.move"]);
const FILESYSTEM_MKDIR_TOOL_NAMES = new Set(["system.mkdir"]);
const WORKTREE_MUTATION_TOOL_NAMES = new Set([
  "system.gitWorktreeCreate",
  "system.gitWorktreeRemove",
]);
const SHELL_TOOL_NAMES = new Set(["system.bash", "desktop.bash"]);
const PROCESS_START_TOOL_NAMES = new Set(["system.processStart"]);
const SERVER_START_TOOL_NAMES = new Set(["system.serverStart"]);

export function inferEffectClass(params: {
  readonly toolName: string;
  readonly explicitEffectClass?: ExecutionEffectClass;
}): ExecutionEffectClass {
  if (params.explicitEffectClass) {
    return params.explicitEffectClass;
  }
  const { toolName } = params;
  if (FILESYSTEM_WRITE_TOOL_NAMES.has(toolName)) return "filesystem_write";
  if (FILESYSTEM_APPEND_TOOL_NAMES.has(toolName)) return "filesystem_write";
  if (FILESYSTEM_DELETE_TOOL_NAMES.has(toolName)) return "filesystem_write";
  if (FILESYSTEM_MOVE_TOOL_NAMES.has(toolName)) return "filesystem_write";
  if (FILESYSTEM_MKDIR_TOOL_NAMES.has(toolName)) return "filesystem_scaffold";
  if (WORKTREE_MUTATION_TOOL_NAMES.has(toolName)) return "filesystem_write";
  if (SHELL_TOOL_NAMES.has(toolName)) return "shell";
  if (
    PROCESS_START_TOOL_NAMES.has(toolName) ||
    SERVER_START_TOOL_NAMES.has(toolName)
  ) {
    return "mixed";
  }
  return inferToolAccess(toolName) === "read" ? "read_only" : "mixed";
}

export function inferEffectKind(toolName: string): EffectKind {
  if (FILESYSTEM_WRITE_TOOL_NAMES.has(toolName)) return "filesystem_write";
  if (FILESYSTEM_APPEND_TOOL_NAMES.has(toolName)) return "filesystem_append";
  if (FILESYSTEM_DELETE_TOOL_NAMES.has(toolName)) return "filesystem_delete";
  if (FILESYSTEM_MOVE_TOOL_NAMES.has(toolName)) return "filesystem_move";
  if (FILESYSTEM_MKDIR_TOOL_NAMES.has(toolName)) return "filesystem_mkdir";
  if (WORKTREE_MUTATION_TOOL_NAMES.has(toolName)) return "other_mutation";
  if (SHELL_TOOL_NAMES.has(toolName)) return "shell_command";
  if (PROCESS_START_TOOL_NAMES.has(toolName)) return "process_start";
  if (SERVER_START_TOOL_NAMES.has(toolName)) return "server_start";
  if (toolName === "desktop.text_editor") return "desktop_editor";
  return "other_mutation";
}

export function isMutatingTool(toolName: string): boolean {
  return inferToolAccess(toolName) === "write";
}

export function summarizeToolResult(result: string, maxChars = 400): string {
  const normalized = result.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

export function buildEffectIntentSummary(params: {
  readonly toolName: string;
  readonly targets: readonly EffectTarget[];
}): string {
  const targetSummary =
    params.targets.length > 0
      ? params.targets
          .map((target) =>
            target.path ??
            target.processId ??
            target.serverId ??
            target.command ??
            target.label ??
            target.kind,
          )
          .join(", ")
      : "no explicit target";
  return `${params.toolName} -> ${targetSummary}`;
}

export function createInitialEffectRecord(
  input: EffectRecordInput,
): EffectRecord {
  const initialStatus: EffectStatus = input.requiresApproval
    ? "pending_approval"
    : "intent_recorded";
  return {
    version: "v1",
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    args: structuredClone(input.args),
    scope: structuredClone(input.scope),
    kind: input.kind,
    effectClass: input.effectClass,
    status: initialStatus,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    intentSummary: input.intentSummary,
    targets: structuredClone(input.targets),
    attempts: [
      {
        attempt: 1,
        recordedAt: input.createdAt,
        status: initialStatus,
      },
    ],
    ...(input.preExecutionSnapshots && input.preExecutionSnapshots.length > 0
      ? { preExecutionSnapshots: structuredClone(input.preExecutionSnapshots) }
      : {}),
    compensation: {
      status: "not_available",
      actions: [],
    },
    ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
  };
}

export function appendEffectAttempt(
  record: EffectRecord,
  now: number,
  status: EffectStatus,
): EffectRecord {
  const nextAttempt: EffectAttemptRecord = {
    attempt: record.attempts.length + 1,
    recordedAt: now,
    status,
  };
  return {
    ...record,
    status,
    updatedAt: now,
    attempts: [...record.attempts, nextAttempt],
  };
}

export function hashSnapshotContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
