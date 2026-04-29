import { describe, expect, test } from "vitest";

import { compareSemver } from "./auto-updater.js";

describe("auto-updater utilities", () => {
  test("compares simple semver triples", () => {
    expect(compareSemver("1.2.3", "1.2.2")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.3.0")).toBe(-1);
  });
});
