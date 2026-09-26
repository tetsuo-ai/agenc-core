import { describe, expect, it } from "vitest";

import {
  MAX_CHECKPOINT_FALLBACK_TEXT_BYTES,
  validatePendingAdmissionFallbackSlice,
} from "../../src/session/turn-checkpoint-slice.js";

const valid = {
  fromModel: "grok-4.5",
  toModel: "gemini-3.1-pro",
  reason: "provider_fallback_ladder",
};

describe("validatePendingAdmissionFallbackSlice", () => {
  it("clones a valid envelope and keeps optional providers omitted", () => {
    const result = validatePendingAdmissionFallbackSlice(valid);
    expect(result).toEqual({ ok: true, value: valid });
    if (result.ok) expect(result.value).not.toBe(valid);
  });

  it("keeps optional provider fields when they are non-empty", () => {
    expect(
      validatePendingAdmissionFallbackSlice({
        ...valid,
        fromProvider: "grok",
        toProvider: "gemini",
      }),
    ).toEqual({
      ok: true,
      value: {
        ...valid,
        fromProvider: "grok",
        toProvider: "gemini",
      },
    });
  });

  it("refuses a value that is not a plain object", () => {
    for (const value of [null, undefined, [], "x", 1, true]) {
      expect(validatePendingAdmissionFallbackSlice(value).ok, String(value)).toBe(
        false,
      );
    }
    expect(validatePendingAdmissionFallbackSlice(null).reason).toBe(
      "pendingAdmissionFallback must be an object",
    );
  });

  it("refuses empty, whitespace, or oversized required fields", () => {
    expect(
      validatePendingAdmissionFallbackSlice({ ...valid, fromModel: "  " }),
    ).toEqual({
      ok: false,
      reason: "pendingAdmissionFallback.fromModel must be a non-empty string",
    });
    expect(
      validatePendingAdmissionFallbackSlice({ ...valid, toModel: "" }),
    ).toMatchObject({ ok: false });
    const oversized = "é".repeat(MAX_CHECKPOINT_FALLBACK_TEXT_BYTES / 2 + 1);
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(
      MAX_CHECKPOINT_FALLBACK_TEXT_BYTES,
    );
    expect(
      validatePendingAdmissionFallbackSlice({ ...valid, reason: oversized }),
    ).toEqual({
      ok: false,
      reason: `pendingAdmissionFallback.reason exceeds ${MAX_CHECKPOINT_FALLBACK_TEXT_BYTES} UTF-8 bytes`,
    });
  });

  it("refuses unversioned keys unless the recovery journal asks to allow them", () => {
    const extra = { ...valid, extra: true };
    expect(validatePendingAdmissionFallbackSlice(extra)).toEqual({
      ok: false,
      reason: "pendingAdmissionFallback contains unversioned fields",
    });
    expect(
      validatePendingAdmissionFallbackSlice(extra, "pendingAdmissionFallback", {
        allowUnknownFields: true,
      }),
    ).toEqual({ ok: true, value: valid });
    expect(
      validatePendingAdmissionFallbackSlice(
        { ...extra, fromModel: "" },
        "pendingAdmissionFallback",
        { allowUnknownFields: true },
      ).ok,
    ).toBe(false);
  });

  it("names the field the caller asked about", () => {
    expect(validatePendingAdmissionFallbackSlice(null, "slice").reason).toBe(
      "slice must be an object",
    );
  });
});
