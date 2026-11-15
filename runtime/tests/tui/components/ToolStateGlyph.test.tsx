import { describe, expect, it } from "vitest";

import {
  TOOL_BREATH_CYCLE_FRAMES,
  TOOL_BREATH_FRAME_MS,
  toolBreathShape,
  toolBreathWeight,
  toolStaticGlyph,
} from "./ToolStateGlyph.js";

const STARS = ["✢", "✳", "✶", "✻", "✽"];
const STATES = ["queued", "running", "done", "failed"] as const;

/**
 * A running tool or agent row shows one dot that breathes between two grays;
 * a finished row keeps a solid dot. Owner pick of 2026-11-14 (working mark C,
 * with the breathing dot on running rows). It replaced a sweeping star whose
 * frames looked like another tool's spinner.
 */
describe("tool state glyphs", () => {
  it("breathes from rest to full and back over one cycle", () => {
    expect(toolBreathWeight(0)).toBe(0);
    expect(toolBreathWeight(TOOL_BREATH_CYCLE_FRAMES / 2)).toBeCloseTo(1);
    expect(toolBreathWeight(TOOL_BREATH_CYCLE_FRAMES)).toBe(0);
    for (let frame = 0; frame < TOOL_BREATH_CYCLE_FRAMES; frame++) {
      expect(toolBreathWeight(frame)).toBeGreaterThanOrEqual(0);
      expect(toolBreathWeight(frame)).toBeLessThanOrEqual(1);
    }
  });

  it("breathes by shape where tones cannot blend, in both glyph modes", () => {
    for (const ascii of [false, true]) {
      const shapes = Array.from({ length: TOOL_BREATH_CYCLE_FRAMES }, (_, frame) => toolBreathShape(frame, ascii));
      expect(new Set(shapes).size).toBeGreaterThanOrEqual(3);
      for (const shape of shapes) expect([...shape]).toHaveLength(1);
    }
    for (let frame = 0; frame < TOOL_BREATH_CYCLE_FRAMES; frame++) {
      expect(toolBreathShape(frame, true).codePointAt(0)!).toBeLessThan(128);
    }
  });

  it("never shows a star", () => {
    for (const ascii of [false, true]) {
      for (const state of STATES) expect(STARS).not.toContain(toolStaticGlyph(state, ascii));
      for (let frame = 0; frame < TOOL_BREATH_CYCLE_FRAMES; frame++) {
        expect(STARS).not.toContain(toolBreathShape(frame, ascii));
      }
    }
  });

  it("finishes on a solid dot", () => {
    expect(toolStaticGlyph("done", false)).toBe("●");
  });

  // Reduced motion freezes `running` on its static glyph. If that matched
  // `done`, a user with animations off could not tell a live tool from a
  // finished one, the one thing this column exists to say.
  it("keeps every static state distinguishable", () => {
    for (const ascii of [false, true]) {
      const glyphs = STATES.map((state) => toolStaticGlyph(state, ascii));
      expect(new Set(glyphs).size).toBe(glyphs.length);
    }
  });

  it("breathes slowly, so a column of running rows stays calm", () => {
    expect(TOOL_BREATH_FRAME_MS * TOOL_BREATH_CYCLE_FRAMES).toBeGreaterThanOrEqual(1200);
  });
});
