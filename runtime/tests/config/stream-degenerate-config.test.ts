import { describe, expect, test } from "vitest";
import { defaultConfig, mergeConfigs, validateAgenCConfigBlocks, type AgenCConfig } from "../../src/config/schema.js";

describe("degenerate stream config", () => {
  test("enables the calibrated guard by default and preserves an explicit opt out", () => {
    expect(defaultConfig().stream_degenerate_guard).toBe(true);
    expect(mergeConfigs(defaultConfig(), { stream_degenerate_guard: false }).stream_degenerate_guard).toBe(false);
    expect(() => validateAgenCConfigBlocks({ stream_degenerate_guard: false })).not.toThrow();
  });
  test("rejects strings rather than silently enabling an invalid setting", () => {
    expect(() => validateAgenCConfigBlocks({ stream_degenerate_guard: "false" } as unknown as AgenCConfig)).toThrow(/stream_degenerate_guard/);
  });
});
