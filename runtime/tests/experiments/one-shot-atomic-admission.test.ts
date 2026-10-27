import { describe, expect, test } from "vitest";

import { requiresAtomicSpendAdmission } from "../../src/one-shot-fast-mode.js";
import type { Session } from "../../src/session/session.js";

function sessionWithScope(
  scope: {
    readonly hasHardCostCap?: boolean;
    readonly hasHardTokenCap?: boolean;
    readonly maxCostUsd?: number;
    readonly maxTokens?: number;
  } | undefined,
): Session {
  return {
    services: {
      ...(scope === undefined
        ? {}
        : { executionAdmission: { scope } }),
    },
  } as Session;
}

describe("requiresAtomicSpendAdmission", () => {
  test("is false when the session has no hard spend or token bound", () => {
    expect(requiresAtomicSpendAdmission(sessionWithScope(undefined))).toBe(false);
    expect(requiresAtomicSpendAdmission(sessionWithScope({}))).toBe(false);
    expect(
      requiresAtomicSpendAdmission(
        sessionWithScope({ hasHardCostCap: false, hasHardTokenCap: false }),
      ),
    ).toBe(false);
  });

  test("is true for any hard cap or explicit numeric bound, including zero", () => {
    expect(
      requiresAtomicSpendAdmission(sessionWithScope({ hasHardCostCap: true })),
    ).toBe(true);
    expect(
      requiresAtomicSpendAdmission(sessionWithScope({ hasHardTokenCap: true })),
    ).toBe(true);
    expect(requiresAtomicSpendAdmission(sessionWithScope({ maxCostUsd: 0 }))).toBe(
      true,
    );
    expect(requiresAtomicSpendAdmission(sessionWithScope({ maxTokens: 0 }))).toBe(
      true,
    );
  });
});
