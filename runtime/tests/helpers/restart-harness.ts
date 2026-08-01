import { createFailurePlan } from "./failure-plan.js";
import type {
  ChildInvocation,
  ChildProcessHarness,
  ChildResult,
  DurableMarkerExpectation,
} from "./child-process-harness.js";
import {
  isWellFormedUnicode,
  snapshotMarkerExpectation,
} from "./process-harness-contract.js";

const MIN_RESTART_COUNT = 2;
const MAX_RESTART_COUNT = 8;
const MAX_FINGERPRINT_BYTES = 4_096;
const DEFAULT_INSPECTION_TIMEOUT_MS = 2_000;
const MAX_INSPECTION_TIMEOUT_MS = 10_000;
const DEFAULT_INSPECTION_SETTLE_TIMEOUT_MS = 1_000;
const MAX_INSPECTION_SETTLE_TIMEOUT_MS = 5_000;
const CONTROL_CHARACTER_PATTERN = /\u0000/u;

export type RestartFailure =
  | {
      readonly kind: "simulated";
      readonly expectedExitCode: number;
    }
  | {
      readonly kind: "process-crash";
      readonly marker: DurableMarkerExpectation;
    };

export interface RestartScenario<T> {
  readonly initial: ChildInvocation;
  readonly failure: RestartFailure;
  readonly restartCount: number;
  readonly expectedTrace: readonly string[];
  readonly inspectionTimeoutMs?: number;
  readonly inspectionSettleTimeoutMs?: number;
  restart(iteration: number): ChildInvocation;
  inspect(
    iteration: number,
    result: ChildResult,
    signal: AbortSignal,
  ): Promise<T>;
  fingerprint(value: T): string;
}

export interface RestartTrace<T> {
  readonly failureKind: RestartFailure["kind"];
  readonly initial: ChildResult;
  readonly restarts: readonly ChildResult[];
  readonly inspections: readonly T[];
  readonly fingerprints: readonly string[];
  readonly checkpoints: readonly string[];
  readonly idempotent: boolean;
}

interface RestartScenarioSnapshot<T> {
  readonly initial: ChildInvocation;
  readonly failure: RestartFailure;
  readonly restartCount: number;
  readonly expectedTrace: readonly string[];
  readonly inspectionTimeoutMs: number;
  readonly inspectionSettleTimeoutMs: number;
  readonly restart: RestartScenario<T>["restart"];
  readonly inspect: RestartScenario<T>["inspect"];
  readonly fingerprint: RestartScenario<T>["fingerprint"];
}

export async function runRestartScenario<T>(
  harness: ChildProcessHarness,
  scenario: RestartScenario<T>,
): Promise<RestartTrace<T>> {
  const snapshot = snapshotScenario(scenario);
  const canonicalTrace = expectedScenarioTrace(
    snapshot.failure.kind,
    snapshot.restartCount,
  );
  if (!equalStringArrays(snapshot.expectedTrace, canonicalTrace)) {
    throw new Error(
      `restart scenario expectedTrace must equal ${JSON.stringify(canonicalTrace)}`,
    );
  }
  const plan = createFailurePlan(
    canonicalTrace.map((checkpoint) => ({ checkpoint })),
    { label: "FND restart scenario" },
  );
  const restarts: ChildResult[] = [];
  const inspections: T[] = [];
  const fingerprints: string[] = [];

  try {
    plan.hit("initial.start");
    let initial: ChildResult;
    if (snapshot.failure.kind === "simulated") {
      initial = await harness.run(snapshot.initial);
      plan.hit("failure.simulated");
      assertSimulatedFailure(initial, snapshot.failure.expectedExitCode);
    } else {
      const child = await harness.spawn(snapshot.initial);
      await child.waitForMarker(snapshot.failure.marker);
      plan.hit("failure.process-crash");
      initial = await child.crash();
      assertProcessCrash(initial);
    }

    for (
      let iteration = 1;
      iteration <= snapshot.restartCount;
      iteration += 1
    ) {
      plan.hit(`restart.${iteration}.run`);
      const result = await harness.run(snapshot.restart(iteration));
      assertSuccessfulRestart(result, iteration);
      restarts.push(result);

      plan.hit(`restart.${iteration}.inspect`);
      const inspection = await runBoundedInspection(
        (signal) => snapshot.inspect(iteration, result, signal),
        snapshot.inspectionTimeoutMs,
        snapshot.inspectionSettleTimeoutMs,
        `restart ${iteration} inspection`,
      );
      const fingerprint = snapshot.fingerprint(inspection);
      validateFingerprint(fingerprint, iteration);
      inspections.push(inspection);
      fingerprints.push(fingerprint);
    }

    plan.assertComplete();
    const idempotent = fingerprints.every(
      (fingerprint) => fingerprint === fingerprints[0],
    );
    if (!idempotent) {
      throw new Error(
        "restart scenario recovery fingerprint is not idempotent",
      );
    }
    return Object.freeze({
      failureKind: snapshot.failure.kind,
      initial,
      restarts: Object.freeze(restarts),
      inspections: Object.freeze(inspections),
      fingerprints: Object.freeze(fingerprints),
      checkpoints: plan.snapshot().reached,
      idempotent,
    });
  } catch (error) {
    try {
      await harness.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "restart scenario failed and child cleanup also failed",
      );
    }
    throw error;
  }
}

export function expectedScenarioTrace(
  failureKind: RestartFailure["kind"],
  restartCount: number,
): readonly string[] {
  if (
    !Number.isSafeInteger(restartCount) ||
    restartCount < MIN_RESTART_COUNT ||
    restartCount > MAX_RESTART_COUNT
  ) {
    throw new Error(
      `restartCount must be in [${MIN_RESTART_COUNT}, ${MAX_RESTART_COUNT}] to prove idempotence`,
    );
  }
  const checkpoints = [
    "initial.start",
    failureKind === "simulated" ? "failure.simulated" : "failure.process-crash",
  ];
  for (let iteration = 1; iteration <= restartCount; iteration += 1) {
    checkpoints.push(
      `restart.${iteration}.run`,
      `restart.${iteration}.inspect`,
    );
  }
  return Object.freeze(checkpoints);
}

function snapshotScenario<T>(
  scenario: RestartScenario<T>,
): RestartScenarioSnapshot<T> {
  validateScenario(scenario);
  const failure: RestartFailure =
    scenario.failure.kind === "simulated"
      ? Object.freeze({
          kind: "simulated",
          expectedExitCode: scenario.failure.expectedExitCode,
        })
      : Object.freeze({
          kind: "process-crash",
          marker: snapshotMarkerExpectation(scenario.failure.marker),
        });
  return Object.freeze({
    initial: scenario.initial,
    failure,
    restartCount: scenario.restartCount,
    expectedTrace: Object.freeze([...scenario.expectedTrace]),
    inspectionTimeoutMs:
      scenario.inspectionTimeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS,
    inspectionSettleTimeoutMs:
      scenario.inspectionSettleTimeoutMs ??
      DEFAULT_INSPECTION_SETTLE_TIMEOUT_MS,
    restart: scenario.restart,
    inspect: scenario.inspect,
    fingerprint: scenario.fingerprint,
  });
}

function validateScenario<T>(scenario: RestartScenario<T>): void {
  if (
    !Number.isSafeInteger(scenario.restartCount) ||
    scenario.restartCount < MIN_RESTART_COUNT ||
    scenario.restartCount > MAX_RESTART_COUNT
  ) {
    throw new Error(
      `restartCount must be in [${MIN_RESTART_COUNT}, ${MAX_RESTART_COUNT}] to prove idempotence`,
    );
  }
  if (
    scenario.failure.kind !== "simulated" &&
    scenario.failure.kind !== "process-crash"
  ) {
    throw new Error("restart scenario has an unknown failure kind");
  }
  if (
    scenario.failure.kind === "simulated" &&
    (!Number.isSafeInteger(scenario.failure.expectedExitCode) ||
      scenario.failure.expectedExitCode <= 0 ||
      scenario.failure.expectedExitCode > 255)
  ) {
    throw new Error("simulated failure exit code must be in [1, 255]");
  }
  if (typeof scenario.restart !== "function") {
    throw new Error("restart scenario restart must be a function");
  }
  if (typeof scenario.inspect !== "function") {
    throw new Error("restart scenario inspect must be a function");
  }
  if (typeof scenario.fingerprint !== "function") {
    throw new Error("restart scenario fingerprint must be a function");
  }
  const inspectionTimeoutMs =
    scenario.inspectionTimeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(inspectionTimeoutMs) ||
    inspectionTimeoutMs <= 0 ||
    inspectionTimeoutMs > MAX_INSPECTION_TIMEOUT_MS
  ) {
    throw new Error(
      "restart scenario inspectionTimeoutMs is outside its range",
    );
  }
  const inspectionSettleTimeoutMs =
    scenario.inspectionSettleTimeoutMs ?? DEFAULT_INSPECTION_SETTLE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(inspectionSettleTimeoutMs) ||
    inspectionSettleTimeoutMs <= 0 ||
    inspectionSettleTimeoutMs > MAX_INSPECTION_SETTLE_TIMEOUT_MS
  ) {
    throw new Error(
      "restart scenario inspectionSettleTimeoutMs is outside its range",
    );
  }
}

function assertSimulatedFailure(result: ChildResult, exitCode: number): void {
  if (
    result.stopReason !== "exit" ||
    !Number.isSafeInteger(result.exitCode) ||
    (result.exitCode as number) <= 0 ||
    result.exitCode !== exitCode ||
    result.signal !== null ||
    result.forced ||
    result.backstopExpired ||
    result.error !== undefined
  ) {
    throw new Error(
      `simulated failure did not exit cleanly with code ${exitCode}`,
    );
  }
}

function assertProcessCrash(result: ChildResult): void {
  if (
    result.stopReason !== "crashed" ||
    result.exitCode !== null ||
    result.signal === null ||
    result.forced ||
    result.backstopExpired ||
    result.error !== undefined
  ) {
    throw new Error(
      "process-crash scenario did not complete a contained crash",
    );
  }
}

function assertSuccessfulRestart(result: ChildResult, iteration: number): void {
  if (
    result.stopReason !== "exit" ||
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.forced ||
    result.error !== undefined ||
    result.backstopExpired
  ) {
    throw new Error(`restart ${iteration} did not exit successfully`);
  }
}

function validateFingerprint(fingerprint: string, iteration: number): void {
  if (
    typeof fingerprint !== "string" ||
    fingerprint.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(fingerprint) ||
    !isWellFormedUnicode(fingerprint) ||
    Buffer.byteLength(fingerprint, "utf8") > MAX_FINGERPRINT_BYTES
  ) {
    throw new Error(`restart ${iteration} produced an invalid fingerprint`);
  }
}

function equalStringArrays(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

type InspectionOutcome<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown };

async function runBoundedInspection<T>(
  inspect: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  settleTimeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const operation = Promise.resolve().then(() => inspect(controller.signal));
  const outcome: Promise<InspectionOutcome<T>> = operation.then(
    (value): InspectionOutcome<T> => ({ kind: "fulfilled", value }),
    (error: unknown): InspectionOutcome<T> => ({ kind: "rejected", error }),
  );
  const deadlineError = new Error(`${label} exceeded its deadline`);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolveDeadline) => {
    deadlineTimer = setTimeout(() => resolveDeadline("deadline"), timeoutMs);
  });

  const initial = await Promise.race([outcome, deadline]);
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  if (initial !== "deadline") return unwrapInspectionOutcome(initial);

  controller.abort(deadlineError);
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  const settlementDeadline = new Promise<"unsettled">((resolveUnsettled) => {
    settlementTimer = setTimeout(
      () => resolveUnsettled("unsettled"),
      settleTimeoutMs,
    );
  });
  const settlement = await Promise.race([outcome, settlementDeadline]);
  if (settlementTimer !== undefined) clearTimeout(settlementTimer);
  if (settlement === "unsettled") {
    throw new Error(`${label} failed to settle after abort`, {
      cause: deadlineError,
    });
  }
  if (settlement.kind === "rejected") {
    throw new Error(deadlineError.message, { cause: settlement.error });
  }
  throw deadlineError;
}

function unwrapInspectionOutcome<T>(outcome: InspectionOutcome<T>): T {
  if (outcome.kind === "fulfilled") return outcome.value;
  throw outcome.error;
}
