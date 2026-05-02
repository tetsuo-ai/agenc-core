/**
 * Ports upstream Rust `rollout/src/metadata.rs` filename and metadata
 * derivation into AgenC-owned helpers used by the recorder and lister.
 */

import { basename } from "node:path";
import {
  AGENC_ROLLOUT_INDEX_FORMAT,
  AGENC_ROLLOUT_SCHEMA_VERSION,
  type AgenCRolloutSessionMetadata,
} from "./types.js";

export const AGENC_ROLLOUT_SESSIONS_DIR = "sessions";
export const AGENC_ROLLOUT_ARCHIVED_SESSIONS_DIR = "archived_sessions";
export const AGENC_ROLLOUT_TRACE_DIR = "rollout-trace";

const ROLLOUT_PREFIX = "rollout-";
const ROLLOUT_SUFFIX = ".jsonl";
const TIMESTAMP_PREFIX = "ts-";
const SESSION_ID_PREFIX = "sid-";

export function buildAgenCRolloutFileName(
  sessionId: string,
  createdAt: string,
): string {
  return `${ROLLOUT_PREFIX}${TIMESTAMP_PREFIX}${
    Buffer.from(createdAt, "utf8").toString("base64url")
  }-${SESSION_ID_PREFIX}${
    Buffer.from(sessionId, "utf8").toString("base64url")
  }${ROLLOUT_SUFFIX}`;
}

export function isAgenCRolloutFileName(fileName: string): boolean {
  return fileName.startsWith(ROLLOUT_PREFIX) && fileName.endsWith(ROLLOUT_SUFFIX);
}

export function sessionIdFromAgenCRolloutPath(
  rolloutPath: string,
): string | undefined {
  const fileName = basename(rolloutPath);
  if (!isAgenCRolloutFileName(fileName)) return undefined;
  const body = fileName.slice(ROLLOUT_PREFIX.length, -ROLLOUT_SUFFIX.length);
  const sessionPrefixIndex = body.indexOf(`-${SESSION_ID_PREFIX}`);
  if (sessionPrefixIndex < 0) return undefined;
  const encodedSessionId = body.slice(
    sessionPrefixIndex + SESSION_ID_PREFIX.length + 1,
  ).trim();
  const sessionId = Buffer.from(
    encodedSessionId,
    "base64url",
  ).toString("utf8");
  return sessionId.length > 0 ? sessionId : undefined;
}

export function buildAgenCRolloutMetadata(params: {
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
}): AgenCRolloutSessionMetadata {
  return {
    format: AGENC_ROLLOUT_INDEX_FORMAT,
    schemaVersion: AGENC_ROLLOUT_SCHEMA_VERSION,
    sessionId: params.sessionId,
    rolloutPath: params.rolloutPath,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
    eventCount: params.eventCount,
    byteLength: params.byteLength,
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.source !== undefined ? { source: params.source } : {}),
    ...(params.traceBundlePath !== undefined
      ? { traceBundlePath: params.traceBundlePath }
      : {}),
    ...(params.deleted === true ? { deleted: true } : {}),
  };
}
