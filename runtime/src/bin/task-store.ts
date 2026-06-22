/**
 * Local task-board storage for the durable `Task*` model-facing tools.
 *
 * Per-project, one JSON file per task, plus a list-level `.lock` and a
 * `.highwatermark` (bare integer) that tracks the maximum task id ever
 * assigned. Deleted ids never recycle.
 *
 *   <agencHome>/projects/<slug>/tasks/<id>.json     // bare numeric id
 *   <agencHome>/projects/<slug>/tasks/.lock         // proper-lockfile
 *   <agencHome>/projects/<slug>/tasks/.highwatermark
 *
 * Locking model mirrors agenc `src/utils/tasks.ts`: every mutation
 * acquires `proper-lockfile.lock(.lock, retries…)` for the whole list,
 * does its read+write+auto-mirror, then releases. Reads do not lock.
 *
 * Auto-mirror: `addBlocks` / `addBlockedBy` fan out via `blockTask`,
 * which writes both endpoint files inside the same critical section, so
 * the graph is always consistent. There are no remove verbs — the way
 * to clear an edge is to mark the blocker `completed` or delete it.
 *
 * @module
 */

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { lock as acquireLock } from "../utils/lockfile.js";
import { isRecord } from "../utils/record.js";
import { createSignal } from "../utils/signal.js";
import { slugifyCwd, findProjectRootSync } from "../session/session-store.js";

export type TaskStatus = "pending" | "in_progress" | "completed";
export type TaskUpdateStatus = TaskStatus | "deleted";

export interface StoredTask {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly activeForm?: string;
  readonly status: TaskStatus;
  readonly owner?: string;
  readonly blocks: readonly string[];
  readonly blockedBy: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export interface TaskStoreOptions {
  readonly workspaceRoot: string;
  readonly agencHome?: string;
}

export interface ListedTask extends StoredTask {
  readonly unresolvedBlockers: readonly string[];
}

export interface CreateTaskInput {
  readonly subject: string;
  readonly description?: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  readonly subject?: string;
  readonly description?: string;
  readonly activeForm?: string;
  readonly status?: TaskUpdateStatus;
  readonly owner?: string | null;
  readonly addBlocks?: readonly string[];
  readonly addBlockedBy?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

const HIGH_WATER_MARK_FILE = ".highwatermark";
const LOCK_FILE = ".lock";
const ID_RE = /^\d+$/;

// Lock options sized for ~10+ concurrent agents under list-level
// serialization (mirrors agenc `src/utils/tasks.ts:LOCK_OPTIONS`).
// Each critical section does readdir + N×readFile + writeFile (~50-100ms
// on slow disks); 30 retries × 5–100ms backoff gives ~2.6s total wait
// for the last caller in a 10-way race.
const LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
};

// Pure event signal so TUI consumers can re-read tasks immediately
// after a mutation in the same process. Mirrors agenc
// `tasksUpdated` in `src/utils/tasks.ts`.
const tasksUpdated = createSignal();

// Fires on create only. Separate from `tasksUpdated` so consumers
// (e.g. the TUI auto-expand on the task panel) can react to task
// creation without flapping on every status edit.
const taskCreated = createSignal<[StoredTask]>();

function notifyTasksUpdated(): void {
  // Listener errors must not propagate to the mutation caller.
  try {
    tasksUpdated.emit();
  } catch {
    // Swallow listener errors.
  }
}

function notifyTaskCreated(task: StoredTask): void {
  try {
    taskCreated.emit(task);
  } catch {
    // Swallow listener errors.
  }
}

function resolveAgencHome(opts: TaskStoreOptions): string {
  return opts.agencHome ?? join(homedir(), ".agenc");
}

export function tasksDir(opts: TaskStoreOptions): string {
  const root = findProjectRootSync(opts.workspaceRoot);
  const slugInput = root ? root.rootDir : opts.workspaceRoot;
  return join(resolveAgencHome(opts), "projects", slugifyCwd(slugInput), "tasks");
}

function highWaterMarkPath(opts: TaskStoreOptions): string {
  return join(tasksDir(opts), HIGH_WATER_MARK_FILE);
}

function lockPath(opts: TaskStoreOptions): string {
  return join(tasksDir(opts), LOCK_FILE);
}

function taskFilePath(opts: TaskStoreOptions, id: string): string {
  return join(tasksDir(opts), `${id}.json`);
}

async function ensureTasksDir(opts: TaskStoreOptions): Promise<void> {
  await mkdir(tasksDir(opts), { recursive: true });
}

async function ensureLockTarget(opts: TaskStoreOptions): Promise<string> {
  await ensureTasksDir(opts);
  const path = lockPath(opts);
  // proper-lockfile requires the target file to exist. Create with 'wx'
  // so concurrent callers don't both create it; first creator wins
  // silently, the rest see EEXIST and proceed.
  try {
    await writeFile(path, "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return path;
}

async function withListLock<T>(
  opts: TaskStoreOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const target = await ensureLockTarget(opts);
  const release = await acquireLock(target, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function readHighWaterMark(opts: TaskStoreOptions): Promise<number> {
  try {
    const raw = (await readFile(highWaterMarkPath(opts), "utf8")).trim();
    const value = Number.parseInt(raw, 10);
    return Number.isNaN(value) || value < 0 ? 0 : value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function writeHighWaterMark(
  opts: TaskStoreOptions,
  value: number,
): Promise<void> {
  await writeFile(highWaterMarkPath(opts), String(value), "utf8");
}

async function findHighestTaskIdFromFiles(opts: TaskStoreOptions): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(tasksDir(opts));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let highest = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!ID_RE.test(id)) continue;
    const value = Number.parseInt(id, 10);
    if (value > highest) highest = value;
  }
  return highest;
}

async function findHighestTaskId(opts: TaskStoreOptions): Promise<number> {
  const [fromFiles, fromMark] = await Promise.all([
    findHighestTaskIdFromFiles(opts),
    readHighWaterMark(opts),
  ]);
  return Math.max(fromFiles, fromMark);
}

function dedupePreserveOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function isStoredTask(value: unknown): value is StoredTask {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    ID_RE.test(value.id) &&
    typeof value.subject === "string" &&
    typeof value.description === "string" &&
    (value.activeForm === undefined || typeof value.activeForm === "string") &&
    isTaskStatus(value.status) &&
    (value.owner === undefined || typeof value.owner === "string") &&
    Array.isArray(value.blocks) &&
    value.blocks.every((entry) => typeof entry === "string") &&
    Array.isArray(value.blockedBy) &&
    value.blockedBy.every((entry) => typeof entry === "string") &&
    (value.metadata === undefined || isRecord(value.metadata))
  );
}

async function loadOneNoLock(
  opts: TaskStoreOptions,
  id: string,
): Promise<StoredTask | null> {
  if (!ID_RE.test(id)) return null;
  try {
    const raw = await readFile(taskFilePath(opts, id), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.status === "deleted") return null;
    return isStoredTask(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeTaskNoLock(
  opts: TaskStoreOptions,
  task: StoredTask,
): Promise<void> {
  await writeFile(
    taskFilePath(opts, task.id),
    `${JSON.stringify(task, null, 2)}\n`,
    "utf8",
  );
}

export async function loadOne(
  opts: TaskStoreOptions,
  id: string,
): Promise<StoredTask | null> {
  return loadOneNoLock(opts, id);
}

export async function loadAll(opts: TaskStoreOptions): Promise<StoredTask[]> {
  const dir = tasksDir(opts);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const tasks: StoredTask[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!ID_RE.test(id)) continue;
    const task = await loadOneNoLock(opts, id);
    if (task !== null) tasks.push(task);
  }
  return tasks;
}

export async function createNew(
  opts: TaskStoreOptions,
  input: CreateTaskInput,
): Promise<StoredTask> {
  await ensureTasksDir(opts);
  const task = await withListLock(opts, async () => {
    const highest = await findHighestTaskId(opts);
    const next = highest + 1;
    const id = String(next);
    const created: StoredTask = {
      id,
      subject: input.subject,
      description: input.description ?? "",
      ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
      status: "pending",
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      blocks: [],
      blockedBy: [],
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    await writeTaskNoLock(opts, created);
    await writeHighWaterMark(opts, next);
    return created;
  });
  notifyTaskCreated(task);
  notifyTasksUpdated();
  return task;
}

export interface UpdateOutcome {
  readonly task?: StoredTask;
  readonly deleted?: boolean;
  readonly error?: {
    readonly message: string;
    readonly missing?: readonly string[];
  };
}

async function applyFieldUpdates(
  existing: StoredTask,
  input: UpdateTaskInput,
): Promise<StoredTask> {
  const draft: Record<string, unknown> = { ...existing };
  if (input.subject !== undefined) draft.subject = input.subject;
  if (input.description !== undefined) draft.description = input.description;
  if (input.activeForm !== undefined) draft.activeForm = input.activeForm;
  if (input.status !== undefined) draft.status = input.status;
  if (input.owner === null) {
    delete draft.owner;
  } else if (input.owner !== undefined) {
    draft.owner = input.owner;
  }
  if (input.metadata !== undefined) {
    const metadata = {
      ...(isRecord(existing.metadata) ? existing.metadata : {}),
    };
    for (const [key, value] of Object.entries(input.metadata)) {
      if (value === null) {
        delete metadata[key];
      } else {
        metadata[key] = value;
      }
    }
    draft.metadata = metadata;
  }
  return draft as unknown as StoredTask;
}

/**
 * Add a "from blocks to" edge with auto-mirror, under the list lock.
 * Mutates both endpoint files atomically: from.blocks += to and
 * to.blockedBy += from. Idempotent — if the edge already exists, no-op.
 *
 * Mirrors agenc `blockTask` (`src/utils/tasks.ts:458`).
 */
async function blockTaskNoLock(
  opts: TaskStoreOptions,
  fromId: string,
  toId: string,
): Promise<{ ok: true } | { ok: false; missing: readonly string[] }> {
  const [from, to] = await Promise.all([
    loadOneNoLock(opts, fromId),
    loadOneNoLock(opts, toId),
  ]);
  const missing: string[] = [];
  if (from === null) missing.push(fromId);
  if (to === null) missing.push(toId);
  if (missing.length > 0 || !from || !to) return { ok: false, missing };

  if (!from.blocks.includes(toId)) {
    const updatedFrom: StoredTask = {
      ...from,
      blocks: dedupePreserveOrder([...from.blocks, toId]),
    };
    await writeTaskNoLock(opts, updatedFrom);
  }
  if (!to.blockedBy.includes(fromId)) {
    const updatedTo: StoredTask = {
      ...to,
      blockedBy: dedupePreserveOrder([...to.blockedBy, fromId]),
    };
    await writeTaskNoLock(opts, updatedTo);
  }
  return { ok: true };
}

export async function updateOne(
  opts: TaskStoreOptions,
  id: string,
  input: UpdateTaskInput,
): Promise<UpdateOutcome> {
  const result = await withListLock(opts, async (): Promise<UpdateOutcome> => {
    const existing = await loadOneNoLock(opts, id);
    if (!existing) return { error: { message: "Task not found" } };

    if (input.status === "deleted") {
      const deleted = await deleteTaskNoLock(opts, existing);
      return deleted
        ? { deleted: true }
        : { error: { message: "Failed to delete task" } };
    }

    const addBlocks = input.addBlocks ?? [];
    const addBlockedBy = input.addBlockedBy ?? [];
    if (addBlocks.includes(id) || addBlockedBy.includes(id)) {
      return { error: { message: "Self-reference is not a valid dependency edge" } };
    }

    const refs = dedupePreserveOrder([...addBlocks, ...addBlockedBy]);
    const missingRefs: string[] = [];
    for (const ref of refs) {
      if (ref === id) continue;
      const referenced = await loadOneNoLock(opts, ref);
      if (referenced === null) missingRefs.push(ref);
    }
    if (missingRefs.length > 0) {
      return {
        error: {
          message: "Unknown task reference",
          missing: dedupePreserveOrder(missingRefs),
        },
      };
    }

    let working = existing;
    const fieldsChanged =
      input.subject !== undefined ||
      input.description !== undefined ||
      input.activeForm !== undefined ||
      input.status !== undefined ||
      input.owner !== undefined ||
      input.metadata !== undefined;
    if (fieldsChanged) {
      working = await applyFieldUpdates(existing, input);
      await writeTaskNoLock(opts, working);
    }

    // Edge auto-mirror: addBlocks=[X] means "self blocks X"; addBlockedBy=[X]
    // means "X blocks self". Both routes through blockTaskNoLock.
    const allMissing: string[] = [];
    for (const target of addBlocks) {
      const result = await blockTaskNoLock(opts, id, target);
      if (!result.ok) allMissing.push(...result.missing);
    }
    for (const blocker of addBlockedBy) {
      const result = await blockTaskNoLock(opts, blocker, id);
      if (!result.ok) allMissing.push(...result.missing);
    }
    if (allMissing.length > 0) {
      const unique = dedupePreserveOrder(allMissing).filter((entry) => entry !== id);
      if (unique.length > 0) {
        return {
          error: { message: "Unknown task reference", missing: unique },
        };
      }
    }

    // Re-read self because blockTaskNoLock may have appended to
    // self.blocks (when addBlocks was used) or self.blockedBy (when
    // addBlockedBy was used) on the auto-mirror side.
    const final = await loadOneNoLock(opts, id);
    return { task: final ?? working };
  });
  if (result.task || result.deleted) notifyTasksUpdated();
  return result;
}

async function deleteTaskNoLock(
  opts: TaskStoreOptions,
  task: StoredTask,
): Promise<boolean> {
  const numericId = Number.parseInt(task.id, 10);
  if (!Number.isNaN(numericId)) {
    const current = await readHighWaterMark(opts);
    if (numericId > current) await writeHighWaterMark(opts, numericId);
  }

  try {
    await unlink(taskFilePath(opts, task.id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  const all = await loadAll(opts);
  for (const other of all) {
    const blocks = other.blocks.filter((entry) => entry !== task.id);
    const blockedBy = other.blockedBy.filter((entry) => entry !== task.id);
    if (
      blocks.length !== other.blocks.length ||
      blockedBy.length !== other.blockedBy.length
    ) {
      await writeTaskNoLock(opts, {
        ...other,
        blocks,
        blockedBy,
      });
    }
  }

  return true;
}

export async function deleteTask(
  opts: TaskStoreOptions,
  id: string,
): Promise<{ readonly deleted: boolean }> {
  const result = await withListLock(opts, async () => {
    const existing = await loadOneNoLock(opts, id);
    if (!existing) return false;
    return deleteTaskNoLock(opts, existing);
  });
  if (result) notifyTasksUpdated();
  return { deleted: result };
}

export function deriveUnresolvedBlockers(
  task: StoredTask,
  byId: ReadonlyMap<string, StoredTask>,
): string[] {
  const out: string[] = [];
  for (const blockerId of task.blockedBy) {
    const blocker = byId.get(blockerId);
    if (!blocker) continue;
    if (blocker.status === "completed") continue;
    out.push(blockerId);
  }
  return out;
}

export function onTasksUpdated(listener: () => void): () => void {
  return tasksUpdated.subscribe(listener);
}

export async function listWithUnresolved(
  opts: TaskStoreOptions,
  filter: { readonly status?: TaskStatus } = {},
): Promise<ListedTask[]> {
  const all = await loadAll(opts);
  const byId = new Map(all.map((task) => [task.id, task] as const));
  const out: ListedTask[] = [];
  for (const task of all) {
    if (filter.status !== undefined) {
      if (task.status !== filter.status) continue;
    }
    out.push({
      ...task,
      unresolvedBlockers: deriveUnresolvedBlockers(task, byId),
    });
  }
  return out;
}
