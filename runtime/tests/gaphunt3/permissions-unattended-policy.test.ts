/**
 * gaphunt3 #27 regression coverage.
 *
 * In unattended (daemon/--autonomous) mode the operator-supplied denylist is
 * canonicalized through TOOL_ALIASES. Previously only `bash` mapped onto
 * `system.bash`, so a `Bash` deny matched only the `system.bash` tool and
 * silently left the other concrete shell-execution tools (`exec_command`,
 * `desktop.bash`) — which run identical arbitrary shell commands — un-denied
 * (returning "pause" or, with a matching allowlist, "allow").
 *
 * The fix adds `exec_command` and `desktop.bash` to TOOL_ALIASES so the whole
 * shell-exec family collapses onto `system.bash`. Each assertion below fails if
 * that fix is reverted and passes with it.
 */

import { describe, expect, it } from "vitest";

import {
  applyUnattendedPermissionPolicyToContext,
  normalizeUnattendedToolList,
  resolveUnattendedPermissionDecision,
} from "src/permissions/unattended-policy.js";
import { createEmptyToolPermissionContext } from "src/permissions/types.js";

describe("gaphunt3 #27: unattended denylist covers the shell-exec tool family", () => {
  it("a Bash deny also denies exec_command and desktop.bash", () => {
    const context = applyUnattendedPermissionPolicyToContext(
      createEmptyToolPermissionContext(),
      { denylist: ["Bash"] },
    );

    // The operator intended to forbid all shell. The denylist is recorded as
    // the single canonical bucket...
    expect(context.unattendedPolicy?.denylist).toEqual(["system.bash"]);

    // ...and every member of the shell-exec family resolves to deny.
    expect(
      resolveUnattendedPermissionDecision(context, "exec_command").behavior,
    ).toBe("deny");
    expect(
      resolveUnattendedPermissionDecision(context, "desktop.bash").behavior,
    ).toBe("deny");
    expect(
      resolveUnattendedPermissionDecision(context, "system.bash").behavior,
    ).toBe("deny");
    expect(
      resolveUnattendedPermissionDecision(context, "Bash").behavior,
    ).toBe("deny");
  });

  it("canonicalizes exec_command and desktop.bash onto system.bash", () => {
    expect(
      normalizeUnattendedToolList(["exec_command", "desktop.bash", "Bash"]),
    ).toEqual(["system.bash"]);
  });

  it("deny still wins over an allowlist that lists the shell family", () => {
    const context = applyUnattendedPermissionPolicyToContext(
      createEmptyToolPermissionContext(),
      { allowlist: ["exec_command"], denylist: ["Bash"] },
    );

    // exec_command collapses to system.bash on both lists; deny precedes allow.
    expect(
      resolveUnattendedPermissionDecision(context, "exec_command"),
    ).toMatchObject({ behavior: "deny", toolName: "system.bash" });
  });

  it("an exec_command allowlist also allows desktop.bash and Bash (same bucket)", () => {
    const context = applyUnattendedPermissionPolicyToContext(
      createEmptyToolPermissionContext(),
      { allowlist: ["exec_command"] },
    );

    expect(
      resolveUnattendedPermissionDecision(context, "desktop.bash"),
    ).toMatchObject({ behavior: "allow", toolName: "system.bash" });
    expect(
      resolveUnattendedPermissionDecision(context, "Bash"),
    ).toMatchObject({ behavior: "allow", toolName: "system.bash" });
  });
});
