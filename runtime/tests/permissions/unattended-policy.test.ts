import { describe, expect, test } from "vitest";

import {
  DEFAULT_UNATTENDED_ALLOWLIST,
  applyUnattendedPermissionPolicyToContext,
  createUnattendedPermissionPolicy,
  normalizeUnattendedToolList,
  resolveUnattendedPermissionDecision,
  unattendedPolicyForContext,
} from "./unattended-policy.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "./types.js";

describe("unattended permission policy", () => {
  test("normalizes canonical risk families, trims entries, and removes duplicates", () => {
    expect(normalizeUnattendedToolList([
      " FileRead ",
      "FileRead",
      "",
      "Grep",
      "Glob",
      "system.bash",
      "exec_command",
      "Write",
      "MultiEdit",
    ])).toEqual([
      "FileRead",
      "Grep",
      "Glob",
      "system.bash",
      "Edit",
    ]);
  });

  test.each(["Read", "Bash", "FileEdit", "FileWrite", "system.grep", "system.glob"])(
    "rejects removed unattended tool spelling %s",
    (name) => {
      expect(() => normalizeUnattendedToolList([name])).toThrow(
        `removed unattended tool name '${name}'`,
      );
    },
  );

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
      denylist: ["system.bash"],
    });

    expect(next.mode).toBe("unattended");
    expect(next.unattendedPolicy).toEqual({
      allowlist: ["FileRead"],
      denylist: ["system.bash"],
    });
    expect(base.mode).toBe("default");
  });

  test("clones and freezes caller-owned context and policy inputs", () => {
    const rules = ["Read(src/**)"];
    const directory = { path: "/extra", source: "session" as const };
    const directories = new Map([[directory.path, directory]]);
    const allowlist = ["FileRead"];
    const denylist = ["system.bash"];
    const input: ToolPermissionContext = {
      mode: "default",
      additionalWorkingDirectories: directories,
      alwaysAllowRules: { session: rules },
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    };

    const next = applyUnattendedPermissionPolicyToContext(input, {
      allowlist,
      denylist,
    });
    rules.push("Write(**)");
    directory.path = "/mutated";
    directories.clear();
    allowlist.push("Write");
    denylist.length = 0;

    expect(next).not.toBe(input);
    expect(next.alwaysAllowRules.session).toEqual(["Read(src/**)"]);
    expect(next.additionalWorkingDirectories.get("/extra")).toEqual({
      path: "/extra",
      source: "session",
    });
    expect(next.unattendedPolicy).toEqual({
      allowlist: ["FileRead"],
      denylist: ["system.bash"],
    });
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.unattendedPolicy)).toBe(true);
    expect(() => {
      (next.unattendedPolicy?.allowlist as string[]).push("Write");
    }).toThrow(TypeError);
    expect(() =>
      Map.prototype.clear.call(next.additionalWorkingDirectories),
    ).toThrow(TypeError);
  });

  // The daemon always forces --autonomous, so installUnattendedPermissionPolicy
  // runs on every startAgent/restoreAgent. It must NOT rewrite a mode the user
  // explicitly chose. Without preservation, plan mode was unusable in the daemon
  // TUI (the live ExitPlanMode read "unattended" and failed its plan guard).
  test.each(["bypassPermissions", "plan", "acceptEdits"] as const)(
    "preserves the explicit %s mode instead of forcing unattended",
    (mode) => {
      const base = createEmptyToolPermissionContext({ mode });
      const next = applyUnattendedPermissionPolicyToContext(base, {
        allowlist: ["FileRead"],
      });
      // Mode is the user's explicit choice...
      expect(next.mode).toBe(mode);
      // ...but the unattended policy is still recorded for subset logic.
      expect(next.unattendedPolicy).toEqual({
        allowlist: ["FileRead"],
        denylist: [],
      });
    },
  );

  test("still forces unattended for non-explicit modes (default)", () => {
    const next = applyUnattendedPermissionPolicyToContext(
      createEmptyToolPermissionContext({ mode: "default" }),
    );
    expect(next.mode).toBe("unattended");
  });

  test("resolves deny before allow and pauses unlisted tools", () => {
    const context = applyUnattendedPermissionPolicyToContext(
      createEmptyToolPermissionContext(),
      {
        allowlist: ["FileRead", "exec_command"],
        denylist: ["system.bash"],
      },
    );

    expect(resolveUnattendedPermissionDecision(context, "exec_command")).toMatchObject({
      behavior: "deny",
      toolName: "system.bash",
    });
    expect(resolveUnattendedPermissionDecision(context, "FileRead")).toMatchObject({
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
