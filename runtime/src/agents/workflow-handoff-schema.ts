/** Public, versioned metadata contract for durable workflow handoffs. */

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import { cloneFiniteJsonValue } from "./workflow-finite-json.js";

export const WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION = 1;
export const WORKFLOW_HANDOFF_ARTIFACT_KIND = "workflow_handoff";
export const WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH =
  "workflow_handoff.v1/state-schema.22";
export const WORKFLOW_HANDOFF_MEDIA_TYPE = "text/plain";
export const WORKFLOW_HANDOFF_ENCODING = "utf-8";
export const LEGACY_TOOL_RESULT_ARTIFACT_KIND = "tool-result";
export const DURABLE_ARTIFACT_KINDS = Object.freeze([
  LEGACY_TOOL_RESULT_ARTIFACT_KIND,
  WORKFLOW_HANDOFF_ARTIFACT_KIND,
] as const);
export type DurableArtifactKind = (typeof DURABLE_ARTIFACT_KINDS)[number];

export const MAX_WORKFLOW_STEP_RESULT_TOKENS = 131_072;
export const MAX_WORKFLOW_ARTIFACT_BYTES = 16_777_216;
export const MAX_WORKFLOW_ARTIFACT_BYTES_PER_RUN = 268_435_456;
export const MAX_WORKFLOW_ARTIFACT_BYTES_GLOBAL = 4_294_967_296;
export const MAX_WORKFLOW_ARTIFACTS_PER_RUN = 4_096;
export const MAX_WORKFLOW_ARTIFACTS_GLOBAL = 100_000;
export const MAX_WORKFLOW_ARTIFACT_CLEANUP_BATCH = 256;
export const WORKFLOW_ARTIFACT_RETENTION_MS = 604_800_000;
export const MAX_WORKFLOW_STEP_PREVIEW_BYTES = 2_048;
export const MAX_WORKFLOW_FINAL_RESPONSE_BYTES = 4_194_304;
export const WORKFLOW_ARTIFACT_INTENT_RECOVERY_GRACE_MS = 300_000;
export const MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES = 1_024;
export const MAX_WORKFLOW_ARTIFACT_IDEMPOTENCY_KEY_UTF8_BYTES = 1_024;

const ARTIFACT_ID_PATTERN = "^wh_[0-9a-f]{48}$";
const ARTIFACT_DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";
const ARTIFACT_REFERENCE_PATTERN = "^workflow-handoff:wh_[0-9a-f]{48}$";
const MAX_ARTIFACT_SCHEMA_ERRORS = 12;

export const WORKFLOW_HANDOFF_POST_VALIDATION_CONSTRAINTS = Object.freeze({
  ownerFieldMaxUtf8Bytes: MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES,
  previewMaxUtf8Bytes: MAX_WORKFLOW_STEP_PREVIEW_BYTES,
  requireWellFormedUnicode: true,
  storageRefMustMatchArtifactId: true,
  committedAtMustNotPrecedeCreatedAt: true,
  previewBytesMustMatchByteLengthAndTruncation: true,
});

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

export const WORKFLOW_HANDOFF_ARTIFACT_SCHEMA = Object.freeze({
  $id: "agenc.workflow-handoff-artifact.v1",
  "x-agenc-post-validation": WORKFLOW_HANDOFF_POST_VALIDATION_CONSTRAINTS,
  type: "object",
  properties: {
    format_version: { const: WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION },
    kind: { const: WORKFLOW_HANDOFF_ARTIFACT_KIND },
    compatibility_epoch: {
      const: WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH,
    },
    artifact_id: { type: "string", pattern: ARTIFACT_ID_PATTERN },
    owner: {
      type: "object",
      properties: {
        run_id: { type: "string", minLength: 1 },
        workflow_id: { type: "string", minLength: 1 },
        producer_step_id: { type: "string", minLength: 1 },
      },
      required: ["run_id", "workflow_id", "producer_step_id"],
      additionalProperties: false,
    },
    digest: { type: "string", pattern: ARTIFACT_DIGEST_PATTERN },
    byte_length: {
      type: "integer",
      minimum: 0,
      maximum: MAX_WORKFLOW_ARTIFACT_BYTES,
    },
    token_count: {
      type: "integer",
      minimum: 0,
      maximum: MAX_WORKFLOW_STEP_RESULT_TOKENS,
    },
    media_type: { const: WORKFLOW_HANDOFF_MEDIA_TYPE },
    encoding: { const: WORKFLOW_HANDOFF_ENCODING },
    storage_ref: { type: "string", pattern: ARTIFACT_REFERENCE_PATTERN },
    created_at_ms: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    committed_at_ms: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    commit_sequence: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    preview: { type: "string" },
    preview_truncated: { type: "boolean" },
  },
  required: [
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
  ],
  additionalProperties: false,
});

const artifactAjv = new Ajv({ allErrors: true, strict: true });
artifactAjv.addKeyword({
  keyword: "x-agenc-post-validation",
  schemaType: "object",
  type: "object",
  errors: false,
  validate: (_schema: unknown, value: unknown) => {
    try {
      assertArtifactRelationships(value as WorkflowHandoffArtifact);
      return true;
    } catch {
      return false;
    }
  },
});
const artifactValidator = artifactAjv.compile(
  WORKFLOW_HANDOFF_ARTIFACT_SCHEMA,
) as ValidateFunction<WorkflowHandoffArtifact>;

export class WorkflowHandoffArtifactSchemaError extends Error {
  readonly code = "WORKFLOW_HANDOFF_SCHEMA" as const;
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "WorkflowHandoffArtifactSchemaError";
    this.issues = Object.freeze([...issues]);
  }
}

export class UnknownDurableArtifactKindError extends Error {
  readonly code = "UNKNOWN_DURABLE_ARTIFACT_KIND" as const;

  constructor(readonly artifactKind: string) {
    super(
      `durable artifact kind ${JSON.stringify(artifactKind)} is unknown; preserve its bytes and refuse cleanup`,
    );
    this.name = "UnknownDurableArtifactKindError";
  }
}

/** Fail-closed gate shared by readers and garbage collectors. */
export function assertKnownDurableArtifactKind(
  value: string,
): asserts value is DurableArtifactKind {
  if (
    value !== LEGACY_TOOL_RESULT_ARTIFACT_KIND &&
    value !== WORKFLOW_HANDOFF_ARTIFACT_KIND
  ) {
    throw new UnknownDurableArtifactKindError(value);
  }
}

export function validateWorkflowHandoffArtifactValue(
  value: unknown,
): WorkflowHandoffArtifact {
  const finite = cloneFiniteJsonValue(value, "workflow handoff artifact", {
    maximumDepth: 4,
    maximumNodes: 64,
    maximumKeyUtf8Bytes: 128,
    maximumStringUtf8Bytes: MAX_WORKFLOW_STEP_PREVIEW_BYTES,
    maximumTotalStringUtf8Bytes: 16_384,
  });
  if (artifactValidator(finite)) {
    assertArtifactRelationships(finite);
    return finite;
  }
  const issues = formatErrors(artifactValidator.errors);
  throw new WorkflowHandoffArtifactSchemaError(
    `workflow handoff artifact is invalid: ${issues.join("; ")}`,
    issues,
  );
}

function assertArtifactRelationships(
  artifact: WorkflowHandoffArtifact,
): void {
  const ownerFields = Object.values(artifact.owner);
  if (
    ownerFields.some(
      (field) =>
        Buffer.byteLength(field, "utf8") >
        MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES,
    )
  ) {
    throw new WorkflowHandoffArtifactSchemaError(
      `workflow handoff owner fields must not exceed ${MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  const previewBytes = Buffer.byteLength(artifact.preview, "utf8");
  if (previewBytes > MAX_WORKFLOW_STEP_PREVIEW_BYTES) {
    throw new WorkflowHandoffArtifactSchemaError(
      `workflow handoff preview exceeds ${MAX_WORKFLOW_STEP_PREVIEW_BYTES} UTF-8 bytes`,
    );
  }
  if (artifact.storage_ref !== `workflow-handoff:${artifact.artifact_id}`) {
    throw new WorkflowHandoffArtifactSchemaError(
      "workflow handoff storage reference does not match its artifact ID",
    );
  }
  if (artifact.committed_at_ms < artifact.created_at_ms) {
    throw new WorkflowHandoffArtifactSchemaError(
      "workflow handoff commit time precedes its creation time",
    );
  }
  if (
    previewBytes > artifact.byte_length ||
    (!artifact.preview_truncated && previewBytes !== artifact.byte_length) ||
    (artifact.preview_truncated && previewBytes >= artifact.byte_length)
  ) {
    throw new WorkflowHandoffArtifactSchemaError(
      "workflow handoff preview length is inconsistent with the artifact bytes",
    );
  }
}

function formatErrors(
  errors: readonly ErrorObject[] | null | undefined,
): readonly string[] {
  const formatted = (errors ?? [])
    .slice(0, MAX_ARTIFACT_SCHEMA_ERRORS)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
  if ((errors?.length ?? 0) > MAX_ARTIFACT_SCHEMA_ERRORS) {
    formatted.push(
      `and ${(errors?.length ?? 0) - MAX_ARTIFACT_SCHEMA_ERRORS} more errors`,
    );
  }
  return formatted.length === 0 ? ["schema validation failed"] : formatted;
}
