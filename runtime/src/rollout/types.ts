import type { JsonValue } from "../app-server/protocol/index.js";

/**
 * Ports the upstream Rust rollout line and metadata shapes onto AgenC JSONL
 * primitives. The TypeScript port keeps the file format intentionally small:
 * one schema-stamped JSON object per line plus append-only index entries.
 */

export const AGENC_ROLLOUT_SCHEMA_VERSION = 1;
export const AGENC_ROLLOUT_LINE_FORMAT = "agenc.rollout.line";
export const AGENC_ROLLOUT_INDEX_FORMAT = "agenc.rollout.index";

export interface AgenCRolloutLine {
  readonly format: typeof AGENC_ROLLOUT_LINE_FORMAT;
  readonly schemaVersion: typeof AGENC_ROLLOUT_SCHEMA_VERSION;
  readonly seq: number;
  readonly sessionId: string;
  readonly writtenAt: string;
  readonly item: JsonValue;
}

export interface AgenCRolloutSessionMetadata {
  readonly format: typeof AGENC_ROLLOUT_INDEX_FORMAT;
  readonly schemaVersion: typeof AGENC_ROLLOUT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly rolloutPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly eventCount: number;
  readonly byteLength: number;
  readonly cwd?: string;
  readonly name?: string;
  readonly source?: string;
  readonly traceBundlePath?: string;
  readonly deleted?: boolean;
}

export interface AgenCRolloutRecorderOptions {
  readonly rootDir: string;
  readonly sessionId: string;
  readonly createdAt?: string;
  readonly cwd?: string;
  readonly name?: string;
  readonly source?: string;
  readonly traceBundlePath?: string;
  readonly fsync?: boolean;
}
