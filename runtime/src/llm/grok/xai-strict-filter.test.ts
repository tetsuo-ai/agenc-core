import { describe, expect, test } from "vitest";
import {
  detectDocumentedXaiModelAlias,
  validateXaiRequestPreFlight,
  type XaiModelDeprecationNotice,
} from "./xai-strict-filter.js";

describe("detectDocumentedXaiModelAlias", () => {
  test("returns null for a canonical catalog ID", () => {
    expect(detectDocumentedXaiModelAlias("grok-4.20-0309-reasoning")).toBeNull();
  });

  test("returns null for an unknown model (pre-flight will throw separately)", () => {
    expect(detectDocumentedXaiModelAlias("definitely-not-real")).toBeNull();
  });

  test("resolves a bare alias to the canonical release", () => {
    const notice = detectDocumentedXaiModelAlias("grok-4.20-reasoning");
    expect(notice).not.toBeNull();
    expect(notice!.subject).toBe("grok-4.20-reasoning");
    expect(notice!.replacement).toBe("grok-4.20-0309-reasoning");
  });

  test("resolves the legacy fast alias used by older AgenC defaults", () => {
    const notice = detectDocumentedXaiModelAlias("grok-4-fast");
    expect(notice).not.toBeNull();
    expect(notice!.subject).toBe("grok-4-fast");
    expect(notice!.replacement).toBe("grok-4-1-fast-non-reasoning");
  });

  test("legacy -beta- alias carries deprecated_since", () => {
    const notice = detectDocumentedXaiModelAlias(
      "grok-4.20-beta-0309-reasoning",
    );
    expect(notice).not.toBeNull();
    expect(notice!.subject).toBe("grok-4.20-beta-0309-reasoning");
    expect(notice!.replacement).toBe("grok-4.20-0309-reasoning");
    expect(notice!.deprecated_since).toBe("2026-04");
  });
});

describe("validateXaiRequestPreFlight — deprecation notice side-channel", () => {
  test("fires onDeprecationNotice when the configured model is an alias", () => {
    const emitted: XaiModelDeprecationNotice[] = [];
    validateXaiRequestPreFlight(
      { model: "grok-4.20-beta-0309-reasoning" },
      { onDeprecationNotice: (notice) => emitted.push(notice) },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.subject).toBe("grok-4.20-beta-0309-reasoning");
    expect(emitted[0]!.replacement).toBe("grok-4.20-0309-reasoning");
    expect(emitted[0]!.deprecated_since).toBe("2026-04");
  });

  test("accepts the legacy fast alias and emits the canonical replacement", () => {
    const emitted: XaiModelDeprecationNotice[] = [];
    expect(() =>
      validateXaiRequestPreFlight(
        { model: "grok-4-fast" },
        { onDeprecationNotice: (notice) => emitted.push(notice) },
      ),
    ).not.toThrow();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.subject).toBe("grok-4-fast");
    expect(emitted[0]!.replacement).toBe("grok-4-1-fast-non-reasoning");
  });

  test("does NOT fire for a canonical model", () => {
    const emitted: XaiModelDeprecationNotice[] = [];
    validateXaiRequestPreFlight(
      { model: "grok-4.20-0309-reasoning" },
      { onDeprecationNotice: (notice) => emitted.push(notice) },
    );
    expect(emitted).toHaveLength(0);
  });

  test("works without the side-channel (existing callers unaffected)", () => {
    // No options object — the pre-flight should still pass for a
    // canonical model, mirroring the original call signature.
    expect(() =>
      validateXaiRequestPreFlight({ model: "grok-4.20-0309-reasoning" }),
    ).not.toThrow();
  });
});
