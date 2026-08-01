import type { RedProbeAssertion } from "../../helpers/red-probe.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "intentional-transition-omission",
    task: "FND-001",
    fingerprint: "FND-001:HARNESS-SELF-TEST:INTENTIONAL-TRANSITION-OMISSION",
  });
  const observedTransitions = Object.freeze(["queued", "running"]);
  const requiredTransitions = Object.freeze(["queued", "running", "completed"]);

  expectDeepStrictEqualRedProbe(
    probeIdentity,
    observedTransitions,
    requiredTransitions,
  );
}
