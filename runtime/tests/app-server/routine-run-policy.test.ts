/**
 * What the daemon runner installs on a routine run's permission registry. The
 * routine executor always marks its agents (routines/daemon-executor.ts), and
 * the mode arrives from the routine's stored permission mode through
 * agent.create, so the policy follows that mode: default and plan keep the
 * read-only grant; acceptEdits and bypassPermissions keep their mode, lose
 * every approval (nobody is attached) and write only inside the run's folder.
 */
import { describe, expect, it } from "vitest";

import { installUnattendedPermissionPolicy } from "../../src/app-server/background-agent-runner/runtime-settings.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext, type PermissionMode } from "../../src/permissions/types.js";

const WORKSPACE = "/workspace/routine-project";

async function installed(mode: PermissionMode, routine?: { workspaceRoot: string }) {
  const registry = new PermissionModeRegistry(createEmptyToolPermissionContext({ mode }));
  await installUnattendedPermissionPolicy(registry, [], [], routine);
  return registry.current();
}

describe("routine run permission policy", () => {
  it.each(["bypassPermissions", "acceptEdits"] as const)(
    "keeps %s, refuses every approval and confines file writes to the run's workspace",
    async (mode) => {
      const context = await installed(mode, { workspaceRoot: WORKSPACE });
      expect(context.mode).toBe(mode);
      expect(context.unattendedPolicy).toEqual({
        allowlist: [], denylist: [], readOnly: false, noApprover: true, workspaceRoots: [WORKSPACE],
      });
    },
  );

  it.each([["default", "unattended"], ["plan", "plan"]] as const)(
    "keeps a %s routine on the read-only grant, as before",
    async (mode, effective) => {
      const context = await installed(mode, { workspaceRoot: WORKSPACE });
      expect(context.mode).toBe(effective);
      expect(context.unattendedPolicy).toEqual({ allowlist: [], denylist: [], readOnly: true });
    },
  );

  it("installs nothing on a run that is not a routine and declares no policy", async () => {
    for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const) {
      const context = await installed(mode);
      expect(context.mode).toBe(mode);
      expect(context.unattendedPolicy).toBeUndefined();
    }
  });
});
