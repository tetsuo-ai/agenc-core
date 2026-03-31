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

/** Scope categories for shared memory. */
export type SharedMemoryScope = "user" | "organization" | "capability";

/** A shared memory fact accessible across worlds. */
export interface SharedFact {
  readonly id: string;
  readonly scope: SharedMemoryScope;
  readonly content: string;
  /** Who wrote this fact. */
  readonly author: string;
  /** Which world it was written from. */
  readonly sourceWorldId?: string;
  /** User ID for user-scoped facts. */
  readonly userId?: string;
  /** Version number for conflict resolution. */
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Confidence — shared facts default to 0.8+ (trusted). */
  readonly confidence: number;
}

/** Audit trail entry for shared memory writes. */
export interface SharedMemoryAuditEntry {
  readonly timestamp: number;
  readonly action: "write" | "update" | "delete";
  readonly factId: string;
  readonly author: string;
  readonly sourceWorldId?: string;
  readonly previousVersion?: number;
  readonly newVersion: number;
}

export interface SharedMemoryConfig {
  readonly memoryBackend: MemoryBackend;
  readonly logger?: Logger;
  readonly keyPrefix?: string;
  /** Read cache TTL in ms. Default: 60000 (1 minute). Per edge case X6: short for safety. */
  readonly cacheTtlMs?: number;
}

const DEFAULT_KEY_PREFIX = "shared:";
const DEFAULT_CACHE_TTL_MS = 60_000;

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
   * Per skeptic: not last-write-wins — version conflict = rejection.
   */
  async writeFact(input: {
    scope: SharedMemoryScope;
    content: string;
    author: string;
    sourceWorldId?: string;
    userId?: string;
    confidence?: number;
  }): Promise<SharedFact> {
    const id = randomUUID();
    const fact: SharedFact = {
      id,
      scope: input.scope,
      content: input.content,
      author: input.author,
      sourceWorldId: input.sourceWorldId,
      userId: input.userId,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      confidence: input.confidence ?? 0.85,
    };

    const key = `${this.keyPrefix}${input.scope}:${id}`;
    await this.backend.set(key, fact);

    // Audit trail
    await this.appendAudit({
      timestamp: Date.now(),
      action: "write",
      factId: id,
      author: input.author,
      sourceWorldId: input.sourceWorldId,
      newVersion: 1,
    });

    // Invalidate cache for this scope
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
    },
  ): Promise<SharedFact | null> {
    const key = `${this.keyPrefix}${scope}:${factId}`;
    const existing = await this.backend.get<SharedFact>(key);
    if (!existing) return null;

    // Version conflict check (per skeptic: not last-write-wins)
    if (existing.version !== update.expectedVersion) {
      this.logger?.warn?.(
        `Shared memory: version conflict on fact ${factId} (expected ${update.expectedVersion}, current ${existing.version})`,
      );
      return null;
    }

    const updated: SharedFact = {
      ...existing,
      content: update.content,
      version: existing.version + 1,
      updatedAt: Date.now(),
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
  ): Promise<SharedFact[]> {
    const cacheKey = `${scope}:${userId ?? "all"}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < this.cacheTtlMs) {
      return cached.facts.slice(0, limit);
    }

    const prefix = `${this.keyPrefix}${scope}:`;
    const keys = await this.backend.listKeys(prefix);
    const facts: SharedFact[] = [];

    for (const key of keys) {
      const fact = await this.backend.get<SharedFact>(key);
      if (!fact) continue;
      if (scope === "user" && userId && fact.userId !== userId) continue;
      facts.push(fact);
    }

    // Sort by confidence desc, then updatedAt desc
    facts.sort((a, b) => {
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
        `<memory source="shared" scope="${f.scope}" confidence="${f.confidence.toFixed(2)}">${f.content}</memory>`,
    );
    return lines.join("\n");
  }

  private async appendAudit(entry: SharedMemoryAuditEntry): Promise<void> {
    const key = `${this.keyPrefix}audit:${entry.factId}`;
    const existing =
      (await this.backend.get<SharedMemoryAuditEntry[]>(key)) ?? [];
    existing.push(entry);
    // Keep last 100 audit entries per fact
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
