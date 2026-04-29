/**
 * Memory trace logging — structured trace events for memory operations (Phase 9.4).
 *
 * All events use the `memory.*` tag prefix for easy filtering in daemon trace logs.
 * Events are fire-safe: errors during logging are swallowed.
 *
 * @module
 */

import { silentLogger, type Logger } from "../utils/logger.js";

/** Memory trace event types. */
type MemoryTraceEventType =
  | "memory.retrieval"
  | "memory.retrieval.scoring"
  | "memory.ingestion.turn"
  | "memory.ingestion.session_end"
  | "memory.ingestion.compaction"
  | "memory.consolidation"
  | "memory.consolidation.retention"
  | "memory.consolidation.vacuum"
  | "memory.activation.update"
  | "memory.forgetting"
  | "memory.identity.load"
  | "memory.identity.update"
  | "memory.reflection"
  | "memory.entity_extraction"
  | "memory.graph.update"
  | "memory.trust.filter"
  | "memory.error";

/**
 * Memory trace logger — emits structured trace events for memory operations.
 * All methods are fire-safe (never throw).
 */
export class MemoryTraceLogger {
  private readonly logger: Logger;
  private readonly enabled: boolean;

  constructor(logger: Logger, enabled = true) {
    this.logger = logger;
    this.enabled = enabled;
  }

  /** Log a retrieval operation with scoring breakdown. */
  traceRetrieval(params: {
    sessionId: string;
    query: string;
    candidateCount: number;
    selectedCount: number;
    estimatedTokens: number;
    roles: Record<string, number>;
    workspaceId?: string;
    durationMs: number;
  }): void {
    this.emit("memory.retrieval", params.sessionId, params.workspaceId, {
      query: params.query.slice(0, 200),
      candidates: params.candidateCount,
      selected: params.selectedCount,
      estimatedTokens: params.estimatedTokens,
      roleCounts: params.roles,
      durationMs: params.durationMs,
    });
  }

  /** Log individual entry scoring during retrieval. */
  traceScoring(params: {
    sessionId: string;
    entryId: string;
    role: string;
    relevanceScore: number;
    recencyScore: number;
    activationBoost: number;
    trustScore: number;
    combinedScore: number;
    included: boolean;
  }): void {
    this.emit("memory.retrieval.scoring", params.sessionId, undefined, {
      entryId: params.entryId,
      role: params.role,
      relevance: round(params.relevanceScore),
      recency: round(params.recencyScore),
      activation: round(params.activationBoost),
      trust: round(params.trustScore),
      combined: round(params.combinedScore),
      included: params.included,
    });
  }

  /** Log a turn ingestion event. */
  traceIngestion(params: {
    sessionId: string;
    workspaceId?: string;
    indexed: boolean;
    salienceScore: number;
    duplicate: boolean;
    backgroundRunId?: string;
  }): void {
    this.emit("memory.ingestion.turn", params.sessionId, params.workspaceId, {
      indexed: params.indexed,
      salience: round(params.salienceScore),
      duplicate: params.duplicate,
      backgroundRunId: params.backgroundRunId,
    });
  }

  /** Log a consolidation run. */
  traceConsolidation(params: {
    workspaceId?: string;
    episodicBefore: number;
    semanticAfter: number;
    clustersFound: number;
    factsCreated: number;
    durationMs: number;
  }): void {
    this.emit("memory.consolidation", undefined, params.workspaceId, {
      episodicBefore: params.episodicBefore,
      semanticAfter: params.semanticAfter,
      clusters: params.clustersFound,
      factsCreated: params.factsCreated,
      durationMs: params.durationMs,
    });
  }

  /** Log a retention/cleanup run. */
  traceRetention(params: {
    workspaceId?: string;
    expiredDeleted: number;
    coldArchived: number;
    dailyLogsDeleted: number;
  }): void {
    this.emit("memory.consolidation.retention", undefined, params.workspaceId, {
      expired: params.expiredDeleted,
      coldArchived: params.coldArchived,
      dailyLogs: params.dailyLogsDeleted,
    });
  }

  /** Log an activation update. */
  traceActivation(params: {
    entryId: string;
    accessCount: number;
    newScore: number;
  }): void {
    this.emit("memory.activation.update", undefined, undefined, {
      entryId: params.entryId,
      accessCount: params.accessCount,
      score: round(params.newScore),
    });
  }

  /** Log a trust-based filtering decision. */
  traceTrustFilter(params: {
    entryId: string;
    trustScore: number;
    threshold: number;
    excluded: boolean;
    source: string;
  }): void {
    this.emit("memory.trust.filter", undefined, undefined, {
      entryId: params.entryId,
      trust: round(params.trustScore),
      threshold: params.threshold,
      excluded: params.excluded,
      source: params.source,
    });
  }

  /** Log a reflection event. */
  traceReflection(params: {
    agentId: string;
    workspaceId?: string;
    traitsAdded: number;
    beliefsUpdated: number;
    messageCount: number;
  }): void {
    this.emit("memory.reflection", undefined, params.workspaceId, {
      agentId: params.agentId,
      traitsAdded: params.traitsAdded,
      beliefsUpdated: params.beliefsUpdated,
      messages: params.messageCount,
    });
  }

  /** Log a memory error. */
  traceError(params: {
    operation: string;
    error: string;
    sessionId?: string;
    workspaceId?: string;
  }): void {
    this.emit("memory.error", params.sessionId, params.workspaceId, {
      operation: params.operation,
      error: params.error,
    });
  }

  private emit(
    type: MemoryTraceEventType,
    sessionId: string | undefined,
    workspaceId: string | undefined,
    payload: Record<string, unknown>,
  ): void {
    if (!this.enabled) return;
    try {
      this.logger.debug?.(
        `[${type}]${sessionId ? ` session=${sessionId}` : ""}${workspaceId ? ` ws=${workspaceId}` : ""} ${JSON.stringify(payload)}`,
      );
    } catch {
      // Fire-safe: never throw from trace logging
    }
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Create a no-op trace logger for tests. */
export function createNoopMemoryTraceLogger(): MemoryTraceLogger {
  return new MemoryTraceLogger(silentLogger, false);
}
