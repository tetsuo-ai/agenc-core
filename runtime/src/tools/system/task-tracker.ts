/**
 * Task tracker tools for @tetsuo-ai/runtime
 *
 * In-conversation task tracking. Mirrors the behavior of the upstream
 * task.create / task.list / task.get / task.update tool family in the
 * reference implementation, giving AgenC agents a structured way to track
 * multi-step work within a session.
 *
 * Tasks are scoped per session via the magic `__agencTaskListId` arg key
 * that the gateway tool-handler-factory injects automatically before
 * dispatch. Two concurrent sessions therefore see independent task
 * lists. The store is in-process and lives only as long as the daemon —
 * task lists are intentionally ephemeral, matching the upstream
 * behavior of clearing on shell exit.
 *
 * Tools:
 *  - `task.create`  — create a new task (status defaults to `pending`)
 *  - `task.list`    — list tasks in the current session, optional status filter
 *  - `task.get`     — fetch a single task by id with full details
 *  - `task.update`  — patch status / subject / description / owner /
 *                     metadata / blocks; status `deleted` removes the task
 *
 * @module
 */

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import {
  normalizeRequestTaskRuntimeMetadata,
} from "../../workflow/request-task-runtime.js";

/**
 * Magic arg key used by the gateway to thread the current session id
 * into task tools. The tools strip this key from their input before
 * doing anything else with the args. Same pattern as
 * `SESSION_ALLOWED_ROOTS_ARG` in `filesystem.ts`.
 */
export const TASK_LIST_ARG = "__agencTaskListId";

/**
 * Default task list id used when the gateway has not injected a
 * session id (e.g. unit tests, ad hoc tool calls outside the
 * tool-handler-factory dispatcher).
 */
export const DEFAULT_TASK_LIST_ID = "default";

/**
 * Tool names that should receive the injected session task-list id.
 * Consumed by `tool-handler-factory.ts` to apply the magic key.
 */
export const TASK_TRACKER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "task.create",
  "task.list",
  "task.get",
  "task.update",
]);

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Task {
  readonly id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
  readonly createdAt: number;
  updatedAt: number;
}

export interface TaskCreateInput {
  readonly subject: string;
  readonly description: string;
  readonly activeForm?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TaskUpdatePatch {
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  addBlocks?: readonly string[];
  addBlockedBy?: readonly string[];
}

interface StoredTask extends Task {
  revision: number;
}

interface TaskListEntry {
  readonly id: string;
  tasks: StoredTask[];
  nextTaskId: number;
}

export interface TaskCompletionGuardResult {
  readonly outcome: "allow" | "block";
  readonly message?: string;
}

export interface TaskTrackerToolOptions {
  readonly onBeforeTaskComplete?: (params: {
    readonly listId: string;
    readonly taskId: string;
    readonly task: Task;
    readonly patch: TaskUpdatePatch;
  }) => Promise<TaskCompletionGuardResult | void>;
}

/**
 * In-memory task store keyed by task list id (typically a session id).
 *
 * Concurrency model: all operations are synchronous and atomic per
 * task list. The runtime never spawns parallel writers against the
 * same task list — the LLM tool loop dispatches tools sequentially
 * within a session — so a Map + plain mutation is sufficient.
 */
export class TaskStore {
  private readonly lists = new Map<string, TaskListEntry>();
  private readonly now: () => number;

  constructor(options?: { readonly now?: () => number }) {
    this.now = options?.now ?? (() => Date.now());
  }

  private getOrCreateList(listId: string): TaskListEntry {
    let list = this.lists.get(listId);
    if (!list) {
      list = { id: listId, tasks: [], nextTaskId: 1 };
      this.lists.set(listId, list);
    }
    return list;
  }

  create(listId: string, input: TaskCreateInput): Task {
    const list = this.getOrCreateList(listId);
    const id = String(list.nextTaskId);
    list.nextTaskId += 1;
    const now = this.now();
    const task: StoredTask = {
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
    return cloneTask(task);
  }

  list(listId: string, filter?: { readonly status?: TaskStatus }): Task[] {
    const list = this.lists.get(listId);
    if (!list) return [];
    const visible = list.tasks.filter((t) => t.status !== "deleted");
    const filtered =
      filter?.status !== undefined
        ? visible.filter((t) => t.status === filter.status)
        : visible;
    return filtered.map(cloneTask);
  }

  get(listId: string, taskId: string): Task | undefined {
    const list = this.lists.get(listId);
    if (!list) return undefined;
    const task = list.tasks.find(
      (t) => t.id === taskId && t.status !== "deleted",
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
    const task = list.tasks.find((t) => t.id === taskId);
    if (!task) return undefined;
    if (task.status === "deleted") return undefined;
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
    if (patch.owner !== undefined) task.owner = patch.owner;

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
      task.blockedBy = Array.from(
        new Set([...task.blockedBy, ...patch.addBlockedBy]),
      );
    }

    task.updatedAt = this.now();
    task.revision += 1;
    return cloneTask(task);
  }

  /** Drop a task list completely. Used when a session terminates. */
  dropList(listId: string): boolean {
    return this.lists.delete(listId);
  }

  /** Test helper: clear all task lists. */
  reset(): void {
    this.lists.clear();
  }
}

function cloneTask(task: Task | StoredTask): Task {
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

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function okResult(data: unknown): ToolResult {
  return { content: safeStringify(data) };
}

function resolveListId(args: Record<string, unknown>): string {
  const value = args[TASK_LIST_ARG];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return DEFAULT_TASK_LIST_ID;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPlainObject(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "deleted"
  );
}

function isFilterableStatus(
  value: unknown,
): value is Exclude<TaskStatus, "deleted"> {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function summarizeTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    ...(task.owner !== undefined ? { owner: task.owner } : {}),
    ...(task.blockedBy.length > 0 ? { blockedBy: task.blockedBy } : {}),
  };
}

function fullTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...(task.activeForm !== undefined ? { activeForm: task.activeForm } : {}),
    ...(task.owner !== undefined ? { owner: task.owner } : {}),
    blocks: task.blocks,
    blockedBy: task.blockedBy,
    ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
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

const TASK_CREATE_DESCRIPTION =
  "Create a structured task in the current session's task list. Use proactively for " +
  "multi-step work (3+ steps), complex tasks that require planning, or when the user " +
  "supplies multiple things to do. Tasks created here are scoped to the current session " +
  "and cleared on daemon restart. Mark a task in_progress with task.update BEFORE " +
  "starting work, and completed as soon as the work is fully done. For runtime-managed " +
  "milestone tracking, use metadata._runtime.milestoneIds and metadata._runtime.verification.";

const TASK_LIST_DESCRIPTION =
  "List tasks in the current session's task list. Returns id, subject, status, owner, " +
  "and blockedBy for each task. Use the optional `status` filter to narrow the result " +
  "to pending / in_progress / completed.";

const TASK_GET_DESCRIPTION =
  "Fetch a single task by id with its full description, metadata, blocks/blockedBy, " +
  "and timestamps. Use this when task.list does not give you enough detail.";

const TASK_UPDATE_DESCRIPTION =
  "Update a task's status, subject, description, owner, activeForm, metadata, or " +
  "blocks. Status transitions: pending -> in_progress -> completed. Use status " +
  "'deleted' to permanently remove a task. Metadata is merged shallowly; pass a key " +
  "with value null to delete that key. addBlocks / addBlockedBy append unique ids " +
  "to the existing arrays. Runtime-managed milestone tracking uses metadata._runtime.milestoneIds " +
  "and metadata._runtime.verification.";

/**
 * Build the four task tracker tools sharing a single in-memory store.
 *
 * @param store - Optional pre-existing TaskStore (handy for tests).
 *                When omitted, a fresh in-memory store is created.
 */
export function createTaskTrackerTools(
  store?: TaskStore,
  options: TaskTrackerToolOptions = {},
): Tool[] {
  const taskStore = store ?? new TaskStore();

  const taskCreate: Tool = {
    name: "task.create",
    description: TASK_CREATE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description:
            "A brief, actionable title in imperative form (e.g., 'Fix authentication bug in login flow').",
        },
        description: {
          type: "string",
          description: "What needs to be done. Include enough detail to act on later.",
        },
        activeForm: {
          type: "string",
          description:
            "Present continuous form shown when the task is in_progress (e.g., 'Fixing authentication bug').",
        },
        metadata: {
          type: "object",
          description:
            "Arbitrary metadata to attach to the task. Runtime-managed milestone tracking uses metadata._runtime.milestoneIds and metadata._runtime.verification.",
        },
      },
      required: ["subject", "description"],
    },
    async execute(args) {
      const subject = asNonEmptyString(args.subject);
      if (!subject) return errorResult("subject must be a non-empty string");
      const description = asNonEmptyString(args.description);
      if (!description) return errorResult("description must be a non-empty string");
      const activeForm = asNonEmptyString(args.activeForm);
      const metadata = asPlainObject(args.metadata);

      const task = taskStore.create(resolveListId(args), {
        subject,
        description,
        ...(activeForm !== undefined ? { activeForm } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      });

      return okResult({
        message: `Task #${task.id} created: ${task.subject}`,
        task: summarizeTask(task),
        taskRuntime: taskRuntime(task),
      });
    },
  };

  const taskList: Tool = {
    name: "task.list",
    description: TASK_LIST_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
          description: "Optional status filter.",
        },
      },
    },
    async execute(args) {
      const filter = isFilterableStatus(args.status)
        ? { status: args.status }
        : undefined;
      const tasks = taskStore.list(resolveListId(args), filter);
      return okResult({
        count: tasks.length,
        tasks: tasks.map(summarizeTask),
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
      const task = taskStore.get(resolveListId(args), taskId);
      if (!task) return errorResult(`task ${taskId} not found`);
      return okResult({
        task: fullTask(task),
        taskRuntime: taskRuntime(task),
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
          enum: ["pending", "in_progress", "completed", "deleted"],
        },
        subject: { type: "string" },
        description: { type: "string" },
        activeForm: { type: "string" },
        owner: { type: "string" },
        metadata: {
          type: "object",
          description:
            "Merged into existing metadata; values of null delete the key. Runtime-managed milestone tracking uses metadata._runtime.milestoneIds and metadata._runtime.verification.",
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

      const patch: TaskUpdatePatch = {};

      if (args.status !== undefined) {
        if (!isTaskStatus(args.status)) {
          return errorResult(
            "status must be one of: pending, in_progress, completed, deleted",
          );
        }
        patch.status = args.status;
      }
      if (args.subject !== undefined) {
        const next = asNonEmptyString(args.subject);
        if (next === undefined) {
          return errorResult("subject must be a non-empty string");
        }
        patch.subject = next;
      }
      if (args.description !== undefined) {
        const next = asNonEmptyString(args.description);
        if (next === undefined) {
          return errorResult("description must be a non-empty string");
        }
        patch.description = next;
      }
      if (args.activeForm !== undefined) {
        if (typeof args.activeForm !== "string") {
          return errorResult("activeForm must be a string");
        }
        patch.activeForm = args.activeForm;
      }
      if (args.owner !== undefined) {
        if (typeof args.owner !== "string") {
          return errorResult("owner must be a string");
        }
        patch.owner = args.owner;
      }
      if (args.metadata !== undefined) {
        const metadata = asPlainObject(args.metadata);
        if (metadata === undefined) {
          return errorResult("metadata must be a plain object");
        }
        patch.metadata = metadata;
      }
      if (args.addBlocks !== undefined) {
        if (!Array.isArray(args.addBlocks) ||
            args.addBlocks.some((v) => typeof v !== "string")) {
          return errorResult("addBlocks must be an array of strings");
        }
        patch.addBlocks = args.addBlocks as string[];
      }
      if (args.addBlockedBy !== undefined) {
        if (!Array.isArray(args.addBlockedBy) ||
            args.addBlockedBy.some((v) => typeof v !== "string")) {
          return errorResult("addBlockedBy must be an array of strings");
        }
        patch.addBlockedBy = args.addBlockedBy as string[];
      }

      const current = taskStore.readState(listId, taskId);
      if (!current) return errorResult(`task ${taskId} not found`);

      const isTransitioningToCompleted =
        patch.status === "completed" && current.task.status !== "completed";
      if (isTransitioningToCompleted && options.onBeforeTaskComplete) {
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
        const refreshed = taskStore.readState(listId, taskId);
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

      const task = taskStore.update(
        listId,
        taskId,
        patch,
        isTransitioningToCompleted ? current.revision : undefined,
      );
      if (!task) return errorResult(`task ${taskId} not found`);
      return okResult({
        message: `Task #${task.id} updated`,
        task: summarizeTask(task),
        taskRuntime: taskRuntime(task),
      });
    },
  };

  return [taskCreate, taskList, taskGet, taskUpdate];
}
