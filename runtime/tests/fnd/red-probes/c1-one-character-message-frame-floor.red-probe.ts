import type { RedProbeAssertion } from "../../helpers/red-probe.js";

import { roughTokenCountEstimationForMessages } from "../../../src/llm/token-estimation.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "c1-one-character-message-frame-floor",
    task: "C1",
    fingerprint: "C1:TOKEN-ACCOUNTING:ONE-CHARACTER-FRAME-FLOOR",
  });
  const messageCount = 100;
  const messages = Object.freeze(
    Array.from({ length: messageCount }, () =>
      Object.freeze({ role: "user", content: "x" }),
    ),
  );
  const observedCount = roughTokenCountEstimationForMessages(messages);

  expectDeepStrictEqualRedProbe(
    probeIdentity,
    observedCount >= messages.length,
    true,
  );
}
