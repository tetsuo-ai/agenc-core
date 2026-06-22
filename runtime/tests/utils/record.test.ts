import { describe, expect, it } from "vitest";

import { asRecord, isRecord } from "../../src/utils/record.js";

describe("record helpers", () => {
  it("accepts non-array objects as records", () => {
    const object = { ok: true };
    const nullPrototype = Object.assign(Object.create(null), { ok: true });

    expect(asRecord(object)).toBe(object);
    expect(isRecord(object)).toBe(true);
    expect(asRecord(nullPrototype)).toBe(nullPrototype);
    expect(isRecord(nullPrototype)).toBe(true);
  });

  it("rejects null, arrays, functions, and primitives", () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord(["x"])).toBeNull();
    expect(asRecord(() => undefined)).toBeNull();
    expect(asRecord("x")).toBeNull();
    expect(asRecord(1)).toBeNull();

    expect(isRecord(null)).toBe(false);
    expect(isRecord(["x"])).toBe(false);
    expect(isRecord(() => undefined)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(1)).toBe(false);
  });
});
