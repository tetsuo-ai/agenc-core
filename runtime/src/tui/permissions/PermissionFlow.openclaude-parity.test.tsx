import { describe, expect, test } from "vitest";

import { approvalBodyComponentForTool } from "./ApprovalOverlay.js";
import { permissionComponentForTool } from "./PermissionRequest.js";
import {
  getNextPermissionMode,
  transitionPermissionMode,
} from "../../permissions/mode.js";
import type { ToolPermissionContext } from "../../permissions/types.js";

function context(mode: ToolPermissionContext["mode"]): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
    isAutoModeAvailable: false,
    autoModeActive: false,
    hasExitedPlanModeInSession: false,
    bypassPermissionsAcceptedIn: ["/repo"],
  };
}

describe("OpenClaude permission flow parity", () => {
  test("approval overlay resolves tool bodies through the permission registry", () => {
    expect(approvalBodyComponentForTool("Bash")).toBe(
      permissionComponentForTool("Bash"),
    );
    expect(approvalBodyComponentForTool("Write")).toBe(
      permissionComponentForTool("Write"),
    );
    expect(approvalBodyComponentForTool("Edit")).toBe(
      permissionComponentForTool("Edit"),
    );
  });

  test("mode cycle enters bypass only through accepted workspace consent", () => {
    const current = context("plan");
    const nextMode = getNextPermissionMode(current.mode, current);
    const transitioned = transitionPermissionMode(current.mode, nextMode, current, {
      requireBypassConsent: true,
      workspacePath: "/repo",
    });

    expect(nextMode).toBe("bypassPermissions");
    const registryUpdate =
      "error" in transitioned
        ? transitioned
        : { ...transitioned, mode: nextMode };

    expect(registryUpdate).toMatchObject({
      mode: "bypassPermissions",
      bypassPermissionsAcceptedIn: expect.arrayContaining(["/repo"]),
    });
  });
});
