import { describe, expect, test } from "vitest";

import {
  freezeSessionPermissionMode,
  installUnattendedPermissionPolicy,
} from "../../src/app-server/background-agent-runner/runtime-settings.js";
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

describe("a session tool policy", () => {
  const policy = { enabledTools: ["FileRead"], frozenPermissionMode: true } as const;

  test("records its allowlist on the permission floor without turning the session unattended", async () => {
    const created = registry();
    await installUnattendedPermissionPolicy(created, undefined, undefined, undefined, policy);
    expect(created.current().mode).toBe("default");
    expect(created.current().unattendedPolicy).toEqual({
      allowlist: [],
      denylist: [],
      readOnly: false,
      enabledTools: ["FileRead"],
    });
  });

  test("keeps an explicit user mode too", async () => {
    const bypass = registry("bypassPermissions");
    await installUnattendedPermissionPolicy(bypass, [], [], undefined, policy);
    expect(bypass.current().mode).toBe("bypassPermissions");
    expect(bypass.current().unattendedPolicy?.enabledTools).toEqual(["FileRead"]);
  });

  test("behaves as an unattended policy when the run also declares allow or deny lists", async () => {
    const both = registry();
    await installUnattendedPermissionPolicy(both, ["FileRead"], undefined, undefined, policy);
    expect(both.current().mode).toBe("unattended");
    expect(both.current().unattendedPolicy).toMatchObject({
      allowlist: ["FileRead"],
      enabledTools: ["FileRead"],
    });
  });

  test("freezes the mode at the ceiling it started in and refuses to widen it", async () => {
    const created = registry("acceptEdits");
    expect(freezeSessionPermissionMode(created, policy, undefined)).toBe("acceptEdits");
    expect(created.modeCeiling).toBe("acceptEdits");
    await expect(
      created.update(createEmptyToolPermissionContext({ mode: "bypassPermissions" })),
    ).rejects.toThrow(/frozen by this session's toolPolicy/);
    await created.update(createEmptyToolPermissionContext({ mode: "plan" }));
    expect(created.current().mode).toBe("plan");
  });

  test("freezes at the recorded ceiling on restore, and refuses a session already past it", () => {
    const narrowed = registry("plan");
    expect(freezeSessionPermissionMode(narrowed, policy, "default")).toBe("default");
    expect(narrowed.modeCeiling).toBe("default");
    expect(() => freezeSessionPermissionMode(registry("bypassPermissions"), policy, "default")).toThrow(
      /frozen by this session's toolPolicy/,
    );
  });

  test("freezes nothing for a policy that does not ask for it, or no policy", () => {
    const open = registry();
    expect(freezeSessionPermissionMode(open, { enabledTools: ["FileRead"] }, undefined)).toBeUndefined();
    expect(freezeSessionPermissionMode(open, undefined, undefined)).toBeUndefined();
    expect(open.modeCeiling).toBeUndefined();
  });
});
