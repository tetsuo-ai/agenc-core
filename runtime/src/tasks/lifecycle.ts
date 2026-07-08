/**
 * Background task lifecycle foundation.
 *
 * This is the upstream-compatible task-state core adapted to AgenC's current
 * agent ownership model. It intentionally does not register model-facing
 * `TaskOutput` / `TaskStop` tools by itself; callers wire this lifecycle to a
 * real backing handle such as `AgentThread`, an AbortController, or a future
 * unified-exec process owner.
 *
 * @module
 */

import {
  generateTaskId,
  isTerminalTaskStatus,
  type AgenCBackgroundTaskType,
  type TaskStatus,
} from "./types.js";

export { isTerminalTaskStatus } from "./types.js";

export type BackgroundTaskType = AgenCBackgroundTaskType;

export type BackgroundTaskStatus = TaskStatus;

export type BackgroundTaskNotificationKind =
  | "started"
  | "progress"
  | "completed"
  | "failed"
  | "killed";

export interface BackgroundTaskOutputRef {
  readonly uri: string;
  readonly bytes: number;
}

export interface AgentToolActivity {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly activityDescription?: string;
  readonly isSearch?: boolean;
  readonly isRead?: boolean;
}

export interface AgentProgress {
  readonly toolUseCount: number;
  readonly tokenCount: number;
  readonly lastActivity?: AgentToolActivity;
  readonly recentActivities?: readonly AgentToolActivity[];
  readonly summary?: string;
}

export interface BackgroundTaskSnapshot {
  readonly id: string;
  readonly type: BackgroundTaskType;
  readonly status: BackgroundTaskStatus;
  readonly description: string;
  readonly toolUseId?: string;
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
  readonly output: BackgroundTaskOutputRef;
  readonly outputOffset: number;
  readonly notified: boolean;
  readonly source?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly progress?: AgentProgress;
  readonly error?: string;
}

export interface BackgroundTaskNotification {
  readonly kind: BackgroundTaskNotificationKind;
  readonly task: BackgroundTaskSnapshot;
  readonly summary: string;
  readonly delta?: string;
  readonly atMs: number;
}

export interface RegisterBackgroundTaskInput {
  readonly id?: string;
  readonly type: BackgroundTaskType;
  readonly description: string;
  readonly toolUseId?: string;
  readonly source?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly progress?: AgentProgress;
  readonly status?: Extract<BackgroundTaskStatus, "pending" | "running">;
  readonly outputUri?: string;
  readonly aliases?: readonly string[];
  readonly abortController?: AbortController;
  readonly onStop?: (reason: string) => Promise<void> | void;
}

export interface BindTaskPromiseOptions<T> {
  readonly onFulfilled?: (value: T) =>
    | {
        readonly status?: Extract<BackgroundTaskStatus, "completed" | "failed">;
        readonly output?: string;
        readonly error?: string;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }
    | void
    | Promise<
        | {
            readonly status?: Extract<
              BackgroundTaskStatus,
              "completed" | "failed"
            >;
            readonly output?: string;
            readonly error?: string;
            readonly metadata?: Readonly<Record<string, unknown>>;
          }
        | void
      >;
  readonly onRejected?: (error: unknown) => {
    readonly output?: string;
    readonly error?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  } | void;
  readonly onSnapshot?: (snapshot: BackgroundTaskSnapshot) => void;
}

interface MutableTaskRecord {
  id: string;
  type: BackgroundTaskType;
  status: BackgroundTaskStatus;
  description: string;
  toolUseId?: string;
  startedAtMs: number;
  endedAtMs?: number;
  outputUri: string;
  outputOffset: number;
  notified: boolean;
  source?: string;
  metadata?: Readonly<Record<string, unknown>>;
  progress?: AgentProgress;
  error?: string;
  abortController?: AbortController;
  onStop?: (reason: string) => Promise<void> | void;
}

interface OutputBuffer {
  content: string;
  totalBytes: number;
}

const MAX_OUTPUT_CHARS = 1_000_000;
const MAX_RETAINED_TERMINAL_TASKS = 100;
const MAX_RETAINED_NOTIFICATIONS = 1_000;

export class BackgroundTaskError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "already_exists"
      | "not_found"
      | "not_running"
      | "stop_failed",
  ) {
    super(message);
    this.name = "BackgroundTaskError";
  }
}

function generateBackgroundTaskId(type: BackgroundTaskType): string {
  return generateTaskId(type);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultOutputUri(taskId: string): string {
  return `urn:agenc:task:${encodeURIComponent(taskId)}:output`;
}

/**
 * In-memory lifecycle owner for background tasks.
 *
 * The output buffer is deliberately small and direct: it provides the delta
 * semantics needed by TaskOutput integration without claiming filesystem
 * persistence. Long-lived durable output can be supplied later by passing an
 * `outputUri` and mirroring writes into this lifecycle.
 */
export class BackgroundTaskLifecycle {
  private readonly tasks = new Map<string, MutableTaskRecord>();
  private readonly aliases = new Map<string, string>();
  private readonly outputs = new Map<string, OutputBuffer>();
  private readonly notifications: BackgroundTaskNotification[] = [];

  register(input: RegisterBackgroundTaskInput): BackgroundTaskSnapshot {
    const id = input.id ?? generateBackgroundTaskId(input.type);
    if (this.tasks.has(id)) {
      throw new BackgroundTaskError(`task ${id} already exists`, "already_exists");
    }
    const aliases = [...new Set(input.aliases ?? [])].filter(
      (alias) => alias.length > 0 && alias !== id,
    );
    for (const alias of aliases) {
      const existingId = this.resolveTaskId(alias);
      const existing = this.tasks.get(existingId);
      if (!existing) continue;
      if (!isTerminalTaskStatus(existing.status)) {
        throw new BackgroundTaskError(
          `task ${alias} already exists`,
          "already_exists",
        );
      }
      this.deleteTaskRecord(existing.id);
    }

    const record: MutableTaskRecord = {
      id,
      type: input.type,
      status: input.status ?? "running",
      description: input.description,
      startedAtMs: Date.now(),
      outputUri: input.outputUri ?? defaultOutputUri(id),
      outputOffset: 0,
      notified: false,
      ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      ...(input.abortController !== undefined
        ? { abortController: input.abortController }
        : {}),
      ...(input.onStop !== undefined ? { onStop: input.onStop } : {}),
    };

    this.tasks.set(id, record);
    this.outputs.set(id, { content: "", totalBytes: 0 });
    for (const alias of aliases) {
      this.aliases.set(alias, id);
    }
    this.pushNotification("started", record, `Task "${record.description}" started`);
    return this.snapshot(record);
  }

  get(taskId: string): BackgroundTaskSnapshot | undefined {
    const record = this.tasks.get(this.resolveTaskId(taskId));
    return record ? this.snapshot(record) : undefined;
  }

  list(): BackgroundTaskSnapshot[] {
    return [...this.tasks.values()].map((record) => this.snapshot(record));
  }

  running(): BackgroundTaskSnapshot[] {
    return this.list().filter((task) => task.status === "running");
  }

  appendOutput(taskId: string, chunk: string): BackgroundTaskSnapshot {
    const record = this.requireTask(taskId);
    const output = this.outputs.get(record.id) ?? { content: "", totalBytes: 0 };
    output.content += chunk;
    if (output.content.length > MAX_OUTPUT_CHARS) {
      const removed = output.content.length - MAX_OUTPUT_CHARS;
      output.content = output.content.slice(-MAX_OUTPUT_CHARS);
      record.outputOffset = Math.max(0, record.outputOffset - removed);
    }
    output.totalBytes += Buffer.byteLength(chunk, "utf8");
    this.outputs.set(record.id, output);
    this.pushNotification("progress", record, `Task "${record.description}" produced output`, chunk);
    return this.snapshot(record);
  }

  readOutput(taskId: string): string {
    const record = this.requireTask(taskId);
    return this.outputs.get(record.id)?.content ?? "";
  }

  takeOutputDelta(taskId: string): { readonly content: string; readonly newOffset: number } {
    const record = this.requireTask(taskId);
    const content = this.outputs.get(record.id)?.content ?? "";
    const delta = content.slice(record.outputOffset);
    record.outputOffset = content.length;
    return { content: delta, newOffset: record.outputOffset };
  }

  markRunning(taskId: string, metadata?: Readonly<Record<string, unknown>>): BackgroundTaskSnapshot {
    const record = this.requireTask(taskId);
    if (!isTerminalTaskStatus(record.status)) {
      record.status = "running";
      if (metadata !== undefined) {
        record.metadata = { ...(record.metadata ?? {}), ...metadata };
      }
    }
    return this.snapshot(record);
  }

  updateAgentProgress(taskId: string, progress: AgentProgress): BackgroundTaskSnapshot {
    const record = this.requireTask(taskId);
    if (!isTerminalTaskStatus(record.status)) {
      const summary = record.progress?.summary;
      record.progress = summary ? { ...progress, summary } : progress;
    }
    return this.snapshot(record);
  }

  updateAgentSummary(taskId: string, summary: string): BackgroundTaskSnapshot {
    const record = this.requireTask(taskId);
    if (!isTerminalTaskStatus(record.status)) {
      record.progress = {
        ...record.progress,
        toolUseCount: record.progress?.toolUseCount ?? 0,
        tokenCount: record.progress?.tokenCount ?? 0,
        summary,
      };
      this.pushNotification(
        "progress",
        record,
        `Task "${record.description}" summary updated`,
      );
    }
    return this.snapshot(record);
  }

  complete(
    taskId: string,
    output?: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): BackgroundTaskSnapshot {
    return this.finish(taskId, "completed", {
      output,
      metadata,
      summaryStatus: "completed successfully",
    });
  }

  fail(
    taskId: string,
    error: unknown,
    output?: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): BackgroundTaskSnapshot {
    return this.finish(taskId, "failed", {
      output,
      metadata,
      error: toErrorMessage(error),
      summaryStatus: "failed",
    });
  }

  async stop(taskId: string, reason = "stopped"): Promise<BackgroundTaskSnapshot> {
    const record = this.requireTask(taskId);
    if (record.status !== "running" && record.status !== "pending") {
      throw new BackgroundTaskError(
        `task ${taskId} is not running (status: ${record.status})`,
        "not_running",
      );
    }

    let stopError: unknown;
    try {
      if (!record.abortController?.signal.aborted) {
        record.abortController?.abort(reason);
      }
      await record.onStop?.(reason);
    } catch (error) {
      stopError = error;
    }

    // Always transition the task to a terminal state, even when onStop throws.
    // Otherwise the task would stay `running` forever and a blocking
    // TaskOutput would hang (zombie task).
    const snapshot = this.finish(taskId, "killed", {
      error: stopError !== undefined ? toErrorMessage(stopError) : reason,
      summaryStatus: "was stopped",
    });

    if (stopError !== undefined) {
      throw new BackgroundTaskError(
        `task ${taskId} stop failed: ${toErrorMessage(stopError)}`,
        "stop_failed",
      );
    }

    return snapshot;
  }

  bindPromise<T>(
    taskId: string,
    promise: Promise<T>,
    options: BindTaskPromiseOptions<T> = {},
  ): void {
    void promise
      .then(
        async (value) => {
          // onFulfilled may be async (e.g. the agent-thread mapper
          // dispatches SubagentStop hooks and appends their feedback
          // to the completion output the parent reads).
          const mapped = await options.onFulfilled?.(value);
          const status = mapped?.status ?? "completed";
          if (status === "failed") {
            const snapshot = this.fail(
              taskId,
              mapped?.error ?? "task failed",
              mapped?.output,
              mapped?.metadata,
            );
            options.onSnapshot?.(snapshot);
            return;
          }
          const snapshot = this.complete(taskId, mapped?.output, mapped?.metadata);
          options.onSnapshot?.(snapshot);
        },
        (error) => {
          const mapped = options.onRejected?.(error);
          const snapshot = this.fail(
            taskId,
            mapped?.error ?? error,
            mapped?.output,
            mapped?.metadata,
          );
          options.onSnapshot?.(snapshot);
        },
      )
      // A task can be evicted before its join promise settles; in that case the
      // lifecycle transition throws BackgroundTaskError("not_found"). Swallow it
      // so a late settle against an evicted task cannot escape as an unhandled
      // rejection.
      .catch(() => {});
  }

  drainNotifications(): BackgroundTaskNotification[] {
    const drained = this.notifications.splice(0, this.notifications.length);
    for (const notification of drained) {
      const record = this.tasks.get(notification.task.id);
      if (record && isTerminalTaskStatus(record.status)) {
        record.notified = true;
      }
    }
    return drained;
  }

  evictNotifiedTerminalTasks(): string[] {
    const evicted: string[] = [];
    for (const [taskId, task] of this.tasks) {
      if (!task.notified || !isTerminalTaskStatus(task.status)) {
        continue;
      }
      this.deleteTaskRecord(taskId);
      evicted.push(taskId);
    }
    return evicted;
  }

  private finish(
    taskId: string,
    status: Extract<BackgroundTaskStatus, "completed" | "failed" | "killed">,
    params: {
      readonly output?: string;
      readonly error?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
      readonly summaryStatus: string;
    },
  ): BackgroundTaskSnapshot {
    const record = this.requireTask(taskId);
    if (isTerminalTaskStatus(record.status)) {
      return this.snapshot(record);
    }
    if (params.output !== undefined) {
      this.appendOutput(taskId, params.output);
    }
    record.status = status;
    record.endedAtMs = Date.now();
    if (params.error !== undefined) {
      record.error = params.error;
    }
    if (params.metadata !== undefined) {
      record.metadata = { ...(record.metadata ?? {}), ...params.metadata };
    }
    this.pushNotification(
      status,
      record,
      `Task "${record.description}" ${params.summaryStatus}`,
    );
    this.evictOldTerminalTasks();
    return this.snapshot(record);
  }

  private evictOldTerminalTasks(): void {
    const terminal = [...this.tasks.values()]
      .filter((task) => isTerminalTaskStatus(task.status))
      .sort((left, right) => (left.endedAtMs ?? 0) - (right.endedAtMs ?? 0));
    const excess = terminal.length - MAX_RETAINED_TERMINAL_TASKS;
    if (excess <= 0) return;
    for (const task of terminal.slice(0, excess)) {
      this.deleteTaskRecord(task.id);
    }
  }

  private requireTask(taskId: string): MutableTaskRecord {
    const record = this.tasks.get(this.resolveTaskId(taskId));
    if (!record) {
      throw new BackgroundTaskError(`task ${taskId} not found`, "not_found");
    }
    return record;
  }

  private resolveTaskId(taskId: string): string {
    return this.tasks.has(taskId) ? taskId : this.aliases.get(taskId) ?? taskId;
  }

  private deleteTaskRecord(taskId: string): void {
    this.tasks.delete(taskId);
    this.outputs.delete(taskId);
    for (const [alias, targetId] of this.aliases) {
      if (targetId === taskId || alias === taskId) {
        this.aliases.delete(alias);
      }
    }
  }

  private snapshot(record: MutableTaskRecord): BackgroundTaskSnapshot {
    const output = this.outputs.get(record.id);
    return {
      id: record.id,
      type: record.type,
      status: record.status,
      description: record.description,
      startedAtMs: record.startedAtMs,
      output: {
        uri: record.outputUri,
        bytes: output?.totalBytes ?? 0,
      },
      outputOffset: record.outputOffset,
      notified: record.notified,
      ...(record.toolUseId !== undefined ? { toolUseId: record.toolUseId } : {}),
      ...(record.endedAtMs !== undefined ? { endedAtMs: record.endedAtMs } : {}),
      ...(record.source !== undefined ? { source: record.source } : {}),
      ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
      ...(record.progress !== undefined ? { progress: record.progress } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }

  private pushNotification(
    kind: BackgroundTaskNotificationKind,
    record: MutableTaskRecord,
    summary: string,
    delta?: string,
  ): void {
    this.notifications.push({
      kind,
      task: this.snapshot(record),
      summary,
      atMs: Date.now(),
      ...(delta !== undefined ? { delta } : {}),
    });
    const excess = this.notifications.length - MAX_RETAINED_NOTIFICATIONS;
    if (excess > 0) {
      this.notifications.splice(0, excess);
    }
  }
}
