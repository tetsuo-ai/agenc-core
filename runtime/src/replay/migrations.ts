import type {
  ReplayEventCursor,
  ReplayTimelineRecord,
} from "./types.js";
import {
  LEGACY_UNVERSIONED_SCHEMA,
  RuntimeSchemaCompatibilityError,
  assertObjectRecord,
  createSchemaMigrationResult,
  extractSchemaVersion,
  type SchemaMigrationResult,
} from "../workflow/schema-version.js";

const REPLAY_EVENT_CURSOR_SCHEMA_VERSION = 1 as const;
const REPLAY_TIMELINE_RECORD_SCHEMA_VERSION = 1 as const;
export const REPLAY_FILE_STATE_SCHEMA_VERSION = 1 as const;

export interface PersistedReplayTimelineState {
  readonly schemaVersion: typeof REPLAY_FILE_STATE_SCHEMA_VERSION;
  readonly cursor: ReplayEventCursor | null;
  readonly records: readonly ReplayTimelineRecord[];
}

function migrateReplayEventCursor(
  value: unknown,
): SchemaMigrationResult<ReplayEventCursor | null> {
  if (value === null || value === undefined) {
    return createSchemaMigrationResult({
      value: null,
      fromVersion: LEGACY_UNVERSIONED_SCHEMA,
      toVersion: REPLAY_EVENT_CURSOR_SCHEMA_VERSION,
    });
  }
  const raw = assertObjectRecord(value, "ReplayEventCursor");
  const version = extractSchemaVersion(raw, "schemaVersion");
  if (
    version !== undefined &&
    version !== REPLAY_EVENT_CURSOR_SCHEMA_VERSION
  ) {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "ReplayEventCursor",
      receivedVersion: version,
      supportedVersions: [REPLAY_EVENT_CURSOR_SCHEMA_VERSION],
    });
  }
  if (typeof raw.slot !== "number" || typeof raw.signature !== "string") {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "ReplayEventCursor",
      receivedVersion: version ?? "invalid",
      supportedVersions: [REPLAY_EVENT_CURSOR_SCHEMA_VERSION],
      reason: "missing required cursor fields",
    });
  }
  return createSchemaMigrationResult({
    value: {
      schemaVersion: REPLAY_EVENT_CURSOR_SCHEMA_VERSION,
      slot: raw.slot,
      signature: raw.signature,
      eventName: typeof raw.eventName === "string" ? raw.eventName : undefined,
      traceId: typeof raw.traceId === "string" ? raw.traceId : undefined,
      traceSpanId:
        typeof raw.traceSpanId === "string" ? raw.traceSpanId : undefined,
    },
    fromVersion: version ?? LEGACY_UNVERSIONED_SCHEMA,
    toVersion: REPLAY_EVENT_CURSOR_SCHEMA_VERSION,
  });
}

function migrateReplayTimelineRecord(
  value: unknown,
): SchemaMigrationResult<ReplayTimelineRecord> {
  const raw = assertObjectRecord(value, "ReplayTimelineRecord");
  const version = extractSchemaVersion(raw, "schemaVersion");
  if (
    version !== undefined &&
    version !== REPLAY_TIMELINE_RECORD_SCHEMA_VERSION
  ) {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "ReplayTimelineRecord",
      receivedVersion: version,
      supportedVersions: [REPLAY_TIMELINE_RECORD_SCHEMA_VERSION],
    });
  }
  if (
    typeof raw.slot !== "number" ||
    typeof raw.signature !== "string" ||
    typeof raw.sourceEventName !== "string" ||
    typeof raw.sourceEventType !== "string" ||
    typeof raw.projectionHash !== "string"
  ) {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "ReplayTimelineRecord",
      receivedVersion: version ?? "invalid",
      supportedVersions: [REPLAY_TIMELINE_RECORD_SCHEMA_VERSION],
      reason: "missing required replay record fields",
    });
  }
  return createSchemaMigrationResult({
    value: {
      ...(raw as unknown as ReplayTimelineRecord),
      schemaVersion: REPLAY_TIMELINE_RECORD_SCHEMA_VERSION,
    },
    fromVersion: version ?? LEGACY_UNVERSIONED_SCHEMA,
    toVersion: REPLAY_TIMELINE_RECORD_SCHEMA_VERSION,
  });
}

export function migratePersistedReplayTimelineState(
  value: unknown,
): SchemaMigrationResult<PersistedReplayTimelineState> {
  if (value === null || value === undefined) {
    return createSchemaMigrationResult({
      value: {
        schemaVersion: REPLAY_FILE_STATE_SCHEMA_VERSION,
        cursor: null,
        records: [],
      },
      fromVersion: LEGACY_UNVERSIONED_SCHEMA,
      toVersion: REPLAY_FILE_STATE_SCHEMA_VERSION,
    });
  }
  const raw = assertObjectRecord(value, "ReplayTimelineState");
  const version = extractSchemaVersion(raw, "schemaVersion");
  if (
    version !== undefined &&
    version !== REPLAY_FILE_STATE_SCHEMA_VERSION
  ) {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "ReplayTimelineState",
      receivedVersion: version,
      supportedVersions: [REPLAY_FILE_STATE_SCHEMA_VERSION],
    });
  }
  const cursor = migrateReplayEventCursor(raw.cursor ?? null).value;
  const records = Array.isArray(raw.records)
    ? raw.records.map((entry) => migrateReplayTimelineRecord(entry).value)
    : [];
  return createSchemaMigrationResult({
    value: {
      schemaVersion: REPLAY_FILE_STATE_SCHEMA_VERSION,
      cursor,
      records,
    },
    fromVersion: version ?? LEGACY_UNVERSIONED_SCHEMA,
    toVersion: REPLAY_FILE_STATE_SCHEMA_VERSION,
  });
}
