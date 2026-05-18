/**
 * Tests for the system-prompt section registry (cache-separation pattern).
 *
 * Covers:
 *   - memoization across resolves
 *   - volatile DANGEROUS_uncached sections recompute every call
 *   - `clearSystemPromptSections()` empties the cache
 *   - `null` compute results are cached as "absent"
 */

import { afterEach, describe, expect, test } from "vitest";

import {
  DANGEROUS_uncachedSystemPromptSection,
  __peekSystemPromptSection,
  __systemPromptSectionCacheSize,
  clearSystemPromptSections,
  resolveSystemPromptSections,
  systemPromptSection,
} from "./sections.js";

describe("systemPromptSection cache", () => {
  afterEach(() => clearSystemPromptSections());

  test("memoizes cached sections across resolves", async () => {
    let callCount = 0;
    const s = systemPromptSection("cached", () => {
      callCount += 1;
      return `value-${callCount}`;
    });

    const first = await resolveSystemPromptSections([s]);
    const second = await resolveSystemPromptSections([s]);

    expect(first).toEqual(["value-1"]);
    expect(second).toEqual(["value-1"]);
    expect(callCount).toBe(1);
  });

  test("clearSystemPromptSections empties the cache", async () => {
    let callCount = 0;
    const s = systemPromptSection("clearable", () => {
      callCount += 1;
      return `value-${callCount}`;
    });

    await resolveSystemPromptSections([s]);
    expect(__systemPromptSectionCacheSize()).toBe(1);

    clearSystemPromptSections();
    expect(__systemPromptSectionCacheSize()).toBe(0);

    await resolveSystemPromptSections([s]);
    expect(callCount).toBe(2);
  });

  test("DANGEROUS_uncachedSystemPromptSection recomputes every call", async () => {
    let callCount = 0;
    const s = DANGEROUS_uncachedSystemPromptSection(
      "volatile",
      () => {
        callCount += 1;
        return `value-${callCount}`;
      },
      "test: volatile changes between turns",
    );

    const first = await resolveSystemPromptSections([s]);
    const second = await resolveSystemPromptSections([s]);
    const third = await resolveSystemPromptSections([s]);

    expect(first).toEqual(["value-1"]);
    expect(second).toEqual(["value-2"]);
    expect(third).toEqual(["value-3"]);
    expect(callCount).toBe(3);
  });

  test("null compute results are cached", async () => {
    let callCount = 0;
    const s = systemPromptSection("absent", () => {
      callCount += 1;
      return null;
    });

    const first = await resolveSystemPromptSections([s]);
    const second = await resolveSystemPromptSections([s]);

    expect(first).toEqual([null]);
    expect(second).toEqual([null]);
    expect(callCount).toBe(1);
    expect(__peekSystemPromptSection("absent")).toBeNull();
  });

  test("async compute functions are supported", async () => {
    const s = systemPromptSection(
      "async",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return "async-value";
      },
    );

    const result = await resolveSystemPromptSections([s]);
    expect(result).toEqual(["async-value"]);
  });

  test("mixed cached + volatile sections resolve independently", async () => {
    let cachedCalls = 0;
    let volatileCalls = 0;
    const cached = systemPromptSection("mixed_cached", () => {
      cachedCalls += 1;
      return `cached-${cachedCalls}`;
    });
    const volatile = DANGEROUS_uncachedSystemPromptSection(
      "mixed_volatile",
      () => {
        volatileCalls += 1;
        return `volatile-${volatileCalls}`;
      },
      "test",
    );

    await resolveSystemPromptSections([cached, volatile]);
    await resolveSystemPromptSections([cached, volatile]);

    expect(cachedCalls).toBe(1);
    expect(volatileCalls).toBe(2);
  });
});
