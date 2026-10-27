import { expect, it } from "vitest";
import { computeCheckpointPrefixHashV2, computeCheckpointPrefixHashV3, computeCheckpointPrefixHashV4 } from "../../src/session/durable-checkpoint-reader.js";
import type { ToolResultIntegrityResponseItem } from "../../src/session/rollout-item.js";

it("authenticates failed-tool metadata in the current checkpoint without changing old hashes", () => {
  const item: ToolResultIntegrityResponseItem = { role: "tool", content: "exit 7", toolCallId: "failed", toolName: "Bash" };
  const failed = { ...item, toolResultIsError: true as const };
  expect(computeCheckpointPrefixHashV4([failed], 1)).not.toBe(computeCheckpointPrefixHashV4([item], 1));
  // Existing v3 digests never included this late-added display flag.
  expect(computeCheckpointPrefixHashV3([failed], 1)).toBe(computeCheckpointPrefixHashV3([item], 1));
  expect(computeCheckpointPrefixHashV3([{ role: "user", content: "checkpoint hash golden" }], 1)).toBe("37c0b125f72b30638ca2119c8fa2b27b22cb7aa228356e0ccb9581f6b99aa863");
  expect(() => computeCheckpointPrefixHashV2([failed], 1)).toThrow(/requires checkpoint v4/);
});

it("refuses misplaced, malformed and unknown failed-tool fields", () => {
  for (const item of [
    { role: "user", content: "bad", toolResultIsError: true },
    { role: "tool", content: "bad", toolResultIsError: false },
    { role: "tool", content: "bad", toolResultIsError: "true" },
    { role: "tool", content: "bad", unexpectedStatus: true },
  ]) {
    expect(() => computeCheckpointPrefixHashV4([item as ToolResultIntegrityResponseItem], 1)).toThrow();
  }
});
