import React, { useLayoutEffect, useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { TeamStatus } from "../../../src/tui/components/teams/TeamStatus.js";
import { renderToString } from "../../../src/utils/staticRender.js";

type Teammate = {
  cwd: string;
  name: string;
  spawnedAt: number;
  tmuxPaneId: string;
  tmuxSessionName: string;
};

type TeamContext = {
  leadAgentId: string;
  teamFilePath: string;
  teamName: string;
  teammates: Record<string, Teammate>;
};

const appStateMock = vi.hoisted(() => ({
  state: {
    teamContext: undefined as TeamContext | undefined,
  },
}));

vi.mock("../../../src/tui/state/AppState.js", () => ({
  useAppState: (selector: (state: typeof appStateMock.state) => unknown) =>
    selector(appStateMock.state),
}));

function teamContext(names: string[]): TeamContext {
  return {
    leadAgentId: "lead",
    teamFilePath: "/tmp/team.json",
    teamName: "coverage-team",
    teammates: Object.fromEntries(
      names.map((name, index) => [
        `agent-${index}`,
        {
          cwd: "/tmp",
          name,
          spawnedAt: index,
          tmuxPaneId: `%${index + 1}`,
          tmuxSessionName: "coverage-team",
        },
      ]),
    ),
  };
}

function RerenderTeamStatus(props: {
  showHint: boolean;
  teamsSelected: boolean;
}) {
  const [renderCount, setRenderCount] = useState(0);

  useLayoutEffect(() => {
    if (renderCount === 0) setRenderCount(1);
  }, [renderCount]);

  return <TeamStatus {...props} />;
}

describe("TeamStatus coverage swarm row 144", () => {
  beforeEach(() => {
    appStateMock.state.teamContext = undefined;
  });

  test("renders nothing when the team context has no visible teammate", async () => {
    expect(
      (
        await renderToString(
          <TeamStatus teamsSelected={false} showHint={false} />,
          80,
        )
      ).trim(),
    ).toBe("");

    appStateMock.state.teamContext = teamContext(["team-lead"]);

    expect(
      (
        await renderToString(
          <TeamStatus teamsSelected={true} showHint={true} />,
          80,
        )
      ).trim(),
    ).toBe("");
  });

  test("counts non-lead teammates and only shows the selected hint when enabled", async () => {
    appStateMock.state.teamContext = teamContext(["team-lead", "builder"]);

    const unselected = await renderToString(
      <TeamStatus teamsSelected={false} showHint={true} />,
      80,
    );
    expect(unselected).toContain("1 teammate");
    expect(unselected).not.toContain("Enter to view");

    const selectedWithoutHint = await renderToString(
      <TeamStatus teamsSelected={true} showHint={false} />,
      80,
    );
    expect(selectedWithoutHint).toContain("1 teammate");
    expect(selectedWithoutHint).not.toContain("Enter to view");

    appStateMock.state.teamContext = teamContext([
      "team-lead",
      "builder",
      "reviewer",
    ]);

    const selectedWithHint = await renderToString(
      <TeamStatus teamsSelected={true} showHint={true} />,
      80,
    );
    expect(selectedWithHint).toContain("2 teammates");
    expect(selectedWithHint).toContain("Enter to view");
  });

  test("keeps the selected footer stable across a rerender with the same team context", async () => {
    appStateMock.state.teamContext = teamContext([
      "team-lead",
      "builder",
      "reviewer",
    ]);

    const output = await renderToString(
      <RerenderTeamStatus teamsSelected={true} showHint={true} />,
      80,
    );

    expect(output).toContain("2 teammates");
    expect(output).toContain("Enter to view");
  });
});
