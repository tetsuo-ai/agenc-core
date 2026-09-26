import { describe, expect, it } from "vitest";

import { normalizeToolRecoveryCategory } from "../../src/state/tool-output-rotation.js";

describe("normalizeToolRecoveryCategory", () => {
  it("keeps the three persisted categories", () => {
    expect(normalizeToolRecoveryCategory("idempotent")).toBe("idempotent");
    expect(normalizeToolRecoveryCategory("side-effecting")).toBe(
      "side-effecting",
    );
    expect(normalizeToolRecoveryCategory("interactive")).toBe("interactive");
  });

  it("fails closed to side-effecting for missing or unknown values", () => {
    expect(normalizeToolRecoveryCategory(undefined)).toBe("side-effecting");
    expect(normalizeToolRecoveryCategory("")).toBe("side-effecting");
    expect(normalizeToolRecoveryCategory("unknown")).toBe("side-effecting");
    expect(normalizeToolRecoveryCategory("read-only")).toBe("side-effecting");
    expect(normalizeToolRecoveryCategory("Idempotent")).toBe("side-effecting");
  });
});
