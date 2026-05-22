import React, { useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import { AgentProgressLine } from "../components/AgentProgressLine.js";

type AgentProgressLineProps = React.ComponentProps<typeof AgentProgressLine>;

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS;

afterEach(() => {
  if (originalGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS;
  } else {
    process.env.AGENC_TUI_GLYPHS = originalGlyphMode;
  }
});

function props(
  overrides: Partial<AgentProgressLineProps> = {},
): AgentProgressLineProps {
  return {
    agentType: "worker",
    isError: false,
    isLast: false,
    isResolved: false,
    shouldAnimate: false,
    tokens: null,
    toolUseCount: 0,
    ...overrides,
  };
}

function RerenderSameLine() {
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    if (tick === 0) setTick(1);
  }, [tick]);

  return (
    <AgentProgressLine
      {...props({
        agentType: "cache",
        description: "stable",
        isLast: true,
        lastToolInfo: "Still working",
        toolUseCount: 1,
        tokens: 2000,
      })}
    />
  );
}

async function renderLine(
  overrides: Partial<AgentProgressLineProps>,
): Promise<string> {
  return renderToString(<AgentProgressLine {...props(overrides)} />, {
    columns: 120,
  });
}

describe("AgentProgressLine coverage swarm 068", () => {
  test("renders active fallback status with colored labels and plural usage", async () => {
    process.env.AGENC_TUI_GLYPHS = "ascii";

    const output = await renderLine({
      agentType: "planner",
      color: "worker",
      description: "queued",
      descriptionColor: "success",
      toolUseCount: 0,
    });

    expect(output).toContain("|- planner (queued) · 0 tool uses");
    expect(output).toContain("|  |_  Initializing...");
  });

  test("uses hide-type fallback labels when name is absent", async () => {
    process.env.AGENC_TUI_GLYPHS = "ascii";

    const descriptionOnly = await renderLine({
      description: "indexing",
      hideType: true,
      isResolved: true,
    });
    expect(descriptionOnly).toContain("|- indexing · 0 tool uses");
    expect(descriptionOnly).toContain("|  |_  Done");

    const agentOnly = await renderLine({
      agentType: "fallback",
      hideType: true,
      isResolved: true,
    });
    expect(agentOnly).toContain("|- fallback · 0 tool uses");
    expect(agentOnly).toContain("|  |_  Done");
  });

  test("keeps backgrounded resolved work compact without a task description", async () => {
    process.env.AGENC_TUI_GLYPHS = "ascii";

    const output = await renderLine({
      isAsync: true,
      isLast: true,
      isResolved: true,
      taskDescription: undefined,
      tokens: 9000,
      toolUseCount: 3,
    });

    expect(output).toContain("`- worker");
    expect(output).not.toContain("Running in the background");
    expect(output).not.toContain("3 tool uses");
    expect(output).not.toContain("9.0k tokens");
  });

  test("rerenders identical props through memoized render branches", async () => {
    process.env.AGENC_TUI_GLYPHS = "ascii";

    const output = await renderToString(<RerenderSameLine />, { columns: 120 });

    expect(output).toContain("`- cache (stable) · 1 tool use · 2.0k tokens");
    expect(output).toContain("   |_  Still working");
  });
});
