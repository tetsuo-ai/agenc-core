/**
 * Memory system diagnostics and health reporting.
 *
 * Provides health metrics, entry counts, and formatted summaries for the
 * /context command and operator observability (Phase 9).
 *
 * @module
 */

import type { MemoryBackend } from "./types.js";
import type { VectorMemoryBackend } from "./vector-store.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { MemoryGraph } from "./graph.js";

/** Snapshot of memory system health. */
export interface MemoryHealthReport {
  /** Memory backend type. */
  readonly backendType: string;
  /** Backend durability level. */
  readonly durability: string;
  /** Total entries in the backend. */
  readonly entryCount: number;
  /** Total sessions tracked. */
  readonly sessionCount: number;
  /** Vector store info. */
  readonly vectorStore: {
    readonly dimension: number;
    readonly entryCount: number;
    readonly persistent: boolean;
  } | null;
  /** Embedding provider info. */
  readonly embeddingProvider: {
    readonly name: string;
    readonly dimension: number;
    readonly available: boolean;
  } | null;
  /** Knowledge graph info. */
  readonly knowledgeGraph: {
    readonly nodeCount: number;
    readonly edgeCount: number;
  } | null;
  /** Backend health check result. */
  readonly healthy: boolean;
}

/**
 * Collect a comprehensive health report from the memory system.
 */
export async function collectMemoryHealthReport(params: {
  memoryBackend?: MemoryBackend;
  vectorStore?: VectorMemoryBackend;
  embeddingProvider?: EmbeddingProvider;
  graph?: MemoryGraph;
}): Promise<MemoryHealthReport> {
  const { memoryBackend, vectorStore, embeddingProvider, graph } = params;

  let healthy = false;
  let entryCount = 0;
  let sessionCount = 0;
  let backendType = "none";
  let durability = "none";

  if (memoryBackend) {
    try {
      healthy = await memoryBackend.healthCheck();
      backendType = memoryBackend.name;
      durability = memoryBackend.getDurability().level;
      const sessions = await memoryBackend.listSessions();
      sessionCount = sessions.length;
      // Count entries from recent sessions (sampling, not full scan)
      const sampleSessions = sessions.slice(0, 10);
      let sampleTotal = 0;
      for (const sid of sampleSessions) {
        const thread = await memoryBackend.getThread(sid);
        sampleTotal += thread.length;
      }
      entryCount =
        sampleSessions.length > 0
          ? Math.round((sampleTotal / sampleSessions.length) * sessionCount)
          : 0;
    } catch {
      // Non-blocking
    }
  }

  let vectorInfo: MemoryHealthReport["vectorStore"] = null;
  if (vectorStore) {
    const dimension = vectorStore.getVectorDimension();
    vectorInfo = {
      dimension,
      entryCount: 0, // Would need a count method
      persistent: vectorStore.getDurability().level !== "none",
    };
  }

  let embeddingInfo: MemoryHealthReport["embeddingProvider"] = null;
  if (embeddingProvider) {
    let available = false;
    try {
      available = await embeddingProvider.isAvailable();
    } catch {
      // Non-blocking
    }
    embeddingInfo = {
      name: embeddingProvider.name,
      dimension: embeddingProvider.dimension,
      available,
    };
  }

  let graphInfo: MemoryHealthReport["knowledgeGraph"] = null;
  if (graph) {
    try {
      const nodes = await graph.listNodes();
      const edges = await graph.listEdges();
      graphInfo = {
        nodeCount: nodes.length,
        edgeCount: edges.length,
      };
    } catch {
      // Non-blocking
    }
  }

  return {
    backendType,
    durability,
    entryCount,
    sessionCount,
    vectorStore: vectorInfo,
    embeddingProvider: embeddingInfo,
    knowledgeGraph: graphInfo,
    healthy,
  };
}

/**
 * Format health report for TUI display (/context command).
 */
export function formatMemoryHealthReport(report: MemoryHealthReport): string {
  const lines: string[] = ["## Memory System Health\n"];

  lines.push(`Backend: ${report.backendType} (${report.durability})`);
  lines.push(`Status: ${report.healthy ? "healthy" : "unhealthy"}`);
  lines.push(`Entries: ~${report.entryCount} across ${report.sessionCount} sessions`);

  if (report.vectorStore) {
    const v = report.vectorStore;
    lines.push(`\nVector Store:`);
    lines.push(`  Dimension: ${v.dimension || "not initialized"}`);
    lines.push(`  Persistent: ${v.persistent ? "yes (SQLite)" : "no (in-memory)"}`);
  }

  if (report.embeddingProvider) {
    const e = report.embeddingProvider;
    lines.push(`\nEmbedding Provider:`);
    lines.push(`  Name: ${e.name}`);
    lines.push(`  Dimension: ${e.dimension}`);
    lines.push(`  Available: ${e.available ? "yes" : "no"}`);
  }

  if (report.knowledgeGraph) {
    const g = report.knowledgeGraph;
    lines.push(`\nKnowledge Graph:`);
    lines.push(`  Nodes: ${g.nodeCount}`);
    lines.push(`  Edges: ${g.edgeCount}`);
  }

  return lines.join("\n");
}
