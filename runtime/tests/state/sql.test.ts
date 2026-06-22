import { describe, expect, it } from "vitest";
import { sqlPlaceholders } from "./sql.js";

describe("sqlPlaceholders", () => {
  it("formats comma-separated SQLite bind placeholders", () => {
    expect(sqlPlaceholders(1)).toBe("?");
    expect(sqlPlaceholders(3)).toBe("?, ?, ?");
  });

  it("rejects counts that would produce invalid dynamic SQL", () => {
    expect(() => sqlPlaceholders(0)).toThrow(
      "SQL placeholder count must be a positive integer",
    );
    expect(() => sqlPlaceholders(-1)).toThrow(
      "SQL placeholder count must be a positive integer",
    );
    expect(() => sqlPlaceholders(1.5)).toThrow(
      "SQL placeholder count must be a positive integer",
    );
  });
});
