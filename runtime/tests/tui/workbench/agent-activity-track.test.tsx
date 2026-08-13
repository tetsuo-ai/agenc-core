import React from "react";
import { describe, expect, it } from "vitest";

import {
  AgentActivityTrack,
  buildAgentActivityTrackFrame,
} from "../../../src/tui/workbench/agents/AgentActivityTrack.js";
import { stringWidth } from "../../../src/tui/ink/stringWidth.js";
import { renderToString } from "../../../src/utils/staticRender.js";

/** The three segments are rendered adjacently, so this is the drawn row. */
function frameText(width: number, toolCount: number, pulseOn = true): string {
  const frame = buildAgentActivityTrackFrame(width, toolCount, pulseOn);
  return frame.filled + frame.head + frame.rest;
}

const MIN_TRACK_WIDTH = 6;

describe("AgentActivityTrack", () => {
  it("keeps every frame exactly as wide as its track", () => {
    for (let toolCount = 0; toolCount < 60; toolCount += 1) {
      expect(stringWidth(frameText(24, toolCount))).toBe(24);
    }
  });

  it("fills one dot per tool call, left to right", () => {
    // `filled` is the earned dots; the head is the one being earned, so the
    // bar reads as work already done rather than a completion estimate.
    expect(buildAgentActivityTrackFrame(8, 0, true).filled).toBe("");
    expect(buildAgentActivityTrackFrame(8, 1, true).filled).toBe("·");
    expect(buildAgentActivityTrackFrame(8, 5, true).filled).toBe("·····");
    expect(buildAgentActivityTrackFrame(8, 7, true).filled).toBe("·······");
  });

  it("wraps into a new lap once the bar is full", () => {
    expect(buildAgentActivityTrackFrame(8, 7, true).laps).toBe(0);
    // A full bar's worth of work starts the next pass with an empty bar.
    const wrapped = buildAgentActivityTrackFrame(8, 8, true);
    expect(wrapped.laps).toBe(1);
    expect(wrapped.filled).toBe("");
    expect(buildAgentActivityTrackFrame(8, 9, true).filled).toBe("·");
    expect(buildAgentActivityTrackFrame(8, 16, true).laps).toBe(2);
  });

  it("pulses the head without moving anything around it", () => {
    // The head alternates between a dot and a blank. If the blank collapsed
    // instead of occupying its cell, the whole row would shift every 450ms.
    const on = buildAgentActivityTrackFrame(12, 4, true);
    const off = buildAgentActivityTrackFrame(12, 4, false);

    expect(on.head).toBe("·");
    expect(off.head).toBe(" ");
    expect(on.filled).toBe(off.filled);
    expect(on.rest).toBe(off.rest);
    expect(stringWidth(frameText(12, 4, false))).toBe(12);
  });

  it("never renders narrower than the minimum track width", () => {
    for (const width of [0, 1, 3, MIN_TRACK_WIDTH - 1]) {
      expect(stringWidth(frameText(width, 2))).toBe(MIN_TRACK_WIDTH);
    }
  });

  it("survives a non-finite tool count instead of collapsing to nothing", () => {
    // A NaN count would turn every repeat() into "" and leave an invisible
    // row, which reads as "no agent" rather than "no work yet".
    for (const toolCount of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(stringWidth(frameText(10, toolCount))).toBe(10);
    }
  });

  it("renders a stable full-width bar when reduced motion is enabled", async () => {
    const output = await renderToString(
      <AgentActivityTrack reducedMotion toolCount={3} width={12} />,
      20,
    );

    // Reduced motion holds the head lit, so the row is every cell drawn.
    expect(stringWidth(output.trim())).toBe(12);
    expect(output.trim()).toBe("·".repeat(12));
  });
});
