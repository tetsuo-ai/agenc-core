import { describe, expect, test, vi } from "vitest";

vi.mock("../../src/session/session-store.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/session/session-store.js")
  >();
  return {
    ...original,
    resolveCanonicalSessionCwd: () => ({ kind: "identity_unsupported" as const }),
  };
});

import {
  canonicalizeBypassPermissionsCwd,
  loadBypassPermissionsConsent,
  recordBypassPermissionsConsent,
} from "../../src/permissions/bypass-consent-state.js";
import type { RuntimeStateRepository } from "../../src/config/runtime-state-repository.js";

describe("bypass consent on filesystems without stable identity", () => {
  test("fails closed for lookup, load, and persistence without a path-only fallback", () => {
    const repository = {} as RuntimeStateRepository;
    expect(() => canonicalizeBypassPermissionsCwd("/workspace")).toThrow(
      /does not provide stable workspace identity/u,
    );
    expect(() => loadBypassPermissionsConsent(repository, "/workspace"))
      .toThrow(/does not provide stable workspace identity/u);
    expect(() => recordBypassPermissionsConsent(repository, "/workspace"))
      .toThrow(/does not provide stable workspace identity/u);
  });
});
