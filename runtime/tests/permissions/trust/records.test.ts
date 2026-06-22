import { describe, expect, it } from "vitest";

import { isTrustRecord } from "./records.js";

describe("trust record helpers", () => {
  it("detects non-array object records", () => {
    expect(isTrustRecord({})).toBe(true);
    expect(isTrustRecord(Object.create(null))).toBe(true);
    expect(isTrustRecord(new Date("2026-06-22T00:00:00.000Z"))).toBe(true);
    expect(isTrustRecord([])).toBe(false);
    expect(isTrustRecord(null)).toBe(false);
    expect(isTrustRecord("settings")).toBe(false);
  });
});
