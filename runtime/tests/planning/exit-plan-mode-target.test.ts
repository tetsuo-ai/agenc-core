import { afterEach, describe, expect, it } from "vitest";

import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import {
  clearExitPlanModeApprovalsForTest,
  recordExitPlanModeApproval,
} from "../../src/planning/exit-plan-approval.js";
import { createPlanningTools } from "../../src/tools/system/planning.js";

/**
 * The plan-approval overlay offers "yes, and auto-accept edits" and "yes,
 * and manually approve edits". The second sends `mode: "default"`, and
 * ExitPlanMode used to read `default` as "restore whatever mode the session
 * entered plan mode from", so a session that went plan from acceptEdits kept
 * auto-accepting edits after the user asked to review each one. Only an
 * approval without a mode (or a model-initiated exit) restores the pre-plan
 * mode now.
 */
function exitPlanTool(prePlanMode: "default" | "acceptEdits") {
  const registry = new PermissionModeRegistry({
    ...createEmptyToolPermissionContext({ mode: "plan" }),
    prePlanMode,
  });
  const tool = createPlanningTools({
    workflowController: { getPermissionModeRegistry: () => registry },
  }).find((candidate) => candidate.name === "ExitPlanMode");
  if (!tool) throw new Error("ExitPlanMode tool not registered");
  return { registry, tool };
}

describe("ExitPlanMode target mode", () => {
  afterEach(() => clearExitPlanModeApprovalsForTest());

  it("honors an explicit default choice even when plan mode was entered from acceptEdits", async () => {
    const { registry, tool } = exitPlanTool("acceptEdits");
    recordExitPlanModeApproval("call-manual", { action: "approve", mode: "default" });

    const result = await tool.execute({ __callId: "call-manual" });

    expect(result.isError).not.toBe(true);
    expect(result.metadata).toMatchObject({ fromMode: "plan", toMode: "default" });
    expect(registry.current().mode).toBe("default");
  });

  it("honors an explicit acceptEdits choice when plan mode was entered from default", async () => {
    const { registry, tool } = exitPlanTool("default");
    recordExitPlanModeApproval("call-auto", { action: "approve", mode: "acceptEdits" });

    await tool.execute({ __callId: "call-auto" });

    expect(registry.current().mode).toBe("acceptEdits");
  });

  it("restores the pre-plan mode when the approval names no mode", async () => {
    const { registry, tool } = exitPlanTool("acceptEdits");
    recordExitPlanModeApproval("call-plain", { action: "approve" });

    await tool.execute({ __callId: "call-plain" });

    expect(registry.current().mode).toBe("acceptEdits");
  });

  it("restores the pre-plan mode on a model-initiated exit with no approval", async () => {
    const { registry, tool } = exitPlanTool("acceptEdits");

    await tool.execute({});

    expect(registry.current().mode).toBe("acceptEdits");
  });
});
