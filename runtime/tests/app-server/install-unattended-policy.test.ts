import { describe, expect, test } from "vitest";

import { installUnattendedPermissionPolicy } from "../../src/app-server/background-agent-runner/runtime-settings.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";

function registry(
  mode: "default" | "plan" | "acceptEdits" | "bypassPermissions" = "default",
): PermissionModeRegistry {
  return new PermissionModeRegistry(createEmptyToolPermissionContext({ mode }));
}

describe("installUnattendedPermissionPolicy", () => {
  test("leaves a run that declares no allowlist or denylist on its created mode", async () => {
    const empty = registry();
    await installUnattendedPermissionPolicy(empty, undefined, undefined);
    expect(empty.current().mode).toBe("default");
    expect(empty.current().unattendedPolicy).toBeUndefined();

    await installUnattendedPermissionPolicy(empty, [], []);
    expect(empty.current().mode).toBe("default");
    expect(empty.current().unattendedPolicy).toBeUndefined();

    await installUnattendedPermissionPolicy(empty, ["", "  "], undefined);
    expect(empty.current().mode).toBe("default");
    expect(empty.current().unattendedPolicy).toBeUndefined();
  });

  // The routine read-only grant is covered with the current `routine` argument
  // in routine-run-policy.test.ts.
  test("installs a declared allowlist or denylist", async () => {
    const allow = registry();
    await installUnattendedPermissionPolicy(allow, ["FileRead"], undefined);
    expect(allow.current().mode).toBe("unattended");
    expect(allow.current().unattendedPolicy).toEqual({
      allowlist: ["FileRead"],
      denylist: [],
      readOnly: false,
    });

    const deny = registry();
    await installUnattendedPermissionPolicy(deny, undefined, ["system.bash"]);
    expect(deny.current().mode).toBe("unattended");
    expect(deny.current().unattendedPolicy?.denylist).toEqual(["system.bash"]);
  });

  test("still records policy without rewriting an explicit user mode", async () => {
    const plan = registry("plan");
    await installUnattendedPermissionPolicy(plan, ["FileRead"], undefined);
    expect(plan.current().mode).toBe("plan");
    expect(plan.current().unattendedPolicy?.allowlist).toEqual(["FileRead"]);
  });

  test("rejects a removed tool spelling before changing the registry", async () => {
    const untouched = registry();
    await expect(
      installUnattendedPermissionPolicy(untouched, ["Read"], undefined),
    ).rejects.toThrow("removed unattended tool name 'Read'");
    expect(untouched.current().mode).toBe("default");
    expect(untouched.current().unattendedPolicy).toBeUndefined();
  });
});
