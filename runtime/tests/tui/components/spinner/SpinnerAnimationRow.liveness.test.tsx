import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  SpinnerAnimationRow,
  type SpinnerAnimationRowProps,
} from "../../../../src/tui/components/spinner/SpinnerAnimationRow.js";
import { renderToString } from "../../../../src/utils/staticRender.js";

const NOW = new Date("2026-06-23T12:00:00.000Z").getTime();

function makeRef<T>(current: T): React.RefObject<T> {
  return { current };
}

function props(
  overrides: Partial<SpinnerAnimationRowProps> = {},
): SpinnerAnimationRowProps {
  return {
    columns: 120,
    effortSuffix: "",
    foregroundedTeammate: undefined,
    hasActiveTools: false,
    hasRunningTeammates: false,
    leaderIsIdle: false,
    loadingStartTimeRef: makeRef(NOW - 31_000),
    message: "Responding",
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

describe("SpinnerAnimationRow liveness + token grammar", () => {
  // #3a: the counter must read "1 token", never "1 tokens".
  test("uses the singular noun for exactly one token", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      // round(4 / 4) === 1 token
      responseLengthRef: makeRef(4),
      verbose: true,
    });

    expect(output).toContain("1 token");
    expect(output).not.toContain("1 tokens");
  });

  test("keeps the plural noun for token counts other than one", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      responseLengthRef: makeRef(800), // 200 tokens
      verbose: true,
    });

    expect(output).toContain("200 tokens");
  });

  // #2: a slow turn that has produced no new token for a while must surface a
  // moving liveness note so it reads as "alive but slow", not "hung". This
  // reproduces the frozen "↓ 1 token (12m …)" build session.
  test("shows a slow-model heartbeat after a long no-token gap", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      // Turn started ~13 minutes ago and nothing has streamed yet.
      loadingStartTimeRef: makeRef(NOW - 13 * 60_000),
      responseLengthRef: makeRef(0),
      mode: "responding",
    });

    expect(output).toContain("slow model");
    expect(output).toContain("still generating");
  });

  test("reports time since the last token once some output has streamed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      // Tokens already present at mount, so the note reports the silence gap.
      loadingStartTimeRef: makeRef(NOW - 5 * 60_000),
      responseLengthRef: makeRef(40), // 10 tokens
      mode: "responding",
    });

    // Tokens are present, so on the first render the stream is treated as
    // fresh — no false stall. (The "last token Ns ago" branch only appears
    // after a real observed gap across renders in the live UI.)
    expect(output).not.toContain("slow model");
    expect(output).toContain("10 tokens");
  });

  // The heartbeat must NOT appear while "thinking" is already explaining the
  // silence (thinking has its own visible status).
  test("suppresses the heartbeat while thinking is shown", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      loadingStartTimeRef: makeRef(NOW - 13 * 60_000),
      responseLengthRef: makeRef(0),
      thinkingStatus: "thinking",
    });

    expect(output).not.toContain("slow model");
    expect(output).toContain("thinking");
  });

  // The heartbeat must NOT appear for a fresh, fast turn (no false alarm).
  test("does not flag a fresh turn as slow", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      loadingStartTimeRef: makeRef(NOW - 1_000),
      responseLengthRef: makeRef(0),
      verbose: true,
    });

    expect(output).not.toContain("slow model");
  });

  // The verb (e.g. "Working…") and the status group's opening "(" must be
  // separated by exactly one space; without it they run together as
  // "Working…(7m 57s …)". This guards the spacing the liveness-heartbeat
  // change introduced.
  test("separates the verb from the status group with a single space", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      message: "Working…",
      verbose: true,
    });

    // One space, exactly: not zero ("Working…("), not two ("Working…  (").
    expect(output).toContain("Working… (");
    expect(output).not.toContain("Working…(");
    expect(output).not.toContain("Working…  (");
  });
});
