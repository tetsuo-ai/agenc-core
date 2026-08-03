/**
 * Generated public metadata contract for durable workflow handoffs.
 * Keep synchronized with
 * `runtime/src/agents/workflow-handoff-artifact.v1.schema.json`.
 */

export const AGENC_WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION = 1 as const;
export const AGENC_WORKFLOW_HANDOFF_ARTIFACT_KIND =
  "workflow_handoff" as const;
export const AGENC_WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH =
  "workflow_handoff.v1/state-schema.22" as const;
export const AGENC_MAX_WORKFLOW_HANDOFF_ARTIFACT_BYTES = 16_777_216 as const;
export const AGENC_MAX_WORKFLOW_STEP_RESULT_TOKENS = 131_072 as const;
export const AGENC_MAX_WORKFLOW_STEP_PREVIEW_BYTES = 2_048 as const;
export const AGENC_MAX_WORKFLOW_HANDOFF_OWNER_FIELD_UTF8_BYTES = 1_024 as const;

export interface WorkflowHandoffOwner {
  readonly run_id: string;
  readonly workflow_id: string;
  readonly producer_step_id: string;
}

export interface WorkflowHandoffArtifact {
  readonly format_version: 1;
  readonly kind: "workflow_handoff";
  readonly compatibility_epoch: "workflow_handoff.v1/state-schema.22";
  readonly artifact_id: string;
  readonly owner: WorkflowHandoffOwner;
  readonly digest: `sha256:${string}`;
  readonly byte_length: number;
  readonly token_count: number;
  readonly media_type: "text/plain";
  readonly encoding: "utf-8";
  readonly storage_ref: string;
  readonly created_at_ms: number;
  readonly committed_at_ms: number;
  readonly commit_sequence: number;
  readonly preview: string;
  readonly preview_truncated: boolean;
}

const ARTIFACT_KEYS = Object.freeze([
  "format_version",
  "kind",
  "compatibility_epoch",
  "artifact_id",
  "owner",
  "digest",
  "byte_length",
  "token_count",
  "media_type",
  "encoding",
  "storage_ref",
  "created_at_ms",
  "committed_at_ms",
  "commit_sequence",
  "preview",
  "preview_truncated",
] as const);
const OWNER_KEYS = Object.freeze([
  "run_id",
  "workflow_id",
  "producer_step_id",
] as const);
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export class WorkflowHandoffArtifactValidationError extends Error {
  readonly code = "WORKFLOW_HANDOFF_SCHEMA" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkflowHandoffArtifactValidationError";
  }
}

/** Strict dependency-free validator for the generated public SDK contract. */
export function validateWorkflowHandoffArtifact(
  value: unknown,
): WorkflowHandoffArtifact {
  const artifact = strictRecord(
    value,
    ARTIFACT_KEYS,
    "workflow handoff artifact",
  );
  expectLiteral(artifact.format_version, 1, "format_version");
  expectLiteral(artifact.kind, AGENC_WORKFLOW_HANDOFF_ARTIFACT_KIND, "kind");
  expectLiteral(
    artifact.compatibility_epoch,
    AGENC_WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH,
    "compatibility_epoch",
  );
  const artifactId = boundedString(artifact.artifact_id, "artifact_id");
  if (!/^wh_[0-9a-f]{48}$/u.test(artifactId)) invalid("artifact_id is invalid");

  const owner = strictRecord(artifact.owner, OWNER_KEYS, "owner");
  for (const key of OWNER_KEYS) {
    boundedString(
      owner[key],
      `owner.${key}`,
      AGENC_MAX_WORKFLOW_HANDOFF_OWNER_FIELD_UTF8_BYTES,
    );
  }
  const digest = boundedString(artifact.digest, "digest");
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) invalid("digest is invalid");
  const byteLength = boundedInteger(
    artifact.byte_length,
    "byte_length",
    0,
    AGENC_MAX_WORKFLOW_HANDOFF_ARTIFACT_BYTES,
  );
  boundedInteger(
    artifact.token_count,
    "token_count",
    0,
    AGENC_MAX_WORKFLOW_STEP_RESULT_TOKENS,
  );
  expectLiteral(artifact.media_type, "text/plain", "media_type");
  expectLiteral(artifact.encoding, "utf-8", "encoding");
  expectLiteral(
    artifact.storage_ref,
    `workflow-handoff:${artifactId}`,
    "storage_ref",
  );
  const createdAt = boundedInteger(
    artifact.created_at_ms,
    "created_at_ms",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const committedAt = boundedInteger(
    artifact.committed_at_ms,
    "committed_at_ms",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (committedAt < createdAt) invalid("committed_at_ms precedes created_at_ms");
  boundedInteger(
    artifact.commit_sequence,
    "commit_sequence",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const preview = boundedString(
    artifact.preview,
    "preview",
    AGENC_MAX_WORKFLOW_STEP_PREVIEW_BYTES,
    true,
  );
  if (typeof artifact.preview_truncated !== "boolean") {
    invalid("preview_truncated must be a boolean");
  }
  const previewBytes = utf8Length(preview);
  if (
    previewBytes > byteLength ||
    (!artifact.preview_truncated && previewBytes !== byteLength) ||
    (artifact.preview_truncated && previewBytes >= byteLength)
  ) {
    invalid("preview length is inconsistent with byte_length");
  }
  return artifact as unknown as WorkflowHandoffArtifact;
}

function strictRecord<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
): Record<Key, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object`);
  }
  const names = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    names.length !== expected.length ||
    names.some((name, index) => name !== expected[index])
  ) {
    invalid(`${label} fields are invalid`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      invalid(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value as Record<Key, unknown>;
}

function boundedString(
  value: unknown,
  label: string,
  maximumUtf8Bytes = Number.MAX_SAFE_INTEGER,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    LONE_SURROGATE_PATTERN.test(value) ||
    utf8Length(value) > maximumUtf8Bytes
  ) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    invalid(`${label} is invalid`);
  }
  return value as number;
}

function expectLiteral(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) invalid(`${label} is invalid`);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalid(message: string): never {
  throw new WorkflowHandoffArtifactValidationError(message);
}
