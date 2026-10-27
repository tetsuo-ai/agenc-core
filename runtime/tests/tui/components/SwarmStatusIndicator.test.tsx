import React from "react";
import { describe, expect, test } from "vitest";

import {
  SwarmStatusIndicator,
  swarmStatusPresentation,
} from "./SwarmStatusIndicator.js";
import { renderToString } from "../../utils/staticRender.js";

describe("SwarmStatusIndicator", () => {
  test.each([
    [0, "swarm", "text", false],
    [-2, "swarm", "text", false],
    [Number.NaN, "swarm", "text", false],
    [Number.POSITIVE_INFINITY, "swarm", "text", false],
    [1, "swarm (1)", "accentSoft", false],
    [2, "swarm (2)", "accentSoft", false],
    [2.9, "swarm (2)", "accentSoft", false],
    [3, "swarm (3)", "accent", false],
    [5, "swarm (5)", "accent", false],
    [6, "swarm (6)", "accent", true],
    [12, "swarm (12)", "accent", true],
  ])("formats running-agent count %s", (count, label, color, bold) => {
    expect(swarmStatusPresentation(count as number)).toMatchObject({ label, color, bold });
  });

  test("renders a quiet inline idle state without the old uppercase slab", async () => {
    const output = await renderToString(
      <SwarmStatusIndicator runningAgents={0} />,
      40,
    );

    expect(output).toBe(" · swarm");
    expect(output).not.toContain("SWARM");
  });

  test("renders an explicit human-readable active count", async () => {
    const output = await renderToString(
      <SwarmStatusIndicator runningAgents={3} />,
      40,
    );

    expect(output).toBe(" · swarm (3)");
  });
});
