import type { RedProbeAssertion } from "../../helpers/red-probe.js";

import { computePrefixHash } from "../../../src/session/durable-turns.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "a3-tool-result-body-digest",
    task: "A3",
    fingerprint: "A3:DURABLE-TURN:TOOL-RESULT-BODY-DIGEST",
  });
  const originalPrefix = Object.freeze([
    Object.freeze({
      role: "assistant",
      content: "",
      toolCalls: Object.freeze([
        Object.freeze({ id: "call-a3", name: "probe" }),
      ]),
    }),
    Object.freeze({
      role: "tool",
      content: "alpha",
      toolCallId: "call-a3",
      toolName: "probe",
    }),
  ]);
  const substitutedPrefix = Object.freeze([
    originalPrefix[0]!,
    Object.freeze({
      role: "tool",
      content: "omega",
      toolCallId: "call-a3",
      toolName: "probe",
    }),
  ]);
  const digestChanged =
    computePrefixHash(originalPrefix, originalPrefix.length) !==
    computePrefixHash(substitutedPrefix, substitutedPrefix.length);

  expectDeepStrictEqualRedProbe(probeIdentity, digestChanged, true);
}
