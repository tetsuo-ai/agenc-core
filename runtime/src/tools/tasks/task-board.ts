/**
 * Ports the donor TaskCreate/TaskGet/TaskList/TaskUpdate task-board tools
 * onto AgenC's durable per-project task store.
 *
 * Shape differences from the donor tools:
 *   - AgenC persists tasks under the local project state directory and exposes
 *     owner values as AgenC agent paths or thread ids.
 *   - Donor hook execution, teammate mailboxes, and feature flags are not
 *     present in the current runtime, so validation stays local to the task
 *     store and dependency graph.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Donor feature-flag nudges.
 *   - Donor teammate mailbox notifications.
 */

import { formatAgentRoleLabel } from "../../agents/role-presentation.js";
import {
  createNew as taskCreateNew,
  listWithUnresolved as taskListWithUnresolved,
  loadOne as taskLoadOne,
  updateOne as taskUpdateOne,
  type StoredTask,
  type TaskStatus,
  type TaskStoreOptions,
  type TaskUpdateStatus,
  type UpdateTaskInput,
} from "../../bin/task-store.js";
import { isRecord } from "../../utils/record.js";
import type { Tool, ToolResult } from "../types.js";
import {
  TASK_CONCURRENCY,
  stringValue,
  taskStrictArgs,
  taskTextResult,
  toolMetadata,
  type TaskToolOptions,
} from "./helpers.js";

const TASK_BOARD_GUIDANCE =
  "Use TodoWrite for per-session checklists. Use these Task tools when work spans multiple turns, multiple AgenC agents, or needs explicit dependency tracking. The owner field is an AgenC agent path (e.g. /root/task_3) or thread id. Dependency edges are auto-mirrored.";

function taskStoreOpts(opts: TaskToolOptions): TaskStoreOptions {
  return opts.agencHome !== undefined
    ? { workspaceRoot: opts.workspaceRoot, agencHome: opts.agencHome }
    : { workspaceRoot: opts.workspaceRoot };
}

const VALID_TASK_STATUS: ReadonlySet<TaskStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
]);
const VALID_TASK_UPDATE_STATUS: ReadonlySet<TaskUpdateStatus> = new Set([
  ...VALID_TASK_STATUS,
  "deleted",
]);

function normalizeTaskUpdateStatus(value: unknown): TaskUpdateStatus | undefined {
  if (
    typeof value === "string" &&
    VALID_TASK_UPDATE_STATUS.has(value as TaskUpdateStatus)
  ) {
    return value as TaskUpdateStatus;
  }
  return undefined;
}

function publicTask(task: StoredTask): Record<string, unknown> {
  return task as unknown as Record<string, unknown>;
}

function parseTaskMetadata(value: unknown): {
  readonly metadata?: Record<string, unknown>;
  readonly error?: ToolResult;
} {
  if (value === undefined) return {};
  if (isRecord(value)) {
    return { metadata: value };
  }
  return {
    error: taskTextResult(
      "metadata must be an object",
      { error: "metadata must be an object" },
      true,
    ),
  };
}

function taskStringArray(
  value: unknown,
  field: string,
): ToolResult | readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return taskTextResult(
      `${field} must be an array of task id strings`,
      { error: `${field} must be an array of task id strings` },
      true,
    );
  }
  return value;
}

function formatTask(task: StoredTask): string {
  const lines = [
    `Task #${task.id}: ${task.subject}`,
    `Status: ${task.status}`,
    `Description: ${task.description}`,
  ];
  if (task.owner) lines.push(`Owner: ${formatTaskOwnerForDisplay(task.owner)}`);
  if (task.activeForm) lines.push(`Active form: ${task.activeForm}`);
  if (task.blockedBy.length > 0) {
    lines.push(`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
  }
  if (task.blocks.length > 0) {
    lines.push(`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`);
  }
  return lines.join("\n");
}

function formatTaskOwnerForDisplay(owner: string): string {
  const label = formatAgentRoleLabel(owner, owner);
  return label === owner ? owner : `${label} (${owner})`;
}

function formatTaskList(tasks: readonly StoredTask[]): string {
  if (tasks.length === 0) return "No tasks found";
  return tasks
    .map((task) => {
      const owner = task.owner ? ` (${formatTaskOwnerForDisplay(task.owner)})` : "";
      const blockedBy = "unresolvedBlockers" in task
        ? (task as { readonly unresolvedBlockers?: readonly string[] }).unresolvedBlockers ?? []
        : task.blockedBy;
      const blocked =
        blockedBy.length > 0
          ? ` [blocked by ${blockedBy.map((id) => `#${id}`).join(", ")}]`
          : "";
      return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`;
    })
    .join("\n");
}

function taskUpdateFields(
  existing: StoredTask,
  args: Record<string, unknown>,
  status: TaskUpdateStatus | undefined,
  addBlocks: readonly string[],
  addBlockedBy: readonly string[],
): string[] {
  const fields: string[] = [];
  const subject = stringValue(args.subject);
  if (subject !== undefined && subject !== existing.subject) fields.push("subject");
  const description = stringValue(args.description);
  if (description !== undefined && description !== existing.description) {
    fields.push("description");
  }
  const activeForm = stringValue(args.activeForm);
  if (activeForm !== undefined && activeForm !== existing.activeForm) {
    fields.push("activeForm");
  }
  if (args.owner === null) {
    if (existing.owner !== undefined) fields.push("owner");
  } else {
    const owner = stringValue(args.owner);
    if (owner !== undefined && owner !== existing.owner) fields.push("owner");
  }
  if (args.metadata !== undefined) fields.push("metadata");
  if (status === "deleted") return ["deleted"];
  if (status !== undefined && status !== existing.status) fields.push("status");
  if (addBlocks.some((id) => !existing.blocks.includes(id))) fields.push("blocks");
  if (addBlockedBy.some((id) => !existing.blockedBy.includes(id))) {
    fields.push("blockedBy");
  }
  return fields;
}

function tryAutoExpandTaskPanel(opts: TaskToolOptions): void {
  try {
    const session = opts.getSession();
    if (!session) return;
    const bridge = (
      session as {
        appStateBridge?: { setExpandedView?: (next: "none" | "tasks") => void };
      }
    ).appStateBridge;
    bridge?.setExpandedView?.("tasks");
  } catch {
    // Bridge access must never break a tool call.
  }
}

export function createTaskBoardTools(opts: TaskToolOptions): readonly Tool[] {
  const storeOpts = taskStoreOpts(opts);

  return [
    {
      name: "TaskCreate",
      description: `Create a durable AgenC task on the project task board. New tasks start pending and unowned; assign AgenC agents with TaskUpdate owner. ${TASK_BOARD_GUIDANCE}`,
      metadata: toolMetadata("task", {
        mutating: true,
        deferred: true,
        keywords: ["task", "create", "coordination", "subagent"],
      }),
      concurrencyClass: TASK_CONCURRENCY,
      recoveryCategory: "side-effecting",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string" },
          description: { type: "string" },
          activeForm: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["subject", "description"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const strict = taskStrictArgs(args, {
          allowed: new Set(["subject", "description", "activeForm", "metadata"]),
          required: ["subject", "description"],
        });
        if (strict) return strict;
        const subject = stringValue(args.subject);
        if (!subject) {
          return taskTextResult("subject is required", { error: "subject is required" }, true);
        }
        const description = stringValue(args.description);
        if (!description) {
          return taskTextResult(
            "description is required",
            { error: "description is required" },
            true,
          );
        }
        const activeForm = stringValue(args.activeForm);
        const parsedMetadata = parseTaskMetadata(args.metadata);
        if (parsedMetadata.error) return parsedMetadata.error;
        const metadata = parsedMetadata.metadata;
        const task = await taskCreateNew(storeOpts, {
          subject,
          description,
          ...(activeForm !== undefined ? { activeForm } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        });
        tryAutoExpandTaskPanel(opts);
        return taskTextResult(
          `Task #${task.id} created successfully: ${task.subject}`,
          { task: publicTask(task) },
        );
      },
    },
    {
      name: "TaskGet",
      description: `Retrieve a durable AgenC task by id. ${TASK_BOARD_GUIDANCE}`,
      metadata: toolMetadata("task", {
        deferred: true,
        keywords: ["task", "get", "coordination"],
      }),
      isReadOnly: true,
      recoveryCategory: "idempotent",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const strict = taskStrictArgs(args, {
          allowed: new Set(["taskId"]),
          required: ["taskId"],
        });
        if (strict) return strict;
        const taskId = stringValue(args.taskId);
        if (!taskId) {
          return taskTextResult("taskId is required", { error: "taskId is required" }, true);
        }
        const task = await taskLoadOne(storeOpts, taskId);
        if (task === null) {
          return taskTextResult(
            "Task not found",
            { error: "Task not found", taskId },
            true,
          );
        }
        return taskTextResult(formatTask(task), { task: publicTask(task) });
      },
    },
    {
      name: "TaskUpdate",
      description: `Update a durable AgenC task: status, fields, AgenC-agent owner, metadata, and dependency edges. Set status to deleted to permanently remove the task and scrub dependency references. Metadata keys set to null are deleted. ${TASK_BOARD_GUIDANCE}`,
      metadata: toolMetadata("task", {
        mutating: true,
        deferred: true,
        keywords: ["task", "update", "coordination", "dependencies"],
      }),
      concurrencyClass: TASK_CONCURRENCY,
      recoveryCategory: "side-effecting",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          subject: { type: "string" },
          description: { type: "string" },
          activeForm: { type: "string" },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed", "deleted"],
          },
          owner: { type: ["string", "null"] },
          addBlocks: { type: "array", items: { type: "string" } },
          addBlockedBy: { type: "array", items: { type: "string" } },
          metadata: { type: "object" },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const strict = taskStrictArgs(args, {
          allowed: new Set([
            "taskId",
            "subject",
            "description",
            "activeForm",
            "status",
            "owner",
            "addBlocks",
            "addBlockedBy",
            "metadata",
          ]),
          required: ["taskId"],
        });
        if (strict) return strict;
        const taskId = stringValue(args.taskId);
        if (!taskId) {
          return taskTextResult("taskId is required", { error: "taskId is required" }, true);
        }
        const existing = await taskLoadOne(storeOpts, taskId);
        if (existing === null) {
          return taskTextResult(
            "Task not found",
            { error: "Task not found", taskId },
            true,
          );
        }
        const update: UpdateTaskInput = {};
        const subject = stringValue(args.subject);
        if (subject !== undefined) (update as { subject?: string }).subject = subject;
        const description = stringValue(args.description);
        if (description !== undefined) {
          (update as { description?: string }).description = description;
        }
        const activeForm = stringValue(args.activeForm);
        if (activeForm !== undefined) {
          (update as { activeForm?: string }).activeForm = activeForm;
        }
        const status = normalizeTaskUpdateStatus(args.status);
        if (args.status !== undefined && status === undefined) {
          return taskTextResult(
            "status must be pending, in_progress, completed, or deleted",
            { error: "invalid status" },
            true,
          );
        }
        if (status !== undefined) {
          (update as { status?: TaskUpdateStatus }).status = status;
        }
        if (args.owner === null) {
          (update as { owner?: string | null }).owner = null;
        } else {
          const owner = stringValue(args.owner);
          if (owner !== undefined) {
            (update as { owner?: string | null }).owner = owner;
          }
        }
        const parsedAddBlocks = taskStringArray(args.addBlocks, "addBlocks");
        if (parsedAddBlocks !== undefined && "content" in parsedAddBlocks) {
          return parsedAddBlocks;
        }
        const addBlocks = parsedAddBlocks ?? [];
        if (addBlocks.length > 0) {
          (update as { addBlocks?: readonly string[] }).addBlocks = addBlocks;
        }
        const parsedAddBlockedBy = taskStringArray(args.addBlockedBy, "addBlockedBy");
        if (parsedAddBlockedBy !== undefined && "content" in parsedAddBlockedBy) {
          return parsedAddBlockedBy;
        }
        const addBlockedBy = parsedAddBlockedBy ?? [];
        if (addBlockedBy.length > 0) {
          (update as { addBlockedBy?: readonly string[] }).addBlockedBy = addBlockedBy;
        }
        const parsedMetadata = parseTaskMetadata(args.metadata);
        if (parsedMetadata.error) return parsedMetadata.error;
        const metadata = parsedMetadata.metadata;
        if (metadata !== undefined) {
          (update as { metadata?: Record<string, unknown> }).metadata = metadata;
        }

        const updatedFields = taskUpdateFields(
          existing,
          args,
          status,
          addBlocks,
          addBlockedBy,
        );
        const outcome = await taskUpdateOne(storeOpts, taskId, update);
        if (outcome.error) {
          const payload: Record<string, unknown> = {
            error: outcome.error.message,
            taskId,
          };
          if (outcome.error.missing) payload.missing = outcome.error.missing;
          return taskTextResult(outcome.error.message, payload, true);
        }
        if (outcome.deleted) {
          return taskTextResult(
            `Deleted task #${taskId}`,
            {
              success: true,
              taskId,
              updatedFields: ["deleted"],
              statusChange: { from: existing.status, to: "deleted" },
            },
          );
        }
        const finalTask = outcome.task!;
        const codeModeResult = {
          success: true,
          taskId,
          updatedFields,
          ...(status !== undefined && status !== "deleted" && status !== existing.status
            ? { statusChange: { from: existing.status, to: status } }
            : {}),
          task: publicTask(finalTask),
        };
        return taskTextResult(
          updatedFields.length > 0
            ? `Updated task #${taskId} ${updatedFields.join(", ")}`
            : `No changes made to task #${taskId}`,
          codeModeResult,
        );
      },
    },
    {
      name: "TaskList",
      description: `List durable AgenC tasks. Includes AgenC-agent owner and unresolvedBlockers per task. ${TASK_BOARD_GUIDANCE}`,
      metadata: toolMetadata("task", {
        deferred: true,
        keywords: ["task", "list", "coordination", "subagent"],
      }),
      isReadOnly: true,
      recoveryCategory: "idempotent",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async (args) => {
        const strict = taskStrictArgs(args, { allowed: new Set() });
        if (strict) return strict;
        const tasks = (await taskListWithUnresolved(storeOpts)).filter(
          (task) => !Boolean(task.metadata?._internal),
        );
        return taskTextResult(formatTaskList(tasks), { tasks });
      },
    },
  ];
}
