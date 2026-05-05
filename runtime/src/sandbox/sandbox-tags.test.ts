import { describe, expect, test } from "vitest";

import {
  externalFileSystemPolicy,
  getPlatformSandbox,
  permissionProfileFromRuntimePermissions,
  restrictedFileSystemPolicy,
  sandboxTypeMetricTag,
  unrestrictedFileSystemPolicy,
} from "./engine/index.js";
import {
  permissionProfilePolicyTag,
  permissionProfileSandboxTag,
  sandboxTag,
} from "./sandbox-tags.js";
import {
  NETWORK_ENABLED,
  newDangerFullAccessPolicy,
  newExternalSandboxPolicy,
  newReadOnlyPolicy,
} from "../permissions/sandbox.js";

describe("sandbox tags", () => {
  test("danger-full-access is untagged even when a platform sandbox exists", () => {
    expect(
      sandboxTag(newDangerFullAccessPolicy(), "disabled", { platform: "linux" }),
    ).toBe("none");
  });

  test("external sandbox keeps an external tag", () => {
    expect(
      sandboxTag(newExternalSandboxPolicy(NETWORK_ENABLED), "disabled", {
        platform: "linux",
      }),
    ).toBe("external");
    expect(
      permissionProfileSandboxTag(
        permissionProfileFromRuntimePermissions(
          externalFileSystemPolicy(),
          "restricted",
        ),
        "disabled",
        false,
        { platform: "linux" },
      ),
    ).toBe("external");
  });

  test("read-only policy uses the selected platform sandbox tag", () => {
    const expected = getPlatformSandbox({
      platform: "linux",
      windowsSandboxEnabled: false,
    });

    expect(
      sandboxTag(newReadOnlyPolicy(), "disabled", { platform: "linux" }),
    ).toBe(expected === null ? "none" : sandboxTypeMetricTag(expected));
  });

  test("unrestricted managed profiles are only tagged when managed network is enforced", () => {
    const profile = permissionProfileFromRuntimePermissions(
      unrestrictedFileSystemPolicy(),
      "enabled",
      "managed",
    );
    const expected = getPlatformSandbox({
      platform: "linux",
      windowsSandboxEnabled: false,
    });

    expect(
      permissionProfileSandboxTag(profile, "disabled", false, {
        platform: "linux",
      }),
    ).toBe("none");
    expect(
      permissionProfileSandboxTag(profile, "disabled", true, {
        platform: "linux",
      }),
    ).toBe(expected === null ? "none" : sandboxTypeMetricTag(expected));
  });

  test("windows elevated level has a distinct metric tag", () => {
    const profile = permissionProfileFromRuntimePermissions(
      restrictedFileSystemPolicy([
        { path: { kind: "special", value: { kind: "root" } }, access: "read" },
      ]),
      "disabled",
      "managed",
    );

    expect(
      permissionProfileSandboxTag(profile, "elevated", false, {
        platform: "win32",
      }),
    ).toBe("windows_elevated");
    expect(
      permissionProfileSandboxTag(profile, "restricted_token", false, {
        platform: "win32",
      }),
    ).toBe("windows_sandbox");
  });

  test("policy tags report the closest legacy sandbox mode", () => {
    expect(
      permissionProfilePolicyTag(
        permissionProfileFromRuntimePermissions(
          unrestrictedFileSystemPolicy(),
          "enabled",
        ),
        "/workspace",
      ),
    ).toBe("danger-full-access");
    expect(
      permissionProfilePolicyTag(
        permissionProfileFromRuntimePermissions(
          externalFileSystemPolicy(),
          "restricted",
        ),
        "/workspace",
      ),
    ).toBe("external-sandbox");
    expect(
      permissionProfilePolicyTag(
        permissionProfileFromRuntimePermissions(
          restrictedFileSystemPolicy([
            { path: { kind: "special", value: { kind: "root" } }, access: "read" },
          ]),
          "disabled",
          "managed",
        ),
        "/workspace",
      ),
    ).toBe("read-only");
    expect(
      permissionProfilePolicyTag(
        permissionProfileFromRuntimePermissions(
          restrictedFileSystemPolicy([
            {
              path: { kind: "special", value: { kind: "project_roots" } },
              access: "write",
            },
          ]),
          "restricted",
          "managed",
        ),
        "/workspace",
      ),
    ).toBe("workspace-write");
  });
});

