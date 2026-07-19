import type { ThreadId } from "../agents/registry.js";
import type { ThreadSource } from "../thread-store/store.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";

export interface IndexedThreadRecord {
  readonly threadId: ThreadId;
  readonly name?: string;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly memoryMode?: "enabled" | "disabled";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly cwd?: string;
  readonly source?: ThreadSource;
  readonly forkedFromId?: ThreadId;
  readonly rolloutPath?: string;
  readonly archivedRolloutPath?: string;
}

export interface IndexedThreadPage {
  readonly items: ReadonlyArray<IndexedThreadRecord>;
  readonly hasMore: boolean;
}

interface ThreadRow {
  readonly thread_id: string;
  readonly name: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
  readonly cwd: string | null;
  readonly originator: string | null;
  readonly source_json: string | null;
  readonly forked_from_id: string | null;
  readonly model: string | null;
  readonly model_provider: string | null;
  readonly memory_mode: string | null;
  readonly rollout_path: string | null;
  readonly archived_rollout_path: string | null;
}

export class StateThreadRepository {
  constructor(private readonly driver: StateSqliteDriver) {}

  /**
   * Relocate every live SQLite reference when a rollout JSONL is archived or
   * restored. The filesystem rename is owned by FileThreadStore; keeping this
   * projection move in one immediate transaction prevents replay, retention,
   * and terminal-epoch checks from retaining a stale source path.
   */
  relocateRolloutSource(sourcePath: string, targetPath: string): void {
    if (sourcePath === targetPath) return;
    this.driver.transactionImmediate(() => {
      this.driver
        .prepareState<[string, string]>(
          "UPDATE thread_rollout_items SET source_path = ? WHERE source_path = ?",
        )
        .run(targetPath, sourcePath);
      this.driver
        .prepareState<[string, string]>(
          "UPDATE rollout_receipts SET source_path = ? WHERE source_path = ?",
        )
        .run(targetPath, sourcePath);
      this.driver
        .prepareState<[string, string]>(
          "UPDATE backfill_files SET source_path = ? WHERE source_path = ?",
        )
        .run(targetPath, sourcePath);
      this.driver
        .prepareState<[string, string]>(
          "UPDATE thread_spawn_edges SET source_path = ? WHERE source_path = ?",
        )
        .run(targetPath, sourcePath);
      this.driver
        .prepareState<[string, string]>(
          "UPDATE run_journal_bindings SET source_path = ? WHERE source_path = ?",
        )
        .run(targetPath, sourcePath);
    });
  }

  /**
   * Commit one bounded rollout projection and validate its filesystem identity
   * at the final synchronous boundary before SQLite commits. Any failed
   * validation rolls back both thread metadata and rollout/receipt rows.
   */
  commitRolloutProjection<T>(
    apply: () => T,
    validateCanonical: () => void,
  ): T {
    return this.driver.transactionImmediate(() => {
      const result = apply();
      validateCanonical();
      return result;
    });
  }

  upsertThread(record: IndexedThreadRecord): void {
    this.driver
      .prepareState(
        `INSERT INTO threads (
          thread_id,
          name,
          created_at,
          updated_at,
          archived_at,
          cwd,
          source_json,
          forked_from_id,
          model,
          model_provider,
          memory_mode,
          rollout_path,
          archived_rollout_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          name = excluded.name,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          cwd = excluded.cwd,
          source_json = excluded.source_json,
          forked_from_id = excluded.forked_from_id,
          model = excluded.model,
          model_provider = excluded.model_provider,
          memory_mode = excluded.memory_mode,
          rollout_path = excluded.rollout_path,
          archived_rollout_path = excluded.archived_rollout_path`,
      )
      .run(
        record.threadId,
        record.name ?? null,
        record.createdAt,
        record.updatedAt,
        record.archivedAt ?? null,
        record.cwd ?? null,
        record.source === undefined ? null : JSON.stringify(record.source),
        record.forkedFromId ?? null,
        record.model ?? null,
        record.modelProvider ?? null,
        record.memoryMode ?? null,
        record.rolloutPath ?? null,
        record.archivedRolloutPath ?? null,
      );
  }

  mergeThread(
    record: IndexedThreadRecord,
    opts: { readonly replaceArchiveState?: boolean } = {},
  ): void {
    const existing = this.getThread(record.threadId);
    const replaceArchiveState = opts.replaceArchiveState === true;
    const name = record.name ?? existing?.name;
    const model = record.model ?? existing?.model;
    const modelProvider = record.modelProvider ?? existing?.modelProvider;
    const memoryMode = record.memoryMode ?? existing?.memoryMode;
    const cwd = record.cwd ?? existing?.cwd;
    const source = record.source ?? existing?.source;
    const forkedFromId = record.forkedFromId ?? existing?.forkedFromId;
    const merged: IndexedThreadRecord = {
      threadId: record.threadId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(name !== undefined ? { name } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(modelProvider !== undefined ? { modelProvider } : {}),
      ...(memoryMode !== undefined ? { memoryMode } : {}),
      ...(!replaceArchiveState && existing?.archivedAt !== undefined
        ? { archivedAt: existing.archivedAt }
        : {}),
      ...(record.archivedAt !== undefined
        ? { archivedAt: record.archivedAt }
        : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(forkedFromId !== undefined ? { forkedFromId } : {}),
      ...(!replaceArchiveState && existing?.rolloutPath !== undefined
        ? { rolloutPath: existing.rolloutPath }
        : {}),
      ...(record.rolloutPath !== undefined
        ? { rolloutPath: record.rolloutPath }
        : {}),
      ...(!replaceArchiveState && existing?.archivedRolloutPath !== undefined
        ? { archivedRolloutPath: existing.archivedRolloutPath }
        : {}),
      ...(record.archivedRolloutPath !== undefined
        ? { archivedRolloutPath: record.archivedRolloutPath }
        : {}),
    };
    this.upsertThread(merged);
  }

  getThread(threadId: ThreadId): IndexedThreadRecord | undefined {
    const row = this.driver
      .prepareState<[ThreadId], ThreadRow>(
        `SELECT thread_id, name, created_at, updated_at, archived_at, cwd, originator,
          source_json, forked_from_id, model, model_provider, memory_mode,
          rollout_path, archived_rollout_path
         FROM threads
         WHERE thread_id = ?`,
      )
      .get(threadId);
    return row === undefined ? undefined : rowToThread(row);
  }

  listThreads(): ReadonlyArray<IndexedThreadRecord> {
    return this.driver
      .prepareState<[], ThreadRow>(
        `SELECT thread_id, name, created_at, updated_at, archived_at, cwd, originator,
          source_json, forked_from_id, model, model_provider, memory_mode,
          rollout_path, archived_rollout_path
         FROM threads`,
      )
      .all()
      .map((row: ThreadRow) => rowToThread(row));
  }

  /** Constant-memory count used by daemon health; never materializes rows. */
  countThreads(archived: boolean): number {
    const predicate = archived
      ? "archived_at IS NOT NULL"
      : "archived_at IS NULL";
    return (
      this.driver
        .prepareState<[], { count: number }>(
          `SELECT COUNT(*) AS count FROM threads WHERE ${predicate}`,
        )
        .get()?.count ?? 0
    );
  }

  /**
   * Read one ordered metadata page without materializing the complete thread
   * table in daemon heap. Callers own the opaque cursor; this repository takes
   * its decoded keyset boundary so later pages do not rescan earlier rows.
   */
  listThreadPage(params: {
    readonly limit: number;
    readonly archived: boolean;
    readonly sortKey: "created_at" | "updated_at";
    readonly sortDirection: "asc" | "desc";
    readonly after?: {
      readonly sortValue: string;
      readonly threadId: string;
    };
  }): IndexedThreadPage {
    const direction = params.sortDirection === "asc" ? "ASC" : "DESC";
    const sortColumn =
      params.sortKey === "updated_at" ? "updated_at" : "created_at";
    const archivePredicate = params.archived
      ? "archived_at IS NOT NULL"
      : "archived_at IS NULL";
    const comparison = params.sortDirection === "asc" ? ">" : "<";
    const pagePredicate =
      params.after === undefined
        ? ""
        : ` AND (${sortColumn}, thread_id) ${comparison} (?, ?)`;
    const statement = this.driver.prepareState(
      `SELECT thread_id, name, created_at, updated_at, archived_at, cwd, originator,
          source_json, forked_from_id, model, model_provider, memory_mode,
          rollout_path, archived_rollout_path
         FROM threads
         WHERE ${archivePredicate}${pagePredicate}
         ORDER BY ${sortColumn} ${direction}, thread_id ${direction}
         LIMIT ?`,
    );
    const rows = (
      params.after === undefined
        ? statement.all(params.limit + 1)
        : statement.all(
            params.after.sortValue,
            params.after.threadId,
            params.limit + 1,
          )
    ) as ThreadRow[];
    return {
      items: rows
        .slice(0, params.limit)
        .map((row: ThreadRow) => rowToThread(row)),
      hasMore: rows.length > params.limit,
    };
  }

  /**
   * Returns the recorded backfill receipt for a rollout source file, or
   * `undefined` if the file has never been indexed. Used to decide whether a
   * re-index can be skipped (unchanged file) or reduced to an incremental
   * append (file grew) instead of a full DELETE-all + re-INSERT-all.
   */
  getBackfillFile(sourcePath: string): BackfillFileReceipt | undefined {
    const row = this.driver
      .prepareState<[string], BackfillFileRow>(
        `SELECT mtime_ms, size, sha256, line_count, item_count
         FROM backfill_files
         WHERE source_path = ?`,
      )
      .get(sourcePath);
    if (row === undefined) return undefined;
    return {
      mtimeMs: row.mtime_ms,
      size: row.size,
      sha256: row.sha256,
      lineCount: row.line_count,
      itemCount: row.item_count,
    };
  }

  /**
   * Incrementally indexes lines appended to an already-indexed rollout file.
   * Only the supplied (new) items are INSERTed; prior rows are left intact.
   * The `backfill_files` / `rollout_receipts` bookkeeping is advanced to the
   * new file size/line count so the next append can also be incremental.
   *
   * Callers must guarantee `items` are strictly new lines (line numbers beyond
   * the previously recorded `line_count`). Use `replaceRolloutItems` for the
   * full reconcile path when the prefix may have changed.
   */
  appendRolloutItems(params: {
    readonly threadId: ThreadId;
    readonly sourcePath: string;
    readonly items: ReadonlyArray<RolloutItemRow>;
    readonly mtimeMs: number;
    readonly size: number;
    readonly sha256: string;
    readonly lineCount: number;
    readonly totalItemCount: number;
  }): void {
    this.driver.transaction(() => {
      const insert = this.driver.prepareState(
        `INSERT INTO thread_rollout_items (
          thread_id, source_path, line_number, byte_offset, item_index,
          item_type, event_version, event_id, event_seq, payload_json, line_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of params.items) {
        insert.run(
          params.threadId,
          params.sourcePath,
          item.lineNumber,
          item.byteOffset,
          item.itemIndex,
          item.itemType,
          item.eventVersion ?? null,
          item.eventId ?? null,
          item.eventSeq ?? null,
          item.payloadJson,
          item.lineHash,
        );
      }
      this.writeBackfillReceipts({
        threadId: params.threadId,
        sourcePath: params.sourcePath,
        mtimeMs: params.mtimeMs,
        size: params.size,
        // Change-detection digest only. On the append path this is the prior
        // full-file hash carried forward, so it goes stale vs the on-disk file
        // until the next full reconcile re-establishes it. Skip decisions rely
        // on mtime+size (authoritative), not this hash, so it is intentionally
        // not recomputed per append (doing so would defeat the perf fix).
        sha256: params.sha256,
        lineCount: params.lineCount,
        itemCount: params.totalItemCount,
      });
    });
  }

  replaceRolloutItems(params: {
    readonly threadId: ThreadId;
    readonly sourcePath: string;
    readonly items: ReadonlyArray<RolloutItemRow>;
    readonly mtimeMs: number;
    readonly size: number;
    readonly sha256: string;
    readonly lineCount: number;
  }): void {
    this.driver.transaction(() => {
      this.driver
        .prepareState<[ThreadId, string]>(
          "DELETE FROM thread_rollout_items WHERE thread_id = ? AND source_path = ?",
        )
        .run(params.threadId, params.sourcePath);
      const insert = this.driver.prepareState(
        `INSERT INTO thread_rollout_items (
          thread_id, source_path, line_number, byte_offset, item_index,
          item_type, event_version, event_id, event_seq, payload_json, line_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of params.items) {
        insert.run(
          params.threadId,
          params.sourcePath,
          item.lineNumber,
          item.byteOffset,
          item.itemIndex,
          item.itemType,
          item.eventVersion ?? null,
          item.eventId ?? null,
          item.eventSeq ?? null,
          item.payloadJson,
          item.lineHash,
        );
      }
      this.writeBackfillReceipts({
        threadId: params.threadId,
        sourcePath: params.sourcePath,
        mtimeMs: params.mtimeMs,
        size: params.size,
        sha256: params.sha256,
        lineCount: params.lineCount,
        itemCount: params.items.length,
      });
    });
  }

  /**
   * Drop every SQLite mirror row that points at `sourcePath` — the indexed
   * rollout lines plus the backfill/receipt bookkeeping that tracks the file.
   * Used by the retention sweep so the `thread_rollout_items` mirror cannot
   * outlive the rollout JSONL it mirrors. Returns the count of indexed lines
   * removed. Idempotent: deleting an already-gone source is a no-op.
   */
  deleteRolloutItemsForSource(sourcePath: string): number {
    return this.driver.transaction(() => {
      const removedItems = this.driver
        .prepareState<[string]>(
          "DELETE FROM thread_rollout_items WHERE source_path = ?",
        )
        .run(sourcePath).changes;
      this.driver
        .prepareState<[string]>(
          "DELETE FROM backfill_files WHERE source_path = ?",
        )
        .run(sourcePath);
      this.driver
        .prepareState<[string]>(
          "DELETE FROM rollout_receipts WHERE source_path = ?",
        )
        .run(sourcePath);
      return removedItems;
    });
  }

  private writeBackfillReceipts(params: {
    readonly threadId: ThreadId;
    readonly sourcePath: string;
    readonly mtimeMs: number;
    readonly size: number;
    readonly sha256: string;
    readonly lineCount: number;
    readonly itemCount: number;
  }): void {
    this.driver
      .prepareState(
        `INSERT INTO backfill_files (
          source_path, thread_id, mtime_ms, size, sha256, line_count, item_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_path) DO UPDATE SET
          thread_id = excluded.thread_id,
          mtime_ms = excluded.mtime_ms,
          size = excluded.size,
          sha256 = excluded.sha256,
          line_count = excluded.line_count,
          item_count = excluded.item_count,
          imported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(
        params.sourcePath,
        params.threadId,
        params.mtimeMs,
        params.size,
        params.sha256,
        params.lineCount,
        params.itemCount,
      );
    this.driver
      .prepareState(
        `INSERT INTO rollout_receipts (
          thread_id, source_path, source_mtime_ms, source_size,
          source_sha256, imported_line_count, imported_item_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, source_path) DO UPDATE SET
          source_mtime_ms = excluded.source_mtime_ms,
          source_size = excluded.source_size,
          source_sha256 = excluded.source_sha256,
          imported_line_count = excluded.imported_line_count,
          imported_item_count = excluded.imported_item_count,
          imported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(
        params.threadId,
        params.sourcePath,
        params.mtimeMs,
        params.size,
        params.sha256,
        params.lineCount,
        params.itemCount,
      );
  }
}

/** Receipt of a previously indexed rollout source file. */
export interface BackfillFileReceipt {
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
  readonly lineCount: number;
  readonly itemCount: number;
}

interface BackfillFileRow {
  readonly mtime_ms: number;
  readonly size: number;
  readonly sha256: string;
  readonly line_count: number;
  readonly item_count: number;
}

/** One indexed rollout line, ready to INSERT into `thread_rollout_items`. */
export interface RolloutItemRow {
  readonly lineNumber: number;
  readonly byteOffset: number;
  readonly itemIndex: number;
  readonly itemType: string;
  readonly eventVersion?: number;
  readonly eventId?: string;
  readonly eventSeq?: number;
  readonly payloadJson: string;
  readonly lineHash: string;
}

function rowToThread(row: ThreadRow): IndexedThreadRecord {
  const record: IndexedThreadRecord = {
    threadId: row.thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.name !== null ? { name: row.name } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.model_provider !== null ? { modelProvider: row.model_provider } : {}),
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
    ...(row.source_json !== null ? { source: parseSource(row.source_json) } : {}),
    ...(row.forked_from_id !== null ? { forkedFromId: row.forked_from_id } : {}),
    ...(row.memory_mode === "enabled" || row.memory_mode === "disabled"
      ? { memoryMode: row.memory_mode }
      : {}),
    ...(row.rollout_path !== null ? { rolloutPath: row.rollout_path } : {}),
    ...(row.archived_rollout_path !== null
      ? { archivedRolloutPath: row.archived_rollout_path }
      : {}),
  };
  return record;
}

function parseSource(raw: string): ThreadSource | undefined {
  try {
    return JSON.parse(raw) as ThreadSource;
  } catch {
    return undefined;
  }
}
