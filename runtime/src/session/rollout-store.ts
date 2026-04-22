/**
 * Rollout-store — the publicly-consumed handle on the session rollout.
 *
 * SessionStore owns the on-disk state (flock, file handle, index);
 * RolloutStore is the event-log-facing facade that phases, sidecars,
 * and session.ts call into. Keeping them separate lets us swap
 * backends (file → S3-for-remote-agents) without touching callers.
 *
 * Also owns the 100ms batch flush scheduler. I-25 (snapshot is
 * best-effort, rollout is source of truth) is honored by treating
 * every snapshot write as advisory: if it fails, the rollout itself
 * still contains the truth.
 *
 * @module
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  AgentMetadata,
  AgentPath,
  ThreadId,
} from "../agents/registry.js";
import type { Event } from "./event-log.js";
import type { RolloutItem } from "./rollout-item.js";
import {
  SessionStore,
  SessionStoreFlushScheduler,
  type AppendOptions,
  type CompactionIndexSnapshot,
  type SessionStoreOpts,
} from "./session-store.js";

export interface RolloutStoreOpts extends SessionStoreOpts {
  /** Flush interval in ms. Default 100. */
  readonly flushIntervalMs?: number;
  /** Whether to auto-start the background flush scheduler. Default true. */
  readonly autoStartScheduler?: boolean;
}

export type ThreadSpawnEdgeStatus = "open" | "closed";

export interface ThreadSpawnEdgeRecord {
  readonly childThreadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly parentPath: AgentPath;
  readonly metadata: AgentMetadata;
  readonly status: ThreadSpawnEdgeStatus;
}

interface ThreadSpawnEdgeSnapshot {
  readonly version: number;
  readonly edges: ReadonlyArray<ThreadSpawnEdgeRecord>;
}

const THREAD_SPAWN_EDGE_SNAPSHOT_VERSION = 1;

export class RolloutStore {
  readonly store: SessionStore;
  private readonly scheduler: SessionStoreFlushScheduler;
  private readonly startScheduler: boolean;
  readonly projectRootMarkers?: readonly string[];
  private readonly threadSpawnEdgePath: string;
  private readonly threadSpawnEdges = new Map<ThreadId, ThreadSpawnEdgeRecord>();

  constructor(opts: RolloutStoreOpts) {
    this.store = new SessionStore(opts);
    this.scheduler = new SessionStoreFlushScheduler(
      this.store,
      opts.flushIntervalMs ?? 100,
    );
    this.startScheduler = opts.autoStartScheduler !== false;
    this.projectRootMarkers = opts.projectRootMarkers;
    this.threadSpawnEdgePath = join(
      this.store.sessionDir,
      "thread-spawn-edges.json",
    );
    this.loadThreadSpawnEdgesSnapshot();
  }

  open(meta: Parameters<SessionStore["open"]>[0]): void {
    this.store.open(meta);
    if (this.startScheduler) this.scheduler.start();
  }

  append(event: Event, opts: AppendOptions = {}): void {
    this.store.append(event, opts);
  }

  appendRollout(item: RolloutItem, opts: AppendOptions = {}): void {
    this.store.appendRollout(item, opts);
  }

  readAll(): RolloutItem[] {
    return this.store.readAll();
  }

  get rolloutPath(): string {
    return this.store.rolloutPath;
  }

  get sessionId(): string {
    return this.store.sessionId;
  }

  get isDegraded(): boolean {
    return this.store.isDegraded;
  }

  /** I-88 — read the per-turn tool-result-bytes index. */
  getToolResultBytes(turnId: string): number {
    return this.store.getToolResultBytes(turnId);
  }

  /** I-88 — snapshot the full index (used by compaction). */
  getToolResultBytesIndexSnapshot(): ReadonlyMap<string, number> {
    return this.store.getToolResultBytesIndexSnapshot();
  }

  getTokenEstimate(turnId: string): number {
    return this.store.getTokenEstimate(turnId);
  }

  getTokenEstimateIndexSnapshot(): ReadonlyMap<string, number> {
    return this.store.getTokenEstimateIndexSnapshot();
  }

  getToolCallTurnIdSnapshot(): ReadonlyMap<string, string> {
    return this.store.getToolCallTurnIdSnapshot();
  }

  getCompactionIndexSnapshot(): CompactionIndexSnapshot {
    return this.store.getCompactionIndexSnapshot();
  }

  upsertThreadSpawnEdge(edge: ThreadSpawnEdgeRecord): void {
    this.threadSpawnEdges.set(edge.childThreadId, cloneThreadSpawnEdge(edge));
    this.persistThreadSpawnEdgesSnapshot();
  }

  setThreadSpawnEdgeStatus(
    childThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): void {
    const existing = this.threadSpawnEdges.get(childThreadId);
    if (!existing || existing.status === status) {
      return;
    }
    this.threadSpawnEdges.set(childThreadId, {
      ...existing,
      status,
      metadata: cloneAgentMetadata(existing.metadata),
    });
    this.persistThreadSpawnEdgesSnapshot();
  }

  listThreadSpawnChildrenWithStatus(
    parentThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return Array.from(this.threadSpawnEdges.values())
      .filter((edge) => edge.parentThreadId === parentThreadId)
      .filter((edge) => edge.status === status)
      .sort(compareThreadSpawnEdges)
      .map((edge) => cloneThreadSpawnEdge(edge));
  }

  listThreadSpawnDescendantsWithStatus(
    rootThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    const childrenByParent = new Map<ThreadId, ThreadSpawnEdgeRecord[]>();
    for (const edge of this.threadSpawnEdges.values()) {
      if (edge.status !== status) continue;
      const bucket = childrenByParent.get(edge.parentThreadId) ?? [];
      bucket.push(edge);
      childrenByParent.set(edge.parentThreadId, bucket);
    }
    for (const bucket of childrenByParent.values()) {
      bucket.sort(compareThreadSpawnEdges);
    }

    const descendants: ThreadSpawnEdgeRecord[] = [];
    const queue = [...(childrenByParent.get(rootThreadId) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      descendants.push(cloneThreadSpawnEdge(next));
      const children = childrenByParent.get(next.childThreadId) ?? [];
      queue.push(...children);
    }
    return descendants;
  }

  /** Force an immediate flush (durable=true). */
  flushDurable(): void {
    this.store.flushBatch(true);
  }

  close(): void {
    this.scheduler.stop();
    this.store.close();
  }

  private loadThreadSpawnEdgesSnapshot(): void {
    if (!existsSync(this.threadSpawnEdgePath)) {
      return;
    }

    const raw = readFileSync(this.threadSpawnEdgePath, "utf8");
    const parsed = JSON.parse(raw) as ThreadSpawnEdgeSnapshot;
    if (
      parsed.version !== THREAD_SPAWN_EDGE_SNAPSHOT_VERSION ||
      !Array.isArray(parsed.edges)
    ) {
      throw new Error(
        `invalid thread-spawn edge snapshot at ${this.threadSpawnEdgePath}`,
      );
    }

    this.threadSpawnEdges.clear();
    for (const edge of parsed.edges) {
      const normalized = normalizeThreadSpawnEdge(edge);
      this.threadSpawnEdges.set(
        normalized.childThreadId,
        cloneThreadSpawnEdge(normalized),
      );
    }
  }

  private persistThreadSpawnEdgesSnapshot(): void {
    const payload: ThreadSpawnEdgeSnapshot = {
      version: THREAD_SPAWN_EDGE_SNAPSHOT_VERSION,
      edges: Array.from(this.threadSpawnEdges.values())
        .sort(compareThreadSpawnEdges)
        .map((edge) => cloneThreadSpawnEdge(edge)),
    };
    const tmpPath = `${this.threadSpawnEdgePath}.tmp`;
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    writeFileSync(tmpPath, serialized, "utf8");
    fsyncPath(tmpPath);
    renameSync(tmpPath, this.threadSpawnEdgePath);
    fsyncPath(this.store.sessionDir);
  }
}

function compareThreadSpawnEdges(
  left: ThreadSpawnEdgeRecord,
  right: ThreadSpawnEdgeRecord,
): number {
  const pathCompare = (left.metadata.agentPath ?? left.parentPath).localeCompare(
    right.metadata.agentPath ?? right.parentPath,
  );
  return pathCompare !== 0
    ? pathCompare
    : left.childThreadId.localeCompare(right.childThreadId);
}

function cloneThreadSpawnEdge(
  edge: ThreadSpawnEdgeRecord,
): ThreadSpawnEdgeRecord {
  return {
    ...edge,
    metadata: cloneAgentMetadata(edge.metadata),
  };
}

function cloneAgentMetadata(metadata: AgentMetadata): AgentMetadata {
  return {
    ...(metadata.agentId !== undefined ? { agentId: metadata.agentId } : {}),
    ...(metadata.agentPath !== undefined ? { agentPath: metadata.agentPath } : {}),
    ...(metadata.agentNickname !== undefined
      ? { agentNickname: metadata.agentNickname }
      : {}),
    ...(metadata.agentRole !== undefined ? { agentRole: metadata.agentRole } : {}),
    ...(metadata.lastTaskMessage !== undefined
      ? { lastTaskMessage: metadata.lastTaskMessage }
      : {}),
    depth: metadata.depth,
  };
}

function normalizeThreadSpawnEdge(
  edge: ThreadSpawnEdgeRecord,
): ThreadSpawnEdgeRecord {
  if (
    !edge ||
    typeof edge.childThreadId !== "string" ||
    typeof edge.parentThreadId !== "string" ||
    typeof edge.parentPath !== "string" ||
    (edge.status !== "open" && edge.status !== "closed")
  ) {
    throw new Error("invalid thread-spawn edge record");
  }

  return {
    childThreadId: edge.childThreadId,
    parentThreadId: edge.parentThreadId,
    parentPath: edge.parentPath,
    metadata: cloneAgentMetadata(edge.metadata),
    status: edge.status,
  };
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
