/** Versioned workflow manifest schemas and v1 compatibility normalization. */

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

const LEGACY_IDENTIFIER_PATTERN = "^[A-Za-z0-9_-]{1,128}$";
const INPUT_ALIAS_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,127}$";
const LEGACY_TEMPLATE_PATTERN =
  /^\{\{\s*(steps|group)\.([A-Za-z0-9_-]+)\s*\}\}$/u;
const MUSTACHE_PATTERN = /\{\{[\s\S]*?\}\}/gu;
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

export interface LegacyWorkflowCommandManifest {
  readonly command: string;
  readonly description?: string;
}

export interface WorkflowManifestDiagnostic {
  readonly code: "WORKFLOW_MANIFEST_V1_COMPAT";
  readonly message: string;
}

export interface NormalizedWorkflowDagDocument {
  readonly kind: "agent_dag";
  readonly formatVersion: 2;
  readonly sourceVersion: 1 | 2;
  readonly manifest: WorkflowDagManifestV2;
  readonly manifestDigest: Sha256Digest;
  readonly diagnostics: readonly WorkflowManifestDiagnostic[];
}

export interface NormalizedLegacyCommandDocument {
  readonly kind: "legacy_command";
  readonly formatVersion: 1;
  readonly sourceVersion: 1;
  readonly manifest: LegacyWorkflowCommandManifest;
  readonly manifestDigest: Sha256Digest;
  readonly diagnostics: readonly WorkflowManifestDiagnostic[];
}

export type NormalizedWorkflowManifest =
  NormalizedWorkflowDagDocument | NormalizedLegacyCommandDocument;

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

export const LEGACY_WORKFLOW_DAG_V1_SCHEMA = Object.freeze({
  $id: "agenc.workflow.agent-dag.legacy-v1",
  type: "object",
  properties: {
    description: { type: "string" },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: MAX_WORKFLOW_STEPS,
      items: {
        type: "object",
        properties: {
          id: { type: "string", pattern: LEGACY_IDENTIFIER_PATTERN },
          message: { type: "string", minLength: 1 },
          task_name: { type: "string", pattern: LEGACY_IDENTIFIER_PATTERN },
          agent_type: { type: "string", minLength: 1 },
          model: { type: "string", minLength: 1 },
          isolation: { enum: ["none", "cwd", "worktree"] },
          group: { type: "string", pattern: LEGACY_IDENTIFIER_PATTERN },
          after: {
            type: "array",
            maxItems: MAX_WORKFLOW_EXPANDED_EDGES,
            items: { type: "string", pattern: LEGACY_IDENTIFIER_PATTERN },
          },
        },
        required: ["id", "message"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps"],
  additionalProperties: false,
});

export const LEGACY_WORKFLOW_COMMAND_SCHEMA = Object.freeze({
  $id: "agenc.workflow.command.legacy-v1",
  type: "object",
  properties: {
    command: { type: "string", minLength: 1 },
    description: { type: "string" },
  },
  required: ["command"],
  additionalProperties: false,
});

const ajv = new Ajv({ allErrors: true, strict: true });
const validateV2 = ajv.compile(
  WORKFLOW_MANIFEST_V2_SCHEMA,
) as ValidateFunction<WorkflowDagManifestV2>;
const validateLegacyDag = ajv.compile(
  LEGACY_WORKFLOW_DAG_V1_SCHEMA,
) as ValidateFunction<LegacyDagManifest>;
const validateLegacyCommand = ajv.compile(
  LEGACY_WORKFLOW_COMMAND_SCHEMA,
) as ValidateFunction<LegacyWorkflowCommandManifest>;

interface LegacyStep {
  readonly id: string;
  readonly message: string;
  readonly task_name?: string;
  readonly agent_type?: string;
  readonly model?: string;
  readonly isolation?: WorkflowIsolationMode;
  readonly group?: string;
  readonly after?: readonly string[];
}

interface LegacyDagManifest {
  readonly description?: string;
  readonly steps: readonly LegacyStep[];
}

export function parseWorkflowManifestBytes(
  bytes: Uint8Array,
  label: string,
): NormalizedWorkflowManifest {
  const parsed = parseFiniteJsonBytes(bytes, label, WORKFLOW_JSON_LIMITS);
  return normalizeFiniteWorkflowManifest(parsed, label);
}

/** Alternate entrypoint for tests/embedders; rejects accessors, Proxies and exotic values. */
export function validateWorkflowManifestValue(
  value: unknown,
  label = "workflow manifest",
): NormalizedWorkflowManifest {
  const finite = cloneFiniteJsonValue(value, label, WORKFLOW_JSON_LIMITS);
  return normalizeFiniteWorkflowManifest(finite, label);
}

function normalizeFiniteWorkflowManifest(
  value: FiniteJsonValue,
  label: string,
): NormalizedWorkflowManifest {
  if (!isFiniteJsonRecord(value)) {
    throw new WorkflowManifestValidationError(
      "WORKFLOW_SCHEMA",
      `${label} must be a JSON object`,
    );
  }

  if (Object.hasOwn(value, "format_version") || Object.hasOwn(value, "kind")) {
    assertSchema(validateV2, value, label, "version-2 DAG manifest");
    enforceAggregateLimits(value, label);
    validateDagSemantics(value, label);
    return Object.freeze({
      kind: "agent_dag",
      formatVersion: WORKFLOW_MANIFEST_VERSION,
      sourceVersion: WORKFLOW_MANIFEST_VERSION,
      manifest: value,
      manifestDigest: digestCanonicalJson("agenc.workflow.manifest.v2", value),
      diagnostics: Object.freeze([]),
    });
  }

  if (Object.hasOwn(value, "steps")) {
    assertSchema(validateLegacyDag, value, label, "legacy v1 DAG manifest");
    const manifest = convertLegacyDag(value, label);
    enforceAggregateLimits(manifest, label);
    validateDagSemantics(manifest, label);
    const diagnostic: WorkflowManifestDiagnostic = Object.freeze({
      code: "WORKFLOW_MANIFEST_V1_COMPAT",
      message:
        "unversioned workflow DAG accepted for the v2 format epoch; migrate it to format_version 2 before v3",
    });
    return Object.freeze({
      kind: "agent_dag",
      formatVersion: WORKFLOW_MANIFEST_VERSION,
      sourceVersion: 1,
      manifest,
      manifestDigest: digestCanonicalJson(
        "agenc.workflow.manifest.v2",
        manifest,
      ),
      diagnostics: Object.freeze([diagnostic]),
    });
  }

  assertSchema(validateLegacyCommand, value, label, "legacy command manifest");
  return Object.freeze({
    kind: "legacy_command",
    formatVersion: 1,
    sourceVersion: 1,
    manifest: value,
    manifestDigest: digestCanonicalJson("agenc.workflow.command.v1", value),
    diagnostics: Object.freeze([]),
  });
}

function convertLegacyDag(
  legacy: LegacyDagManifest,
  label: string,
): WorkflowDagManifestV2 {
  const stepIds = new Set(legacy.steps.map((step) => step.id));
  const groupNames = new Set(
    legacy.steps
      .map((step) => step.group)
      .filter((group): group is string => group !== undefined),
  );
  for (const collision of stepIds) {
    if (groupNames.has(collision)) {
      throw new WorkflowManifestValidationError(
        "WORKFLOW_LEGACY_AMBIGUOUS_REF",
        `${label} legacy step/group name ${JSON.stringify(collision)} is ambiguous`,
      );
    }
  }

  const steps = legacy.steps.map((step): WorkflowStepV2 => {
    assertLegacyTemplates(step.message, label, stepIds, groupNames);
    const after = step.after?.map((reference): WorkflowRef => {
      if (stepIds.has(reference)) return inertRecord({ step: reference });
      if (groupNames.has(reference)) return inertRecord({ group: reference });
      throw new WorkflowManifestValidationError(
        "WORKFLOW_LEGACY_UNKNOWN_REF",
        `${label} legacy step ${JSON.stringify(step.id)} references unknown step/group ${JSON.stringify(reference)}`,
      );
    });
    return inertRecord({
      id: step.id,
      message: step.message,
      ...(step.task_name === undefined ? {} : { task_name: step.task_name }),
      ...(step.agent_type === undefined ? {} : { agent_type: step.agent_type }),
      ...(step.model === undefined ? {} : { model: step.model }),
      ...(step.isolation === undefined ? {} : { isolation: step.isolation }),
      ...(step.group === undefined ? {} : { group: step.group }),
      ...(after === undefined ? {} : { after: Object.freeze(after) }),
    });
  });
  return inertRecord({
    format_version: WORKFLOW_MANIFEST_VERSION,
    kind: "agent_dag",
    ...(legacy.description === undefined
      ? {}
      : { description: legacy.description }),
    steps: Object.freeze(steps),
  });
}

function assertLegacyTemplates(
  message: string,
  label: string,
  stepIds: ReadonlySet<string>,
  groupNames: ReadonlySet<string>,
): void {
  const unmatched = message.replace(MUSTACHE_PATTERN, "");
  if (unmatched.includes("{{") || unmatched.includes("}}")) {
    throw new WorkflowManifestValidationError(
      "WORKFLOW_LEGACY_TEMPLATE",
      `${label} contains malformed legacy template syntax`,
    );
  }
  for (const match of message.matchAll(MUSTACHE_PATTERN)) {
    const parsed = LEGACY_TEMPLATE_PATTERN.exec(match[0]);
    if (parsed === null) {
      throw new WorkflowManifestValidationError(
        "WORKFLOW_LEGACY_TEMPLATE",
        `${label} contains unsupported legacy template ${JSON.stringify(match[0])}`,
      );
    }
    const namespace = parsed[1];
    const name = parsed[2]!;
    const known =
      namespace === "steps" ? stepIds.has(name) : groupNames.has(name);
    if (!known) {
      throw new WorkflowManifestValidationError(
        "WORKFLOW_LEGACY_TEMPLATE",
        `${label} legacy template references unknown ${namespace} name ${JSON.stringify(name)}`,
      );
    }
  }
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

function inertRecord<T extends object>(value: T): Readonly<T> {
  const record = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(record, key, {
      configurable: false,
      enumerable: true,
      value: entry,
      writable: false,
    });
  }
  return Object.freeze(record) as Readonly<T>;
}
