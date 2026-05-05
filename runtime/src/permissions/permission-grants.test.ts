import { describe, expect, test } from "vitest";

import { permissionGrantsFromToolPermissionContext } from "./permission-grants.js";
import { applyUnattendedPermissionPolicyToContext } from "./unattended-policy.js";
import { createEmptyToolPermissionContext } from "./types.js";

describe("permissionGrantsFromToolPermissionContext", () => {
  test("includes unattended policy grants for permission.list visibility", () => {
    const context = applyUnattendedPermissionPolicyToContext(
      createEmptyToolPermissionContext(),
      {
        allowlist: ["FileRead"],
        denylist: ["Bash"],
      },
    );

    expect(permissionGrantsFromToolPermissionContext(context)).toEqual(
      expect.arrayContaining([
        {
          permissionId: "mode:unattended",
          subject: "permission-mode",
          action: "unattended",
          scope: "session",
        },
        {
          permissionId: "unattended:allow:FileRead",
          subject: "FileRead",
          action: "unattended-allow",
          scope: "session",
        },
        {
          permissionId: "unattended:deny:Bash",
          subject: "Bash",
          action: "unattended-deny",
          scope: "session",
        },
      ]),
    );
  });
});
