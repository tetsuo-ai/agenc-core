import {
  AGENT_RUN_SCHEMA_VERSION,
} from "./agent-run-contract.js";
import type {
  StrategicExecutionSummary,
  StrategicGoalRecord,
  StrategicMemoryState,
  StrategicWorkingNote,
} from "../autonomous/goal-store.js";
import {
  LEGACY_UNVERSIONED_SCHEMA,
  RuntimeSchemaCompatibilityError,
  assertObjectRecord,
  createSchemaMigrationResult,
  extractSchemaVersion,
  type SchemaMigrationResult,
} from "../workflow/schema-version.js";

const STRATEGIC_MEMORY_SCHEMA_VERSION = "v1" as const;

export function isCompatibleBackgroundRunStateVersion(
  value: unknown,
): value is 1 | typeof AGENT_RUN_SCHEMA_VERSION {
  return value === 1 || value === AGENT_RUN_SCHEMA_VERSION;
}

export function migrateStrategicMemoryState(
  value: unknown,
  now: number,
): SchemaMigrationResult<StrategicMemoryState> {
  const raw = assertObjectRecord(value, "StrategicMemoryState");
  const version = extractSchemaVersion(raw, "version");
  if (
    version !== undefined &&
    version !== STRATEGIC_MEMORY_SCHEMA_VERSION
  ) {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "StrategicMemoryState",
      receivedVersion: version,
      supportedVersions: [STRATEGIC_MEMORY_SCHEMA_VERSION],
    });
  }
  const goals = Array.isArray(raw.goals)
    ? (raw.goals as readonly StrategicGoalRecord[])
    : [];
  const workingNotes = Array.isArray(raw.workingNotes)
    ? (raw.workingNotes as readonly StrategicWorkingNote[])
    : [];
  const executionSummaries = Array.isArray(raw.executionSummaries)
    ? (raw.executionSummaries as readonly StrategicExecutionSummary[])
    : [];
  const updatedAt =
    typeof raw.updatedAt === "number" ? raw.updatedAt : now;
  return createSchemaMigrationResult({
    value: {
      version: STRATEGIC_MEMORY_SCHEMA_VERSION,
      goals,
      workingNotes,
      executionSummaries,
      updatedAt,
    },
    fromVersion: version ?? LEGACY_UNVERSIONED_SCHEMA,
    toVersion: STRATEGIC_MEMORY_SCHEMA_VERSION,
  });
}
