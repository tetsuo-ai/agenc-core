import React from "react";
import { describe, expect, test } from "vitest";

import {
  SwarmStatusIndicator,
  swarmStatusPresentation,
} from "./SwarmStatusIndicator.js";
import { renderToString } from "../../utils/staticRender.js";

describe("SwarmStatusIndicator", () => {
  test.each([
    [0, { glyph: "◇", label: "swarm" }],
    [-2, { glyph: "◇", label: "swarm" }],
    [Number.NaN, { glyph: "◇", label: "swarm" }],
    [1, { glyph: "◆", label: "1 agent" }],
    [2, { glyph: "◆", label: "2 agents" }],
    [2.9, { glyph: "◆", label: "2 agents" }],
  ])("formats running-agent count %s", (count, expected) => {
    expect(swarmStatusPresentation(count)).toEqual(expected);
  });

  test("renders a quiet inline idle state without the old uppercase slab", async () => {
    const output = await renderToString(
      <SwarmStatusIndicator runningAgents={0} />,
      40,
    );

    expect(output).toBe(" · ◇ swarm");
    expect(output).not.toContain("SWARM");
  });

  test("renders an explicit human-readable active count", async () => {
    const output = await renderToString(
      <SwarmStatusIndicator runningAgents={3} />,
      40,
    );

    expect(output).toBe(" · ◆ 3 agents");
  });
});
