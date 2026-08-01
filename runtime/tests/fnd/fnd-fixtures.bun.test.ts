import { describe, expect, test } from "bun:test";

import { openFndFixtureCatalog } from "../helpers/fnd-fixtures.js";

const AUDITED_SHA = "d2b228e87ea63bd6a5d93e6f599f36bce88d672b";
const EXPECTED_FIXTURE_COUNT = 48;
const EXPECTED_FIRST_FIXTURE = "admission.legacy-v14-state-v16.v1";
const EXPECTED_LAST_FIXTURE = "patch.no-final-newline.source.v1";

describe("FND runtime-neutral fixture catalog", () => {
  test("loads the complete cached and digest-verified catalog", async () => {
    const catalog = await openFndFixtureCatalog();
    const entries = catalog.entries;
    const firstEntry = catalog.get(EXPECTED_FIRST_FIXTURE);

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(catalog.entries).toHaveLength(EXPECTED_FIXTURE_COUNT);
    expect(catalog.entries[0]?.id).toBe(EXPECTED_FIRST_FIXTURE);
    expect(catalog.entries.at(-1)?.id).toBe(EXPECTED_LAST_FIXTURE);
    expect(() => {
      (catalog as unknown as { auditSha: string }).auditSha = "0".repeat(40);
    }).toThrow(TypeError);
    expect(() => {
      (catalog as unknown as { entries: typeof entries }).entries = [];
    }).toThrow(TypeError);
    expect(catalog.auditSha).toBe(AUDITED_SHA);
    expect(catalog.entries).toBe(entries);
    expect(catalog.get(EXPECTED_FIRST_FIXTURE)).toBe(firstEntry);
    expect(
      (await catalog.bytes("journal.interrupted-tail.v1")).byteLength,
    ).toBe(catalog.get("journal.interrupted-tail.v1").byteLength);
  });

  test("returns independent cached fixture buffers", async () => {
    const catalog = await openFndFixtureCatalog();
    const first = await catalog.bytes("patch.lf.source.v1");
    const expected = Buffer.from(first);
    first.fill(0xff);
    expect(await catalog.bytes("patch.lf.source.v1")).toEqual(expected);
  });
});
