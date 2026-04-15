/**
 * SQLite backend for conversation and key-value storage.
 *
 * Uses `better-sqlite3` loaded lazily on first use (optional dependency).
 * Data persists across restarts when using a file-based path.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { Logger } from "../../utils/logger.js";
import { silentLogger } from "../../utils/logger.js";
import type {
  MemoryBackend,
  MemoryEntry,
  MemoryQuery,
  AddEntryOptions,
  TranscriptCapableMemoryBackend,
  TranscriptEvent,
  TranscriptEventInput,
  TranscriptLoadOptions,
} from "../types.js";
import type { SqliteBackendConfig } from "./types.js";
import {
  MemoryBackendError,
  MemoryEncryptionError,
  MemorySerializationError,
} from "../errors.js";
import { ensureLazyBackend } from "../lazy-import.js";
import type { MetricsProvider } from "../../task/types.js";
import { TELEMETRY_METRIC_NAMES } from "../../telemetry/metric-names.js";
import type { EncryptionProvider } from "../encryption.js";
import { createAES256GCMProvider } from "../encryption.js";
import {
  applyTranscriptLoadOptions,
  materializeTranscriptEvent,
} from "../transcript.js";

/** Security H-2: escape SQL LIKE wildcards in prefix parameters. */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export class SqliteBackend
  implements MemoryBackend, TranscriptCapableMemoryBackend
{
  readonly name: string = "sqlite";

  protected db: any = null;
  /**
   * Memoized init promise (audit S2.3). Concurrent callers of
   * `ensureDb()` await the same in-flight init instead of racing on
   * the `if (this.db)` check, which previously could let two callers
   * both run `createSchema()` and `cleanupExpired()` against the
   * same DB instance. Cleared on init failure so a retry can
   * re-initialize.
   */
  private dbInitPromise: Promise<any> | null = null;
  private readonly config: Required<
    Pick<SqliteBackendConfig, "dbPath" | "walMode" | "cleanupOnConnect">
  > &
    SqliteBackendConfig;
  private readonly logger: Logger;
  private readonly defaultTtlMs: number;
  private readonly metrics?: MetricsProvider;
  private readonly encryptor?: EncryptionProvider;
  private closed = false;

  constructor(config: SqliteBackendConfig = {}) {
    this.config = {
      ...config,
      dbPath: config.dbPath ?? ":memory:",
      walMode: config.walMode ?? true,
      cleanupOnConnect: config.cleanupOnConnect ?? true,
    };
    this.logger = config.logger ?? silentLogger;
    this.defaultTtlMs = config.defaultTtlMs ?? 0;
    this.metrics = config.metrics;
    if (config.encryption) {
      this.encryptor = createAES256GCMProvider(config.encryption);
    }
  }

  // ---------- Thread Operations ----------

  async addEntry(options: AddEntryOptions): Promise<MemoryEntry> {
    const db = await this.ensureDb();
    const start = Date.now();
    const now = Date.now();
    const id = randomUUID();
    const ttl = options.ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttl > 0 ? now + ttl : null;

    // Security H-1: per-entry size limits to prevent DoS
    const MAX_CONTENT_BYTES = 102_400; // 100KB
    const MAX_METADATA_BYTES = 10_240; // 10KB
    if (options.content.length > MAX_CONTENT_BYTES) {
      throw new MemoryBackendError(
        this.name,
        `Content exceeds size limit (${options.content.length} > ${MAX_CONTENT_BYTES} bytes)`,
      );
    }

    let metadataJson: string | null = null;
    if (options.metadata) {
      try {
        metadataJson = JSON.stringify(options.metadata);
        // Security H-1: metadata size limit
        if (metadataJson.length > MAX_METADATA_BYTES) {
          throw new MemoryBackendError(
            this.name,
            `Metadata exceeds size limit (${metadataJson.length} > ${MAX_METADATA_BYTES} bytes)`,
          );
        }
      } catch (err) {
        if (err instanceof MemoryBackendError) throw err;
        throw new MemorySerializationError(
          this.name,
          `Failed to serialize metadata: ${(err as Error).message}`,
        );
      }
    }

    const storedContent = this.encryptField(options.content);
    // Security: encrypt metadata alongside content
    const storedMetadata = metadataJson ? this.encryptField(metadataJson) : null;

    db.prepare(
      `INSERT INTO memory_entries (id, session_id, role, content, tool_call_id, tool_name, task_pda, metadata, timestamp, expires_at, workspace_id, agent_id, user_id, world_id, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      options.sessionId,
      options.role,
      storedContent,
      options.toolCallId ?? null,
      options.toolName ?? null,
      options.taskPda ?? null,
      storedMetadata,
      now,
      expiresAt,
      options.workspaceId ?? "default",
      options.agentId ?? null,
      options.userId ?? null,
      options.worldId ?? null,
      options.channel ?? null,
    );

    this.logger.debug(`Added entry ${id} to session ${options.sessionId}`);
    this.recordMemoryMetrics("addEntry", Date.now() - start);

    return {
      id,
      sessionId: options.sessionId,
      role: options.role,
      content: options.content,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      timestamp: now,
      taskPda: options.taskPda,
      metadata: options.metadata,
      workspaceId: options.workspaceId ?? "default",
      agentId: options.agentId,
      userId: options.userId,
      worldId: options.worldId,
      channel: options.channel,
    };
  }

  async getThread(sessionId: string, limit?: number): Promise<MemoryEntry[]> {
    const db = await this.ensureDb();
    const start = Date.now();
    const now = Date.now();

    let sql = `SELECT * FROM memory_entries
               WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)
               ORDER BY timestamp ASC`;
    const params: unknown[] = [sessionId, now];

    if (limit !== undefined && limit > 0) {
      // Get the most recent `limit` entries by using a subquery
      sql = `SELECT * FROM (
               SELECT * FROM memory_entries
               WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)
               ORDER BY timestamp DESC
               LIMIT ?
             ) sub ORDER BY timestamp ASC`;
      params.push(limit);
    }

    const rows = db.prepare(sql).all(...params);
    this.recordMemoryMetrics("getThread", Date.now() - start);
    return rows.map((row: any) => this.rowToEntry(row));
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    const db = await this.ensureDb();
    const start = Date.now();
    const now = Date.now();
    const conditions: string[] = ["(expires_at IS NULL OR expires_at > ?)"];
    const params: unknown[] = [now];

    if (query.sessionId) {
      conditions.push("session_id = ?");
      params.push(query.sessionId);
    }
    if (query.taskPda) {
      conditions.push("task_pda = ?");
      params.push(query.taskPda);
    }
    if (query.after !== undefined) {
      conditions.push("timestamp > ?");
      params.push(query.after);
    }
    if (query.before !== undefined) {
      conditions.push("timestamp < ?");
      params.push(query.before);
    }
    if (query.role) {
      conditions.push("role = ?");
      params.push(query.role);
    }
    if (query.workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(query.workspaceId);
    }
    if (query.agentId) {
      conditions.push("agent_id = ?");
      params.push(query.agentId);
    }
    if (query.userId) {
      conditions.push("user_id = ?");
      params.push(query.userId);
    }
    if (query.worldId) {
      conditions.push("world_id = ?");
      params.push(query.worldId);
    }

    const validOrders = { asc: "ASC", desc: "DESC" } as const;
    const direction = validOrders[query.order ?? "asc"] ?? "ASC";
    let sql = `SELECT * FROM memory_entries WHERE ${conditions.join(" AND ")} ORDER BY timestamp ${direction}`;

    if (query.limit !== undefined && query.limit > 0) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }

    const rows = db.prepare(sql).all(...params);
    this.recordMemoryMetrics("query", Date.now() - start);
    return rows.map((row: any) => this.rowToEntry(row));
  }

  async deleteThread(sessionId: string): Promise<number> {
    const db = await this.ensureDb();
    const result = db
      .prepare("DELETE FROM memory_entries WHERE session_id = ?")
      .run(sessionId);
    this.logger.debug(
      `Deleted thread ${sessionId} (${result.changes} entries)`,
    );
    return result.changes;
  }

  async listSessions(prefix?: string): Promise<string[]> {
    const db = await this.ensureDb();
    const now = Date.now();

    if (prefix) {
      const rows = db
        .prepare(
          `SELECT DISTINCT session_id FROM memory_entries
         WHERE (expires_at IS NULL OR expires_at > ?) AND session_id LIKE ?`,
        )
        .all(now, `${escapeLikePrefix(prefix)}%`);
      return rows.map((r: any) => r.session_id);
    }

    const rows = db
      .prepare(
        "SELECT DISTINCT session_id FROM memory_entries WHERE (expires_at IS NULL OR expires_at > ?)",
      )
      .all(now);
    return rows.map((r: any) => r.session_id);
  }

  async appendTranscript(
    streamId: string,
    events: readonly TranscriptEventInput[],
  ): Promise<TranscriptEvent[]> {
    const db = await this.ensureDb();
    const start = Date.now();

    const getMaxSeqStmt = db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM memory_transcript_events WHERE stream_id = ?",
    );
    const getExistingStmt = db.prepare(
      "SELECT * FROM memory_transcript_events WHERE stream_id = ? AND event_id = ?",
    );
    const insertStmt = db.prepare(
      `INSERT INTO memory_transcript_events (stream_id, seq, event_id, kind, payload, metadata, timestamp, version, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let nextSeq = Number(getMaxSeqStmt.get(streamId)?.max_seq ?? 0);
    const appended: TranscriptEvent[] = [];

    for (const event of events) {
      const existingRow = getExistingStmt.get(streamId, event.eventId);
      if (existingRow) {
        appended.push(this.rowToTranscriptEvent(existingRow));
        continue;
      }

      nextSeq += 1;
      const stored = materializeTranscriptEvent(streamId, nextSeq, event);
      const payloadJson = this.encryptField(JSON.stringify(stored.payload));
      const metadataJson = stored.metadata
        ? this.encryptField(JSON.stringify(stored.metadata))
        : null;

      insertStmt.run(
        streamId,
        stored.seq,
        stored.eventId,
        stored.kind,
        payloadJson,
        metadataJson,
        stored.timestamp,
        stored.version,
        stored.dedupeKey ?? null,
      );
      appended.push(stored);
    }

    this.recordMemoryMetrics("appendTranscript", Date.now() - start);
    return appended;
  }

  async loadTranscript(
    streamId: string,
    options: TranscriptLoadOptions = {},
  ): Promise<TranscriptEvent[]> {
    const db = await this.ensureDb();
    const start = Date.now();
    const conditions = ["stream_id = ?"];
    const params: unknown[] = [streamId];

    if (options.afterSeq !== undefined) {
      conditions.push("seq > ?");
      params.push(options.afterSeq);
    }

    const order = options.order === "desc" ? "DESC" : "ASC";
    let sql = `SELECT * FROM memory_transcript_events WHERE ${conditions.join(" AND ")} ORDER BY seq ${order}`;
    if (options.limit !== undefined && options.limit > 0) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = db.prepare(sql).all(...params);
    const result = applyTranscriptLoadOptions(
      rows.map((row: any) => this.rowToTranscriptEvent(row)),
      options,
    );
    this.recordMemoryMetrics("loadTranscript", Date.now() - start);
    return result;
  }

  async deleteTranscript(streamId: string): Promise<number> {
    const db = await this.ensureDb();
    const result = db
      .prepare("DELETE FROM memory_transcript_events WHERE stream_id = ?")
      .run(streamId);
    return result.changes;
  }

  async listTranscriptStreams(prefix?: string): Promise<string[]> {
    const db = await this.ensureDb();
    if (prefix) {
      const rows = db
        .prepare(
          `SELECT DISTINCT stream_id FROM memory_transcript_events
           WHERE stream_id LIKE ? ORDER BY stream_id ASC`,
        )
        .all(`${escapeLikePrefix(prefix)}%`);
      return rows.map((row: any) => row.stream_id);
    }

    const rows = db
      .prepare(
        "SELECT DISTINCT stream_id FROM memory_transcript_events ORDER BY stream_id ASC",
      )
      .all();
    return rows.map((row: any) => row.stream_id);
  }

  // ---------- Key-Value Operations ----------

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const db = await this.ensureDb();
    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttl > 0 ? Date.now() + ttl : null;

    let valueJson: string;
    try {
      valueJson = JSON.stringify(value);
    } catch (err) {
      throw new MemorySerializationError(
        this.name,
        `Failed to serialize value: ${(err as Error).message}`,
      );
    }

    const storedValue = this.encryptField(valueJson);

    db.prepare(
      `INSERT OR REPLACE INTO memory_kv (key, value, expires_at) VALUES (?, ?, ?)`,
    ).run(key, storedValue, expiresAt);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const db = await this.ensureDb();
    const now = Date.now();
    const row = db
      .prepare(
        "SELECT value FROM memory_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(key, now);

    if (!row) return undefined;

    try {
      const rawValue = this.decryptField((row as any).value);
      return JSON.parse(rawValue) as T;
    } catch (err) {
      if (err instanceof MemoryEncryptionError) throw err;
      throw new MemorySerializationError(
        this.name,
        `Failed to deserialize value for key "${key}": ${(err as Error).message}`,
      );
    }
  }

  async delete(key: string): Promise<boolean> {
    const db = await this.ensureDb();
    const result = db.prepare("DELETE FROM memory_kv WHERE key = ?").run(key);
    return result.changes > 0;
  }

  async has(key: string): Promise<boolean> {
    const db = await this.ensureDb();
    const now = Date.now();
    const row = db
      .prepare(
        "SELECT 1 FROM memory_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(key, now);
    return row !== undefined;
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const db = await this.ensureDb();
    const now = Date.now();

    if (prefix) {
      const rows = db
        .prepare(
          "SELECT key FROM memory_kv WHERE (expires_at IS NULL OR expires_at > ?) AND key LIKE ?",
        )
        .all(now, `${escapeLikePrefix(prefix)}%`);
      return rows.map((r: any) => r.key);
    }

    const rows = db
      .prepare(
        "SELECT key FROM memory_kv WHERE (expires_at IS NULL OR expires_at > ?)",
      )
      .all(now);
    return rows.map((r: any) => r.key);
  }

  // ---------- Lifecycle ----------

  async clear(): Promise<void> {
    const db = await this.ensureDb();
    db.prepare("DELETE FROM memory_entries").run();
    db.prepare("DELETE FROM memory_transcript_events").run();
    db.prepare("DELETE FROM memory_kv").run();
    this.logger.debug("Cleared all memory");
  }

  async close(): Promise<void> {
    this.closed = true;
    // Audit S2.3: also clear the memoized init promise so a stale
    // init can't resurrect the connection after close.
    this.dbInitPromise = null;
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.logger.debug("SQLite backend closed");
  }

  async healthCheck(): Promise<boolean> {
    if (this.closed || !this.db) return false;
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  getDurability(): import("../types.js").DurabilityInfo {
    return {
      level: "sync",
      supportsFlush: true,
      description:
        "Data is persisted synchronously to disk via SQLite WAL. flush() forces a WAL checkpoint.",
    };
  }

  async flush(): Promise<void> {
    const db = await this.ensureDb();
    db.pragma("wal_checkpoint(TRUNCATE)");
  }

  // ---------- Internals ----------

  private recordMemoryMetrics(operation: string, durationMs: number): void {
    if (!this.metrics) return;
    const labels = { operation, backend: "sqlite" };
    this.metrics.counter(TELEMETRY_METRIC_NAMES.MEMORY_OPS_TOTAL, 1, labels);
    this.metrics.histogram(
      TELEMETRY_METRIC_NAMES.MEMORY_OP_DURATION,
      durationMs,
      labels,
    );
  }

  protected async ensureDb(): Promise<any> {
    if (this.closed) {
      throw new MemoryBackendError(this.name, "Backend is closed");
    }
    if (this.db) return this.db;
    if (this.dbInitPromise) return this.dbInitPromise;

    // Audit S2.3: memoize the in-flight init Promise so concurrent
    // callers do not race on the `if (this.db)` check above. The
    // previous code could have two callers both pass the check, both
    // call ensureLazyBackend(), and both run createSchema() +
    // cleanupExpired() against the same DB instance.
    this.dbInitPromise = (async () => {
      const db = await ensureLazyBackend("better-sqlite3", this.name, (mod) => {
        const Database = (mod.default ?? mod) as any;
        return new Database(this.config.dbPath);
      });

      this.db = db;

      if (this.config.walMode && this.config.dbPath !== ":memory:") {
        db.pragma("journal_mode = WAL");
      }

      this.createSchema();

      if (this.config.cleanupOnConnect) {
        this.cleanupExpired();
      }

      return db;
    })();

    try {
      return await this.dbInitPromise;
    } catch (err) {
      // Clear so a retry can re-initialize. Otherwise the second
      // caller would await a permanently-rejected Promise forever.
      this.dbInitPromise = null;
      this.db = null;
      throw err;
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT,
        task_pda TEXT,
        metadata TEXT,
        timestamp INTEGER NOT NULL,
        expires_at INTEGER,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT,
        user_id TEXT,
        world_id TEXT,
        channel TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_entries_session_id ON memory_entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON memory_entries(timestamp);
      CREATE INDEX IF NOT EXISTS idx_entries_task_pda ON memory_entries(task_pda);
      CREATE INDEX IF NOT EXISTS idx_entries_workspace_id ON memory_entries(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_entries_workspace_session ON memory_entries(workspace_id, session_id, timestamp);

      CREATE TABLE IF NOT EXISTS memory_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS memory_transcript_events (
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        metadata TEXT,
        timestamp INTEGER NOT NULL,
        version INTEGER NOT NULL,
        dedupe_key TEXT,
        PRIMARY KEY (stream_id, seq),
        UNIQUE(stream_id, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_transcript_stream_seq ON memory_transcript_events(stream_id, seq);
      CREATE INDEX IF NOT EXISTS idx_transcript_stream_timestamp ON memory_transcript_events(stream_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_transcript_stream_dedupe ON memory_transcript_events(stream_id, dedupe_key);
    `);
    // Schema migration: add scoping columns to existing DBs
    this.migrateSchemaIfNeeded();
  }

  private migrateSchemaIfNeeded(): void {
    try {
      // Check if workspace_id column exists
      const columns = this.db
        .prepare("PRAGMA table_info(memory_entries)")
        .all() as Array<{ name: string }>;
      const hasWorkspaceId = columns.some((c) => c.name === "workspace_id");
      if (!hasWorkspaceId) {
        this.db.exec(`
          ALTER TABLE memory_entries ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
          ALTER TABLE memory_entries ADD COLUMN agent_id TEXT;
          ALTER TABLE memory_entries ADD COLUMN user_id TEXT;
          ALTER TABLE memory_entries ADD COLUMN world_id TEXT;
          ALTER TABLE memory_entries ADD COLUMN channel TEXT;
          CREATE INDEX IF NOT EXISTS idx_entries_workspace_id ON memory_entries(workspace_id);
          CREATE INDEX IF NOT EXISTS idx_entries_workspace_session ON memory_entries(workspace_id, session_id, timestamp);
        `);
      }
    } catch (err) {
      // Audit S3.2: log instead of silently swallowing the migration
      // failure. The previous comment "Migration not needed or
      // already applied" was correct ONLY for ALTER TABLE failures
      // caused by the column already existing. Any other failure
      // (locked DB, corrupted file, schema mismatch) was silently
      // dropped, leaving the backend running against an under-
      // migrated schema. The catch is kept (so a benign re-migration
      // doesn't crash startup) but a warning is now emitted.
      this.logger.warn(
        `[sqlite] schema migration check failed: ${(err as Error).message}`,
      );
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    const entriesResult = this.db
      .prepare(
        "DELETE FROM memory_entries WHERE expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(now);
    const kvResult = this.db
      .prepare(
        "DELETE FROM memory_kv WHERE expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(now);

    const total = entriesResult.changes + kvResult.changes;
    if (total > 0) {
      this.logger.debug(`Cleaned up ${total} expired rows on connect`);
    }
  }

  private rowToEntry(row: any): MemoryEntry {
    const entry: MemoryEntry = {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: this.decryptField(row.content),
      timestamp: row.timestamp,
    };

    if (row.tool_call_id) (entry as any).toolCallId = row.tool_call_id;
    if (row.tool_name) (entry as any).toolName = row.tool_name;
    if (row.task_pda) (entry as any).taskPda = row.task_pda;
    if (row.metadata) {
      try {
        const decryptedMetadata = this.decryptField(row.metadata);
        (entry as any).metadata = JSON.parse(decryptedMetadata);
      } catch {
        // Ignore corrupt or unencrypted metadata
      }
    }
    // Scoping fields (Phase 2)
    if (row.workspace_id) (entry as any).workspaceId = row.workspace_id;
    if (row.agent_id) (entry as any).agentId = row.agent_id;
    if (row.user_id) (entry as any).userId = row.user_id;
    if (row.world_id) (entry as any).worldId = row.world_id;
    if (row.channel) (entry as any).channel = row.channel;

    return entry;
  }

  private rowToTranscriptEvent(row: any): TranscriptEvent {
    let payload: TranscriptEvent["payload"];
    try {
      payload = JSON.parse(this.decryptField(row.payload)) as TranscriptEvent["payload"];
    } catch (err) {
      throw new MemorySerializationError(
        this.name,
        `Failed to deserialize transcript payload: ${(err as Error).message}`,
      );
    }

    let metadata: Record<string, unknown> | undefined;
    if (row.metadata) {
      try {
        metadata = JSON.parse(this.decryptField(row.metadata)) as Record<
          string,
          unknown
        >;
      } catch (err) {
        throw new MemorySerializationError(
          this.name,
          `Failed to deserialize transcript metadata: ${(err as Error).message}`,
        );
      }
    }

    return {
      version: row.version,
      streamId: row.stream_id,
      seq: row.seq,
      eventId: row.event_id,
      kind: row.kind,
      payload,
      timestamp: row.timestamp,
      metadata,
      dedupeKey: row.dedupe_key ?? undefined,
    };
  }

  private encryptField(plaintext: string): string {
    if (!this.encryptor) return plaintext;
    try {
      return this.encryptor.encrypt(plaintext);
    } catch (err) {
      throw new MemoryEncryptionError(
        this.name,
        `Encryption failed: ${(err as Error).message}`,
      );
    }
  }

  private decryptField(value: string): string {
    if (!this.encryptor) return value;
    try {
      return this.encryptor.decrypt(value);
    } catch (err) {
      throw new MemoryEncryptionError(
        this.name,
        `Decryption failed: ${(err as Error).message}`,
      );
    }
  }
}
