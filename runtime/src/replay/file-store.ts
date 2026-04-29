/**
 * File-backed replay timeline store for deterministic checkpointed replay.
 *
 * @module
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { InMemoryReplayTimelineStore } from "./in-memory-store.js";
import {
  type ReplayEventCursor,
  type ReplayStorageWriteResult,
  type ReplayTimelineQuery,
  type ReplayTimelineRecord,
  type ReplayTimelineStore,
} from "./types.js";
import {
  migratePersistedReplayTimelineState,
  REPLAY_FILE_STATE_SCHEMA_VERSION,
  type PersistedReplayTimelineState,
} from "./migrations.js";

export class FileReplayTimelineStore implements ReplayTimelineStore {
  private readonly fallback = new InMemoryReplayTimelineStore();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async save(
    records: readonly ReplayTimelineRecord[],
  ): Promise<ReplayStorageWriteResult> {
    await this.getState();
    const result = await this.fallback.save(records);
    const cursor = await this.fallback.getCursor();
    const allRecords = [...(await this.fallback.query())];
    await this.persist({
      schemaVersion: REPLAY_FILE_STATE_SCHEMA_VERSION,
      cursor,
      records: allRecords,
    });
    return result;
  }

  async query(
    filter: ReplayTimelineQuery = {},
  ): Promise<ReadonlyArray<ReplayTimelineRecord>> {
    await this.getState();
    return this.fallback.query(filter);
  }

  async getCursor(): Promise<ReplayEventCursor | null> {
    const state = await this.getState();
    return state.cursor;
  }

  async saveCursor(cursor: ReplayEventCursor | null): Promise<void> {
    const state = await this.getState();
    await this.persist({
      schemaVersion: REPLAY_FILE_STATE_SCHEMA_VERSION,
      cursor,
      records: state.records,
    });
    await this.fallback.saveCursor(cursor);
  }

  async clear(): Promise<void> {
    await this.persist({
      schemaVersion: REPLAY_FILE_STATE_SCHEMA_VERSION,
      cursor: null,
      records: [],
    });
    await this.fallback.clear();
  }

  getDurability(): import("../memory/types.js").DurabilityInfo {
    return {
      level: "async",
      supportsFlush: true,
      description:
        "Data is persisted via atomic file rename. flush() forces a persist of current state.",
    };
  }

  async flush(): Promise<void> {
    const state = await this.getState();
    await this.persist(state);
  }

  private async getState(): Promise<PersistedReplayTimelineState> {
    if (this.loaded) {
      return {
        schemaVersion: REPLAY_FILE_STATE_SCHEMA_VERSION,
        cursor: await this.fallback.getCursor(),
        records: [...(await this.fallback.query())],
      };
    }

    await this.fallback.clear();
    if (!existsSync(this.filePath)) {
      const empty: PersistedReplayTimelineState = {
        schemaVersion: REPLAY_FILE_STATE_SCHEMA_VERSION,
        cursor: null,
        records: [],
      };
      await this.persist(empty);
      this.loaded = true;
      return empty;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      const migration = migratePersistedReplayTimelineState(
        JSON.parse(raw) as PersistedReplayTimelineState | null,
      );
      const parsed = migration.value;
      const cursor = parsed.cursor ?? null;
      const records = [...parsed.records];
      await this.fallback.clear();
      if (records.length > 0) {
        await this.fallback.save(records);
      }
      await this.fallback.saveCursor(cursor);
      if (migration.migrated) {
        await this.persist(parsed);
      }
      this.loaded = true;
      return parsed;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        const empty: PersistedReplayTimelineState = {
          schemaVersion: REPLAY_FILE_STATE_SCHEMA_VERSION,
          cursor: null,
          records: [],
        };
        this.loaded = true;
        return empty;
      }
      throw error;
    }
  }

  private async persist(state: PersistedReplayTimelineState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify({
      schemaVersion: REPLAY_FILE_STATE_SCHEMA_VERSION,
      cursor: state.cursor,
      records: state.records,
    });
    // Write to temp file then rename for crash-safe persistence
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, payload);
    await rename(tmpPath, this.filePath);
  }
}
