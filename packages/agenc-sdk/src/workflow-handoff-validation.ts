import type { WorkflowHandoffArtifact } from "./workflow-handoff.generated.js";

interface HandoffSchema {
  readonly const?: string | number | boolean;
  readonly type?: "object" | "string" | "integer" | "boolean";
  readonly properties?: Readonly<Record<string, HandoffSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

interface HandoffPostValidation {
  readonly ownerFieldMaxUtf8Bytes: number;
  readonly previewMaxUtf8Bytes: number;
}

const loneSurrogatePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export class WorkflowHandoffArtifactValidationError extends Error {
  readonly code = "WORKFLOW_HANDOFF_SCHEMA" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkflowHandoffArtifactValidationError";
  }
}

function invalid(message: string): never {
  throw new WorkflowHandoffArtifactValidationError(message);
}

function handoffRecord(value: unknown, label: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  return value;
}

function validateHandoffObject(value: unknown, schema: HandoffSchema, label: string): void {
  const record = handoffRecord(value, label);
  const properties = schema.properties ?? {};
  for (const name of Object.keys(record)) {
    if (!Object.hasOwn(properties, name)) invalid(`${label} fields are invalid`);
  }
  for (const [name, field] of Object.entries(properties)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (descriptor === undefined) {
      if (schema.required?.includes(name)) invalid(`${label}.${name} is required`);
      continue;
    }
    if (!("value" in descriptor) || !descriptor.enumerable) invalid(`${label}.${name} must be an enumerable data property`);
    validateHandoffStructure(descriptor.value, field, `${label}.${name}`);
  }
}

function validateHandoffString(value: unknown, schema: HandoffSchema, label: string): void {
  if (typeof value !== "string" || loneSurrogatePattern.test(value)) invalid(`${label} is invalid`);
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) invalid(`${label} is invalid`);
  if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    const length = Array.from(value).length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Number.MAX_SAFE_INTEGER)) invalid(`${label} length is invalid`);
  }
}

function validateHandoffInteger(value: unknown, schema: HandoffSchema, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < (schema.minimum ?? Number.MIN_SAFE_INTEGER) ||
    (value as number) > (schema.maximum ?? Number.MAX_SAFE_INTEGER)
  ) invalid(`${label} is invalid`);
}

export function validateHandoffStructure(value: unknown, schema: HandoffSchema, label: string): void {
  if (schema.const !== undefined) {
    if (value !== schema.const) invalid(`${label} is invalid`);
    return;
  }
  switch (schema.type) {
    case "object": return validateHandoffObject(value, schema, label);
    case "string": return validateHandoffString(value, schema, label);
    case "integer": return validateHandoffInteger(value, schema, label);
    case "boolean":
      if (typeof value !== "boolean") invalid(`${label} must be a boolean`);
      return;
    default: invalid(`${label} has an unsupported schema`);
  }
}

export function validateHandoffRelationships(artifact: WorkflowHandoffArtifact, constraints: HandoffPostValidation): void {
  const encoder = new TextEncoder();
  for (const value of Object.values(artifact.owner)) {
    if (encoder.encode(value).byteLength > constraints.ownerFieldMaxUtf8Bytes) invalid("owner field exceeds its UTF-8 limit");
  }
  if (artifact.storage_ref !== `workflow-handoff:${artifact.artifact_id}`) invalid("storage_ref is invalid");
  if (artifact.committed_at_ms < artifact.created_at_ms) invalid("committed_at_ms precedes created_at_ms");
  const previewBytes = encoder.encode(artifact.preview).byteLength;
  if (previewBytes > constraints.previewMaxUtf8Bytes) invalid("preview exceeds its UTF-8 limit");
  if (
    previewBytes > artifact.byte_length ||
    (!artifact.preview_truncated && previewBytes !== artifact.byte_length) ||
    (artifact.preview_truncated && previewBytes >= artifact.byte_length)
  ) invalid("preview length is inconsistent with byte_length");
}
