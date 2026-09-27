import { describe, expect, test } from "vitest";

import { durableRedactionDropsProviderReplay } from "../../src/session/message-history-conversion.js";

/**
 * Persistence and compaction share this predicate. The writer dropping a
 * replay while the projection kept it is what made a redacted DeepSeek
 * replay fail the pin check. Lock the rule at the helper so the two sides
 * cannot drift again.
 */
const SYNTHETIC_SECRET = ["sk-ws-H", "WORK123", "ABCD", "a".repeat(64)].join(".");
/** Writer/projection lowercase provider and model before this predicate. */
const NORMALIZED_SECRET = `sk-proj-${"a".repeat(64)}`;

describe("durableRedactionDropsProviderReplay", () => {
  test("keeps ordinary replay and ignores a missing field", () => {
    expect(durableRedactionDropsProviderReplay(undefined)).toBe(false);
    expect(
      durableRedactionDropsProviderReplay({
        version: 1,
        content: "ordinary replay state",
      }),
    ).toBe(false);
    expect(
      durableRedactionDropsProviderReplay({
        version: 2,
        content: "ordinary replay state",
        provider: "deepseek",
        model: "deepseek-flash",
      }),
    ).toBe(false);
  });

  test("drops a replay whose content or v2 identity redaction would alter", () => {
    expect(
      durableRedactionDropsProviderReplay({
        version: 1,
        content: `provider state ${SYNTHETIC_SECRET}`,
      }),
    ).toBe(true);
    expect(
      durableRedactionDropsProviderReplay({
        version: 2,
        content: "ordinary replay state",
        provider: NORMALIZED_SECRET,
        model: "deepseek-flash",
      }),
    ).toBe(true);
    expect(
      durableRedactionDropsProviderReplay({
        version: 2,
        content: "ordinary replay state",
        provider: "deepseek",
        model: NORMALIZED_SECRET,
      }),
    ).toBe(true);
  });
});
