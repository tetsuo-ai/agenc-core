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
    expect(normalizeUnattendedToolList([" read ", "FileRead", "", "grep", "Bash", "FileEdit", "FileWrite"])).toEqual([
      "FileRead",
      "Grep",
      "system.bash",
      "Edit",
      "Write",
    ]);
  });

  test("defaults to pausing every tool when no allowlist is provided", () => {
    const policy = createUnattendedPermissionPolicy();
    expect(DEFAULT_UNATTENDED_ALLOWLIST).toEqual([]);
    expect(policy.allowlist).toEqual([]);
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
      denylist: ["system.bash"],
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
      toolName: "system.bash",
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

  test("missing context policy falls back to pause-all defaults", () => {
    const context = createEmptyToolPermissionContext({ mode: "unattended" });
    expect(unattendedPolicyForContext(context).allowlist).toEqual([]);
    expect(resolveUnattendedPermissionDecision(context, "FileRead")).toMatchObject({
      behavior: "pause",
      toolName: "FileRead",
    });
  });
});
