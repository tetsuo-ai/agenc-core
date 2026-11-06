/**
 * Review B, round 2: a PreToolUse hook that answers "ask" now runs the
 * evaluator floor, and the floor is hasPermissionsToUseTool with its mode
 * handling. This records what that does per permission mode for an ordinary
 * call the tool's own check passes through (no deny, no safety check).
 */
import { describe, expect, it } from "vitest";

import { arbitratePermissionMode } from "../../../src/permissions/guardian/arbiter.js";
import { hasPermissionsToUseTool, type ToolEvaluatorContext } from "../../../src/permissions/evaluator.js";
import { createEmptyToolPermissionContext } from "../../../src/permissions/types.js";

function contextFor(mode: "default" | "dontAsk" | "acceptEdits"): ToolEvaluatorContext {
  const permission = createEmptyToolPermissionContext({ mode });
  return {
    session: {},
    getAppState: () => ({
      toolPermissionContext: permission,
      denialTracking: { consecutiveDenials: 0, totalDenials: 0 },
      autoModeActive: false,
    }),
  } as unknown as ToolEvaluatorContext;
}

const tool = {
  name: "Notify",
  requiresApproval: true,
  checkPermissions: () => ({ behavior: "passthrough" as const, message: "Notify needs approval." }),
};

describe("review B round 2: a PreToolUse ask under each permission mode", () => {
  it.each([
    ["default", "ask"],
    ["acceptEdits", "ask"],
    ["dontAsk", "deny"],
  ] as const)("%s mode ends as %s", async (mode, expected) => {
    const decision = await arbitratePermissionMode({
      tool: tool as never,
      args: {},
      hookPermissionResult: { behavior: "ask", hookName: "PreToolUse:review" },
      canUseTool: hasPermissionsToUseTool as never,
      permissionContext: contextFor(mode),
    });
    console.log(`MODE ${mode} -> ${decision.kind} via ${"source" in decision ? decision.source : "none"}`);
    expect(decision.kind).toBe(expected);
  });
});
