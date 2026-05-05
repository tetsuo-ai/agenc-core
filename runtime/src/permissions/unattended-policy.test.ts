import { describe, expect, test } from "vitest";

import {
  DEFAULT_UNATTENDED_ALLOWLIST,
  applyUnattendedPermissionPolicyToContext,
  createUnattendedPermissionPolicy,
  normalizeUnattendedToolList,
  resolveUnattendedPermissionDecision,
  unattendedPolicyForContext,
} from "./unattended-policy.js";
import { createEmptyToolPermissionContext } from "./types.js";

describe("unattended permission policy", () => {
  test("normalizes aliases, trims entries, and removes duplicates", () => {
    expect(normalizeUnattendedToolList([" read ", "FileRead", "", "grep"])).toEqual([
      "FileRead",
      "system.grep",
    ]);
  });

  test("uses the conservative default allowlist when no allowlist is provided", () => {
    const policy = createUnattendedPermissionPolicy();
    expect(policy.allowlist).toEqual([...DEFAULT_UNATTENDED_ALLOWLIST]);
    expect(policy.denylist).toEqual([]);
  });

  test("preserves an explicit empty allowlist", () => {
    const policy = createUnattendedPermissionPolicy({ allowlist: [] });
    expect(policy.allowlist).toEqual([]);
  });

  test("applies unattended mode and policy to an existing context", () => {
    const base = createEmptyToolPermissionContext({ mode: "default" });
    const next = applyUnattendedPermissionPolicyToContext(base, {
      allowlist: ["FileRead"],
      denylist: ["Bash"],
    });

    expect(next.mode).toBe("unattended");
    expect(next.unattendedPolicy).toEqual({
      allowlist: ["FileRead"],
      denylist: ["Bash"],
    });
    expect(base.mode).toBe("default");
  });

  test("resolves deny before allow and pauses unlisted tools", () => {
    const context = applyUnattendedPermissionPolicyToContext(
      createEmptyToolPermissionContext(),
      {
        allowlist: ["FileRead", "Bash"],
        denylist: ["Bash"],
      },
    );

    expect(resolveUnattendedPermissionDecision(context, "Bash")).toMatchObject({
      behavior: "deny",
      toolName: "Bash",
    });
    expect(resolveUnattendedPermissionDecision(context, "read")).toMatchObject({
      behavior: "allow",
      toolName: "FileRead",
    });
    expect(resolveUnattendedPermissionDecision(context, "Edit")).toMatchObject({
      behavior: "pause",
      toolName: "Edit",
    });
  });

  test("missing context policy falls back to defaults", () => {
    const context = createEmptyToolPermissionContext({ mode: "unattended" });
    expect(unattendedPolicyForContext(context).allowlist).toEqual([
      ...DEFAULT_UNATTENDED_ALLOWLIST,
    ]);
  });
});
