import { describe, expect, it } from "vitest";

import {
  AUTOCOMPACT_BUFFER_TOKENS,
  getAutoCompactThreshold,
} from "./autoCompact.js";

/**
 * Regression for two sessions killed mid-run on grok-4.5 (catalogued 500k).
 *
 * Admission compares totalTokens — inputTokens already inflated by
 * safetyMarginForTokens() (10% + 256) plus 32k reserved output — against its
 * own window. Measured from consecutive turns in one run: 435,227 admitted,
 * 444,458 denied `context_window_exceeded`, so the real cut sits near 476k.
 * `window - 13_000` would not compact until 487k, i.e. 11k AFTER the run is
 * already dead, which is why compaction_retention_pins stayed at 0 while the
 * session was destroyed twice.
 */
describe("auto-compaction fires before admission denies the turn", () => {
  const OBSERVED_DENIAL_FLOOR = 467_227; // last admitted total, grok-4.5 500k

  it("stays below the observed denial point on a 500k window", () => {
    const threshold = getAutoCompactThreshold("grok-4.5");

    expect(threshold).toBeLessThan(OBSERVED_DENIAL_FLOOR);
    expect(threshold).toBeLessThan(500_000 - AUTOCOMPACT_BUFFER_TOKENS);
    // Third kill, measured: the last ADMITTED turn carried 423,740 tokens and
    // the next message (445,857) was denied. A threshold that admits 423k
    // without compacting leaves exactly one turn of slack — none in practice.
    // Fire before the last observed surviving turn, not between it and death.
    expect(threshold).toBeLessThanOrEqual(400_000);
  });

  it("never exceeds the fixed-buffer threshold it replaces", () => {
    for (const window of [128_000, 200_000, 500_000, 1_000_000]) {
      const threshold = getAutoCompactThreshold({
        options: { contextWindowTokens: window },
      } as never);
      expect(threshold).toBeLessThanOrEqual(window - AUTOCOMPACT_BUFFER_TOKENS);
      expect(threshold).toBeGreaterThan(0);
    }
  });

  it("leaves small windows on the buffer rule, where it is already stricter", () => {
    // 100k * 0.85 = 85_000 vs 100_000 - 13_000 = 87_000 -> fraction wins.
    // 20k  * 0.85 = 17_000 vs  20_000 - 13_000 =  7_000 -> buffer wins.
    expect(
      getAutoCompactThreshold({
        options: { contextWindowTokens: 20_000 },
      } as never),
    ).toBe(7_000);
  });
});
