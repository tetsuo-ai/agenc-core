import { describe, expect, it } from "vitest";

import { buildAgentActivityTrackFrame } from "../../../../src/tui/workbench/agents/AgentActivityTrack.js";

const WIDTH = 10;

describe("agent activity bar", () => {
  it("starts empty and fills one dot per tool call", () => {
    expect(buildAgentActivityTrackFrame(WIDTH, 0, true)).toMatchObject({
      filled: "",
      laps: 0,
    });
    expect(buildAgentActivityTrackFrame(WIDTH, 3, true).filled).toHaveLength(3);
    expect(buildAgentActivityTrackFrame(WIDTH, 7, true).filled).toHaveLength(7);
  });

  it("keeps the bar exactly `width` cells wide at every fill level", () => {
    for (const toolCount of [0, 1, 5, 9, 10, 11, 25]) {
      const frame = buildAgentActivityTrackFrame(WIDTH, toolCount, true);
      expect(
        frame.filled.length + frame.head.length + frame.rest.length,
      ).toBe(WIDTH);
    }
  });

  // The bar measures work done, not percent complete — there is no trustworthy
  // completion estimate from a running agent. Past a full bar it wraps, and the
  // lap count is what tells the renderer to brighten the remainder so a second
  // pass does not read as "the agent started over".
  it("wraps into laps instead of saturating", () => {
    expect(buildAgentActivityTrackFrame(WIDTH, 10, true)).toMatchObject({
      filled: "",
      laps: 1,
    });
    expect(buildAgentActivityTrackFrame(WIDTH, 23, true)).toMatchObject({
      laps: 2,
    });
    expect(buildAgentActivityTrackFrame(WIDTH, 23, true).filled).toHaveLength(3);
  });

  it("pulses only the next dot, and never loses a cell doing it", () => {
    const on = buildAgentActivityTrackFrame(WIDTH, 4, true);
    const off = buildAgentActivityTrackFrame(WIDTH, 4, false);
    expect(on.head).toBe("·");
    expect(off.head).toBe(" ");
    expect(on.filled).toBe(off.filled);
    expect(on.rest).toBe(off.rest);
  });

  it("never renders a negative or fractional fill", () => {
    for (const toolCount of [-5, 0.4, Number.NaN]) {
      const frame = buildAgentActivityTrackFrame(WIDTH, toolCount, true);
      expect(frame.filled).toBe("");
      expect(frame.rest.length + frame.head.length).toBe(WIDTH);
    }
  });

  it("honours a floor width so a narrow rail still shows a bar", () => {
    const frame = buildAgentActivityTrackFrame(2, 0, true);
    expect(frame.filled.length + frame.head.length + frame.rest.length).toBe(6);
  });
});
