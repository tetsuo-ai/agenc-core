import { expect, it } from "vitest";
import { normalizeHistoryMessages } from "../../src/session/session.js";
import { llmMessageToCheckpointResponseItem } from "../../src/session/message-history-conversion.js";
import { computeCheckpointPrefixHashV4 } from "../../src/session/durable-checkpoint-reader.js";

it("preserves failed-tool checkpoint hashes across the next human turn", () => {
  const failed = { role: "tool" as const, content: "exit 7", toolCallId: "failed", toolResultIsError: true as const };
  const live = { role: "tool" as const, content: "exit 7", toolCallId: "failed", runtimeOnly: { toolResultIsError: true as const } };
  for (const source of [failed, live]) {
    const restored = normalizeHistoryMessages([source]);
    expect(restored[0]?.runtimeOnly?.toolResultIsError).toBe(true);
    const projected = restored.map(llmMessageToCheckpointResponseItem);
    expect(computeCheckpointPrefixHashV4(projected, 1)).toBe(computeCheckpointPrefixHashV4([failed], 1));
  }
});

it("keeps successful tools and user prompts free of failure metadata", () => {
  for (const source of [
    { role: "tool", content: "OK" },
    { role: "user", content: "true", toolResultIsError: true },
  ]) expect(normalizeHistoryMessages([source])[0]?.runtimeOnly?.toolResultIsError).toBeUndefined();
});
