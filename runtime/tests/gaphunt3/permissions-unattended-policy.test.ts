/**
 * gaphunt3 #27 regression coverage.
 *
 * Distinct canonical shell tools share one unattended risk bucket. Retired
 * spellings are rejected instead of remaining a second live authority.
 */

import { describe, expect, it } from "vitest";

import {
  applyUnattendedPermissionPolicyToContext,
  normalizeUnattendedToolList,
  resolveUnattendedPermissionDecision,
} from "src/permissions/unattended-policy.js";
import { createEmptyToolPermissionContext } from "src/permissions/types.js";

describe("gaphunt3 #27: unattended denylist covers the shell-exec tool family", () => {
  it("a system.bash deny also denies canonical exec_command", () => {
    const context = applyUnattendedPermissionPolicyToContext(
      createEmptyToolPermissionContext(),
      { denylist: ["system.bash"] },
    );

    // The operator intended to forbid all shell. The denylist is recorded as
    // the single canonical bucket...
    expect(context.unattendedPolicy?.denylist).toEqual(["system.bash"]);

    // ...and every member of the shell-exec family resolves to deny.
    expect(
      resolveUnattendedPermissionDecision(context, "exec_command").behavior,
    ).toBe("deny");
    expect(
      resolveUnattendedPermissionDecision(context, "system.bash").behavior,
    ).toBe("deny");
  });

  it("canonicalizes distinct live shell tools onto system.bash", () => {
    expect(
      normalizeUnattendedToolList(["exec_command", "write_stdin", "PowerShell"]),
    ).toEqual(["system.bash"]);
  });

  it.each(["Bash", "bash", "desktop.bash", "shell"])(
    "rejects retired shell spelling %s",
    (name) => {
      expect(() => normalizeUnattendedToolList([name])).toThrow(
        "removed unattended tool name",
      );
    },
  );

  it("deny still wins over an allowlist that lists the shell family", () => {
    const context = applyUnattendedPermissionPolicyToContext(
      createEmptyToolPermissionContext(),
      { allowlist: ["exec_command"], denylist: ["system.bash"] },
    );

    // exec_command collapses to system.bash on both lists; deny precedes allow.
    expect(
      resolveUnattendedPermissionDecision(context, "exec_command"),
    ).toMatchObject({ behavior: "deny", toolName: "system.bash" });
  });

  it("an exec_command allowlist also allows canonical write_stdin", () => {
    const context = applyUnattendedPermissionPolicyToContext(
      createEmptyToolPermissionContext(),
      { allowlist: ["exec_command"] },
    );

    expect(
      resolveUnattendedPermissionDecision(context, "write_stdin"),
    ).toMatchObject({ behavior: "allow", toolName: "system.bash" });
  });
});
