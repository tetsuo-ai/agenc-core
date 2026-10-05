import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ loads: vi.fn() }));
vi.mock("../../../src/services/compact/compact.js", () => {
  state.loads();
  throw new Error("compaction implementation unavailable");
});

import { autoCompactIfNeeded, getAutoCompactThreshold } from "../../../src/services/compact/autoCompact.js";

it("keeps threshold lookup and skipped compaction independent of the implementation", async () => {
  expect(state.loads).not.toHaveBeenCalled();
  expect(getAutoCompactThreshold({ options: { contextWindowTokens: 20_000 } })).toBe(7_000);
  await expect(autoCompactIfNeeded([], {}, undefined, "compact"))
    .resolves.toEqual({ wasCompacted: false });
  await expect(autoCompactIfNeeded([{ role: "user", content: "hello" }], {
    options: { contextWindowTokens: 200_000 },
  })).resolves.toEqual({ wasCompacted: false, consecutiveFailures: 0 });
  expect(state.loads).not.toHaveBeenCalled();
});

it("propagates an implementation-load failure instead of recording an advisory compact failure", async () => {
  await expect(autoCompactIfNeeded([], {}, undefined, undefined, undefined, 0, { force: true }))
    .rejects.toThrow();
  expect(state.loads).toHaveBeenCalledOnce();
});
