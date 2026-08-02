import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { parseProviderRetryAfterDirective } from "../../src/llm/retry-after.js";

interface RetryAfterFixtureCase {
  readonly name: string;
  readonly header: string | null;
  readonly classification: "absent" | "invalid" | "valid" | "over_policy";
  readonly floorMs?: number;
  readonly invalidReason?: "negative" | "non_finite" | "overflow" | "syntax";
  readonly nowMs?: number;
}

interface RetryAfterFixture {
  readonly version: 1;
  readonly nowMs: number;
  readonly cases: readonly RetryAfterFixtureCase[];
}

const TEST_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    join(
      TEST_DIRECTORY,
      "..",
      "recovery",
      "fixtures",
      "retry-after-v1.json",
    ),
    "utf8",
  ),
) as RetryAfterFixture;

describe("parseProviderRetryAfterDirective", () => {
  test("keeps the fixture schema version explicit", () => {
    expect(fixture.version).toBe(1);
  });

  test.each(fixture.cases)("classifies $name", (entry) => {
    const headers = new Headers();
    if (entry.header !== null) headers.set("retry-after", entry.header);
    const actual = parseProviderRetryAfterDirective(
      headers,
      entry.nowMs ?? fixture.nowMs,
    );
    expect(Object.isFrozen(actual)).toBe(true);
    expect(actual).toEqual({
      classification: entry.classification,
      ...(entry.floorMs !== undefined ? { floorMs: entry.floorMs } : {}),
      ...(entry.invalidReason !== undefined
        ? { invalidReason: entry.invalidReason }
        : {}),
    });
  });

  test("treats obsolete asctime dates as UTC independent of host timezone", () => {
    const priorTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/Edmonton";
      const headers = new Headers({
        "retry-after": "Tue Apr 21 12:00:05 2026",
      });
      expect(
        parseProviderRetryAfterDirective(headers, fixture.nowMs),
      ).toEqual({ classification: "valid", floorMs: 5_000 });
    } finally {
      if (priorTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = priorTimezone;
      }
    }
  });
});
