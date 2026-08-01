import type { RedProbeAssertion } from "../../helpers/red-probe.js";

import { setTimeout as delay } from "node:timers/promises";

import {
  ToolTimeoutError,
  withTimeoutAndAbort,
} from "../../../src/tools/execution.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "a1-timeout-returns-before-physical-settlement",
    task: "A1",
    fingerprint: "A1:TOOL-EXECUTION:DEADLINE-BEFORE-PHYSICAL-SETTLEMENT",
  });
  const timeoutMilliseconds = 10;
  const observationMilliseconds = 100;
  let settlePhysicalEffect!: (value: string) => void;
  let physicalOutcome = "pending";
  const physicalEffect = new Promise<string>((resolve) => {
    settlePhysicalEffect = resolve;
  });
  const ownedPhysicalSettlement = physicalEffect.then((value) => {
    physicalOutcome = "settled";
    return value;
  });
  let callerOutcome = "pending";
  const callerSettlement = withTimeoutAndAbort(() => ownedPhysicalSettlement, {
    timeoutMs: timeoutMilliseconds,
    toolName: "probe",
  }).then(
    () => {
      callerOutcome = "completed";
    },
    (error: unknown) => {
      if (!(error instanceof ToolTimeoutError)) throw error;
      callerOutcome = "timed_out";
    },
  );

  await delay(observationMilliseconds);
  const observedCallerOutcome = callerOutcome;
  const observedPhysicalOutcome = physicalOutcome;
  settlePhysicalEffect("physically-settled");
  const latePhysicalResult = await ownedPhysicalSettlement;
  await callerSettlement;

  expectDeepStrictEqualRedProbe(
    probeIdentity,
    {
      callerOutcome: observedCallerOutcome,
      physicalOutcome: observedPhysicalOutcome,
      latePhysicalResult,
    },
    {
      callerOutcome: "timed_out",
      physicalOutcome: "pending",
      latePhysicalResult: "physically-settled",
    },
  );
}
