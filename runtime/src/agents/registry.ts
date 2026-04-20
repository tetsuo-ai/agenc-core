/**
 * AgentRegistry — in-memory slot + path tracking for subagents.
 *
 * Hand-port of codex `core/src/agent/registry.rs` (344 LOC).
 * Owns:
 *   - Spawn-slot counter (bounded by `maxThreads`)
 *   - `agentPath` → `AgentMetadata` map (hierarchical "/root/worker/sub")
 *   - `agentId` → `metadata` reverse index
 *   - Nickname cycle bookkeeping
 *
 * Invariants wired:
 *   I-37 (sibling `agentPath` collision) — `reserveAgentPath` returns
 *        `AgentPathExistsError` on collision. Mirrors codex.
 *   I-63 (atomic slot acquisition) — slot counter increment/decrement
 *        happens under `AsyncLock<void>`. Concurrent spawns never
 *        both observe `count = N-1` and both increment to `N`.
 *
 * @module
 */

import { AsyncLock } from "../utils/async-lock.js";
import type { AgentRole } from "./role.js";

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type AgentPath = string; // "/root" | "/root/worker" | "/root/worker/sub"
export type ThreadId = string;

export interface AgentMetadata {
  readonly agentId?: ThreadId;
  readonly agentPath?: AgentPath;
  readonly agentNickname?: string;
  readonly agentRole?: string;
  readonly lastTaskMessage?: string;
  readonly depth: number;
}

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

export class AgentLimitReachedError extends Error {
  constructor(public readonly maxThreads: number) {
    super(`agent limit reached (max=${maxThreads})`);
    this.name = "AgentLimitReachedError";
  }
}

export class AgentPathExistsError extends Error {
  constructor(public readonly path: AgentPath) {
    super(`agent path already exists: ${path}`);
    this.name = "AgentPathExistsError";
  }
}

// ─────────────────────────────────────────────────────────────────────
// SpawnReservation — held until the child actually boots
// ─────────────────────────────────────────────────────────────────────

/**
 * Opaque handle the caller must hold until spawn finalizes. On drop
 * (dispose), the reservation releases the slot — so failed spawns
 * don't leak counters. Matches codex's `SpawnReservation` RAII.
 */
export class SpawnReservation {
  private released = false;
  constructor(
    private readonly registry: AgentRegistry,
    private readonly maxThreads: number | undefined,
    public readonly cancellationToken: AbortController,
  ) {}

  /** Finalize the reservation — caller promises the agent is alive. */
  finalize(metadata: AgentMetadata): void {
    if (this.released) return;
    this.registry.finalizeSpawnReservation(metadata, this);
    this.released = true;
  }

  /** Rollback — release the slot without registering metadata. */
  release(): void {
    if (this.released) return;
    this.registry.rollbackSpawnReservation(this.maxThreads);
    this.released = true;
  }

  isReleased(): boolean {
    return this.released;
  }
}

// ─────────────────────────────────────────────────────────────────────
// AgentRegistry
// ─────────────────────────────────────────────────────────────────────

export interface AgentRegistryOpts {
  /** Optional global cap on live non-root agents. */
  readonly maxThreads?: number;
}

export class AgentRegistry {
  private readonly byPath = new Map<AgentPath, AgentMetadata>();
  private readonly usedNicknames = new Set<string>();
  private readonly slotLock: AsyncLock<void> = new AsyncLock<void>(undefined);
  private totalCount = 0;
  private readonly maxThreads: number | undefined;

  constructor(opts: AgentRegistryOpts = {}) {
    this.maxThreads = opts.maxThreads;
  }

  /**
   * I-63: atomic slot reservation. Callers receive a SpawnReservation
   * they must either `finalize()` or `release()`. The slot counter
   * is protected by `slotLock` so concurrent reservations can never
   * observe a stale count.
   *
   * Returns a cancellation token the caller threads through
   * `spawnAgentInternal` — I-32 parent-interrupt race uses it to
   * cancel a mid-spawn child when the parent gets an `Interrupt`.
   */
  async reserveSpawnSlot(): Promise<SpawnReservation> {
    return this.slotLock.with(() => {
      if (
        this.maxThreads !== undefined &&
        this.totalCount >= this.maxThreads
      ) {
        throw new AgentLimitReachedError(this.maxThreads);
      }
      this.totalCount += 1;
      return new SpawnReservation(this, this.maxThreads, new AbortController());
    });
  }

  /** Called by SpawnReservation.release() to roll back the counter. */
  rollbackSpawnReservation(_maxThreads: number | undefined): void {
    void _maxThreads;
    void this.slotLock.with(() => {
      this.totalCount = Math.max(0, this.totalCount - 1);
    });
  }

  /**
   * Called by SpawnReservation.finalize(). Registers the metadata
   * under its agentPath. I-37: collision on path → throws
   * AgentPathExistsError. The slot counter stays charged.
   */
  finalizeSpawnReservation(
    metadata: AgentMetadata,
    _reservation: SpawnReservation,
  ): void {
    if (metadata.agentPath) {
      if (this.byPath.has(metadata.agentPath)) {
        throw new AgentPathExistsError(metadata.agentPath);
      }
      this.byPath.set(metadata.agentPath, metadata);
    }
    if (metadata.agentNickname) {
      this.usedNicknames.add(metadata.agentNickname);
    }
  }

  /**
   * Release a completed/shutdown agent. Decrements the slot counter
   * + removes the path + nickname entries. Idempotent.
   */
  async releaseSpawnedThread(threadId: ThreadId): Promise<void> {
    return this.slotLock.with(() => {
      const entry = this.findEntryByThreadId(threadId);
      if (!entry) return;
      const [path, metadata] = entry;
      this.byPath.delete(path);
      if (metadata.agentNickname) {
        this.usedNicknames.delete(metadata.agentNickname);
      }
      this.totalCount = Math.max(0, this.totalCount - 1);
    });
  }

  /** Register the session's root thread — never counted against maxThreads. */
  registerRootThread(threadId: ThreadId): void {
    const ROOT_PATH = "/root";
    if (this.byPath.has(ROOT_PATH)) return;
    this.byPath.set(ROOT_PATH, {
      agentId: threadId,
      agentPath: ROOT_PATH,
      depth: 0,
    });
  }

  agentIdForPath(path: AgentPath): ThreadId | undefined {
    return this.byPath.get(path)?.agentId;
  }

  agentMetadataForThread(threadId: ThreadId): AgentMetadata | undefined {
    return this.findEntryByThreadId(threadId)?.[1];
  }

  liveAgents(): ReadonlyArray<AgentMetadata> {
    return Array.from(this.byPath.values()).filter(
      (m) => m.agentPath !== "/root" && m.agentId !== undefined,
    );
  }

  updateLastTaskMessage(threadId: ThreadId, message: string): void {
    const entry = this.findEntryByThreadId(threadId);
    if (!entry) return;
    const [path, prev] = entry;
    this.byPath.set(path, { ...prev, lastTaskMessage: message });
  }

  /**
   * I-37: reserve an agentPath. Throws AgentPathExistsError on
   * collision. Called by control.ts before spawn finalize.
   */
  reserveAgentPath(path: AgentPath): void {
    if (this.byPath.has(path)) {
      throw new AgentPathExistsError(path);
    }
  }

  /** Return whether a nickname is currently live. */
  hasNickname(nickname: string): boolean {
    return this.usedNicknames.has(nickname);
  }

  /** Diagnostics — total live non-root count. */
  get activeCount(): number {
    return this.totalCount;
  }

  /** Iterate live agents by role for debug/telemetry. */
  listAgentsByRole(): ReadonlyMap<string, ReadonlyArray<AgentMetadata>> {
    const out = new Map<string, AgentMetadata[]>();
    for (const m of this.liveAgents()) {
      const role = m.agentRole ?? "default";
      const bucket = out.get(role) ?? [];
      bucket.push(m);
      out.set(role, bucket);
    }
    return out;
  }

  private findEntryByThreadId(
    threadId: ThreadId,
  ): [AgentPath, AgentMetadata] | undefined {
    for (const [path, m] of this.byPath) {
      if (m.agentId === threadId) return [path, m];
    }
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────

export function joinAgentPath(parent: AgentPath, segment: string): AgentPath {
  const sanitized = segment.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return parent === "/root"
    ? `/root/${sanitized}`
    : `${parent}/${sanitized}`;
}

export function depthOfAgentPath(path: AgentPath): number {
  return Math.max(0, path.split("/").filter(Boolean).length - 1);
}

/** Compose metadata from a role + allocated nickname. */
export function buildChildMetadata(opts: {
  readonly agentId: ThreadId;
  readonly parentPath: AgentPath;
  readonly role: AgentRole;
  readonly nickname: string;
  readonly depth: number;
}): AgentMetadata {
  return {
    agentId: opts.agentId,
    agentPath: joinAgentPath(opts.parentPath, opts.nickname),
    agentNickname: opts.nickname,
    agentRole: opts.role.name,
    depth: opts.depth,
  };
}
