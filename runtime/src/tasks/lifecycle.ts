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

import { logError } from "../utils/log.js";
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

interface TaskPromiseMapping {
  readonly output?: string;
  readonly error?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface TaskPromiseFulfillment extends TaskPromiseMapping {
  readonly status?: Extract<BackgroundTaskStatus, "completed" | "failed">;
}

export interface BindTaskPromiseOptions<T> {
  readonly onFulfilled?: (value: T) =>
    | TaskPromiseFulfillment
    | void
    | Promise<TaskPromiseFulfillment | void>;
  readonly onRejected?: (error: unknown) =>
    | TaskPromiseMapping
    | void
    | Promise<TaskPromiseMapping | void>;
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

function boundedTaskPromiseError(error: unknown): string {
  try {
    const message = toErrorMessage(error);
    const limit = 4096;
    const suffix = message.length > limit ? "...[truncated]" : "";
    // Copy the bounded prefix so it cannot retain a large backing string.
    return Buffer.from(message.slice(0, limit - suffix.length), "utf8")
      .toString("utf8") + suffix;
  } catch {
    return "Task failed with an unprintable error";
  }
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
  private readonly snapshotListeners = new Map<
    string,
    Set<(snapshot: BackgroundTaskSnapshot) => void>
  >();

  /**
   * IDs and aliases share one namespace. Names owned by terminal tasks may be
   * reclaimed; live owners remain reserved. Prepare and validate the complete
   * registration before removing any terminal owner or publishing new state.
   */
  register(input: RegisterBackgroundTaskInput): BackgroundTaskSnapshot {
    const id = input.id ?? generateBackgroundTaskId(input.type);
    const aliases = [...new Set(input.aliases ?? [])].filter(
      (alias) => alias.length > 0 && alias !== id,
    );
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

    // Input getters may run user code. Check ownership after all fields have
    // been read, with no callbacks between validation and the map updates.
    const terminalOwners = new Set<string>();
    for (const name of [id, ...aliases]) {
      const existing = this.tasks.get(this.resolveTaskId(name));
      if (!existing) continue;
      if (!isTerminalTaskStatus(existing.status)) {
        throw new BackgroundTaskError(
          `task ${name} already exists`,
          "already_exists",
        );
      }
      terminalOwners.add(existing.id);
    }
    for (const owner of terminalOwners) this.deleteTaskRecord(owner);
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

  /** Observe the canonical snapshot stream for an already-registered task. */
  subscribe(
    taskId: string,
    listener: (snapshot: BackgroundTaskSnapshot) => void,
  ): () => void {
    const record = this.requireTask(taskId);
    const listeners = this.snapshotListeners.get(record.id) ?? new Set();
    listeners.add(listener);
    this.snapshotListeners.set(record.id, listeners);
    return () => {
      const current = this.snapshotListeners.get(record.id);
      current?.delete(listener);
      if (current?.size === 0) this.snapshotListeners.delete(record.id);
    };
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
    return this.publish(record);
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
    return this.publish(record);
  }

  updateAgentProgress(taskId: string, progress: AgentProgress): BackgroundTaskSnapshot {
    const record = this.requireTask(taskId);
    if (!isTerminalTaskStatus(record.status)) {
      const summary = record.progress?.summary;
      record.progress = summary ? { ...progress, summary } : progress;
    }
    return this.publish(record);
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
    return this.publish(record);
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

  /** Record an externally observed terminal shutdown without invoking onStop. */
  kill(taskId: string, reason: string): BackgroundTaskSnapshot {
    return this.finish(taskId, "killed", {
      error: reason,
      summaryStatus: "was stopped",
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
    const record = this.tasks.get(this.resolveTaskId(taskId));
    // Keep identity without retaining an evicted record's metadata and handles
    // for the remaining lifetime of its backing promise.
    const binding = record === undefined
      ? undefined
      : { id: record.id, record: new WeakRef(record) };
    const settle = async (): Promise<void> => {
      let mapped: TaskPromiseFulfillment | void;
      let status: "completed" | "failed";
      let failure: unknown;
      try {
        const result = await promise.then(
          (value) => ({ kind: "fulfilled" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        if (result.kind === "fulfilled") {
          mapped = await options.onFulfilled?.(result.value);
          status = mapped?.status ?? "completed";
          failure = mapped?.error ?? "task failed";
        } else {
          mapped = await options.onRejected?.(result.error);
          status = "failed";
          failure = mapped?.error ?? result.error;
        }
      } catch (error) {
        mapped = undefined;
        status = "failed";
        failure = error;
      }

      if (binding === undefined) {
        throw new BackgroundTaskError(`task ${taskId} not found`, "not_found");
      }
      const current = this.tasks.get(binding.id);
      // Eviction is harmless, including replacement under the same ID or alias.
      // Any exception from a live transition or its observers is unexpected.
      if (current === undefined || current !== binding.record.deref()) return;
      const snapshot = status === "failed"
        ? this.fail(
            binding.id,
            boundedTaskPromiseError(failure),
            mapped?.output,
            mapped?.metadata,
          )
        : this.complete(binding.id, mapped?.output, mapped?.metadata);
      await options.onSnapshot?.(snapshot);
    };
    void settle().catch(logError);
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
    return this.publish(record);
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
    this.snapshotListeners.delete(taskId);
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

  private publish(record: MutableTaskRecord): BackgroundTaskSnapshot {
    const snapshot = this.snapshot(record);
    for (const listener of this.snapshotListeners.get(record.id) ?? []) {
      listener(snapshot);
    }
    return snapshot;
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
