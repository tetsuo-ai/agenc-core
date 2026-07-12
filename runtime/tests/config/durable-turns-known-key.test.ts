import { describe, expect, it } from "vitest";
import { KNOWN_CONFIG_KEYS, defaultConfig } from "../config/schema.js";
import { normalizeRawConfig } from "../config/schema.js";

describe("durableTurns known key (todo-116)", () => {
  it("is a known top-level config key", () => {
    expect(KNOWN_CONFIG_KEYS.includes("durableTurns")).toBe(true);
  });

  it("loads durableTurns from raw config instead of _unknown", () => {
    const normalized = normalizeRawConfig({
      ...defaultConfig(),
      durableTurns: {
        resume: { onRestart: false, policy: "safe" },
      },
    });
    expect(normalized.durableTurns).toBeDefined();
    expect((normalized._unknown as Record<string, unknown> | undefined)?.durableTurns).toBeUndefined();
  });
});
