/**
 * Ports upstream Rust `rollout/src/list.rs` discovery into AgenC helpers that
 * prefer the append-only index and can repair by scanning rollout files.
 */

import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  AGENC_ROLLOUT_SESSIONS_DIR,
  buildAgenCRolloutMetadata,
  isAgenCRolloutFileName,
  sessionIdFromAgenCRolloutPath,
} from "./metadata.js";
import {
  deleteRolloutFiles,
  planRolloutRetention,
  type AgenCRolloutRetentionPolicy,
} from "./policy.js";
import { readAgenCRolloutLines } from "./recorder.js";
import { AgenCRolloutSessionIndex } from "./session-index.js";
import type { AgenCRolloutSessionMetadata } from "./types.js";

export interface AgenCRolloutListOptions {
  readonly repairFromDisk?: boolean;
}

export interface AgenCRolloutPruneResult {
  readonly kept: readonly AgenCRolloutSessionMetadata[];
  readonly removed: readonly AgenCRolloutSessionMetadata[];
}

export function listAgenCRolloutSessions(
  rootDir: string,
  options: AgenCRolloutListOptions = {},
): AgenCRolloutSessionMetadata[] {
  const index = new AgenCRolloutSessionIndex(rootDir);
  const indexed = index.list().filter((entry) => existsSync(entry.rolloutPath));
  if (!options.repairFromDisk) return indexed;

  const known = new Set(indexed.map((entry) => entry.rolloutPath));
  const repaired = [...indexed];
  for (const metadata of scanRolloutSessions(rootDir)) {
    if (known.has(metadata.rolloutPath)) continue;
    index.append(metadata);
    repaired.push(metadata);
  }
  return repaired.sort((left, right) => {
    const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return left.sessionId.localeCompare(right.sessionId);
  });
}

export function findAgenCRolloutSession(
  rootDir: string,
  sessionId: string,
): AgenCRolloutSessionMetadata | undefined {
  return listAgenCRolloutSessions(rootDir, { repairFromDisk: true })
    .find((entry) => entry.sessionId === sessionId);
}

export function pruneAgenCRollouts(
  rootDir: string,
  policy: AgenCRolloutRetentionPolicy,
  options: { readonly now?: () => string; readonly nowMs?: number } = {},
): AgenCRolloutPruneResult {
  const index = new AgenCRolloutSessionIndex(rootDir);
  const deletedAt = options.now?.() ?? new Date().toISOString();
  const plan = planRolloutRetention(
    listAgenCRolloutSessions(rootDir, { repairFromDisk: true }),
    policy,
    { nowMs: options.nowMs ?? Date.parse(deletedAt) },
  );
  deleteRolloutFiles(rootDir, plan.remove);
  for (const removed of plan.remove) {
    index.markDeleted(removed, deletedAt);
  }
  return {
    kept: plan.keep,
    removed: plan.remove,
  };
}

export function removeRolloutRoot(rootDir: string): void {
  rmSync(rootDir, { recursive: true, force: true });
}

function scanRolloutSessions(rootDir: string): AgenCRolloutSessionMetadata[] {
  const sessionsDir = join(rootDir, AGENC_ROLLOUT_SESSIONS_DIR);
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isAgenCRolloutFileName(entry.name))
    .map((entry) => join(sessionsDir, entry.name))
    .map((rolloutPath) => metadataFromRolloutFile(rolloutPath))
    .filter((entry): entry is AgenCRolloutSessionMetadata => entry !== undefined);
}

function metadataFromRolloutFile(
  rolloutPath: string,
): AgenCRolloutSessionMetadata | undefined {
  const stats = statSync(rolloutPath);
  const lines = readAgenCRolloutLines(rolloutPath);
  const first = lines[0];
  const last = lines.at(-1);
  const sessionId = first?.sessionId ?? sessionIdFromAgenCRolloutPath(rolloutPath);
  if (sessionId === undefined) return undefined;
  return buildAgenCRolloutMetadata({
    sessionId,
    rolloutPath,
    createdAt: first?.writtenAt ?? stats.birthtime.toISOString(),
    updatedAt: last?.writtenAt ?? stats.mtime.toISOString(),
    eventCount: lines.length,
    byteLength: stats.size,
  });
}
