/** Frozen WorkflowTool invocation contract, independent of the tool caller. */

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { types as utilTypes } from "node:util";

import { cloneFiniteJsonValue } from "./workflow-finite-json.js";
import {
  DEFAULT_WORKFLOW_MAX_CONCURRENCY,
  DEFAULT_WORKFLOW_MAX_HANDOFF_TOKENS,
  MAX_WORKFLOW_HANDOFF_TOKENS,
  MAX_WORKFLOW_MAX_CONCURRENCY,
  type WorkflowDagManifestV2,
  type WorkflowFailurePolicy,
} from "./workflow-manifest-schema.js";

const MAX_INVOCATION_SCHEMA_ERRORS = 10;
const INVOCATION_JSON_LIMITS = Object.freeze({
  maximumDepth: 3,
  maximumNodes: 16,
  maximumKeyUtf8Bytes: 64,
  maximumStringUtf8Bytes: 1_024,
  maximumTotalStringUtf8Bytes: 2_048,
});

export interface WorkflowInvocationOverrides {
  readonly max_concurrency?: number;
  readonly max_handoff_tokens?: number;
  readonly failure_policy?: WorkflowFailurePolicy;
}

export interface WorkflowInvocation {
  readonly name: string;
  readonly args?: WorkflowInvocationOverrides;
}

export interface EffectiveWorkflowLimits {
  readonly formatVersion: 2;
  readonly maxConcurrency: number;
  readonly maxHandoffTokens: number;
  readonly failurePolicy: WorkflowFailurePolicy;
}

export const WORKFLOW_INVOCATION_SCHEMA = Object.freeze({
  $id: "agenc.workflow.tool-invocation.v2",
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    args: {
      type: "object",
      properties: {
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
      },
      additionalProperties: false,
    },
  },
  required: ["name"],
  additionalProperties: false,
});

const invocationValidator = new Ajv({ allErrors: true, strict: true }).compile(
  WORKFLOW_INVOCATION_SCHEMA,
) as ValidateFunction<WorkflowInvocation>;

export class WorkflowInvocationValidationError extends Error {
  readonly code: string;
  readonly issues: readonly string[];

  constructor(code: string, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "WorkflowInvocationValidationError";
    this.code = code;
    this.issues = Object.freeze([...issues]);
  }
}

export function validateWorkflowInvocationValue(
  value: unknown,
): WorkflowInvocation {
  const finite = cloneFiniteJsonValue(
    value,
    "WorkflowTool invocation",
    INVOCATION_JSON_LIMITS,
  );
  if (invocationValidator(finite)) return finite;
  const issues = formatErrors(invocationValidator.errors);
  throw new WorkflowInvocationValidationError(
    "WORKFLOW_INVOCATION_SCHEMA",
    `WorkflowTool invocation is invalid: ${issues.join("; ")}`,
    issues,
  );
}

/**
 * Copy only the public WorkflowTool fields from an executor argument object.
 * Runtime-injected symbol/string metadata remains out of the public contract,
 * while accessors and Proxies still fail before user code can run.
 */
export function validateWorkflowInvocationToolArgs(
  value: Readonly<Record<string, unknown>>,
): WorkflowInvocation {
  if (utilTypes.isProxy(value)) {
    throw new WorkflowInvocationValidationError(
      "WORKFLOW_INVOCATION_PROXY",
      "WorkflowTool invocation must not be a Proxy",
    );
  }
  const invocation = Object.create(null) as Record<string, unknown>;
  for (const key of ["name", "args"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) {
      throw new WorkflowInvocationValidationError(
        "WORKFLOW_INVOCATION_ACCESSOR",
        `WorkflowTool invocation field ${JSON.stringify(key)} must be a data property`,
      );
    }
    Object.defineProperty(invocation, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  return validateWorkflowInvocationValue(Object.freeze(invocation));
}

export function assertLegacyCommandInvocation(
  invocation: WorkflowInvocation,
): void {
  if (
    invocation.args !== undefined &&
    Object.keys(invocation.args).length !== 0
  ) {
    throw new WorkflowInvocationValidationError(
      "WORKFLOW_LEGACY_ARGS",
      "legacy command workflows do not accept invocation overrides",
    );
  }
}

/**
 * Invocation values may tighten approved manifest/default ceilings, never
 * widen them. Registry capacity is a live ceiling supplied by B3b.
 */
export function resolveEffectiveWorkflowLimits(
  manifest: WorkflowDagManifestV2,
  invocation: WorkflowInvocation,
  registryCapacity: number,
  accountingHandoffTokenCapacity: number,
): EffectiveWorkflowLimits {
  if (!Number.isSafeInteger(registryCapacity) || registryCapacity < 1) {
    throw new WorkflowInvocationValidationError(
      "WORKFLOW_REGISTRY_CAPACITY",
      "workflow registry capacity must be a positive safe integer",
    );
  }
  if (
    !Number.isSafeInteger(accountingHandoffTokenCapacity) ||
    accountingHandoffTokenCapacity < 1
  ) {
    throw new WorkflowInvocationValidationError(
      "WORKFLOW_ACCOUNTING_CAPACITY",
      "workflow handoff-token accounting capacity must be a positive safe integer",
    );
  }
  const manifestConcurrency =
    manifest.max_concurrency ?? DEFAULT_WORKFLOW_MAX_CONCURRENCY;
  const invocationConcurrency =
    invocation.args?.max_concurrency ?? MAX_WORKFLOW_MAX_CONCURRENCY;
  const manifestHandoff =
    manifest.max_handoff_tokens ?? DEFAULT_WORKFLOW_MAX_HANDOFF_TOKENS;
  const invocationHandoff =
    invocation.args?.max_handoff_tokens ?? MAX_WORKFLOW_HANDOFF_TOKENS;
  return Object.freeze({
    formatVersion: 2,
    maxConcurrency: Math.min(
      manifestConcurrency,
      invocationConcurrency,
      MAX_WORKFLOW_MAX_CONCURRENCY,
      registryCapacity,
    ),
    maxHandoffTokens: Math.min(
      manifestHandoff,
      invocationHandoff,
      MAX_WORKFLOW_HANDOFF_TOKENS,
      accountingHandoffTokenCapacity,
    ),
    failurePolicy:
      manifest.failure_policy === "fail_fast" ||
      invocation.args?.failure_policy === "fail_fast"
        ? "fail_fast"
        : "continue_independent",
  });
}

function formatErrors(
  errors: readonly ErrorObject[] | null | undefined,
): readonly string[] {
  const formatted = (errors ?? [])
    .slice(0, MAX_INVOCATION_SCHEMA_ERRORS)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
  if ((errors?.length ?? 0) > MAX_INVOCATION_SCHEMA_ERRORS) {
    formatted.push(
      `and ${(errors?.length ?? 0) - MAX_INVOCATION_SCHEMA_ERRORS} more errors`,
    );
  }
  return formatted.length === 0 ? ["schema validation failed"] : formatted;
}
