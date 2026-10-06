import { describe, expect, test, vi } from "vitest";

vi.mock("bun:bundle", () => ({ feature: () => false }));

import {
  ALL_PERMISSION_MODES,
  USER_ADDRESSABLE_PERMISSION_MODES,
} from "../../../src/types/permissions.js";
import { permissionModeFromString } from "../../../src/utils/permissions/PermissionMode.js";

describe("permissionModeFromString", () => {
  test("keeps every user-addressable mode", () => {
    for (const mode of USER_ADDRESSABLE_PERMISSION_MODES) {
      expect(permissionModeFromString(mode)).toBe(mode);
    }
  });

  test("maps internal-only and unknown strings to default", () => {
    expect(permissionModeFromString("unattended")).toBe("default");
    expect(permissionModeFromString("bubble")).toBe("default");
    expect(permissionModeFromString("Plan")).toBe("default");
    expect(permissionModeFromString("bypass-permissions")).toBe("default");
    expect(permissionModeFromString("")).toBe("default");
    expect(permissionModeFromString("not-a-mode")).toBe("default");
  });

  test("does not treat ALL_PERMISSION_MODES extras as addressable", () => {
    const extras = ALL_PERMISSION_MODES.filter(
      (mode) =>
        !(USER_ADDRESSABLE_PERMISSION_MODES as readonly string[]).includes(
          mode,
        ),
    );
    expect(extras).toEqual(["unattended", "bubble"]);
    for (const mode of extras) {
      expect(permissionModeFromString(mode)).toBe("default");
    }
  });
});
