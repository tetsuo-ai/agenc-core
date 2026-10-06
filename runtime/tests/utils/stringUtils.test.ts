import { describe, expect, it } from "vitest";

import { compareCodeUnits, nonEmptyString } from "../../src/utils/stringUtils.js";

describe("string utilities", () => {
  it("returns original strings that contain non-whitespace content", () => {
    const value = "  keep spacing  ";

    expect(nonEmptyString(value)).toBe(value);
    expect(nonEmptyString("value")).toBe("value");
  });

  it("rejects whitespace-only strings and non-strings", () => {
    expect(nonEmptyString("")).toBeUndefined();
    expect(nonEmptyString(" \t\n")).toBeUndefined();
    expect(nonEmptyString(1)).toBeUndefined();
    expect(nonEmptyString(null)).toBeUndefined();
    expect(nonEmptyString({ value: "x" })).toBeUndefined();
  });
});

describe("compareCodeUnits", () => {
  it("matches the default Array.sort contract, including equality and prefixes", () => {
    expect(compareCodeUnits("same", "same")).toBe(0);
    expect(compareCodeUnits("", "")).toBe(0);
    expect(compareCodeUnits("", "a")).toBe(-1);
    expect(compareCodeUnits("a", "")).toBe(1);
    expect(compareCodeUnits("aa", "a")).toBe(1);
    expect(compareCodeUnits("A", "a")).toBe(-1);

    const values = ["ä", "z", "A", "a", "11", "2", "", "aa", "a"];
    expect([...values].sort(compareCodeUnits)).toEqual([...values].sort());
  });

  it("does not follow localeCompare, which would make cache keys machine-dependent", () => {
    // U+00E4 sorts after "z" by UTF-16 code unit. German collation treats ä as a.
    expect(compareCodeUnits("z", "ä")).toBe(-1);
    expect("z".localeCompare("ä", "de")).toBeGreaterThan(0);
    expect(["a", "ä", "z"].sort(compareCodeUnits)).toEqual(["a", "z", "ä"]);
    expect(["a", "ä", "z"].sort((left, right) => left.localeCompare(right, "de")))
      .toEqual(["a", "ä", "z"]);
  });
});
