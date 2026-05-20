import { beforeEach, describe, expect, test, vi } from "vitest";

const detectionMock = vi.hoisted(() => ({
  insideTmux: false,
  leaderPaneId: "%lead",
}));

vi.mock("../../../utils/swarm/backends/detection.js", () => ({
  getLeaderPaneId: () => detectionMock.leaderPaneId,
  IT2_COMMAND: "it2",
  isInsideTmuxSync: () => detectionMock.insideTmux,
}));

describe("resolveTeammateShowTargetPane", () => {
  beforeEach(() => {
    detectionMock.insideTmux = false;
    detectionMock.leaderPaneId = "%lead";
  });

  test("selects a valid show target and rejects self-targeting", async () => {
    const { SWARM_SESSION_NAME, SWARM_VIEW_WINDOW_NAME } = await import(
      "../../../utils/swarm/constants.js"
    );
    const { resolveTeammateShowTargetPane } = await import("./TeamsDialog.js");

    detectionMock.insideTmux = true;
    detectionMock.leaderPaneId = "%lead";
    expect(resolveTeammateShowTargetPane("%hidden")).toBe("%lead");
    expect(resolveTeammateShowTargetPane("%lead")).toBeNull();

    detectionMock.insideTmux = false;
    const swarmViewTarget = `${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`;
    expect(resolveTeammateShowTargetPane("%hidden")).toBe(swarmViewTarget);
    expect(resolveTeammateShowTargetPane(swarmViewTarget)).toBeNull();
  });
});
