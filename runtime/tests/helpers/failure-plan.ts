import { types as nodeUtilTypes } from "node:util";

export const MAX_FAILURE_PLAN_STEPS = 100_000;
export const MAX_FAILURE_PLAN_CHECKPOINT_UTF8_BYTES = 1_024;
export const MAX_FAILURE_PLAN_DIAGNOSTIC_CHECKPOINTS = 16;

export type FailurePlanErrorCode =
  | "action_async"
  | "action_invalid"
  | "checkpoint_invalid"
  | "incomplete"
  | "invalid_limit"
  | "mismatch"
  | "plan_poisoned"
  | "reentrant_hit"
  | "step_limit"
  | "steps_invalid"
  | "steps_mutated"
  | "steps_sparse"
  | "unexpected_checkpoint";

export class FailurePlanError extends Error {
  readonly code: FailurePlanErrorCode;

  constructor(code: FailurePlanErrorCode, message: string) {
    super(message);
    this.name = "FailurePlanError";
    this.code = code;
  }
}

export interface FailurePlanStep {
  readonly checkpoint: string;
  readonly action?: () => void;
}

export interface FailurePlanOptions {
  readonly label?: string;
  readonly stepLimit?: number;
}

export interface FailurePlanSnapshot {
  readonly label: string;
  readonly status: "active" | "complete" | "poisoned";
  readonly nextIndex: number;
  readonly reached: readonly string[];
  readonly remaining: readonly string[];
  readonly poisonReason?: string;
}

export interface FailurePlan {
  hit(checkpoint: string): void;
  snapshot(): FailurePlanSnapshot;
  assertComplete(): void;
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        next < 0xdc00 ||
        next > 0xdfff
      ) {
        throw new FailurePlanError(
          "checkpoint_invalid",
          `${label} contains an unpaired high surrogate at UTF-16 offset ${index}`,
        );
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new FailurePlanError(
        "checkpoint_invalid",
        `${label} contains an unpaired low surrogate at UTF-16 offset ${index}`,
      );
    }
  }
}

function validateName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_FAILURE_PLAN_CHECKPOINT_UTF8_BYTES
  ) {
    throw new FailurePlanError(
      "checkpoint_invalid",
      `${label} must contain 1-${MAX_FAILURE_PLAN_CHECKPOINT_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  assertWellFormedUnicode(value, label);
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > MAX_FAILURE_PLAN_CHECKPOINT_UTF8_BYTES) {
    throw new FailurePlanError(
      "checkpoint_invalid",
      `${label} must contain 1-${MAX_FAILURE_PLAN_CHECKPOINT_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) && typeof (value as { readonly then?: unknown }).then === "function";
}

function compactCheckpointList(checkpoints: readonly string[]): string {
  const shown = checkpoints.slice(0, MAX_FAILURE_PLAN_DIAGNOSTIC_CHECKPOINTS);
  const suffix =
    checkpoints.length > shown.length
      ? `, ... ${checkpoints.length - shown.length} more`
      : "";
  return `${JSON.stringify(shown)}${suffix}`;
}

function validateStepCount(
  inputSteps: readonly FailurePlanStep[],
  stepLimit: number,
): number {
  if (nodeUtilTypes.isProxy(inputSteps) || !Array.isArray(inputSteps)) {
    throw new FailurePlanError(
      "steps_invalid",
      "failure plan steps must be a non-proxy array",
    );
  }
  const stepCount = inputSteps.length;
  if (stepCount > stepLimit) {
    throw new FailurePlanError(
      "step_limit",
      `failure plan exceeds ${stepLimit} steps`,
    );
  }
  return stepCount;
}

function copyFailurePlanSteps(
  inputSteps: readonly FailurePlanStep[],
  stepCount: number,
): readonly FailurePlanStep[] {
  const steps = new Array<FailurePlanStep>(stepCount);
  for (let index = 0; index < stepCount; index += 1) {
    if (inputSteps.length !== stepCount) {
      throw new FailurePlanError(
        "steps_mutated",
        "failure plan step count changed while it was copied",
      );
    }
    if (!Object.prototype.hasOwnProperty.call(inputSteps, index)) {
      throw new FailurePlanError(
        "steps_sparse",
        `failure plan steps are sparse at index ${index}`,
      );
    }
    const step = inputSteps[index];
    if (inputSteps.length !== stepCount) {
      throw new FailurePlanError(
        "steps_mutated",
        "failure plan step count changed while it was copied",
      );
    }
    if (typeof step !== "object" || step === null) {
      throw new FailurePlanError(
        "checkpoint_invalid",
        `checkpoint ${index} must be an object`,
      );
    }
    const checkpointInput = step.checkpoint;
    if (inputSteps.length !== stepCount) {
      throw new FailurePlanError(
        "steps_mutated",
        "failure plan step count changed while it was copied",
      );
    }
    const action = step.action;
    if (inputSteps.length !== stepCount) {
      throw new FailurePlanError(
        "steps_mutated",
        "failure plan step count changed while it was copied",
      );
    }
    const checkpoint = validateName(checkpointInput, `checkpoint ${index}`);
    if (action !== undefined && typeof action !== "function") {
      throw new FailurePlanError(
        "action_invalid",
        `checkpoint ${JSON.stringify(checkpoint)} action must be a function`,
      );
    }
    steps[index] = Object.freeze({ checkpoint, action });
  }
  if (inputSteps.length !== stepCount) {
    throw new FailurePlanError(
      "steps_mutated",
      "failure plan step count changed while it was copied",
    );
  }
  return Object.freeze(steps);
}

/**
 * Create an exact ordered boundary plan for failure-injection tests.
 *
 * A step is consumed before its action executes, so an intentional throw at a
 * boundary still proves that the boundary was reached exactly once.
 */
export function createFailurePlan(
  inputSteps: readonly FailurePlanStep[],
  options: FailurePlanOptions = {},
): FailurePlan {
  const stepLimit = options.stepLimit ?? MAX_FAILURE_PLAN_STEPS;
  if (
    !Number.isSafeInteger(stepLimit) ||
    stepLimit < 1 ||
    stepLimit > MAX_FAILURE_PLAN_STEPS
  ) {
    throw new FailurePlanError(
      "invalid_limit",
      `stepLimit must be a safe integer in [1, ${MAX_FAILURE_PLAN_STEPS}]`,
    );
  }
  const stepCount = validateStepCount(inputSteps, stepLimit);
  const label = validateName(options.label ?? "failure plan", "plan label");
  const steps = copyFailurePlanSteps(inputSteps, stepCount);

  const reached: string[] = [];
  let nextIndex = 0;
  let poisonReason: string | undefined;
  let actionExecuting = false;

  const poison = (code: FailurePlanErrorCode, message: string): never => {
    poisonReason ??= message;
    throw new FailurePlanError(code, message);
  };

  const snapshot = (): FailurePlanSnapshot =>
    Object.freeze({
      label,
      status:
        poisonReason !== undefined
          ? "poisoned"
          : nextIndex === steps.length
            ? "complete"
            : "active",
      nextIndex,
      reached: Object.freeze([...reached]),
      remaining: Object.freeze(
        steps.slice(nextIndex).map((step) => step.checkpoint),
      ),
      ...(poisonReason === undefined ? {} : { poisonReason }),
    });

  const plan: FailurePlan = {
    hit(checkpointInput: string): void {
      if (poisonReason !== undefined) {
        throw new FailurePlanError(
          "plan_poisoned",
          `${label} is poisoned: ${poisonReason}`,
        );
      }
      if (actionExecuting) {
        poison(
          "reentrant_hit",
          `${label} received a reentrant checkpoint while an action was running`,
        );
      }
      const checkpoint = validateName(checkpointInput, "observed checkpoint");
      const expected = steps[nextIndex];
      if (expected === undefined) {
        poison(
          "unexpected_checkpoint",
          `${label} received unexpected checkpoint ${JSON.stringify(checkpoint)} after completion`,
        );
      }
      if (expected.checkpoint !== checkpoint) {
        poison(
          "mismatch",
          `${label} checkpoint ${nextIndex} was ${JSON.stringify(checkpoint)}, expected ${JSON.stringify(expected.checkpoint)}`,
        );
      }

      nextIndex += 1;
      reached.push(checkpoint);
      if (expected.action === undefined) return;
      actionExecuting = true;
      try {
        const result = (expected.action as () => unknown)();
        if (isThenable(result)) {
          void Promise.resolve(result).catch(() => {});
          poison(
            "action_async",
            `${label} checkpoint ${JSON.stringify(checkpoint)} returned a thenable action`,
          );
        }
      } finally {
        actionExecuting = false;
      }
    },
    snapshot,
    assertComplete(): void {
      if (poisonReason !== undefined) {
        throw new FailurePlanError(
          "plan_poisoned",
          `${label} is poisoned: ${poisonReason}`,
        );
      }
      if (nextIndex === steps.length) return;
      const remaining = steps
        .slice(nextIndex)
        .map((step) => step.checkpoint);
      throw new FailurePlanError(
        "incomplete",
        `${label} omitted ${remaining.length} checkpoint(s): ${compactCheckpointList(remaining)}`,
      );
    },
  };

  return Object.freeze(plan);
}
