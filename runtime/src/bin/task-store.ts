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
 * Locking model mirrors openclaude `src/utils/tasks.ts`: every mutation
 * acquires `proper-lockfile.lock(.lock, retries…)` for the whole list,
 * does its read+write+auto-mirror, then releases. Reads do not lock.
 *
 * Auto-mirror: `addBlocks` / `addBlockedBy` fan out via `blockTask`,
 * which writes both endpoint files inside the same critical section, so
 * the graph is always consistent. There are no remove verbs — the way
 * to clear an edge is to mark the blocker `completed` or `deleted`.
 *
 * @module
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { lock as acquireLock } from "../utils/lockfile.js";
import { createSignal } from "../utils/signal.js";
import { slugifyCwd, findProjectRootSync } from "../session/session-store.js";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

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
  readonly createdAt: string;
  readonly updatedAt: string;
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
  readonly status?: TaskStatus;
  readonly owner?: string | null;
  readonly addBlocks?: readonly string[];
  readonly addBlockedBy?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

const HIGH_WATER_MARK_FILE = ".highwatermark";
const LOCK_FILE = ".lock";
const ID_RE = /^\d+$/;

// Lock options sized for ~10+ concurrent agents under list-level
// serialization (mirrors openclaude `src/utils/tasks.ts:LOCK_OPTIONS`).
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
// after a mutation in the same process. Mirrors openclaude
// `tasksUpdated` in `src/utils/tasks.ts`.
const tasksUpdated = createSignal();
export const onTasksUpdated = tasksUpdated.subscribe;

function notifyTasksUpdated(): void {
  // Listener errors must not propagate to the mutation caller.
  try {
    tasksUpdated.emit();
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

function isObjectLiteral(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function loadOneNoLock(
  opts: TaskStoreOptions,
  id: string,
): Promise<StoredTask | null> {
  if (!ID_RE.test(id)) return null;
  try {
    const raw = await readFile(taskFilePath(opts, id), "utf8");
    return JSON.parse(raw) as StoredTask;
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
    const now = new Date().toISOString();
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
      createdAt: now,
      updatedAt: now,
    };
    await writeTaskNoLock(opts, created);
    await writeHighWaterMark(opts, next);
    return created;
  });
  notifyTasksUpdated();
  return task;
}

export interface UpdateOutcome {
  readonly task?: StoredTask;
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
    draft.metadata = {
      ...(isObjectLiteral(existing.metadata) ? existing.metadata : {}),
      ...input.metadata,
    };
  }
  draft.updatedAt = new Date().toISOString();
  return draft as unknown as StoredTask;
}

/**
 * Add a "from blocks to" edge with auto-mirror, under the list lock.
 * Mutates both endpoint files atomically: from.blocks += to and
 * to.blockedBy += from. Idempotent — if the edge already exists, no-op.
 *
 * Mirrors openclaude `blockTask` (`src/utils/tasks.ts:458`).
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
  if (from === null || from.status === "deleted") missing.push(fromId);
  if (to === null || to.status === "deleted") missing.push(toId);
  if (missing.length > 0 || !from || !to) return { ok: false, missing };

  const now = new Date().toISOString();
  if (!from.blocks.includes(toId)) {
    const updatedFrom: StoredTask = {
      ...from,
      blocks: dedupePreserveOrder([...from.blocks, toId]),
      updatedAt: now,
    };
    await writeTaskNoLock(opts, updatedFrom);
  }
  if (!to.blockedBy.includes(fromId)) {
    const updatedTo: StoredTask = {
      ...to,
      blockedBy: dedupePreserveOrder([...to.blockedBy, fromId]),
      updatedAt: now,
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

    const addBlocks = input.addBlocks ?? [];
    const addBlockedBy = input.addBlockedBy ?? [];
    if (addBlocks.includes(id) || addBlockedBy.includes(id)) {
      return { error: { message: "Self-reference is not a valid dependency edge" } };
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
  if (result.task) notifyTasksUpdated();
  return result;
}

export async function deleteTask(
  opts: TaskStoreOptions,
  id: string,
): Promise<UpdateOutcome> {
  const result = await updateOne(opts, id, { status: "deleted" });
  return result;
}

export function deriveUnresolvedBlockers(
  task: StoredTask,
  byId: ReadonlyMap<string, StoredTask>,
): string[] {
  const out: string[] = [];
  for (const blockerId of task.blockedBy) {
    const blocker = byId.get(blockerId);
    if (!blocker) continue;
    if (blocker.status === "deleted") continue;
    if (blocker.status === "completed") continue;
    out.push(blockerId);
  }
  return out;
}

export async function listWithUnresolved(
  opts: TaskStoreOptions,
  filter: { readonly status?: TaskStatus; readonly includeDeleted?: boolean } = {},
): Promise<ListedTask[]> {
  const all = await loadAll(opts);
  const byId = new Map(all.map((task) => [task.id, task] as const));
  const out: ListedTask[] = [];
  for (const task of all) {
    if (filter.status !== undefined) {
      if (task.status !== filter.status) continue;
    } else if (task.status === "deleted" && !filter.includeDeleted) {
      continue;
    }
    out.push({
      ...task,
      unresolvedBlockers: deriveUnresolvedBlockers(task, byId),
    });
  }
  return out;
}
