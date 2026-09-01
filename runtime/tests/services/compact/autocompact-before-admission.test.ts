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

  /*
   * Third kill, measured end to end on grok-4.6 (catalogued 500k, effective
   * 475k after the 95% factor). Admission compares the ACCOUNTING ESTIMATE,
   * which ran 2.118x the provider's reported prompt size across all 306
   * samples of the run: the last admitted reservation was 474,423 against a
   * real 223,988, and the next step was denied. The turn loop's own gate was
   * comparing the provider number against `window - 13_000` = 462,000, a
   * threshold the real conversation could never reach because admission caps
   * it near 224k. Auto-compaction was therefore never called once in 306
   * iterations. The threshold has to sit below the observed denial point on
   * the SAME scale admission uses.
   */
  it("fires before the measured grok-4.6 denial on admission's own scale", () => {
    const EFFECTIVE_WINDOW = 475_000; // 500k catalogued x 95%
    const LAST_ADMITTED_RESERVATION = 474_423;
    const threshold = getAutoCompactThreshold({
      options: { contextWindowTokens: EFFECTIVE_WINDOW },
    } as never);

    expect(threshold).toBeLessThan(LAST_ADMITTED_RESERVATION);
    // It also has to beat the stale in-loop formula that let the run die.
    expect(threshold).toBeLessThan(EFFECTIVE_WINDOW - 13_000);
    // Measured: the run's estimate crossed this 91 iterations before death.
    expect(threshold).toBeLessThanOrEqual(360_000);
  });
});
