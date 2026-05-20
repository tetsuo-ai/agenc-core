import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderToString } from "../../../utils/staticRender.js";

type TeamContext = {
  teamName: string;
  teamFilePath: string;
  leadAgentId: string;
  teammates: Record<
    string,
    {
      name: string;
      tmuxSessionName: string;
      tmuxPaneId: string;
      cwd: string;
      spawnedAt: number;
    }
  >;
};

const appStateMock = vi.hoisted(() => ({
  state: {
    teamContext: undefined as TeamContext | undefined,
  },
}));

vi.mock("../../state/AppState.js", () => ({
  useAppState: (selector: (state: typeof appStateMock.state) => unknown) =>
    selector(appStateMock.state),
}));

function teamContext(teammateNames: string[]): TeamContext {
  return {
    teamName: "coverage-team",
    teamFilePath: "/tmp/coverage-team.json",
    leadAgentId: "lead",
    teammates: Object.fromEntries(
      teammateNames.map((name, index) => [
        `agent-${index}`,
        {
          name,
          tmuxSessionName: "coverage-session",
          tmuxPaneId: `%${index + 1}`,
          cwd: "/tmp",
          spawnedAt: index,
        },
      ]),
    ),
  };
}

describe("TeamStatus coverage", () => {
  beforeEach(() => {
    appStateMock.state.teamContext = undefined;
  });

  it("counts visible teammates and only shows the selected hint when requested", async () => {
    const { TeamStatus } = await import("./TeamStatus.js");

    const noTeam = await renderToString(
      <TeamStatus teamsSelected={false} showHint={false} />,
    );
    expect(noTeam.trim()).toBe("");

    appStateMock.state.teamContext = teamContext(["team-lead"]);
    const onlyLeader = await renderToString(
      <TeamStatus teamsSelected={true} showHint={true} />,
    );
    expect(onlyLeader.trim()).toBe("");

    appStateMock.state.teamContext = teamContext(["team-lead", "builder"]);
    const singular = await renderToString(
      <TeamStatus teamsSelected={false} showHint={true} />,
    );
    expect(singular).toContain("1 teammate");
    expect(singular).not.toContain("Enter to view");

    appStateMock.state.teamContext = teamContext([
      "team-lead",
      "builder",
      "reviewer",
    ]);
    const selected = await renderToString(
      <TeamStatus teamsSelected={true} showHint={true} />,
    );
    expect(selected).toContain("2 teammates");
    expect(selected).toContain("Enter to view");
  });
});
