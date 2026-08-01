import type { RedProbeAssertion } from "../../helpers/red-probe.js";

import { getCompactPrompt } from "../../../src/services/compact/prompt.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "c2-compaction-transcript-instruction-trust",
    task: "C2",
    fingerprint: "C2:COMPACTION:TRANSCRIPT-INSTRUCTION-TRUST",
  });
  const unsafeInstructionMarker =
    "There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions";
  const promptTrustsTranscriptInstructions = getCompactPrompt().includes(
    unsafeInstructionMarker,
  );

  expectDeepStrictEqualRedProbe(
    probeIdentity,
    promptTrustsTranscriptInstructions,
    false,
  );
}
