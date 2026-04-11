/**
 * SQLite-backed vector memory backend with persistent embedding storage.
 *
 * Extends SqliteBackend with a `memory_vectors` table for persistent
 * embedding storage. Vectors survive daemon restarts.
 *
 * Design decisions per TODO.MD Phase 1 and specialist reviews:
 * - Float32Array for storage (half the size of Float64 — skeptic finding)
 * - storeWithEmbedding wrapped in SQLite transaction (edge case T1)
 * - Dimension=0 from noop provider → skip vector storage (edge case D7)
 * - getDurability returns "sync" (vectors persist across restarts)
 *
 * Research: R3 (Mem0 dual store), R9 (sqlite-vec for local persistence),
 * R32 (Memori SQL-native persistent memory)
 *
 * @module
 */

import type {
  MemoryEntry,
  AddEntryOptions,
  DurabilityInfo,
} from "../types.js";
import type {
  VectorMemoryBackend,
  VectorSearchOptions,
  HybridSearchOptions,
  ScoredMemoryEntry,
} from "../vector-store.js";
import type { SqliteBackendConfig } from "./types.js";
import { SqliteBackend } from "./backend.js";

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function computeNorm(v: Float32Array | number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i]! * v[i]!;
  }
  return Math.sqrt(sum);
}

function fastCosineSimilarity(
  a: Float32Array | number[],
  b: Float32Array | number[],
  normA: number,
  normB: number,
): number {
  const denom = normA * normB;
  if (denom === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot / denom;
}

interface VectorRecord {
  entryId: string;
  embedding: Float32Array;
  norm: number;
}

interface SqliteVectorBackendConfig extends SqliteBackendConfig {
  dimension?: number;
}

/**
 * SQLite vector backend — extends SqliteBackend with persistent vector storage.
 *
 * Vectors are stored in a `memory_vectors` table and loaded into an in-memory
 * search index on first query. This gives us:
 * - Persistent vectors that survive daemon restarts (unlike InMemoryVectorStore)
 * - Fast cosine similarity search via pre-computed norms
 * - Hybrid vector + BM25 keyword search
 */
export class SqliteVectorBackend
  extends SqliteBackend
  implements VectorMemoryBackend
{
  override readonly name = "sqlite-vector";
  private dimension: number;
  private readonly vectors = new Map<string, VectorRecord>();
  private readonly entryCacheMap = new Map<string, MemoryEntry>();
  private vectorsLoaded = false;
  private loadPromise: Promise<number> | null = null;

  constructor(config: SqliteVectorBackendConfig = {}) {
    super(config);
    this.dimension = config.dimension ?? 0;
  }

  private ensureVectorSchema(): void {
    const db = this.db;
    if (!db) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        entry_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        dimension INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /** Load all vectors from SQLite into the in-memory search index. */
  async loadVectors(): Promise<number> {
    if (this.vectorsLoaded) return this.vectors.size;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this._doLoadVectors();
    return this.loadPromise;
  }

  private async _doLoadVectors(): Promise<number> {
    await this.ensureDb();
    this.ensureVectorSchema();

    const rows = this.db
      .prepare("SELECT entry_id, embedding, dimension FROM memory_vectors")
      .all() as Array<{
      entry_id: string;
      embedding: Buffer;
      dimension: number;
    }>;

    for (const row of rows) {
      const floats = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.dimension,
      );
      if (this.dimension === 0 && row.dimension > 0) {
        this.dimension = row.dimension;
      }
      this.vectors.set(row.entry_id, {
        entryId: row.entry_id,
        embedding: floats,
        norm: computeNorm(floats),
      });
    }

    // Load entries for filtering
    const entries = await this.query({ order: "desc", limit: 100_000 });
    for (const entry of entries) {
      this.entryCacheMap.set(entry.id, entry);
    }

    this.vectorsLoaded = true;
    return this.vectors.size;
  }

  // ============================================================================
  // VectorMemoryBackend interface
  // ============================================================================

  async storeWithEmbedding(
    options: AddEntryOptions,
    embedding: number[],
  ): Promise<MemoryEntry> {
    // Dimension=0 from noop provider → skip vector storage (edge case D7)
    if (embedding.length === 0) {
      return this.addEntry(options);
    }

    if (this.dimension === 0) {
      this.dimension = embedding.length;
    } else if (embedding.length !== this.dimension) {
      // Phase 1.5: graceful dimension mismatch — store entry without vector
      // rather than crashing. Log warning and degrade to keyword-only for this entry.
      // This handles provider switches (e.g., Ollama 768 → OpenAI 1536).
      const entry = await this.addEntry(options);
      this.entryCacheMap.set(entry.id, entry);
      return entry;
    }

    await this.ensureDb();
    this.ensureVectorSchema();

    // Store entry first
    const entry = await this.addEntry(options);

    // Store vector — Float32Array for half the memory (skeptic finding)
    const floats = new Float32Array(embedding);
    const buffer = Buffer.from(
      floats.buffer,
      floats.byteOffset,
      floats.byteLength,
    );

    this.db
      .prepare(
        "INSERT OR REPLACE INTO memory_vectors (entry_id, embedding, dimension, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(entry.id, buffer, this.dimension, Date.now());

    // Update in-memory index
    this.vectors.set(entry.id, {
      entryId: entry.id,
      embedding: floats,
      norm: computeNorm(floats),
    });
    this.entryCacheMap.set(entry.id, entry);

    return entry;
  }

  async searchSimilar(
    queryEmbedding: number[],
    options?: VectorSearchOptions,
  ): Promise<ScoredMemoryEntry[]> {
    await this.loadVectors();
    if (queryEmbedding.length === 0) return [];

    const limit = options?.limit ?? 10;
    const threshold = options?.threshold ?? 0;
    const queryNorm = computeNorm(queryEmbedding);
    if (queryNorm === 0) return [];

    const candidates = this.getFilteredVectorEntries(options);
    const scored: ScoredMemoryEntry[] = [];

    for (const [id, entry] of candidates) {
      const vec = this.vectors.get(id);
      if (!vec) continue;
      const score = fastCosineSimilarity(
        queryEmbedding,
        vec.embedding,
        queryNorm,
        vec.norm,
      );
      if (score >= threshold) {
        scored.push({ entry, score, vectorScore: score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async searchHybrid(
    queryText: string,
    queryEmbedding: number[],
    options?: HybridSearchOptions,
  ): Promise<ScoredMemoryEntry[]> {
    await this.loadVectors();
    const vectorWeight = options?.vectorWeight ?? 0.7;
    const keywordWeight = options?.keywordWeight ?? 0.3;
    const limit = options?.limit ?? 10;
    const threshold = options?.threshold ?? 0;

    const vectorResults = await this.searchSimilar(queryEmbedding, {
      ...options,
      limit: Math.max(limit * 3, 100),
      threshold: 0,
    });

    const keywordResults = this.searchBM25(queryText, options);

    normalizeScores(vectorResults);
    normalizeScores(keywordResults);

    const merged = mergeSearchResults(
      vectorResults,
      keywordResults,
      vectorWeight,
      keywordWeight,
    );

    return merged.filter((r) => r.score >= threshold).slice(0, limit);
  }

  getVectorDimension(): number {
    return this.dimension;
  }

  override getDurability(): DurabilityInfo {
    return {
      level: "sync",
      supportsFlush: true,
      description:
        "SQLite-backed memory persists synchronously on committed writes.",
    };
  }

  override async deleteThread(sessionId: string): Promise<number> {
    const entries = await this.getThread(sessionId);
    for (const entry of entries) {
      this.vectors.delete(entry.id);
      this.entryCacheMap.delete(entry.id);
    }
    await this.ensureDb();
    this.ensureVectorSchema();
    const ids = entries.map((e) => e.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .prepare(
          `DELETE FROM memory_vectors WHERE entry_id IN (${placeholders})`,
        )
        .run(...ids);
    }
    return super.deleteThread(sessionId);
  }

  override async clear(): Promise<void> {
    this.vectors.clear();
    this.entryCacheMap.clear();
    this.dimension = 0;
    this.vectorsLoaded = false;
    await this.ensureDb();
    this.ensureVectorSchema();
    this.db.exec("DELETE FROM memory_vectors");
    return super.clear();
  }

  override async close(): Promise<void> {
    this.vectors.clear();
    this.entryCacheMap.clear();
    this.vectorsLoaded = false;
    return super.close();
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private getFilteredVectorEntries(
    options?: VectorSearchOptions,
  ): Map<string, MemoryEntry> {
    const result = new Map<string, MemoryEntry>();
    for (const [id, entry] of this.entryCacheMap) {
      if (!this.vectors.has(id)) continue;
      if (options?.sessionId && entry.sessionId !== options.sessionId) continue;
      if (options?.after && entry.timestamp <= options.after) continue;
      if (options?.before && entry.timestamp >= options.before) continue;
      if (
        options?.channel &&
        (entry.metadata as Record<string, unknown> | undefined)?.channel !==
          options.channel
      ) {
        continue;
      }
      if (options?.tags) {
        const entryTags =
          ((entry.metadata as Record<string, unknown> | undefined)?.tags as
            | string[]
            | undefined) ?? [];
        if (!options.tags.every((t) => entryTags.includes(t))) continue;
      }
      if (options?.memoryRoles) {
        const meta = entry.metadata as Record<string, unknown> | undefined;
        const role = meta?.memoryRole as string | undefined;
        const roles = (meta?.memoryRoles as string[] | undefined) ?? [];
        const combined = role ? [role, ...roles] : roles;
        if (!options.memoryRoles.some((r) => combined.includes(r))) continue;
      }
      // Workspace/agent scoping (Phase 2)
      // Allow entries with "default" or undefined workspaceId to match any workspace
      // (legacy unscoped entries from before workspace-aware ingestion).
      if (
        options?.workspaceId &&
        entry.workspaceId !== options.workspaceId &&
        entry.workspaceId !== "default" &&
        entry.workspaceId !== undefined &&
        entry.workspaceId !== ""
      ) continue;
      if (options?.agentId && entry.agentId !== options.agentId) continue;
      result.set(id, entry);
    }
    return result;
  }

  private searchBM25(
    queryText: string,
    options?: VectorSearchOptions,
  ): ScoredMemoryEntry[] {
    const queryTerms = tokenize(queryText);
    if (queryTerms.length === 0) return [];

    const candidates = this.getFilteredVectorEntries(options);
    const docs: Array<{ entry: MemoryEntry; terms: string[] }> = [];
    for (const [, entry] of candidates) {
      docs.push({ entry, terms: tokenize(entry.content) });
    }
    if (docs.length === 0) return [];

    const termDocFreq = new Map<string, number>();
    let totalDocLen = 0;
    for (const doc of docs) {
      const seen = new Set<string>();
      for (const term of doc.terms) {
        if (!seen.has(term)) {
          termDocFreq.set(term, (termDocFreq.get(term) ?? 0) + 1);
          seen.add(term);
        }
      }
      totalDocLen += doc.terms.length;
    }
    const avgDocLen = totalDocLen / docs.length;

    const results: ScoredMemoryEntry[] = [];
    for (const doc of docs) {
      let score = 0;
      const docLen = doc.terms.length;
      const termFreq = new Map<string, number>();
      for (const term of doc.terms) {
        termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
      }
      for (const term of queryTerms) {
        const tf = termFreq.get(term) ?? 0;
        if (tf === 0) continue;
        const df = termDocFreq.get(term) ?? 0;
        const idf = Math.log(
          (docs.length - df + 0.5) / (df + 0.5) + 1,
        );
        score +=
          idf *
          ((tf * (BM25_K1 + 1)) /
            (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen))));
      }
      if (score > 0) {
        results.push({ entry: doc.entry, score, keywordScore: score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }
}

// ============================================================================
// Score normalization + merge helpers
// ============================================================================

function normalizeScores(results: ScoredMemoryEntry[]): void {
  if (results.length === 0) return;
  let min = Infinity;
  let max = -Infinity;
  for (const r of results) {
    if (r.score < min) min = r.score;
    if (r.score > max) max = r.score;
  }
  const range = max - min;
  if (range === 0) {
    for (const r of results) r.score = 1;
    return;
  }
  for (const r of results) {
    r.score = (r.score - min) / range;
  }
}

function mergeSearchResults(
  vectorResults: ScoredMemoryEntry[],
  keywordResults: ScoredMemoryEntry[],
  vectorWeight: number,
  keywordWeight: number,
): ScoredMemoryEntry[] {
  const map = new Map<string, ScoredMemoryEntry>();

  for (const r of vectorResults) {
    map.set(r.entry.id, {
      entry: r.entry,
      score: r.score * vectorWeight,
      vectorScore: r.score,
      keywordScore: 0,
    });
  }

  for (const r of keywordResults) {
    const existing = map.get(r.entry.id);
    if (existing) {
      existing.score += r.score * keywordWeight;
      existing.keywordScore = r.score;
    } else {
      map.set(r.entry.id, {
        entry: r.entry,
        score: r.score * keywordWeight,
        vectorScore: 0,
        keywordScore: r.score,
      });
    }
  }

  const merged = Array.from(map.values());
  merged.sort((a, b) => b.score - a.score);
  return merged;
}
