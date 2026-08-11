import { describe, expect, it } from "vitest";

import {
  TOOL_STAR_FRAME_MS,
  toolStarFrames,
  toolStaticGlyph,
} from "./ToolStateGlyph.js";

/**
 * The glyph beside a tool call used to be a lifecycle circle (`○ ◐ ● ✕`).
 * User report: "the svg next to the tool is a circle now, I'd like an animated
 * ascii star whose points move". These assertions pin the two properties that
 * make that work: the frames are stars that actually change, and every state
 * stays distinguishable when motion is off.
 */
describe("tool star glyphs", () => {
  it("animates through distinct star frames in both glyph modes", () => {
    for (const ascii of [false, true]) {
      const frames = toolStarFrames(ascii);
      expect(frames.length).toBeGreaterThanOrEqual(4);
      expect(new Set(frames).size).toBeGreaterThanOrEqual(3);
      for (const frame of frames) {
        expect([...frame]).toHaveLength(1);
      }
    }
  });

  it("keeps ascii frames inside 7-bit ascii", () => {
    for (const frame of toolStarFrames(true)) {
      expect(frame.codePointAt(0)!).toBeLessThan(128);
    }
  });

  it("never renders a circle for a tool state", () => {
    for (const ascii of [false, true]) {
      for (const state of ["queued", "running", "done", "failed"] as const) {
        expect(["●", "◐", "○"]).not.toContain(toolStaticGlyph(state, ascii));
      }
    }
  });

  // Reduced motion freezes `running` on its static glyph. If that matched
  // `done`, a user with animations off could not tell a live tool from a
  // finished one — the one thing this column exists to say.
  it("keeps every static state distinguishable", () => {
    for (const ascii of [false, true]) {
      const glyphs = (["queued", "running", "done", "failed"] as const).map(
        (state) => toolStaticGlyph(state, ascii),
      );
      expect(new Set(glyphs).size).toBe(glyphs.length);
    }
  });

  it("ticks slower than the composer spinner so a column of rows is calm", () => {
    expect(TOOL_STAR_FRAME_MS).toBeGreaterThan(90);
  });
});
