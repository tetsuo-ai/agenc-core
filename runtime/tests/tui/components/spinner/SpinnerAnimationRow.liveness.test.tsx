import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  SpinnerAnimationRow,
  formatRate,
  initialTokenLivenessState,
  selectStallNote,
  stepTokenLiveness,
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
  // reproduces the frozen "↓ 1 token (12m …)" build session. Honesty update
  // (2026-07-20): with zero tokens there is no rate evidence to blame the
  // MODEL with, so the note is a neutral "waiting for model", not
  // "slow model".
  test("shows a waiting-for-model heartbeat after a long no-token gap", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      // Turn started ~13 minutes ago and nothing has streamed yet.
      loadingStartTimeRef: makeRef(NOW - 13 * 60_000),
      responseLengthRef: makeRef(0),
      mode: "responding",
    });

    expect(output).toContain("waiting for model");
    expect(output).toContain("no output yet");
    expect(output).not.toContain("slow model");
  });

  // Operator bug 2026-07-20: "Running tools… (1m 33s · ↓ 208 tokens ·
  // 2.4 tok/s · slow model · last token 16s ago)" — while tools execute the
  // model is not being asked for tokens, so no stall note may render at all.
  test("suppresses the stall note entirely while tools are running", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      loadingStartTimeRef: makeRef(NOW - 13 * 60_000),
      responseLengthRef: makeRef(832), // 208 tokens
      mode: "tool-use",
      hasActiveTools: true,
      verbose: true,
    });

    expect(output).not.toContain("slow model");
    expect(output).not.toContain("last token");
    expect(output).not.toContain("waiting for model");
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

  test("suppresses estimated leader token and liveness stats when disabled", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const output = await renderRow({
      loadingStartTimeRef: makeRef(NOW - 5 * 60_000),
      responseLengthRef: makeRef(4_000),
      showLeaderTokenStats: false,
      verbose: true,
    });

    expect(output).not.toContain("tokens");
    expect(output).not.toContain("tok/s");
    expect(output).not.toContain("last token");
    expect(output).not.toContain("slow model");
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

  // The tok/s figure divides an ESTIMATED token count (chars/4) by ACTIVE
  // streaming time only. Tool-execution windows must pause the denominator:
  // previously 90s of tool time diluted a healthy stream to "2.4 tok/s".
  test("tok/s rate counts only active streaming windows", () => {
    const t0 = 1_000_000;
    const state = initialTokenLivenessState(0, t0, t0);

    // 10s of active streaming producing 400 tokens → 40 tok/s.
    let result = stepTokenLiveness(state, {
      totalTokens: 40,
      now: t0 + 1_000,
      streamingActive: true,
    });
    for (let i = 2; i <= 10; i++) {
      result = stepTokenLiveness(state, {
        totalTokens: 40 * i,
        now: t0 + i * 1_000,
        streamingActive: true,
      });
    }
    expect(result.ratePerSec).toBeCloseTo(400 / 9, 0);

    // 90s of tool execution: no tokens, denominator must NOT grow.
    for (let i = 1; i <= 90; i++) {
      result = stepTokenLiveness(state, {
        totalTokens: 400,
        now: t0 + 10_000 + i * 1_000,
        streamingActive: false,
      });
    }
    expect(result.ratePerSec).toBeCloseTo(400 / 9, 0);
    // Tool-window silence is not model silence.
    expect(result.msSinceLastToken).toBe(0);
  });

  test("post-tool silence is measured from the tool window end, not the last token", () => {
    const t0 = 1_000_000;
    const state = initialTokenLivenessState(0, t0, t0);
    stepTokenLiveness(state, { totalTokens: 100, now: t0 + 5_000, streamingActive: true });
    // 60s of tools…
    stepTokenLiveness(state, { totalTokens: 100, now: t0 + 65_000, streamingActive: false });
    // …then 9s of model-owned silence.
    const result = stepTokenLiveness(state, {
      totalTokens: 100,
      now: t0 + 74_000,
      streamingActive: true,
    });
    expect(result.msSinceLastToken).toBe(9_000);
  });

  // "slow model" is a claim about the model — it needs rate evidence.
  test("selectStallNote labels slow model only with genuine rate evidence", () => {
    // Tools running → never a note.
    expect(
      selectStallNote({ totalTokens: 208, msSinceLastToken: 16_000, ratePerSec: 2.4, toolsRunning: true }),
    ).toBeNull();
    // Silence with a healthy measured rate → neutral gap note.
    expect(
      selectStallNote({ totalTokens: 208, msSinceLastToken: 16_000, ratePerSec: 40, toolsRunning: false }),
    ).toBe("last token 16s ago");
    // Silence with measured slow streaming → honest slow-model label.
    expect(
      selectStallNote({ totalTokens: 208, msSinceLastToken: 16_000, ratePerSec: 4, toolsRunning: false }),
    ).toBe("slow model · last token 16s ago");
    // No tokens yet → waiting, not "slow model".
    expect(
      selectStallNote({ totalTokens: 0, msSinceLastToken: 20_000, ratePerSec: 0, toolsRunning: false }),
    ).toBe("waiting for model · no output yet");
  });

  // The rate is an estimate (chars/4) — it must be visibly marked as one.
  test("formatRate marks the figure as an estimate", () => {
    expect(formatRate(42)).toBe("~42 tok/s");
    expect(formatRate(2.4)).toBe("~2.4 tok/s");
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
