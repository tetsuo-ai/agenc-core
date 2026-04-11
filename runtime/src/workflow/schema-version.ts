type RuntimeSchemaVersion = number | string;
export const LEGACY_UNVERSIONED_SCHEMA = "legacy_unversioned" as const;

type RuntimeSchemaSourceVersion =
  | RuntimeSchemaVersion
  | typeof LEGACY_UNVERSIONED_SCHEMA;

export interface SchemaMigrationResult<T> {
  readonly value: T;
  readonly migrated: boolean;
  readonly fromVersion: RuntimeSchemaSourceVersion;
  readonly toVersion: RuntimeSchemaVersion;
  readonly compatibility: "current" | "migrated";
}

export class RuntimeSchemaCompatibilityError extends Error {
  readonly schemaName: string;
  readonly receivedVersion: RuntimeSchemaVersion | "missing" | "invalid";
  readonly supportedVersions: readonly RuntimeSchemaVersion[];

  constructor(params: {
    readonly schemaName: string;
    readonly receivedVersion: RuntimeSchemaVersion | "missing" | "invalid";
    readonly supportedVersions: readonly RuntimeSchemaVersion[];
    readonly reason?: string;
  }) {
    const supported = params.supportedVersions.map(String).join(", ");
    const detail = params.reason ? ` (${params.reason})` : "";
    super(
      `Unsupported ${params.schemaName} schema version: ${String(params.receivedVersion)}. Supported versions: ${supported}${detail}`,
    );
    this.name = "RuntimeSchemaCompatibilityError";
    this.schemaName = params.schemaName;
    this.receivedVersion = params.receivedVersion;
    this.supportedVersions = [...params.supportedVersions];
  }
}

export function extractSchemaVersion(
  value: unknown,
  key: "schemaVersion" | "version" = "schemaVersion",
): RuntimeSchemaVersion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate === "number" || typeof candidate === "string") {
    return candidate;
  }
  return undefined;
}

export function createSchemaMigrationResult<T>(params: {
  readonly value: T;
  readonly fromVersion: RuntimeSchemaSourceVersion;
  readonly toVersion: RuntimeSchemaVersion;
}): SchemaMigrationResult<T> {
  const migrated = params.fromVersion !== params.toVersion;
  return {
    value: params.value,
    migrated,
    fromVersion: params.fromVersion,
    toVersion: params.toVersion,
    compatibility: migrated ? "migrated" : "current",
  };
}

export function assertObjectRecord(
  value: unknown,
  schemaName: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeSchemaCompatibilityError({
      schemaName,
      receivedVersion: "invalid",
      supportedVersions: [],
      reason: "expected an object record",
    });
  }
  return value as Record<string, unknown>;
}
