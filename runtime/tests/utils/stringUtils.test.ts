import { describe, expect, it } from "vitest";

import { nonEmptyString } from "../../src/utils/stringUtils.js";

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
