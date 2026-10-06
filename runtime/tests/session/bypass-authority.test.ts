import { describe, expect, test } from "vitest";

import {
  executionAuthorityForPermissionContext,
  permissionContextUsesBypassAuthority,
  type SessionExecutionAuthority,
} from "../../src/session/configuration.js";

const CONFIGURED: SessionExecutionAuthority = Object.freeze({
  approvalPolicy: Object.freeze({ value: "on_request" as const }),
  sandboxPolicy: Object.freeze({ value: "workspace_write" as const }),
  fileSystemSandboxPolicy: Object.freeze({
    allowWrite: Object.freeze(["/workspace"]),
    denyWrite: Object.freeze([]),
    allowRead: Object.freeze([]),
    denyRead: Object.freeze([]),
  }),
  networkSandboxPolicy: Object.freeze({
    allowlist: Object.freeze([]),
    denylist: Object.freeze([]),
    allowManagedDomainsOnly: false,
  }),
  windowsSandboxLevel: "none",
  sandboxAllowGpu: false,
});

describe("permissionContextUsesBypassAuthority", () => {
  test("is true for live bypass and for plan that stashed bypass", () => {
    expect(
      permissionContextUsesBypassAuthority({ mode: "bypassPermissions" }),
    ).toBe(true);
    expect(
      permissionContextUsesBypassAuthority({
        mode: "plan",
        prePlanMode: "bypassPermissions",
      }),
    ).toBe(true);
  });

  test("is false for plan without a bypass stash and for ordinary modes", () => {
    expect(
      permissionContextUsesBypassAuthority({
        mode: "plan",
        prePlanMode: "acceptEdits",
      }),
    ).toBe(false);
    expect(permissionContextUsesBypassAuthority({ mode: "plan" })).toBe(false);
    expect(permissionContextUsesBypassAuthority({ mode: "default" })).toBe(
      false,
    );
    expect(
      permissionContextUsesBypassAuthority({
        mode: "acceptEdits",
        prePlanMode: "bypassPermissions",
      }),
    ).toBe(false);
  });
});

describe("executionAuthorityForPermissionContext plan+bypass stash", () => {
  test("suppresses approvals while planning after a bypass stash without widening the sandbox", () => {
    const projected = executionAuthorityForPermissionContext(CONFIGURED, {
      mode: "plan",
      prePlanMode: "bypassPermissions",
    });

    expect(projected.approvalPolicy.value).toBe("never");
    expect(projected.sandboxPolicy.value).toBe("workspace_write");
    expect(projected.fileSystemSandboxPolicy.allowWrite).toEqual(["/workspace"]);
  });

  test("keeps on-request approvals when plan stashed a non-bypass mode", () => {
    const projected = executionAuthorityForPermissionContext(CONFIGURED, {
      mode: "plan",
      prePlanMode: "acceptEdits",
    });

    expect(projected.approvalPolicy.value).toBe("on_request");
    expect(projected.sandboxPolicy.value).toBe("workspace_write");
  });
});
