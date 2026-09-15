import { describe, expect, test } from "vitest";

import {
  attachReadOnlyDelegationReadGuard,
  hasReadOnlyDelegationReadGuard,
  readOnlyDelegationReadAuthorityCurrent,
  readOnlyDelegationReadPathAllowed,
} from "../../src/permissions/readonly-read-guard.js";

describe("read-only delegation read guard", () => {
  test("unguarded args stay open; a denied check is not recorded", () => {
    const open = { file_path: "/workspace/public.ts" };
    expect(hasReadOnlyDelegationReadGuard(open)).toBe(false);
    expect(readOnlyDelegationReadPathAllowed(open, "/workspace/secret.ts")).toBe(true);
    expect(readOnlyDelegationReadAuthorityCurrent(open)).toBe(true);

    const guarded = { file_path: "/workspace/public.ts" };
    const allowed = new Set(["/workspace/public.ts"]);
    attachReadOnlyDelegationReadGuard(guarded, (path) => allowed.has(path));
    expect(hasReadOnlyDelegationReadGuard(guarded)).toBe(true);
    expect(readOnlyDelegationReadPathAllowed(guarded, "/workspace/secret.ts")).toBe(false);
    expect(readOnlyDelegationReadAuthorityCurrent(guarded)).toBe(true);
  });

  test("authority fails closed after a recorded path is later denied", () => {
    const args = { file_path: "/workspace/public.ts" };
    const allowed = new Set(["/workspace/public.ts"]);
    attachReadOnlyDelegationReadGuard(args, (path) => allowed.has(path));
    expect(readOnlyDelegationReadPathAllowed(args, "/workspace/public.ts")).toBe(true);
    expect(readOnlyDelegationReadAuthorityCurrent(args)).toBe(true);
    allowed.delete("/workspace/public.ts");
    expect(readOnlyDelegationReadAuthorityCurrent(args)).toBe(false);
    expect(readOnlyDelegationReadPathAllowed(args, "/workspace/public.ts")).toBe(false);
  });
});
