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
          permissionId: "unattended:deny:system.bash",
          subject: "system.bash",
          action: "unattended-deny",
          scope: "session",
        },
      ]),
    );
  });

  test("does not show inactive unattended grants outside unattended mode", () => {
    const context = createEmptyToolPermissionContext({
      mode: "default",
      unattendedPolicy: {
        allowlist: ["FileRead"],
        denylist: ["Bash"],
      },
    });

    expect(permissionGrantsFromToolPermissionContext(context)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          permissionId: "unattended:allow:FileRead",
        }),
        expect.objectContaining({
          permissionId: "unattended:deny:Bash",
        }),
      ]),
    );
  });
});
