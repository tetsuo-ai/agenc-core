/** Canonical version-2 workflow manifest schema and validation. */

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import {
  digestCanonicalJson,
  type Sha256Digest,
} from "../eval-contract/index.js";
import {
  cloneFiniteJsonValue,
  parseFiniteJsonBytes,
  type FiniteJsonLimits,
  type FiniteJsonValue,
} from "./workflow-finite-json.js";
import {
  compileWorkflowGraph,
  WorkflowGraphValidationError,
} from "./workflow-graph.js";

export const WORKFLOW_MANIFEST_VERSION = 2;
export const MAX_WORKFLOW_MANIFEST_BYTES = 16_777_216;
export const MAX_WORKFLOW_JSON_DEPTH = 64;
export const MAX_WORKFLOW_JSON_NODES = 100_000;
export const MAX_WORKFLOW_JSON_KEY_UTF8_BYTES = 1_024;
export const MAX_WORKFLOW_JSON_STRING_UTF8_BYTES = 262_144;
export const MAX_WORKFLOW_JSON_TOTAL_STRING_UTF8_BYTES = 8_388_608;
export const MAX_WORKFLOW_STEPS = 1_024;
export const MAX_WORKFLOW_GROUPS = 256;
export const MAX_WORKFLOW_EXPANDED_EDGES = 65_536;
export const MAX_WORKFLOW_INPUT_ALIASES_PER_STEP = 256;
export const MAX_WORKFLOW_INPUT_ALIASES_TOTAL = 65_536;
export const MAX_WORKFLOW_STEP_MESSAGE_BYTES = 262_144;
export const MAX_WORKFLOW_TOTAL_MESSAGE_BYTES = 8_388_608;
export const DEFAULT_WORKFLOW_MAX_CONCURRENCY = 16;
export const MAX_WORKFLOW_MAX_CONCURRENCY = 64;
export const DEFAULT_WORKFLOW_MAX_HANDOFF_TOKENS = 8_192;
export const MAX_WORKFLOW_HANDOFF_TOKENS = 32_768;

const INPUT_ALIAS_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,127}$";
const MAX_SCHEMA_ERRORS = 20;

const WORKFLOW_JSON_LIMITS: FiniteJsonLimits = Object.freeze({
  maximumBytes: MAX_WORKFLOW_MANIFEST_BYTES,
  maximumDepth: MAX_WORKFLOW_JSON_DEPTH,
  maximumNodes: MAX_WORKFLOW_JSON_NODES,
  maximumKeyUtf8Bytes: MAX_WORKFLOW_JSON_KEY_UTF8_BYTES,
  maximumStringUtf8Bytes: MAX_WORKFLOW_JSON_STRING_UTF8_BYTES,
  maximumTotalStringUtf8Bytes: MAX_WORKFLOW_JSON_TOTAL_STRING_UTF8_BYTES,
});

export type WorkflowFailurePolicy = "continue_independent" | "fail_fast";
export type WorkflowIsolationMode = "none" | "cwd" | "worktree";

export type WorkflowRef =
  { readonly step: string } | { readonly group: string };

export interface WorkflowStepV2 {
  readonly id: string;
  readonly message: string;
  readonly task_name?: string;
  readonly agent_type?: string;
  readonly model?: string;
  readonly isolation?: WorkflowIsolationMode;
  readonly group?: string;
  readonly after?: readonly WorkflowRef[];
  readonly inputs?: Readonly<Record<string, WorkflowRef>>;
}

export interface WorkflowDagManifestV2 {
  readonly format_version: 2;
  readonly kind: "agent_dag";
  readonly description?: string;
  readonly max_concurrency?: number;
  readonly max_handoff_tokens?: number;
  readonly failure_policy?: WorkflowFailurePolicy;
  readonly steps: readonly WorkflowStepV2[];
}

export interface ValidatedWorkflowManifest {
  readonly manifest: WorkflowDagManifestV2;
  readonly manifestDigest: Sha256Digest;
}

export class WorkflowManifestValidationError extends Error {
  readonly code: string;
  readonly issues: readonly string[];

  constructor(code: string, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "WorkflowManifestValidationError";
    this.code = code;
    this.issues = Object.freeze([...issues]);
  }
}

const WORKFLOW_REFERENCE_SCHEMA = Object.freeze({
  oneOf: [
    {
      type: "object",
      properties: { step: { type: "string", minLength: 1 } },
      required: ["step"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { group: { type: "string", minLength: 1 } },
      required: ["group"],
      additionalProperties: false,
    },
  ],
});

export const WORKFLOW_MANIFEST_V2_SCHEMA = Object.freeze({
  $id: "agenc.workflow.agent-dag.v2",
  type: "object",
  properties: {
    format_version: { const: WORKFLOW_MANIFEST_VERSION },
    kind: { const: "agent_dag" },
    description: { type: "string" },
    max_concurrency: {
      type: "integer",
      minimum: 1,
      maximum: MAX_WORKFLOW_MAX_CONCURRENCY,
    },
    max_handoff_tokens: {
      type: "integer",
      minimum: 1,
      maximum: MAX_WORKFLOW_HANDOFF_TOKENS,
    },
    failure_policy: {
      enum: ["continue_independent", "fail_fast"],
    },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: MAX_WORKFLOW_STEPS,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          message: { type: "string", minLength: 1 },
          task_name: { type: "string", minLength: 1 },
          agent_type: { type: "string", minLength: 1 },
          model: { type: "string", minLength: 1 },
          isolation: { enum: ["none", "cwd", "worktree"] },
          group: { type: "string", minLength: 1 },
          after: {
            type: "array",
            maxItems: MAX_WORKFLOW_EXPANDED_EDGES,
            items: WORKFLOW_REFERENCE_SCHEMA,
          },
          inputs: {
            type: "object",
            maxProperties: MAX_WORKFLOW_INPUT_ALIASES_PER_STEP,
            propertyNames: { pattern: INPUT_ALIAS_PATTERN },
            additionalProperties: WORKFLOW_REFERENCE_SCHEMA,
          },
        },
        required: ["id", "message"],
        additionalProperties: false,
      },
    },
  },
  required: ["format_version", "kind", "steps"],
  additionalProperties: false,
});

const ajv = new Ajv({ allErrors: true, strict: true });
const validateV2 = ajv.compile(
  WORKFLOW_MANIFEST_V2_SCHEMA,
) as ValidateFunction<WorkflowDagManifestV2>;

export function parseWorkflowManifestBytes(
  bytes: Uint8Array,
  label: string,
): ValidatedWorkflowManifest {
  const parsed = parseFiniteJsonBytes(bytes, label, WORKFLOW_JSON_LIMITS);
  return normalizeFiniteWorkflowManifest(parsed, label);
}

/** Alternate entrypoint for tests/embedders; rejects accessors, Proxies and exotic values. */
export function validateWorkflowManifestValue(
  value: unknown,
  label = "workflow manifest",
): ValidatedWorkflowManifest {
  const finite = cloneFiniteJsonValue(value, label, WORKFLOW_JSON_LIMITS);
  return normalizeFiniteWorkflowManifest(finite, label);
}

function normalizeFiniteWorkflowManifest(
  value: FiniteJsonValue,
  label: string,
): ValidatedWorkflowManifest {
  if (!isFiniteJsonRecord(value)) {
    throw new WorkflowManifestValidationError(
      "WORKFLOW_SCHEMA",
      `${label} must be a JSON object`,
    );
  }

  assertSchema(validateV2, value, label, "version-2 DAG manifest");
  enforceAggregateLimits(value, label);
  validateDagSemantics(value, label);
  return Object.freeze({
    manifest: value,
    manifestDigest: digestCanonicalJson("agenc.workflow.manifest.v2", value),
  });
}

function enforceAggregateLimits(
  manifest: WorkflowDagManifestV2,
  label: string,
): void {
  let totalMessageBytes = 0;
  let totalAliases = 0;
  let expandedEdges = 0;
  const groupSizes = new Map<string, number>();
  for (const step of manifest.steps) {
    if (step.group !== undefined) {
      groupSizes.set(step.group, (groupSizes.get(step.group) ?? 0) + 1);
    }
  }
  if (groupSizes.size > MAX_WORKFLOW_GROUPS) {
    throw aggregateError(
      label,
      `exceeds ${MAX_WORKFLOW_GROUPS} workflow groups`,
    );
  }
  for (const step of manifest.steps) {
    const messageBytes = Buffer.byteLength(step.message, "utf8");
    if (messageBytes > MAX_WORKFLOW_STEP_MESSAGE_BYTES) {
      throw aggregateError(
        label,
        `step ${JSON.stringify(step.id)} message exceeds ${MAX_WORKFLOW_STEP_MESSAGE_BYTES} UTF-8 bytes`,
      );
    }
    totalMessageBytes += messageBytes;
    if (totalMessageBytes > MAX_WORKFLOW_TOTAL_MESSAGE_BYTES) {
      throw aggregateError(
        label,
        `exceeds ${MAX_WORKFLOW_TOTAL_MESSAGE_BYTES} aggregate message UTF-8 bytes`,
      );
    }
    const aliases =
      step.inputs === undefined ? 0 : Object.keys(step.inputs).length;
    totalAliases += aliases;
    if (totalAliases > MAX_WORKFLOW_INPUT_ALIASES_TOTAL) {
      throw aggregateError(
        label,
        `exceeds ${MAX_WORKFLOW_INPUT_ALIASES_TOTAL} total input aliases`,
      );
    }
    for (const reference of [
      ...(step.after ?? []),
      ...Object.values(step.inputs ?? {}),
    ]) {
      expandedEdges +=
        "group" in reference ? (groupSizes.get(reference.group) ?? 1) : 1;
      if (expandedEdges > MAX_WORKFLOW_EXPANDED_EDGES) {
        throw aggregateError(
          label,
          `exceeds ${MAX_WORKFLOW_EXPANDED_EDGES} expanded workflow edges`,
        );
      }
    }
  }
}

/**
 * Validate graph meaning before a manifest can cross the loader boundary.
 * Kahn's algorithm keeps the check linear in the bounded expanded graph.
 */
function validateDagSemantics(
  manifest: WorkflowDagManifestV2,
  label: string,
): void {
  try {
    compileWorkflowGraph(manifest, {
      maximumExpandedEdges: MAX_WORKFLOW_EXPANDED_EDGES,
    });
  } catch (error) {
    if (error instanceof WorkflowGraphValidationError) {
      throw semanticError(label, error.message);
    }
    throw error;
  }
}

function assertSchema<T>(
  validator: ValidateFunction<T>,
  value: unknown,
  label: string,
  expected: string,
): asserts value is T {
  if (validator(value)) return;
  const issues = formatSchemaErrors(validator.errors);
  throw new WorkflowManifestValidationError(
    "WORKFLOW_SCHEMA",
    `${label} is not a strict ${expected}: ${issues.join("; ")}`,
    issues,
  );
}

function formatSchemaErrors(
  errors: readonly ErrorObject[] | null | undefined,
): readonly string[] {
  const formatted = (errors ?? [])
    .slice(0, MAX_SCHEMA_ERRORS)
    .map(
      (error) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    );
  if ((errors?.length ?? 0) > MAX_SCHEMA_ERRORS) {
    formatted.push(
      `and ${(errors?.length ?? 0) - MAX_SCHEMA_ERRORS} more errors`,
    );
  }
  return formatted.length === 0 ? ["schema validation failed"] : formatted;
}

function aggregateError(
  label: string,
  detail: string,
): WorkflowManifestValidationError {
  return new WorkflowManifestValidationError(
    "WORKFLOW_AGGREGATE_LIMIT",
    `${label} ${detail}`,
  );
}

function semanticError(
  label: string,
  detail: string,
): WorkflowManifestValidationError {
  return new WorkflowManifestValidationError(
    "WORKFLOW_GRAPH",
    `${label} ${detail}`,
  );
}

function isFiniteJsonRecord(
  value: FiniteJsonValue,
): value is { readonly [key: string]: FiniteJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
