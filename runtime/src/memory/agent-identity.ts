/**
 * Agent identity — persistent per-agent personality, beliefs, and learned traits.
 *
 * Each agent has a core personality (from config, versioned) and accumulated
 * learned traits, beliefs, and communication style from reflection.
 *
 * Research: R16 (Generative Agents observation/reflection/planning),
 * R17 (Hindsight 4 memory networks), R23 (emergent individuality)
 *
 * Per skeptic: "versioned" personality, not "immutable". User can update
 * core personality, which resets learned traits.
 * Per edge case EC-1: core personality always takes priority over learned traits.
 * Per edge case M1: reflection scopes by BOTH agentId AND workspaceId.
 *
 * @module
 */

import type { MemoryBackend } from "./types.js";
import type { MemoryRetriever } from "../llm/chat-executor-types.js";
import type { Logger } from "../utils/logger.js";

/** Persistent agent identity. */
interface AgentIdentity {
  readonly agentId: string;
  readonly name: string;
  /** Core personality from config — versioned, can be updated. */
  readonly corePersonality: string;
  /** Version of the core personality (incremented on config change). */
  readonly personalityVersion: number;
  /** Learned traits accumulated from reflection. */
  readonly learnedTraits: readonly string[];
  /** Learned communication style preferences. */
  readonly communicationStyle: string;
  /** Per-agent beliefs (key → { belief, confidence, evidence, formedAt }). */
  readonly beliefs: Readonly<Record<string, AgentBelief>>;
  readonly workspaceId?: string;
  readonly createdAt: number;
  readonly lastActiveAt: number;
}

export interface AgentBelief {
  readonly belief: string;
  readonly confidence: number;
  /** Source entry IDs that support this belief (per edge case X5: ungrounded beliefs discarded). */
  readonly evidence: readonly string[];
  readonly formedAt: number;
}

interface AgentIdentityConfig {
  readonly memoryBackend: MemoryBackend;
  readonly logger?: Logger;
  readonly keyPrefix?: string;
}

const DEFAULT_KEY_PREFIX = "agent:identity:";

/**
 * Agent identity manager — creates, loads, and updates agent identities.
 */
export class AgentIdentityManager {
  private readonly backend: MemoryBackend;
  private readonly logger: Logger | undefined;
  private readonly keyPrefix: string;

  constructor(config: AgentIdentityConfig) {
    this.backend = config.memoryBackend;
    this.logger = config.logger;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  private identityKey(agentId: string, workspaceId?: string): string {
    return `${this.keyPrefix}${workspaceId ?? "default"}:${agentId}`;
  }

  /** Load an agent's identity, or return null if not found. */
  async load(agentId: string, workspaceId?: string): Promise<AgentIdentity | null> {
    const key = this.identityKey(agentId, workspaceId);
    return (await this.backend.get<AgentIdentity>(key)) ?? null;
  }

  /** Create or update an agent's core identity. */
  async upsert(input: {
    agentId: string;
    name: string;
    corePersonality: string;
    workspaceId?: string;
  }): Promise<AgentIdentity> {
    const existing = await this.load(input.agentId, input.workspaceId);

    if (existing && existing.corePersonality === input.corePersonality) {
      // Personality unchanged — just update lastActiveAt
      const updated: AgentIdentity = {
        ...existing,
        lastActiveAt: Date.now(),
      };
      await this.backend.set(
        this.identityKey(input.agentId, input.workspaceId),
        updated,
      );
      return updated;
    }

    // Personality changed or new agent — create/version
    const identity: AgentIdentity = {
      agentId: input.agentId,
      name: input.name,
      corePersonality: input.corePersonality,
      personalityVersion: (existing?.personalityVersion ?? 0) + 1,
      // Per skeptic: personality change resets learned traits
      learnedTraits: [],
      communicationStyle: "",
      beliefs: {},
      workspaceId: input.workspaceId,
      createdAt: existing?.createdAt ?? Date.now(),
      lastActiveAt: Date.now(),
    };

    await this.backend.set(
      this.identityKey(input.agentId, input.workspaceId),
      identity,
    );
    this.logger?.info?.(
      `Agent identity ${existing ? "updated" : "created"}: ${input.name} (v${identity.personalityVersion})`,
    );
    return identity;
  }

  /** Add learned traits from reflection (appends, never replaces core). */
  async addLearnedTraits(
    agentId: string,
    traits: readonly string[],
    workspaceId?: string,
  ): Promise<AgentIdentity | null> {
    const existing = await this.load(agentId, workspaceId);
    if (!existing) return null;

    const updated: AgentIdentity = {
      ...existing,
      learnedTraits: [
        ...new Set([...existing.learnedTraits, ...traits]),
      ],
      lastActiveAt: Date.now(),
    };
    await this.backend.set(this.identityKey(agentId, workspaceId), updated);
    return updated;
  }

  /** Update communication style from reflection. */
  async updateCommunicationStyle(
    agentId: string,
    style: string,
    workspaceId?: string,
  ): Promise<AgentIdentity | null> {
    const existing = await this.load(agentId, workspaceId);
    if (!existing) return null;

    const updated: AgentIdentity = {
      ...existing,
      communicationStyle: style,
      lastActiveAt: Date.now(),
    };
    await this.backend.set(this.identityKey(agentId, workspaceId), updated);
    return updated;
  }

  /** Add or update a belief. Per edge case X5: beliefs must cite evidence. */
  async upsertBelief(
    agentId: string,
    topic: string,
    belief: AgentBelief,
    workspaceId?: string,
  ): Promise<AgentIdentity | null> {
    // Per edge case X5: discard beliefs without evidence
    if (belief.evidence.length === 0) {
      this.logger?.debug?.(
        `Discarded ungrounded belief for agent ${agentId}: "${topic}"`,
      );
      return null;
    }

    const existing = await this.load(agentId, workspaceId);
    if (!existing) return null;

    const updated: AgentIdentity = {
      ...existing,
      beliefs: {
        ...existing.beliefs,
        [topic]: belief,
      },
      lastActiveAt: Date.now(),
    };
    await this.backend.set(this.identityKey(agentId, workspaceId), updated);
    return updated;
  }

  /** Reset learned traits and beliefs (keep core personality). */
  async resetLearned(
    agentId: string,
    workspaceId?: string,
  ): Promise<AgentIdentity | null> {
    const existing = await this.load(agentId, workspaceId);
    if (!existing) return null;

    const updated: AgentIdentity = {
      ...existing,
      learnedTraits: [],
      communicationStyle: "",
      beliefs: {},
      lastActiveAt: Date.now(),
    };
    await this.backend.set(this.identityKey(agentId, workspaceId), updated);
    this.logger?.info?.(
      `Agent ${agentId} learned traits reset (personality v${existing.personalityVersion} preserved)`,
    );
    return updated;
  }

  /**
   * Format identity for prompt injection.
   * Core personality always first (takes priority per EC-1).
   * Budget: max 500 tokens (~2000 chars).
   */
  formatForPrompt(identity: AgentIdentity): string {
    const parts: string[] = [];

    // Core personality always first
    parts.push(`# Agent Identity: ${identity.name}\n${identity.corePersonality}`);

    // Learned traits
    if (identity.learnedTraits.length > 0) {
      parts.push(
        `## Learned Traits\n${identity.learnedTraits.map((t) => `- ${t}`).join("\n")}`,
      );
    }

    // Communication style
    if (identity.communicationStyle) {
      parts.push(`## Communication Style\n${identity.communicationStyle}`);
    }

    // Active beliefs (above confidence threshold)
    const activeBeliefs = Object.entries(identity.beliefs)
      .filter(([, b]) => b.confidence >= 0.5)
      .sort(([, a], [, b]) => b.confidence - a.confidence)
      .slice(0, 5);
    if (activeBeliefs.length > 0) {
      const beliefLines = activeBeliefs.map(
        ([topic, b]) => `- **${topic}**: ${b.belief} (confidence: ${b.confidence.toFixed(2)})`,
      );
      parts.push(`## Current Beliefs\n${beliefLines.join("\n")}`);
    }

    const full = parts.join("\n\n");
    // Budget cap: 2000 chars (~500 tokens)
    return full.length > 2000 ? full.slice(0, 1997) + "..." : full;
  }
}

/**
 * Creates a MemoryRetriever that injects agent identity context into the
 * ChatExecutor prompt assembly pipeline (Phase 5.4).
 *
 * Returns undefined (no context) if the agent identity has not been created yet,
 * providing zero overhead for the single-agent default case.
 */
export function createAgentIdentityProvider(
  identityManager: AgentIdentityManager,
  agentId: string,
  workspaceId?: string,
): MemoryRetriever {
  return {
    async retrieve(
      _query: string,
      _sessionId: string,
    ): Promise<string | undefined> {
      const identity = await identityManager.load(agentId, workspaceId);
      if (!identity) return undefined;
      return identityManager.formatForPrompt(identity);
    },
  };
}
