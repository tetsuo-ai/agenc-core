/**
 * AgentRegistry — in-memory slot + path tracking for subagents.
 *
 * Hand-port of reference runtime `core/src/agent/registry.rs` (344 LOC).
 * Owns:
 *   - Spawn-slot counter
 *   - `agentPath` → `AgentMetadata` map (hierarchical "/root/worker/sub")
 *   - `agentId` → `metadata` reverse index
 *   - Nickname cycle bookkeeping
 *
 * Invariants wired:
 *   I-37 (sibling `agentPath` collision) — `reserveAgentPath` returns
 *        `AgentPathExistsError` on collision. Mirrors reference runtime.
 *   I-63 (atomic slot acquisition) — slot counter increment/decrement
 *        happens under `AsyncLock<void>`. Concurrent spawns never
 *        both observe `count = N-1` and both increment to `N`.
 *
 * @module
 */

import { AsyncLock } from "./_deps/async-lock.js";
import {
  defaultAgentNicknameCandidates,
  formatNicknameWithSuffix,
  type AgentRole,
} from "./role.js";

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type AgentPath = string; // "/root" | "/root/worker" | "/root/worker/sub"
export type ThreadId = string;

export const ROOT_AGENT_PATH = "/root" as AgentPath;
export const MEMORY_AGENT_PATH = "/morpheus" as AgentPath;

export interface AgentMetadata {
  readonly agentId?: ThreadId;
  readonly agentPath?: AgentPath;
  readonly agentNickname?: string;
  readonly agentRole?: string;
  readonly agentRoleWorkspaceId?: string;
  readonly agentRoleFingerprint?: string;
  readonly lastTaskMessage?: string;
  readonly depth: number;
}

export class InvalidAgentMetadataError extends Error {
  constructor(message = "invalid agent metadata", options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidAgentMetadataError";
  }
}

export function normalizeAgentRoleMetadata(
  metadata: unknown,
): Pick<
  AgentMetadata,
  "agentRole" | "agentRoleWorkspaceId" | "agentRoleFingerprint"
> {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new InvalidAgentMetadataError();
  }
  const record = metadata as Record<string, unknown>;
  const agentRole = optionalMetadataString(record.agentRole, "agentRole", true);
  const agentRoleWorkspaceId = optionalMetadataString(
    record.agentRoleWorkspaceId,
    "agentRoleWorkspaceId",
    true,
  );
  const agentRoleFingerprint = optionalMetadataString(
    record.agentRoleFingerprint,
    "agentRoleFingerprint",
    true,
  );
  if (
    (agentRoleWorkspaceId !== undefined || agentRoleFingerprint !== undefined) &&
    agentRole === undefined
  ) {
    throw new InvalidAgentMetadataError(
      "invalid agent metadata role provenance without agentRole",
    );
  }
  return {
    ...(agentRole !== undefined ? { agentRole } : {}),
    ...(agentRoleWorkspaceId !== undefined ? { agentRoleWorkspaceId } : {}),
    ...(agentRoleFingerprint !== undefined ? { agentRoleFingerprint } : {}),
  };
}

export function normalizeAgentMetadata(metadata: unknown): AgentMetadata {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new InvalidAgentMetadataError();
  }
  const record = metadata as Record<string, unknown>;
  if (
    typeof record.depth !== "number" ||
    !Number.isSafeInteger(record.depth) ||
    record.depth < 0
  ) {
    throw new InvalidAgentMetadataError("invalid agent metadata depth");
  }
  const roleMetadata = normalizeAgentRoleMetadata(record);
  const agentId = optionalMetadataString(record.agentId, "agentId", true);
  const agentPath = optionalMetadataString(record.agentPath, "agentPath", true);
  const agentNickname = optionalMetadataString(
    record.agentNickname,
    "agentNickname",
    true,
  );
  const lastTaskMessage = optionalMetadataString(
    record.lastTaskMessage,
    "lastTaskMessage",
    false,
  );
  return {
    depth: record.depth,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(agentPath !== undefined ? { agentPath } : {}),
    ...(agentNickname !== undefined ? { agentNickname } : {}),
    ...roleMetadata,
    ...(lastTaskMessage !== undefined ? { lastTaskMessage } : {}),
  };
}

function optionalMetadataString(
  value: unknown,
  field: string,
  requireNonEmpty: boolean,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    (requireNonEmpty && value.trim().length === 0)
  ) {
    throw new InvalidAgentMetadataError(`invalid agent metadata ${field}`);
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

export class AgentPathExistsError extends Error {
  constructor(public readonly path: AgentPath) {
    super(`agent path already exists: ${path}`);
    this.name = "AgentPathExistsError";
  }
}

export class AgentIdExistsError extends Error {
  constructor(public readonly threadId: ThreadId) {
    super(`agent thread id already exists: ${threadId}`);
    this.name = "AgentIdExistsError";
  }
}

export class InvalidAgentPathError extends Error {
  constructor(public readonly path: string, message: string) {
    super(message);
    this.name = "InvalidAgentPathError";
  }
}

// ─────────────────────────────────────────────────────────────────────
// SpawnReservation — held until the child actually boots
// ─────────────────────────────────────────────────────────────────────

/**
 * Opaque handle the caller must hold until spawn finalizes. On drop
 * (dispose), the reservation releases the slot — so failed spawns
 * don't leak counters. Matches reference runtime's `SpawnReservation` RAII.
 */
export class SpawnReservation {
  private released = false;
  private reservedAgentPath: AgentPath | undefined;

  constructor(
    private readonly registry: AgentRegistry,
    public readonly cancellationToken: AbortController,
  ) {}

  reserveAgentPath(path: AgentPath): void {
    if (this.released) return;
    this.registry.reserveAgentPathForReservation(path);
    this.reservedAgentPath = path;
  }

  ownsAgentPath(path: AgentPath): boolean {
    return this.reservedAgentPath === path;
  }

  /** Finalize the reservation — caller promises the agent is alive. */
  finalize(metadata: AgentMetadata): void {
    if (this.released) return;
    this.registry.finalizeSpawnReservation(metadata, this);
    this.reservedAgentPath = undefined;
    this.released = true;
  }

  /** Rollback — release the slot without registering metadata. */
  release(): void {
    if (this.released) return;
    if (this.reservedAgentPath !== undefined) {
      this.registry.releaseReservedAgentPath(this.reservedAgentPath);
      this.reservedAgentPath = undefined;
    }
    this.registry.rollbackSpawnReservation();
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
  /** Deprecated. Root agent spawning is intentionally uncapped. */
  readonly maxThreads?: number;
}

export class AgentRegistry {
  private readonly byPath = new Map<AgentPath, AgentMetadata>();
  private readonly usedNicknames = new Set<string>();
  /**
   * Nickname overflow counter. When all role candidates collide at
   * the current ordinal we advance and re-try with a suffix
   * ("scout the 2nd", "scout the 3rd", …). Shared across roles
   * because a collision in any pool signals nickname pressure.
   */
  private nicknameResetCount = 0;
  private readonly slotLock: AsyncLock<void> = new AsyncLock<void>(undefined);
  private totalCount = 0;
  constructor(_opts: AgentRegistryOpts = {}) {
    void _opts;
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
      this.totalCount += 1;
      return new SpawnReservation(this, new AbortController());
    });
  }

  /** Called by SpawnReservation.release() to roll back the counter. */
  rollbackSpawnReservation(): void {
    this.totalCount = Math.max(0, this.totalCount - 1);
  }

  /**
   * Called by SpawnReservation.finalize(). Registers the metadata
   * under its agentPath. I-37: collision on path → throws
   * AgentPathExistsError. The slot counter stays charged.
   */
  finalizeSpawnReservation(
    metadata: AgentMetadata,
    reservation: SpawnReservation,
  ): void {
    if (metadata.agentId && this.findEntryByThreadId(metadata.agentId)) {
      throw new AgentIdExistsError(metadata.agentId);
    }
    if (metadata.agentPath) {
      assertValidAgentPath(metadata.agentPath);
      if (
        this.byPath.has(metadata.agentPath) &&
        !reservation.ownsAgentPath(metadata.agentPath)
      ) {
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
   * and removes the path entry. reference deliberately does not release
   * nicknames here; used nicknames remain reserved until the nickname
   * allocator exhausts its candidate pool and advances the suffix cycle.
   * This prevents sequential short-lived sibling agents from all reusing
   * the same display name/path.
   */
  async releaseSpawnedThread(threadId: ThreadId): Promise<void> {
    return this.slotLock.with(() => {
      const entry = this.findEntryByThreadId(threadId);
      if (!entry) return;
      const [path] = entry;
      this.byPath.delete(path);
      this.totalCount = Math.max(0, this.totalCount - 1);
    });
  }

  /** Register the session's root thread. */
  registerRootThread(threadId: ThreadId): void {
    if (this.byPath.has(ROOT_AGENT_PATH)) return;
    this.byPath.set(ROOT_AGENT_PATH, {
      agentId: threadId,
      agentPath: ROOT_AGENT_PATH,
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

  /** Reserve an agentPath before child startup. */
  reserveAgentPathForReservation(path: AgentPath): void {
    assertValidAgentPath(path);
    if (this.byPath.has(path)) {
      throw new AgentPathExistsError(path);
    }
    this.byPath.set(path, {
      agentPath: path,
      depth: depthOfAgentPath(path),
    });
  }

  /** Remove an uncommitted path reservation. */
  releaseReservedAgentPath(path: AgentPath): void {
    const metadata = this.byPath.get(path);
    if (metadata?.agentId === undefined) {
      this.byPath.delete(path);
    }
  }

  /** Return whether a nickname is currently live. */
  hasNickname(nickname: string): boolean {
    return this.usedNicknames.has(nickname);
  }

  /**
   * Allocate a nickname for a freshly spawning child. Matches the reference
   * candidate-pool semantics: use the role-specific pool when present,
   * otherwise use the shared `agent_names.txt` list, choose one currently
   * unused candidate, and advance the ordinal suffix after full exhaustion.
   * Nicknames stay reserved until the allocator exhausts a suffix cycle.
   */
  allocateNickname(role: AgentRole): string {
    const candidates =
      role.config.nicknameCandidates ?? defaultAgentNicknameCandidates();
    const available: string[] = [];
    for (const candidate of candidates) {
      const formatted =
        this.nicknameResetCount === 0
          ? candidate
          : formatNicknameWithSuffix(candidate, this.nicknameResetCount);
      if (!this.usedNicknames.has(formatted)) {
        available.push(formatted);
      }
    }
    if (available.length > 0) {
      const nickname =
        available[Math.floor(Math.random() * available.length)] ?? available[0]!;
      this.usedNicknames.add(nickname);
      return nickname;
    }
    this.usedNicknames.clear();
    this.nicknameResetCount += 1;
    return this.allocateNickname(role);
  }

  /**
   * Release a nickname back into the pool. Idempotent. This is only
   * for failed-spawn rollback before the child becomes a live thread.
   * Normal thread shutdown intentionally keeps the nickname reserved,
   * matching reference registry behavior.
   */
  releaseNickname(nickname: string): void {
    this.usedNicknames.delete(nickname);
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
  assertValidAgentPath(parent);
  assertValidAgentName(segment);
  return `${parent}/${segment}`;
}

export function depthOfAgentPath(path: AgentPath): number {
  assertValidAgentPath(path);
  if (path === MEMORY_AGENT_PATH) return 0;
  return Math.max(0, path.split("/").filter(Boolean).length - 1);
}

export function agentPathName(path: AgentPath): string {
  assertValidAgentPath(path);
  if (path === ROOT_AGENT_PATH) return "root";
  const last = path.split("/").pop();
  return last && last.length > 0 ? last : "root";
}

export function resolveAgentPath(
  current: AgentPath,
  reference: string,
): AgentPath {
  assertValidAgentPath(current);
  if (reference.length === 0) {
    throw new InvalidAgentPathError(reference, "agent path must not be empty");
  }
  if (reference === ROOT_AGENT_PATH) return ROOT_AGENT_PATH;
  if (reference === MEMORY_AGENT_PATH) return MEMORY_AGENT_PATH;
  if (reference.startsWith("/")) {
    assertValidAgentPath(reference);
    return reference;
  }
  for (const segment of reference.split("/")) {
    assertValidAgentName(segment);
  }
  return `${current}/${reference}`;
}

export function normalizeAgentNameForPath(input: string): string {
  const lowered = input.trim().toLowerCase();
  const normalized = lowered
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  const candidate = normalized.length > 0 ? normalized : "agent";
  if (candidate === "root" || candidate === "." || candidate === "..") {
    return `agent_${candidate.replace(/\W+/g, "_")}`;
  }
  return candidate;
}

function assertValidAgentPath(path: string): asserts path is AgentPath {
  if (path === MEMORY_AGENT_PATH) return;
  if (!path.startsWith("/")) {
    throw new InvalidAgentPathError(
      path,
      "absolute agent paths must start with `/root` or be `/morpheus`",
    );
  }
  if (path.endsWith("/")) {
    throw new InvalidAgentPathError(
      path,
      "absolute agent path must not end with `/`",
    );
  }
  const segments = path.slice(1).split("/");
  if (segments[0] !== "root") {
    throw new InvalidAgentPathError(
      path,
      "absolute agent paths must start with `/root` or be `/morpheus`",
    );
  }
  for (const segment of segments.slice(1)) {
    assertValidAgentName(segment);
  }
}

export function assertValidAgentName(name: string): void {
  if (name.length === 0) {
    throw new InvalidAgentPathError(name, "agent_name must not be empty");
  }
  if (name === "root") {
    throw new InvalidAgentPathError(name, "agent_name `root` is reserved");
  }
  if (name === "." || name === "..") {
    throw new InvalidAgentPathError(name, `agent_name \`${name}\` is reserved`);
  }
  if (name.includes("/")) {
    throw new InvalidAgentPathError(name, "agent_name must not contain `/`");
  }
  if (!/^[a-z0-9_]+$/u.test(name)) {
    throw new InvalidAgentPathError(
      name,
      "agent_name must use only lowercase letters, digits, and underscores",
    );
  }
}

/** Compose metadata from a role + allocated nickname. */
export function buildChildMetadata(opts: {
  readonly agentId: ThreadId;
  readonly parentPath: AgentPath;
  readonly role: AgentRole;
  readonly roleWorkspaceId: string;
  readonly roleFingerprint: string;
  readonly nickname: string;
  readonly depth: number;
  readonly agentName?: string;
  readonly agentPath?: AgentPath;
}): AgentMetadata {
  const agentPath =
    opts.agentPath ??
    joinAgentPath(
      opts.parentPath,
      opts.agentName ?? normalizeAgentNameForPath(opts.nickname),
    );
  assertValidAgentPath(agentPath);
  return {
    agentId: opts.agentId,
    agentPath,
    agentNickname: opts.nickname,
    agentRole: opts.role.name,
    agentRoleWorkspaceId: opts.roleWorkspaceId,
    agentRoleFingerprint: opts.roleFingerprint,
    depth: opts.depth,
  };
}
