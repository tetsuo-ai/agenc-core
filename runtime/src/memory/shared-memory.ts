/**
 * Shared memory layer — cross-world knowledge sharing with access control.
 *
 * Enables organizational knowledge, user preferences, and agent capabilities
 * to be shared across isolated worlds while maintaining read-only access
 * from world contexts and write-through validation.
 *
 * Research: R1 (shared vs distributed memory paradigms),
 * R12 (token coherence for multi-agent), R38 (memory as asset)
 *
 * Per skeptic: vector clocks per-key for conflict resolution,
 * not last-write-wins.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { MemoryBackend } from "./types.js";
import type { Logger } from "../utils/logger.js";
import { computeTrustScore, type TrustSource } from "./trust-scoring.js";

/** Scope categories for shared memory. */
type SharedMemoryScope = "user" | "organization" | "capability";
type SharedMemoryVisibility =
  | "private"
  | "shared"
  | "world-visible"
  | "lineage-shared";
type SharedMemoryAuthorizationMode =
  | "auto"
  | "requires-user-authorization"
  | "requires-system-authorization";

interface SharedFactProvenance {
  readonly type: string;
  readonly source: TrustSource;
  readonly sourceId: string;
  readonly simulationId?: string | null;
  readonly lineageId?: string | null;
  readonly parentSimulationId?: string | null;
  readonly worldId?: string | null;
  readonly workspaceId?: string | null;
  readonly eventId?: string | null;
  readonly timestamp: number;
  readonly metadata?: Record<string, unknown>;
}

interface SharedFactAuthorization {
  readonly mode: SharedMemoryAuthorizationMode;
  readonly approved: boolean;
  readonly approvedBy?: string | null;
  readonly approvedAt?: number | null;
  readonly reason?: string | null;
}

/** A shared memory fact accessible across worlds. */
interface SharedFact {
  readonly id: string;
  readonly scope: SharedMemoryScope;
  readonly content: string;
  /** Who wrote this fact. */
  readonly author: string;
  /** Which world it was written from. */
  readonly sourceWorldId?: string;
  /** User ID for user-scoped facts. */
  readonly userId?: string;
  /** Optional lineage continuity scope for lineage-shared facts. */
  readonly lineageId?: string | null;
  /** Version number for conflict resolution. */
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Confidence — shared facts default to 0.8+ (trusted). */
  readonly confidence: number;
  readonly visibility: SharedMemoryVisibility;
  readonly trustSource: TrustSource;
  readonly trustScore: number;
  readonly provenance: readonly SharedFactProvenance[];
  readonly authorization: SharedFactAuthorization;
}

/** Audit trail entry for shared memory writes. */
interface SharedMemoryAuditEntry {
  readonly timestamp: number;
  readonly action: "write" | "update" | "delete";
  readonly factId: string;
  readonly author: string;
  readonly sourceWorldId?: string;
  readonly previousVersion?: number;
  readonly newVersion: number;
  readonly authorizationMode: SharedMemoryAuthorizationMode;
  readonly authorizedBy?: string | null;
  readonly visibility: SharedMemoryVisibility;
  readonly provenance?: SharedFactProvenance | null;
}

interface SharedMemoryConfig {
  readonly memoryBackend: MemoryBackend;
  readonly logger?: Logger;
  readonly keyPrefix?: string;
  /** Read cache TTL in ms. Default: 60000 (1 minute). Per edge case X6: short for safety. */
  readonly cacheTtlMs?: number;
}

const DEFAULT_KEY_PREFIX = "shared:";
const DEFAULT_CACHE_TTL_MS = 60_000;

function sanitizeForPrompt(content: string): string {
  return content
    .replace(/<memory([\s>])/gi, "&lt;memory$1")
    .replace(/<\/memory>/gi, "&lt;/memory&gt;");
}

function deriveAuthorization(input: {
  readonly scope: SharedMemoryScope;
  readonly visibility: SharedMemoryVisibility;
  readonly userId?: string;
  readonly trustSource: TrustSource;
  readonly authorization?: SharedFactAuthorization;
}): SharedFactAuthorization {
  if (input.authorization) {
    return input.authorization;
  }

  if (
    input.scope === "organization" ||
    input.visibility === "world-visible" ||
    input.visibility === "lineage-shared"
  ) {
    return {
      mode: "requires-system-authorization",
      approved: false,
      reason: "broad_shared_scope_requires_system_review",
    };
  }

  if (
    input.scope === "user" &&
    input.userId &&
    (input.trustSource === "system" || input.trustSource === "user")
  ) {
    return {
      mode: "auto",
      approved: true,
      approvedBy: "system:auto",
      approvedAt: Date.now(),
      reason: "user_scoped_fact_meets_auto_policy",
    };
  }

  if (input.scope === "capability" && input.trustSource === "system") {
    return {
      mode: "auto",
      approved: true,
      approvedBy: "system:auto",
      approvedAt: Date.now(),
      reason: "capability_fact_system_generated",
    };
  }

  return {
    mode: "requires-user-authorization",
    approved: false,
    reason: "fact_requires_explicit_user_review",
  };
}

function assertAuthorizedWrite(fact: SharedFactAuthorization): void {
  if (!fact.approved) {
    throw new Error(`Shared memory write requires ${fact.mode}`);
  }
}

function buildSharedTrustScore(input: {
  readonly source: TrustSource;
  readonly confidence: number;
}): number {
  return computeTrustScore({
    source: input.source,
    confidence: input.confidence,
    ageMs: 0,
    accessCount: 1,
    confirmed: input.source === "system" || input.source === "user",
  });
}

/**
 * Shared memory backend — cross-world read-only access with controlled writes.
 */
export class SharedMemoryBackend {
  private readonly backend: MemoryBackend;
  private readonly logger: Logger | undefined;
  private readonly keyPrefix: string;
  private readonly cacheTtlMs: number;

  // Per-world read cache
  private readonly cache = new Map<
    string,
    { facts: SharedFact[]; loadedAt: number }
  >();

  constructor(config: SharedMemoryConfig) {
    this.backend = config.memoryBackend;
    this.logger = config.logger;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Write a shared fact. Only authorized sources should call this.
   * Uses optimistic concurrency: read version → write with version check.
   */
  async writeFact(input: {
    scope: SharedMemoryScope;
    content: string;
    author: string;
    sourceWorldId?: string;
    userId?: string;
    confidence?: number;
    visibility?: SharedMemoryVisibility;
    lineageId?: string | null;
    trustSource?: TrustSource;
    provenance?: readonly SharedFactProvenance[];
    authorization?: SharedFactAuthorization;
  }): Promise<SharedFact> {
    const id = randomUUID();
    const timestamp = Date.now();
    const visibility = input.visibility ?? "shared";
    const trustSource = input.trustSource ?? "system";
    const confidence = input.confidence ?? 0.85;
    const authorization = deriveAuthorization({
      scope: input.scope,
      visibility,
      userId: input.userId,
      trustSource,
      authorization: input.authorization,
    });
    assertAuthorizedWrite(authorization);

    const fact: SharedFact = {
      id,
      scope: input.scope,
      content: input.content,
      author: input.author,
      sourceWorldId: input.sourceWorldId,
      userId: input.userId,
      lineageId: input.lineageId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      confidence,
      visibility,
      trustSource,
      trustScore: buildSharedTrustScore({ source: trustSource, confidence }),
      provenance: input.provenance ?? [{
        type: "shared_fact",
        source: trustSource,
        sourceId: input.author,
        worldId: input.sourceWorldId,
        lineageId: input.lineageId ?? null,
        timestamp,
      }],
      authorization,
    };

    const key = `${this.keyPrefix}${input.scope}:${id}`;
    await this.backend.set(key, fact);

    await this.appendAudit({
      timestamp,
      action: "write",
      factId: id,
      author: input.author,
      sourceWorldId: input.sourceWorldId,
      newVersion: 1,
      authorizationMode: authorization.mode,
      authorizedBy: authorization.approvedBy ?? null,
      visibility,
      provenance: fact.provenance[0] ?? null,
    });

    this.invalidateCache(input.scope);

    this.logger?.debug?.(`Shared memory: wrote fact ${id} (scope: ${input.scope})`);
    return fact;
  }

  /**
   * Update a shared fact with version check (optimistic concurrency).
   * Rejects if the provided expectedVersion doesn't match current version.
   */
  async updateFact(
    factId: string,
    scope: SharedMemoryScope,
    update: {
      content: string;
      author: string;
      sourceWorldId?: string;
      expectedVersion: number;
      confidence?: number;
      trustSource?: TrustSource;
      authorization?: SharedFactAuthorization;
    },
  ): Promise<SharedFact | null> {
    const key = `${this.keyPrefix}${scope}:${factId}`;
    const existing = await this.backend.get<SharedFact>(key);
    if (!existing) return null;

    if (existing.version !== update.expectedVersion) {
      this.logger?.warn?.(
        `Shared memory: version conflict on fact ${factId} (expected ${update.expectedVersion}, current ${existing.version})`,
      );
      return null;
    }

    const authorization = deriveAuthorization({
      scope,
      visibility: existing.visibility,
      userId: existing.userId,
      trustSource: update.trustSource ?? existing.trustSource,
      authorization: update.authorization,
    });
    assertAuthorizedWrite(authorization);

    const updated: SharedFact = {
      ...existing,
      content: update.content,
      version: existing.version + 1,
      updatedAt: Date.now(),
      confidence: update.confidence ?? existing.confidence,
      trustSource: update.trustSource ?? existing.trustSource,
      trustScore: buildSharedTrustScore({
        source: update.trustSource ?? existing.trustSource,
        confidence: update.confidence ?? existing.confidence,
      }),
      authorization,
    };

    await this.backend.set(key, updated);
    await this.appendAudit({
      timestamp: Date.now(),
      action: "update",
      factId,
      author: update.author,
      sourceWorldId: update.sourceWorldId,
      previousVersion: existing.version,
      newVersion: updated.version,
      authorizationMode: authorization.mode,
      authorizedBy: authorization.approvedBy ?? null,
      visibility: updated.visibility,
      provenance: updated.provenance[0] ?? null,
    });

    this.invalidateCache(scope);
    return updated;
  }

  /**
   * Retrieve shared facts for a given scope.
   * Uses per-scope read cache to prevent excessive DB queries.
   */
  async getFacts(
    scope: SharedMemoryScope,
    userId?: string,
    limit = 50,
    options?: {
      readonly lineageId?: string | null;
      readonly minTrustScore?: number;
      readonly allowedVisibilities?: readonly SharedMemoryVisibility[];
    },
  ): Promise<SharedFact[]> {
    const cacheKey = `${scope}:${userId ?? "all"}:${options?.lineageId ?? "all"}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < this.cacheTtlMs) {
      return cached.facts.slice(0, limit);
    }

    const prefix = `${this.keyPrefix}${scope}:`;
    const keys = await this.backend.listKeys(prefix);
    const facts: SharedFact[] = [];
    const minTrustScore = options?.minTrustScore ?? 0;
    const allowedVisibilities = options?.allowedVisibilities;

    for (const key of keys) {
      const fact = await this.backend.get<SharedFact>(key);
      if (!fact) continue;
      if (scope === "user" && userId && fact.userId !== userId) continue;
      if (fact.visibility === "lineage-shared" && options?.lineageId && fact.lineageId !== options.lineageId) {
        continue;
      }
      if (allowedVisibilities && !allowedVisibilities.includes(fact.visibility)) {
        continue;
      }
      if (fact.trustScore < minTrustScore) {
        continue;
      }
      facts.push(fact);
    }

    facts.sort((a, b) => {
      if (b.trustScore !== a.trustScore) return b.trustScore - a.trustScore;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.updatedAt - a.updatedAt;
    });

    this.cache.set(cacheKey, { facts, loadedAt: Date.now() });
    return facts.slice(0, limit);
  }

  /** Get the audit trail for a fact. */
  async getAuditTrail(factId: string): Promise<SharedMemoryAuditEntry[]> {
    const key = `${this.keyPrefix}audit:${factId}`;
    return (await this.backend.get<SharedMemoryAuditEntry[]>(key)) ?? [];
  }

  /** Format shared facts for prompt injection (max 10% of budget). */
  formatForPrompt(facts: readonly SharedFact[]): string {
    if (facts.length === 0) return "";
    const lines = facts.map(
      (f) =>
        `<memory source="shared" scope="${f.scope}" visibility="${f.visibility}" trust_source="${f.trustSource}" confidence="${f.confidence.toFixed(2)}" trust_score="${f.trustScore.toFixed(2)}">${sanitizeForPrompt(f.content)}</memory>`,
    );
    return lines.join("\n");
  }

  private async appendAudit(entry: SharedMemoryAuditEntry): Promise<void> {
    const key = `${this.keyPrefix}audit:${entry.factId}`;
    const existing =
      (await this.backend.get<SharedMemoryAuditEntry[]>(key)) ?? [];
    existing.push(entry);
    while (existing.length > 100) existing.shift();
    await this.backend.set(key, existing);
  }

  private invalidateCache(scope: SharedMemoryScope): void {
    for (const [key] of this.cache) {
      if (key.startsWith(`${scope}:`)) {
        this.cache.delete(key);
      }
    }
  }
}
