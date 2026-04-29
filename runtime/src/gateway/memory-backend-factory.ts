/**
 * Factory for creating memory backends from gateway config.
 *
 * Extracts memory backend creation (SQLite/Redis/InMemory selection)
 * from daemon.ts into a standalone factory function.
 *
 * Gate 3 — prerequisite reduction for planner/pipeline cross-cut.
 */

import { InMemoryBackend } from "../memory/in-memory/backend.js";
import type { MemoryBackend } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";
import type { GatewayConfig } from "./types.js";
import type { UnifiedTelemetryCollector } from "../telemetry/collector.js";
import { resolveRuntimePersistencePaths } from "./runtime-persistence.js";
import { resolveWorldDbPath } from "../memory/world-db-resolver.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface CreateMemoryBackendParams {
  config: GatewayConfig;
  metrics?: UnifiedTelemetryCollector;
  logger: Logger;
  /** When set, resolves to a per-world SQLite DB for full DB-level isolation (Phase 2.7). */
  worldId?: string;
}

/**
 * Create a memory backend based on gateway config.
 * Defaults to SqliteBackend for persistence across restarts.
 * Use backend='memory' to explicitly opt into InMemoryBackend.
 */
export async function createMemoryBackend(
  params: CreateMemoryBackendParams,
): Promise<MemoryBackend> {
  const { config, metrics, logger, worldId } = params;
  const memConfig = config.memory;
  const backend = memConfig?.backend ?? "sqlite";
  const persistencePaths = resolveRuntimePersistencePaths();
  const encryption = memConfig?.encryptionKey
    ? { key: memConfig.encryptionKey }
    : undefined;

  switch (backend) {
    case "sqlite": {
      // Phase 2.7: per-world SQLite DB for full DB-level isolation.
      // When worldId is set and not "default", each world gets its own DB file.
      const dbPath = worldId && worldId !== "default"
        ? resolveWorldDbPath(worldId)
        : memConfig?.dbPath ?? persistencePaths.memoryDbPath;

      const { SqliteBackend } = await import("../memory/sqlite/backend.js");
      return new SqliteBackend({
        dbPath,
        logger,
        metrics,
        encryption,
      });
    }
    case "redis": {
      const { RedisBackend } = await import("../memory/redis/backend.js");
      return new RedisBackend({
        url: memConfig?.url,
        host: memConfig?.host,
        port: memConfig?.port,
        password: memConfig?.password,
        logger,
        metrics,
      });
    }
    case "memory":
      return new InMemoryBackend({ logger, metrics });
    default:
      throw new Error(`Unsupported memory backend: ${String(backend)}`);
  }
}
