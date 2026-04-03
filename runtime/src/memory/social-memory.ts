/**
 * Social memory — tracks inter-agent relationships and shared world state.
 *
 * When multiple agents interact in a virtual world, they need:
 * - Social memory: what agent A knows about agent B
 * - Shared world state: observable facts visible to all agents
 * - Access control: private / shared / world visibility
 *
 * Research: R18 (Collaborative Memory with access control),
 * R19 (Emergent collective memory), R16 (Generative Agents social behaviors)
 *
 * Per skeptic: evidence-weighted agreement, not majority vote.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { MemoryBackend } from "./types.js";
import type { Logger } from "../utils/logger.js";
import { computeTrustScore, type TrustSource } from "./trust-scoring.js";

/** Visibility level for a memory entry. */
export type MemoryVisibility =
  | "private"
  | "shared"
  | "world-visible"
  | "lineage-shared";

export interface WorldFactProvenance {
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

export interface WorldFactTrust {
  readonly source: TrustSource;
  readonly score: number;
  readonly confidence: number;
  readonly threshold: number;
}

export interface WorldFactAuditEntry {
  readonly timestamp: number;
  readonly action: "write" | "confirm" | "promote_visibility";
  readonly actor: string;
  readonly visibility: MemoryVisibility;
  readonly reason?: string;
}

/** A social memory record — what one agent knows about another. */
export interface SocialMemoryEntry {
  readonly id: string;
  readonly agentId: string;
  readonly otherAgentId: string;
  readonly worldId: string;
  /** Nature of the relationship. */
  readonly relationship: string;
  /** Key interaction records. */
  readonly interactions: readonly SocialInteraction[];
  /** Sentiment score [-1, 1]. */
  readonly sentiment: number;
  readonly lastInteraction: number;
  readonly createdAt: number;
}

export interface SocialInteraction {
  readonly timestamp: number;
  readonly summary: string;
  readonly context?: string;
}

/** A shared world state fact — observable by all agents in the world. */
export interface WorldStateFact {
  readonly id: string;
  readonly worldId: string;
  readonly content: string;
  /** Who observed this fact. */
  readonly observedBy: string;
  readonly observedAt: number;
  /** How many agents have independently confirmed this fact. */
  readonly confirmations: number;
  /** Which agents confirmed. */
  readonly confirmedBy: readonly string[];
  readonly visibility: MemoryVisibility;
  /** Access list for "shared" visibility. */
  readonly allowedAgents?: readonly string[];
  readonly provenance: readonly WorldFactProvenance[];
  readonly trust: WorldFactTrust;
  readonly auditTrail: readonly WorldFactAuditEntry[];
}

export interface SocialMemoryConfig {
  readonly memoryBackend: MemoryBackend;
  readonly logger?: Logger;
  readonly keyPrefix?: string;
}

const DEFAULT_KEY_PREFIX = "social:";
const DEFAULT_PROMPT_TRUST_THRESHOLD = 0.55;

function normalizeVisibility(
  visibility: MemoryVisibility | "world",
): MemoryVisibility {
  return visibility === "world" ? "world-visible" : visibility;
}

function buildWorldFactTrust(input: {
  readonly source: TrustSource;
  readonly confidence: number;
  readonly confirmations: number;
}): WorldFactTrust {
  return {
    source: input.source,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    threshold: DEFAULT_PROMPT_TRUST_THRESHOLD,
    score: computeTrustScore({
      source: input.source,
      confidence: input.confidence,
      ageMs: 0,
      accessCount: Math.max(1, input.confirmations),
      confirmed: input.confirmations > 1,
    }),
  };
}

/**
 * Social memory manager for multi-agent worlds.
 */
export class SocialMemoryManager {
  private readonly backend: MemoryBackend;
  private readonly logger: Logger | undefined;
  private readonly keyPrefix: string;

  constructor(config: SocialMemoryConfig) {
    this.backend = config.memoryBackend;
    this.logger = config.logger;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  // ============================================================================
  // Social memory (agent-to-agent relationships)
  // ============================================================================

  /** Record an interaction between two agents. */
  async recordInteraction(
    agentId: string,
    otherAgentId: string,
    worldId: string,
    interaction: SocialInteraction,
  ): Promise<SocialMemoryEntry> {
    const key = `${this.keyPrefix}${worldId}:${agentId}:${otherAgentId}`;
    const existing = await this.backend.get<SocialMemoryEntry>(key);

    const entry: SocialMemoryEntry = existing
      ? {
          ...existing,
          interactions: [
            ...existing.interactions.slice(-19),
            interaction,
          ],
          lastInteraction: interaction.timestamp,
          sentiment: existing.sentiment,
        }
      : {
          id: randomUUID(),
          agentId,
          otherAgentId,
          worldId,
          relationship: "acquaintance",
          interactions: [interaction],
          sentiment: 0,
          lastInteraction: interaction.timestamp,
          createdAt: Date.now(),
        };

    await this.backend.set(key, entry);
    return entry;
  }

  /** Query what an agent knows about another agent. */
  async getRelationship(
    agentId: string,
    otherAgentId: string,
    worldId: string,
  ): Promise<SocialMemoryEntry | null> {
    const key = `${this.keyPrefix}${worldId}:${agentId}:${otherAgentId}`;
    return (await this.backend.get<SocialMemoryEntry>(key)) ?? null;
  }

  /** List all agents that this agent has interacted with in a world. */
  async listKnownAgents(
    agentId: string,
    worldId: string,
  ): Promise<string[]> {
    const prefix = `${this.keyPrefix}${worldId}:${agentId}:`;
    const keys = await this.backend.listKeys(prefix);
    return keys.map((key) => key.replace(prefix, ""));
  }

  // ============================================================================
  // Shared world state
  // ============================================================================

  /** Add an observable fact to the world state. */
  async addWorldFact(
    worldId: string,
    content: string,
    observedBy: string,
    visibility: MemoryVisibility | "world" = "world-visible",
    allowedAgents?: readonly string[],
    options?: {
      readonly provenance?: readonly WorldFactProvenance[];
      readonly trustSource?: TrustSource;
      readonly confidence?: number;
      readonly reason?: string;
    },
  ): Promise<WorldStateFact> {
    const id = randomUUID();
    const normalizedVisibility = normalizeVisibility(visibility);
    const observedAt = Date.now();
    const trustSource = options?.trustSource ?? "agent";
    const fact: WorldStateFact = {
      id,
      worldId,
      content,
      observedBy,
      observedAt,
      confirmations: 1,
      confirmedBy: [observedBy],
      visibility: normalizedVisibility,
      allowedAgents,
      provenance: options?.provenance ?? [{
        type: "world_fact",
        source: trustSource,
        sourceId: observedBy,
        worldId,
        timestamp: observedAt,
      }],
      trust: buildWorldFactTrust({
        source: trustSource,
        confidence: options?.confidence ?? 0.7,
        confirmations: 1,
      }),
      auditTrail: [{
        timestamp: observedAt,
        action: "write",
        actor: observedBy,
        visibility: normalizedVisibility,
        reason: options?.reason,
      }],
    };

    const key = `${this.keyPrefix}world:${worldId}:fact:${id}`;
    await this.backend.set(key, fact);
    return fact;
  }

  /** Confirm an existing world fact (another agent observed the same thing). */
  async confirmWorldFact(
    factId: string,
    worldId: string,
    agentId: string,
    options?: {
      readonly provenance?: readonly WorldFactProvenance[];
      readonly trustSource?: TrustSource;
      readonly confidence?: number;
      readonly reason?: string;
    },
  ): Promise<WorldStateFact | null> {
    const key = `${this.keyPrefix}world:${worldId}:fact:${factId}`;
    const existing = await this.backend.get<WorldStateFact>(key);
    if (!existing) return null;
    if (existing.confirmedBy.includes(agentId)) return existing;

    const trustSource = options?.trustSource ?? existing.trust.source;
    const confirmedAt = Date.now();
    const updated: WorldStateFact = {
      ...existing,
      confirmations: existing.confirmations + 1,
      confirmedBy: [...existing.confirmedBy, agentId],
      provenance: [
        ...existing.provenance,
        ...(options?.provenance ?? [{
          type: "world_fact_confirmation",
          source: trustSource,
          sourceId: agentId,
          worldId,
          timestamp: confirmedAt,
        }]),
      ],
      trust: buildWorldFactTrust({
        source: trustSource,
        confidence: options?.confidence ?? existing.trust.confidence,
        confirmations: existing.confirmations + 1,
      }),
      auditTrail: [
        ...existing.auditTrail,
        {
          timestamp: confirmedAt,
          action: "confirm",
          actor: agentId,
          visibility: existing.visibility,
          reason: options?.reason,
        },
      ],
    };
    await this.backend.set(key, updated);
    return updated;
  }

  /**
   * Retrieve world facts visible to a specific agent.
   * Enforces access control:
   * - "world-visible": visible to all agents in the scoped world/lineage namespace
   * - "lineage-shared": visible to all agents in the scoped lineage namespace
   * - "shared": visible only to agents in allowedAgents list
   * - "private": visible only to the observing agent
   */
  async getWorldFacts(
    worldId: string,
    agentId: string,
    limit = 50,
  ): Promise<WorldStateFact[]> {
    const prefix = `${this.keyPrefix}world:${worldId}:fact:`;
    const keys = await this.backend.listKeys(prefix);
    const facts: WorldStateFact[] = [];

    for (const key of keys) {
      if (facts.length >= limit) break;
      const fact = await this.backend.get<WorldStateFact>(key);
      if (!fact) continue;

      if (
        fact.visibility === "world-visible" ||
        fact.visibility === "lineage-shared"
      ) {
        facts.push(fact);
      } else if (
        fact.visibility === "shared" &&
        fact.allowedAgents?.includes(agentId)
      ) {
        facts.push(fact);
      } else if (
        fact.visibility === "private" &&
        fact.observedBy === agentId
      ) {
        facts.push(fact);
      }
    }

    facts.sort((left, right) => {
      if (right.trust.score !== left.trust.score) {
        return right.trust.score - left.trust.score;
      }
      if (right.confirmations !== left.confirmations) {
        return right.confirmations - left.confirmations;
      }
      return right.observedAt - left.observedAt;
    });

    return facts;
  }

  /**
   * Phase 6.4: Check for collective knowledge emergence.
   * A fact with 3+ independent confirmations is promoted to world-visible knowledge.
   */
  async checkCollectiveEmergence(
    worldId: string,
    minConfirmations = 3,
  ): Promise<WorldStateFact[]> {
    const prefix = `${this.keyPrefix}world:${worldId}:fact:`;
    const keys = await this.backend.listKeys(prefix);
    const promoted: WorldStateFact[] = [];

    for (const key of keys) {
      const fact = await this.backend.get<WorldStateFact>(key);
      if (!fact) continue;
      if (fact.confirmations >= minConfirmations && fact.visibility !== "world-visible") {
        const updated: WorldStateFact = {
          ...fact,
          visibility: "world-visible",
          trust: buildWorldFactTrust({
            source: fact.trust.source,
            confidence: Math.max(fact.trust.confidence, 0.85),
            confirmations: fact.confirmations,
          }),
          auditTrail: [
            ...fact.auditTrail,
            {
              timestamp: Date.now(),
              action: "promote_visibility",
              actor: "system",
              visibility: "world-visible",
              reason: "collective_emergence",
            },
          ],
        };
        await this.backend.set(key, updated);
        promoted.push(updated);
        this.logger?.info?.(
          `Collective emergence: "${fact.content}" promoted to world knowledge (${fact.confirmations} confirmations)`,
        );
      }
    }

    return promoted;
  }
}
