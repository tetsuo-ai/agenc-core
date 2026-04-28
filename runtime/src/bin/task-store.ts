/**
 * Local task-board storage for the durable `Task*` model-facing tools.
 *
 * Per-project, one JSON file per task, atomic create + update.
 *
 *   <agencHome>/projects/<slug>/tasks/<id>.json
 *   <agencHome>/projects/<slug>/tasks/.counter.json
 *
 * The per-task file existence (under O_EXCL) is the authoritative
 * collision check for ID allocation. The counter file is a hint that
 * eventually settles to `max(seq)+1`. Two concurrent creators both
 * attempting `task-N` will see one win and the other retry with `N+1`.
 *
 * @module
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  readonly removeBlocks?: readonly string[];
  readonly addBlockedBy?: readonly string[];
  readonly removeBlockedBy?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

const COUNTER_FILE = ".counter.json";
const ID_PREFIX = "task-";
const ID_RE = /^task-\d+$/;
// Cap retries so a pathological caller can never spin forever; in
// practice O_EXCL allocation converges in 1-2 attempts even under
// heavy contention.
const MAX_ALLOC_ATTEMPTS = 64;

function resolveAgencHome(opts: TaskStoreOptions): string {
  return opts.agencHome ?? join(homedir(), ".agenc");
}

export function tasksDir(opts: TaskStoreOptions): string {
  const root = findProjectRootSync(opts.workspaceRoot);
  const slugInput = root ? root.rootDir : opts.workspaceRoot;
  return join(resolveAgencHome(opts), "projects", slugifyCwd(slugInput), "tasks");
}

function counterFile(opts: TaskStoreOptions): string {
  return join(tasksDir(opts), COUNTER_FILE);
}

function taskFilePath(opts: TaskStoreOptions, id: string): string {
  return join(tasksDir(opts), `${id}.json`);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function readCounter(opts: TaskStoreOptions): Promise<number> {
  try {
    const raw = await readFile(counterFile(opts), "utf8");
    const parsed = JSON.parse(raw) as { nextSeq?: unknown };
    if (typeof parsed.nextSeq === "number" && Number.isInteger(parsed.nextSeq) && parsed.nextSeq >= 1) {
      return parsed.nextSeq;
    }
    return 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 1;
    throw error;
  }
}

async function writeCounter(opts: TaskStoreOptions, nextSeq: number): Promise<void> {
  await atomicWriteJson(counterFile(opts), { nextSeq });
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

function applyEdgeEdit(
  current: readonly string[],
  add: readonly string[] | undefined,
  remove: readonly string[] | undefined,
): string[] {
  const removeSet = new Set(remove ?? []);
  const filtered = current.filter((id) => !removeSet.has(id));
  const merged = [...filtered, ...(add ?? [])];
  return dedupePreserveOrder(merged);
}

export async function loadOne(
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
    if (!entry.endsWith(".json") || entry === COUNTER_FILE) continue;
    const id = entry.slice(0, -".json".length);
    if (!ID_RE.test(id)) continue;
    const task = await loadOne(opts, id);
    if (task !== null) tasks.push(task);
  }
  return tasks;
}

export async function createNew(
  opts: TaskStoreOptions,
  input: CreateTaskInput,
): Promise<StoredTask> {
  const dir = tasksDir(opts);
  await mkdir(dir, { recursive: true });

  let nextSeq = await readCounter(opts);
  for (let attempt = 0; attempt < MAX_ALLOC_ATTEMPTS; attempt += 1) {
    const id = `${ID_PREFIX}${nextSeq}`;
    const path = taskFilePath(opts, id);
    const now = new Date().toISOString();
    const task: StoredTask = {
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
    try {
      await writeFile(path, `${JSON.stringify(task, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      // Best-effort counter update; if this races, the next reader
      // recovers via the same retry path on its first allocation.
      await writeCounter(opts, nextSeq + 1);
      return task;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        nextSeq += 1;
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `task id allocation exhausted after ${MAX_ALLOC_ATTEMPTS} attempts`,
  );
}

export interface UpdateOutcome {
  readonly task?: StoredTask;
  readonly error?: {
    readonly message: string;
    readonly missing?: readonly string[];
  };
}

export async function updateOne(
  opts: TaskStoreOptions,
  id: string,
  input: UpdateTaskInput,
): Promise<UpdateOutcome> {
  const existing = await loadOne(opts, id);
  if (!existing) {
    return { error: { message: "Task not found" } };
  }

  const addBlocks = input.addBlocks ?? [];
  const addBlockedBy = input.addBlockedBy ?? [];

  if (addBlocks.includes(id) || addBlockedBy.includes(id)) {
    return { error: { message: "Self-reference is not a valid dependency edge" } };
  }

  const newRefs = dedupePreserveOrder([...addBlocks, ...addBlockedBy]);
  const refsToCheck = newRefs.filter((ref) => ref !== id);
  if (refsToCheck.length > 0) {
    const missing: string[] = [];
    for (const ref of refsToCheck) {
      const target = await loadOne(opts, ref);
      if (target === null || target.status === "deleted") {
        missing.push(ref);
      }
    }
    if (missing.length > 0) {
      return { error: { message: "Unknown task reference", missing } };
    }
  }

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
  draft.blocks = applyEdgeEdit(existing.blocks, input.addBlocks, input.removeBlocks);
  draft.blockedBy = applyEdgeEdit(
    existing.blockedBy,
    input.addBlockedBy,
    input.removeBlockedBy,
  );
  if (input.metadata !== undefined) {
    draft.metadata = {
      ...(isObjectLiteral(existing.metadata) ? existing.metadata : {}),
      ...input.metadata,
    };
  }
  draft.updatedAt = new Date().toISOString();

  const next = draft as unknown as StoredTask;
  await atomicWriteJson(taskFilePath(opts, id), next);
  return { task: next };
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
