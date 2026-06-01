import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT_PLAN_MODE_TOOL_NAME } from "../../src/tools/ExitPlanModeTool/constants.js";

// Mock the plan accessors so the enrichment is exercised without a real
// session/filesystem. These are the daemon-side sources of plan content/path.
const getPlanMock = vi.fn<(agentId?: string) => string | null>(() => null);
const getPlanFilePathMock = vi.fn<(agentId?: string) => string>(
  () => "/plans/quiet-harbor.md",
);

vi.mock("../../src/utils/plans.js", () => ({
  getPlan: (agentId?: string) => getPlanMock(agentId),
  getPlanFilePath: (agentId?: string) => getPlanFilePathMock(agentId),
}));

const { planApprovalPayloadFields } = await import(
  "../../src/app-server/background-agent-runner.js"
);

describe("planApprovalPayloadFields (contract #4)", () => {
  afterEach(() => {
    getPlanMock.mockReset();
    getPlanFilePathMock.mockReset();
    getPlanMock.mockReturnValue(null);
    getPlanFilePathMock.mockReturnValue("/plans/quiet-harbor.md");
  });

  it("includes planContent and planFilePath for ExitPlanMode", () => {
    getPlanMock.mockReturnValue("# Plan\n\n1. do the thing");
    getPlanFilePathMock.mockReturnValue("/plans/quiet-harbor.md");

    const fields = planApprovalPayloadFields(
      EXIT_PLAN_MODE_TOOL_NAME,
      "agent_1",
      {},
    );

    expect(fields).toEqual({
      planContent: "# Plan\n\n1. do the thing",
      planFilePath: "/plans/quiet-harbor.md",
    });
  });

  it("falls back to input.plan when the on-disk plan is empty", () => {
    getPlanMock.mockReturnValue(null);

    const fields = planApprovalPayloadFields(
      EXIT_PLAN_MODE_TOOL_NAME,
      "agent_1",
      { plan: "inline plan body" },
    );

    expect(fields.planContent).toBe("inline plan body");
    expect(fields.planFilePath).toBe("/plans/quiet-harbor.md");
  });

  it("returns an empty object for a non-ExitPlanMode tool", () => {
    getPlanMock.mockReturnValue("# Plan");

    const fields = planApprovalPayloadFields("Bash", "agent_1", {
      plan: "should be ignored",
    });

    expect(fields).toEqual({});
    expect(getPlanMock).not.toHaveBeenCalled();
    expect(getPlanFilePathMock).not.toHaveBeenCalled();
  });
});
