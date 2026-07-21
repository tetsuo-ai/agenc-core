import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  SpinnerAnimationRow,
  type SpinnerAnimationRowProps,
} from "../../../src/tui/components/spinner/SpinnerAnimationRow.js";
import { renderToString } from "../../../src/utils/staticRender.js";

const NOW = new Date("2026-05-20T12:00:00.000Z").getTime();

function makeRef<T>(current: T): React.RefObject<T> {
  return { current };
}

function props(
  overrides: Partial<SpinnerAnimationRowProps> = {},
): SpinnerAnimationRowProps {
  return {
    columns: 100,
    effortSuffix: "",
    foregroundedTeammate: undefined,
    hasActiveTools: false,
    hasRunningTeammates: false,
    leaderIsIdle: false,
    loadingStartTimeRef: makeRef(NOW - 31_000),
    message: "Working",
    messageColor: "text",
    mode: "responding",
    overrideColor: null,
    pauseStartTimeRef: makeRef(null),
    reducedMotion: false,
    responseLengthRef: makeRef(800),
    shimmerColor: "agencShimmer",
    spinnerSuffix: null,
    teammateTokens: 0,
    thinkingStatus: null,
    totalPausedMsRef: makeRef(0),
    verbose: false,
    ...overrides,
  };
}

async function renderRow(
  overrides: Partial<SpinnerAnimationRowProps> = {},
): Promise<string> {
  const rowProps = props(overrides);

  return renderToString(<SpinnerAnimationRow {...rowProps} />, rowProps.columns);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SpinnerAnimationRow coverage swarm row 189", () => {
  test("uses paused elapsed time and renders the responding token glyph", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      loadingStartTimeRef: makeRef(NOW - 60_000),
      pauseStartTimeRef: makeRef(NOW - 15_000),
      totalPausedMsRef: makeRef(5_000),
      verbose: true,
    });

    expect(output).toContain("Working");
    expect(output).toContain("40s");
    expect(output).toContain("200 tokens");
    expect(output.match(/↓/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("shows aggregate teammate tokens without adding a token glyph", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      hasRunningTeammates: true,
      loadingStartTimeRef: makeRef(NOW - 10_000),
      responseLengthRef: makeRef(4_000),
      teammateTokens: 2_500,
    });

    expect(output).toContain("10s");
    expect(output).toContain("3.5k tokens");
    expect(output.match(/↓/g)?.length ?? 0).toBe(1);
  });

  test("covers tool-input status while suppressing zero token metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const withTokens = await renderRow({
      mode: "tool-input",
      responseLengthRef: makeRef(1_200),
      verbose: true,
    });

    expect(withTokens).toContain("⣷");
    expect(withTokens).toContain("300 tokens");

    const withoutTokens = await renderRow({
      mode: "thinking",
      responseLengthRef: makeRef(0),
      verbose: true,
    });

    expect(withoutTokens).toContain("31s");
    expect(withoutTokens).not.toContain("0 tokens");
  });

  test("omits thinking text when compact columns cannot fit even the bare label", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      columns: 14,
      effortSuffix: " deeply",
      loadingStartTimeRef: makeRef(NOW - 2_000),
      message: "Go",
      thinkingStatus: "thinking",
    });

    expect(output).toContain("Go");
    expect(output).not.toContain("thinking");
    expect(output).not.toContain("deeply");
  });

  test("renders foregrounded teammate status when progress is absent and hides idle teammate metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const foregrounded = await renderRow({
      foregroundedTeammate: {
        identity: {
          agentName: "Scout",
          color: "yellow",
        },
        isIdle: false,
      } as SpinnerAnimationRowProps["foregroundedTeammate"],
      hasRunningTeammates: true,
      responseLengthRef: makeRef(4_000),
      teammateTokens: 2_000,
      thinkingStatus: "thinking",
      verbose: true,
    });

    expect(foregrounded).toContain("(esc to interrupt Scout)");
    expect(foregrounded).not.toContain("tokens");
    expect(foregrounded).not.toContain("thinking");

    const idle = await renderRow({
      foregroundedTeammate: {
        identity: {
          agentName: "IdleScout",
          color: "yellow",
        },
        isIdle: true,
      } as SpinnerAnimationRowProps["foregroundedTeammate"],
      thinkingStatus: "thinking",
      verbose: true,
    });

    expect(idle).toContain("Working");
    expect(idle).not.toContain("IdleScout");
    expect(idle).not.toContain("tokens");
    expect(idle).not.toContain("thinking");
  });
});
