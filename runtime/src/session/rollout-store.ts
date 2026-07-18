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
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  AgentIdExistsError,
  InvalidAgentMetadataError,
  normalizeAgentMetadata,
  type AgentMetadata,
  type AgentPath,
  type ThreadId,
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
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../state/sqlite-driver.js";
import {
  checkUnknownOutcomeMutationGate,
  UnknownOutcomeMutationBlockedError,
} from "../state/unknown-outcome-gate.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import { ThreadSpawnEdgeRepository } from "../state/spawn-edges.js";
import { isRecord } from "../utils/record.js";

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

const THREAD_SPAWN_EDGE_SNAPSHOT_VERSION = 1;

export class RolloutStore {
  readonly store: SessionStore;
  private readonly scheduler: SessionStoreFlushScheduler;
  private readonly startScheduler: boolean;
  readonly projectRootMarkers?: readonly string[];
  private readonly threadSpawnEdgePath: string;
  private readonly stateDriver: StateSqliteDriver;
  private readonly threadSpawnEdgeRepo: ThreadSpawnEdgeRepository;

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
    this.stateDriver = openStateDatabases({
      cwd: opts.cwd,
      projectRootMarkers: opts.projectRootMarkers,
    });
    this.threadSpawnEdgeRepo = new ThreadSpawnEdgeRepository(this.stateDriver);
    this.loadThreadSpawnEdges();
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

  /** M3 pre-dispatch gate backed by the same project state database. */
  assertToolAdmissionAllowed(recoveryCategory: ToolRecoveryCategory): void {
    const decision = checkUnknownOutcomeMutationGate(this.stateDriver, {
      sessionId: this.sessionId,
      recoveryCategory,
    });
    if (!decision.allowed) {
      throw new UnknownOutcomeMutationBlockedError(
        this.sessionId,
        decision.blocking,
      );
    }
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

  createThreadSpawnEdge(edge: ThreadSpawnEdgeRecord): void {
    const normalized = normalizeThreadSpawnEdge(edge);
    this.threadSpawnEdgeRepo.create(normalized);
  }

  /** @deprecated Spawn-edge identity is create-only; use createThreadSpawnEdge. */
  upsertThreadSpawnEdge(edge: ThreadSpawnEdgeRecord): void {
    this.createThreadSpawnEdge(edge);
  }

  setThreadSpawnEdgeStatus(
    childThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): void {
    // Never decide from a constructor-time snapshot. Multiple daemon/session
    // handles can share this project database, so the repository performs the
    // authoritative monotonic transition (or idempotent acknowledgement).
    this.threadSpawnEdgeRepo.setStatus(childThreadId, status);
  }

  getThreadSpawnEdge(
    childThreadId: ThreadId,
  ): ThreadSpawnEdgeRecord | undefined {
    const edge = this.threadSpawnEdgeRepo.get(childThreadId);
    return edge ? cloneThreadSpawnEdge(edge) : undefined;
  }

  listThreadSpawnChildrenWithStatus(
    parentThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.listThreadSpawnChildrenMatching(parentThreadId, status);
  }

  listThreadSpawnChildren(
    parentThreadId: ThreadId,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.listThreadSpawnChildrenMatching(parentThreadId);
  }

  listThreadSpawnDescendants(
    rootThreadId: ThreadId,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.listThreadSpawnDescendantsMatching(rootThreadId);
  }

  listThreadSpawnDescendantsWithStatus(
    rootThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.listThreadSpawnDescendantsMatching(rootThreadId, status);
  }

  findThreadSpawnChildByPath(
    parentThreadId: ThreadId,
    agentPath: AgentPath,
  ): ThreadId | undefined {
    const matches = this.listThreadSpawnChildren(parentThreadId)
      .filter((edge) => edge.metadata.agentPath === agentPath)
      .map((edge) => edge.childThreadId)
      .sort();
    return oneThreadIdFromPathMatches(matches, agentPath);
  }

  findThreadSpawnDescendantByPath(
    rootThreadId: ThreadId,
    agentPath: AgentPath,
  ): ThreadId | undefined {
    const matches = this.listThreadSpawnDescendants(rootThreadId)
      .filter((edge) => edge.metadata.agentPath === agentPath)
      .map((edge) => edge.childThreadId)
      .sort();
    return oneThreadIdFromPathMatches(matches, agentPath);
  }

  private listThreadSpawnChildrenMatching(
    parentThreadId: ThreadId,
    status?: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.threadSpawnEdgeRepo
      .list()
      .filter((edge) => edge.parentThreadId === parentThreadId)
      .filter((edge) => status === undefined || edge.status === status)
      .sort(compareThreadSpawnEdges)
      .map((edge) => cloneThreadSpawnEdge(edge));
  }

  private listThreadSpawnDescendantsMatching(
    rootThreadId: ThreadId,
    status?: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    const childrenByParent = new Map<ThreadId, ThreadSpawnEdgeRecord[]>();
    for (const edge of this.threadSpawnEdgeRepo.list()) {
      if (status !== undefined && edge.status !== status) continue;
      const bucket = childrenByParent.get(edge.parentThreadId) ?? [];
      bucket.push(edge);
      childrenByParent.set(edge.parentThreadId, bucket);
    }
    for (const bucket of childrenByParent.values()) {
      bucket.sort(compareThreadSpawnEdges);
    }

    const descendants: ThreadSpawnEdgeRecord[] = [];
    const seen = new Set<ThreadId>([rootThreadId]);
    let level = [...(childrenByParent.get(rootThreadId) ?? [])];
    while (level.length > 0) {
      level.sort(compareThreadSpawnEdges);
      const nextLevel: ThreadSpawnEdgeRecord[] = [];
      for (const next of level) {
        if (seen.has(next.childThreadId)) continue;
        seen.add(next.childThreadId);
        descendants.push(cloneThreadSpawnEdge(next));
        nextLevel.push(...(childrenByParent.get(next.childThreadId) ?? []));
      }
      level = nextLevel;
    }
    return descendants;
  }

  /** Force an immediate flush (durable=true). */
  flushDurable(): void {
    this.store.flushBatch(true);
  }

  close(): void {
    this.scheduler.stop();
    this.stateDriver.close();
    this.store.close();
  }

  private loadThreadSpawnEdges(): void {
    const persistedChildIds = new Set(
      this.threadSpawnEdgeRepo.list().map((edge) => edge.childThreadId),
    );

    for (const edge of this.readLegacyThreadSpawnEdges()) {
      if (persistedChildIds.has(edge.childThreadId)) continue;
      try {
        // Historical topology, not a new admission — bypass the gate.
        this.threadSpawnEdgeRepo.create(edge, { admissionGate: "import" });
        persistedChildIds.add(edge.childThreadId);
      } catch (error) {
        // Another process can win the create between list() and legacy import.
        // Accept only its durable row; never rewrite it from the legacy file.
        if (!(error instanceof AgentIdExistsError)) throw error;
        const persisted = this.threadSpawnEdgeRepo.get(edge.childThreadId);
        if (!persisted) throw error;
        persistedChildIds.add(persisted.childThreadId);
      }
    }
  }

  private readLegacyThreadSpawnEdges(): ReadonlyArray<ThreadSpawnEdgeRecord> {
    if (!existsSync(this.threadSpawnEdgePath)) {
      return [];
    }

    try {
      const raw = readFileSync(this.threadSpawnEdgePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return normalizeThreadSpawnEdgesSnapshot(parsed);
    } catch {
      this.copyCorruptLegacyThreadSpawnEdges();
      return [];
    }
  }

  private copyCorruptLegacyThreadSpawnEdges(): void {
    const raw = readFileSync(this.threadSpawnEdgePath);
    const hash = createHash("sha256").update(raw).digest("hex");
    const corruptDir = join(this.stateDriver.projectDir, "state-corrupt");
    const target = join(corruptDir, `thread-spawn-edges-${hash}.json`);
    if (existsSync(target)) return;
    mkdirSync(corruptDir, { recursive: true, mode: 0o700 });
    copyFileSync(this.threadSpawnEdgePath, target);
  }
}

function normalizeThreadSpawnEdgesSnapshot(
  parsed: unknown,
): ReadonlyArray<ThreadSpawnEdgeRecord> {
  if (Array.isArray(parsed)) {
    return parsed.map((edge) => normalizeThreadSpawnEdge(edge));
  }

  if (!isRecord(parsed)) {
    throw new Error("invalid thread-spawn edge snapshot");
  }

  if ("version" in parsed || "edges" in parsed) {
    if (
      parsed.version !== THREAD_SPAWN_EDGE_SNAPSHOT_VERSION ||
      !Array.isArray(parsed.edges)
    ) {
      throw new Error("invalid thread-spawn edge snapshot");
    }
    return parsed.edges.map((edge) => normalizeThreadSpawnEdge(edge));
  }

  if (Array.isArray(parsed.threadSpawnEdges)) {
    return parsed.threadSpawnEdges.map((edge) => normalizeThreadSpawnEdge(edge));
  }

  if (isRecord(parsed.threadSpawnEdges)) {
    return Object.entries(parsed.threadSpawnEdges).map(([childThreadId, edge]) =>
      normalizeThreadSpawnEdge(edge, childThreadId),
    );
  }

  const entries = Object.entries(parsed);
  if (entries.length > 0 && entries.every(([, edge]) => isRecord(edge))) {
    return entries.map(([childThreadId, edge]) =>
      normalizeThreadSpawnEdge(edge, childThreadId),
    );
  }

  throw new Error("invalid thread-spawn edge snapshot");
}

function oneThreadIdFromPathMatches(
  matches: readonly ThreadId[],
  agentPath: AgentPath,
): ThreadId | undefined {
  if (matches.length > 1) {
    throw new Error(
      `multiple spawned threads matched agent path ${agentPath}: ${matches.join(", ")}`,
    );
  }
  return matches[0];
}

function compareThreadSpawnEdges(
  left: ThreadSpawnEdgeRecord,
  right: ThreadSpawnEdgeRecord,
): number {
  return left.childThreadId.localeCompare(right.childThreadId);
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
  return normalizeAgentMetadata(metadata);
}

function normalizeThreadSpawnEdge(
  edge: unknown,
  fallbackChildThreadId?: string,
): ThreadSpawnEdgeRecord {
  if (!isRecord(edge)) {
    throw new Error("invalid thread-spawn edge record");
  }

  const childThreadId =
    typeof edge.childThreadId === "string"
      ? edge.childThreadId
      : fallbackChildThreadId;
  const status =
    edge.status === undefined ? "open" : edge.status;

  const metadata = normalizeAgentMetadata(edge.metadata);
  if (
    typeof childThreadId !== "string" ||
    typeof edge.parentThreadId !== "string" ||
    typeof edge.parentPath !== "string" ||
    (status !== "open" && status !== "closed") ||
    metadata.agentId !== childThreadId
  ) {
    throw new InvalidAgentMetadataError(
      "invalid thread-spawn edge record or child identity",
    );
  }

  return {
    childThreadId,
    parentThreadId: edge.parentThreadId,
    parentPath: edge.parentPath,
    metadata,
    status,
  };
}
