/**
 * Ports upstream Rust `rollout/src/session_index.rs` into an append-only
 * AgenC JSONL index. Latest entry for a session id wins; tombstones hide
 * deleted rollout files while preserving audit history.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgenCRolloutMetadata } from "./metadata.js";
import {
  AGENC_ROLLOUT_INDEX_FORMAT,
  AGENC_ROLLOUT_SCHEMA_VERSION,
  type AgenCRolloutSessionMetadata,
} from "./types.js";

export const AGENC_ROLLOUT_SESSION_INDEX_FILE = "session_index.jsonl";

export class AgenCRolloutSessionIndex {
  readonly rootDir: string;
  readonly indexPath: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.indexPath = join(rootDir, AGENC_ROLLOUT_SESSION_INDEX_FILE);
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  }

  append(metadata: AgenCRolloutSessionMetadata): void {
    appendJsonLine(this.indexPath, metadata);
  }

  markDeleted(metadata: AgenCRolloutSessionMetadata, updatedAt: string): void {
    this.append(
      buildAgenCRolloutMetadata({
        ...metadata,
        updatedAt,
        deleted: true,
      }),
    );
  }

  find(sessionId: string): AgenCRolloutSessionMetadata | undefined {
    return this.list().find((entry) => entry.sessionId === sessionId);
  }

  list(): AgenCRolloutSessionMetadata[] {
    if (!existsSync(this.indexPath)) return [];
    const latest = new Map<string, AgenCRolloutSessionMetadata>();
    for (const line of readFileSync(this.indexPath, "utf8").split(/\r?\n/)) {
      const entry = parseIndexLine(line);
      if (entry === undefined) continue;
      latest.set(entry.sessionId, entry);
    }
    return [...latest.values()]
      .filter((entry) => entry.deleted !== true)
      .sort((left, right) => {
        const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
        if (byUpdated !== 0) return byUpdated;
        return left.sessionId.localeCompare(right.sessionId);
      });
  }
}

export function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function parseIndexLine(
  line: string,
): AgenCRolloutSessionMetadata | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Partial<AgenCRolloutSessionMetadata>;
    if (
      parsed.format !== AGENC_ROLLOUT_INDEX_FORMAT ||
      parsed.schemaVersion !== AGENC_ROLLOUT_SCHEMA_VERSION ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.rolloutPath !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.eventCount !== "number" ||
      typeof parsed.byteLength !== "number"
    ) {
      return undefined;
    }
    return parsed as AgenCRolloutSessionMetadata;
  } catch {
    return undefined;
  }
}
