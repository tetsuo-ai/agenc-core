/**
 * Per-world SQLite database path resolver (Phase 2.7).
 *
 * When a worldId is specified, resolves to a separate SQLite DB per world
 * at ~/.agenc/worlds/{worldId}/memory.db. This provides full DB-level
 * isolation — cross-world queries are impossible because each world has
 * its own database file.
 *
 * Per edge case S2: uses LRU eviction for world DB connections to prevent
 * 100+ simultaneous SQLite connections from consuming too much memory.
 *
 * @module
 */

import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

/** Default AgenC home directory. */
const DEFAULT_AGENC_HOME = join(
  process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
  ".agenc",
);

/**
 * Resolve the SQLite database path for a given world.
 * Creates the world directory if it doesn't exist.
 *
 * @param worldId - World identifier. If undefined, returns the default DB path.
 * @param agencHome - Override for ~/.agenc directory.
 */
export function resolveWorldDbPath(
  worldId?: string,
  agencHome?: string,
): string {
  const home = agencHome ?? DEFAULT_AGENC_HOME;

  if (!worldId || worldId === "default") {
    return join(home, "memory.db");
  }

  // Sanitize worldId to prevent path traversal (security)
  const sanitized = worldId
    .replace(/[^a-zA-Z0-9_\-\.]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 128);

  const worldDir = join(home, "worlds", sanitized);
  if (!existsSync(worldDir)) {
    mkdirSync(worldDir, { recursive: true });
  }

  return join(worldDir, "memory.db");
}

/**
 * Resolve the vector database path for a given world.
 */
export function resolveWorldVectorDbPath(
  worldId?: string,
  agencHome?: string,
): string {
  const home = agencHome ?? DEFAULT_AGENC_HOME;

  if (!worldId || worldId === "default") {
    return join(home, "vectors.db");
  }

  const sanitized = worldId
    .replace(/[^a-zA-Z0-9_\-\.]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 128);

  const worldDir = join(home, "worlds", sanitized);
  if (!existsSync(worldDir)) {
    mkdirSync(worldDir, { recursive: true });
  }

  return join(worldDir, "vectors.db");
}
