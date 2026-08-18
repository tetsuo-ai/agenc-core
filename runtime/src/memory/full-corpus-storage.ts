import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

import {
  MAX_MEMORY_FILES_PER_ROOT,
  MEMORY_FTS_TOKENIZER,
  MEMORY_INDEX_SCHEMA_VERSION,
} from "./full-corpus-contract.js";

const INDEX_DIRECTORY_MODE = 0o700;
const INDEX_FILE_MODE = 0o600;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const MEMORY_INDEX_SCHEMA_SIGNATURE =
  "agenc-memory-index-schema-v2-generational-fts5-reader-pins-bounded-counts";

export interface OpenMemoryIndexDatabaseResult {
  readonly database: BetterSqlite3.Database;
  readonly ftsAvailable: boolean;
}

export class MemoryIndexSchemaError extends Error {
  constructor(readonly foundVersion: number) {
    super(
      `memory index schema ${foundVersion} is incompatible with ${MEMORY_INDEX_SCHEMA_VERSION}`,
    );
    this.name = "MemoryIndexSchemaError";
  }
}

export class MemoryIndexCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryIndexCorruptionError";
  }
}

export function openMemoryIndexDatabase(
  databasePath: string,
): OpenMemoryIndexDatabaseResult {
  const directory = dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: INDEX_DIRECTORY_MODE });
  chmodSync(directory, INDEX_DIRECTORY_MODE);
  let database: BetterSqlite3.Database | undefined;
  let ftsAvailable: boolean;
  try {
    database = new Database(databasePath);
    configureDatabase(database);
    assertDatabaseIntegrity(database);
    ftsAvailable = probeFtsCapability(database);
    initializeSchema(database, ftsAvailable);
    chmodSync(databasePath, INDEX_FILE_MODE);
  } catch (error) {
    database?.close();
    const recoverable = classifyRecoverableDatabaseError(error);
    if (recoverable === null) throw error;
    rotateIncompatibleDatabase(databasePath, recoverable);
    database = new Database(databasePath);
    configureDatabase(database);
    ftsAvailable = probeFtsCapability(database);
    initializeSchema(database, ftsAvailable);
    chmodSync(databasePath, INDEX_FILE_MODE);
  }
  if (database === undefined) {
    throw new Error("memory index database initialization did not complete");
  }
  return { database, ftsAvailable };
}

function configureDatabase(database: BetterSqlite3.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("foreign_keys = ON");
  database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  database.pragma("temp_store = MEMORY");
}

function assertDatabaseIntegrity(database: BetterSqlite3.Database): void {
  let result: unknown;
  try {
    result = database.pragma("quick_check", { simple: true });
  } catch (error) {
    throw new MemoryIndexCorruptionError(
      `memory index integrity check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (result !== "ok") {
    throw new MemoryIndexCorruptionError(
      "memory index integrity check reported corruption",
    );
  }
}

function classifyRecoverableDatabaseError(
  error: unknown,
): MemoryIndexSchemaError | MemoryIndexCorruptionError | null {
  if (
    error instanceof MemoryIndexSchemaError ||
    error instanceof MemoryIndexCorruptionError
  ) {
    return error;
  }
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") {
    return new MemoryIndexCorruptionError(
      `memory index database is corrupt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return null;
}

function rotateIncompatibleDatabase(
  databasePath: string,
  error: MemoryIndexSchemaError | MemoryIndexCorruptionError,
): void {
  const reason =
    error instanceof MemoryIndexSchemaError
      ? `schema-${error.foundVersion}`
      : "corrupt";
  const backupBase = `${databasePath}.${reason}-${Date.now()}-${randomUUID()}`;
  for (const suffix of ["", "-wal", "-shm"] as const) {
    const source = `${databasePath}${suffix}`;
    if (!existsSync(source)) continue;
    renameSync(source, `${backupBase}${suffix}`);
  }
}

function probeFtsCapability(database: BetterSqlite3.Database): boolean {
  try {
    database.exec(
      `CREATE VIRTUAL TABLE temp.agenc_memory_fts_probe
         USING fts5(title, description, tokenize='${MEMORY_FTS_TOKENIZER}')`,
    );
    database
      .prepare(
        "INSERT INTO temp.agenc_memory_fts_probe(title, description) VALUES (?, ?)",
      )
      .run("café", "probe");
    const row = database
      .prepare(
        "SELECT rowid FROM temp.agenc_memory_fts_probe WHERE title MATCH ?",
      )
      .get('"cafe"');
    database.exec("DROP TABLE temp.agenc_memory_fts_probe");
    return row !== undefined;
  } catch {
    try {
      database.exec("DROP TABLE IF EXISTS temp.agenc_memory_fts_probe");
    } catch {
      // Capability probing is best effort and must not alter the last good index.
    }
    return false;
  }
}

function initializeSchema(
  database: BetterSqlite3.Database,
  ftsAvailable: boolean,
): void {
  const version = database.pragma("user_version", { simple: true });
  if (!ftsAvailable) return;
  if (version !== 0 && version !== MEMORY_INDEX_SCHEMA_VERSION) {
    throw new MemoryIndexSchemaError(Number(version));
  }
  if (
    version === MEMORY_INDEX_SCHEMA_VERSION &&
    readMemorySchemaSignature(database) !== MEMORY_INDEX_SCHEMA_SIGNATURE
  ) {
    throw new MemoryIndexSchemaError(Number(version));
  }
  database
    .transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS memory_index_metadata(
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS memory_index_roots(
          root_id TEXT PRIMARY KEY,
          canonical_path TEXT NOT NULL UNIQUE,
          root_role TEXT NOT NULL CHECK(root_role IN ('global', 'project')),
          current_generation_id INTEGER,
          last_used_at_ms INTEGER NOT NULL,
          watcher_health TEXT NOT NULL CHECK(watcher_health IN ('healthy', 'degraded', 'overflow')),
          audit_cursor TEXT
        );
        CREATE TABLE IF NOT EXISTS memory_index_generations(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_id TEXT NOT NULL REFERENCES memory_index_roots(root_id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK(state IN ('staging', 'complete', 'failed', 'superseded')),
          generation_token TEXT NOT NULL UNIQUE,
          started_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER,
          elapsed_active_ms INTEGER NOT NULL,
          discovery_operations INTEGER NOT NULL,
          discovered_file_count INTEGER NOT NULL CHECK(
            discovered_file_count >= 0 AND
            discovered_file_count <= ${MAX_MEMORY_FILES_PER_ROOT}
          ),
          entry_count INTEGER NOT NULL CHECK(
            entry_count >= 0 AND entry_count <= ${MAX_MEMORY_FILES_PER_ROOT}
          ),
          indexed_bytes INTEGER NOT NULL,
          digest TEXT,
          change_cursor INTEGER NOT NULL,
          change_overflow INTEGER NOT NULL CHECK(change_overflow IN (0, 1)),
          error TEXT,
          builder_owner TEXT,
          builder_lease_expires_at_ms INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS memory_one_staging_generation
          ON memory_index_generations(root_id) WHERE state = 'staging';
        CREATE TABLE IF NOT EXISTS memory_index_directory_work(
          root_id TEXT NOT NULL,
          generation_id INTEGER NOT NULL REFERENCES memory_index_generations(id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending', 'enumerating', 'complete')),
          dev TEXT NOT NULL,
          ino TEXT NOT NULL,
          mtime_ns TEXT NOT NULL,
          PRIMARY KEY(root_id, generation_id, relative_path)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS memory_index_discovered_files(
          root_id TEXT NOT NULL,
          generation_id INTEGER NOT NULL REFERENCES memory_index_generations(id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending', 'complete', 'diagnosed')),
          error TEXT,
          PRIMARY KEY(root_id, generation_id, relative_path)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS memory_discovered_pending_order
          ON memory_index_discovered_files(
            root_id, generation_id, state, CAST(relative_path AS BLOB)
          );
        CREATE TABLE IF NOT EXISTS memory_index_entries(
          root_id TEXT NOT NULL,
          generation_id INTEGER NOT NULL REFERENCES memory_index_generations(id) ON DELETE CASCADE,
          memory_id TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          canonical_path TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          memory_type TEXT,
          mtime_ms INTEGER NOT NULL,
          file_size INTEGER NOT NULL,
          fingerprint TEXT NOT NULL,
          last_seen_generation INTEGER NOT NULL,
          file_dev TEXT NOT NULL,
          file_ino TEXT NOT NULL,
          file_mode TEXT NOT NULL,
          file_mtime_ns TEXT NOT NULL,
          file_ctime_ns TEXT NOT NULL,
          root_dev TEXT NOT NULL,
          root_ino TEXT NOT NULL,
          root_mode TEXT NOT NULL,
          root_size TEXT NOT NULL,
          root_mtime_ns TEXT NOT NULL,
          root_ctime_ns TEXT NOT NULL,
          PRIMARY KEY(root_id, generation_id, memory_id),
          UNIQUE(root_id, generation_id, canonical_path)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS memory_index_change_log(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          root_id TEXT NOT NULL REFERENCES memory_index_roots(root_id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          change_kind TEXT NOT NULL CHECK(change_kind IN ('create', 'update', 'delete', 'rename')),
          observed_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_change_log_root_sequence
          ON memory_index_change_log(root_id, sequence);
        CREATE TABLE IF NOT EXISTS memory_index_owners(
          root_id TEXT NOT NULL REFERENCES memory_index_roots(root_id) ON DELETE CASCADE,
          owner_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('watcher')),
          lease_expires_at_ms INTEGER NOT NULL,
          PRIMARY KEY(root_id, owner_id, kind)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS memory_index_owner_lease
          ON memory_index_owners(lease_expires_at_ms, root_id);
        CREATE TABLE IF NOT EXISTS memory_index_reader_pins(
          pin_id TEXT NOT NULL,
          generation_id INTEGER NOT NULL REFERENCES memory_index_generations(id) ON DELETE CASCADE,
          lease_expires_at_ms INTEGER NOT NULL,
          PRIMARY KEY(pin_id, generation_id)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS memory_reader_pin_generation_lease
          ON memory_index_reader_pins(generation_id, lease_expires_at_ms);
        CREATE INDEX IF NOT EXISTS memory_reader_pin_expiry
          ON memory_index_reader_pins(lease_expires_at_ms, pin_id, generation_id);
      `);
      database.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
           root_id UNINDEXED,
           generation_id UNINDEXED,
           memory_id UNINDEXED,
           title,
           description,
           tokenize='${MEMORY_FTS_TOKENIZER}'
         )`,
      );
      database
        .prepare(
          `INSERT OR REPLACE INTO memory_index_metadata(key, value)
           VALUES ('schema_signature', ?)`,
        )
        .run(MEMORY_INDEX_SCHEMA_SIGNATURE);
      database.pragma(`user_version = ${MEMORY_INDEX_SCHEMA_VERSION}`);
    })
    .immediate();
}

function readMemorySchemaSignature(
  database: BetterSqlite3.Database,
): string | null {
  try {
    const row = database
      .prepare<[], { value: string }>(
        `SELECT value FROM memory_index_metadata
          WHERE key = 'schema_signature'`,
      )
      .get();
    return row?.value ?? null;
  } catch {
    return null;
  }
}
