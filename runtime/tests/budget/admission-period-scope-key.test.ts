import { describe, expect, it } from "vitest";

import { admissionPeriodScopeKey } from "../../src/budget/admission-types.js";

describe("admissionPeriodScopeKey", () => {
  it("encodes the budget identity so colon and slash owners cannot collide", () => {
    expect(admissionPeriodScopeKey("alice", "day", "2026-10-11"))
      .toBe("period:agent:alice:day:2026-10-11");
    expect(admissionPeriodScopeKey("alice:day", "day", "2026-10-11"))
      .toBe("period:agent:alice%3Aday:day:2026-10-11");
    expect(admissionPeriodScopeKey("alice/team", "month", "2026-10"))
      .toBe("period:agent:alice%2Fteam:month:2026-10");
  });

  it("keeps percent-encoded identities distinct from their decoded lookalikes", () => {
    const encodedOwner = admissionPeriodScopeKey("alice%3Aday", "day", "2026-10-11");
    const colonOwner = admissionPeriodScopeKey("alice:day", "day", "2026-10-11");
    expect(encodedOwner).toBe("period:agent:alice%253Aday:day:2026-10-11");
    expect(encodedOwner).not.toBe(colonOwner);
    expect(new Set([
      admissionPeriodScopeKey("a:b", "day", "2026-10-11"),
      admissionPeriodScopeKey("a", "day", "b:2026-10-11"),
      admissionPeriodScopeKey("a:b:day", "day", "2026-10-11"),
    ]).size).toBe(3);
  });
});
