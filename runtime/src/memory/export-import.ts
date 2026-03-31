/**
 * Memory export and import — enables backup, migration, and portability.
 *
 * Phase 9.3: dump workspace memory to JSON, restore from backup.
 * Format includes schema version for forward compatibility.
 *
 * @module
 */

import type { MemoryBackend, MemoryEntry } from "./types.js";
import type { Logger } from "../utils/logger.js";

const EXPORT_SCHEMA_VERSION = 1;

/** Exported memory snapshot. */
export interface MemoryExport {
  readonly schemaVersion: number;
  readonly exportedAt: number;
  readonly workspaceId?: string;
  readonly entries: readonly MemoryEntry[];
  readonly kvEntries: readonly { key: string; value: unknown }[];
}

/**
 * Export workspace memory to a portable JSON format.
 */
export async function exportMemory(params: {
  readonly memoryBackend: MemoryBackend;
  readonly workspaceId?: string;
  readonly logger?: Logger;
}): Promise<MemoryExport> {
  const { memoryBackend, workspaceId, logger } = params;

  // Export all entries (across sessions for this workspace)
  const sessions = await memoryBackend.listSessions();
  const allEntries: MemoryEntry[] = [];

  for (const sessionId of sessions) {
    const thread = await memoryBackend.getThread(sessionId);
    for (const entry of thread) {
      if (workspaceId && entry.workspaceId && entry.workspaceId !== workspaceId) {
        continue;
      }
      allEntries.push(entry);
    }
  }

  // Export KV entries
  const kvKeys = await memoryBackend.listKeys();
  const kvEntries: Array<{ key: string; value: unknown }> = [];
  for (const key of kvKeys) {
    if (workspaceId && !key.startsWith(`${workspaceId}:`)) continue;
    const value = await memoryBackend.get(key);
    if (value !== undefined) {
      kvEntries.push({ key, value });
    }
  }

  logger?.info?.(
    `Memory export: ${allEntries.length} entries, ${kvEntries.length} KV entries`,
  );

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    workspaceId,
    entries: allEntries,
    kvEntries,
  };
}

/**
 * Import memory from a portable JSON backup.
 * Validates schema version for forward compatibility.
 */
export async function importMemory(params: {
  readonly memoryBackend: MemoryBackend;
  readonly data: MemoryExport;
  readonly logger?: Logger;
}): Promise<{ entriesImported: number; kvImported: number }> {
  const { memoryBackend, data, logger } = params;

  if (data.schemaVersion > EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `Cannot import: schema version ${data.schemaVersion} is newer than supported version ${EXPORT_SCHEMA_VERSION}`,
    );
  }

  let entriesImported = 0;
  for (const entry of data.entries) {
    try {
      await memoryBackend.addEntry({
        sessionId: entry.sessionId,
        role: entry.role,
        content: entry.content,
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        taskPda: entry.taskPda,
        metadata: entry.metadata,
        workspaceId: entry.workspaceId,
        agentId: entry.agentId,
        userId: entry.userId,
        worldId: entry.worldId,
        channel: entry.channel,
      });
      entriesImported++;
    } catch {
      // Skip individual entry failures
    }
  }

  let kvImported = 0;
  for (const kv of data.kvEntries) {
    try {
      await memoryBackend.set(kv.key, kv.value);
      kvImported++;
    } catch {
      // Skip individual KV failures
    }
  }

  logger?.info?.(
    `Memory import: ${entriesImported}/${data.entries.length} entries, ${kvImported}/${data.kvEntries.length} KV entries`,
  );

  return { entriesImported, kvImported };
}
