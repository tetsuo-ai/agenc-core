import React, { useEffect, useState } from "react";

import type { Theme } from "../../../utils/theme.js";
import { resolveAgenCTuiGlyphMode } from "../../glyphs.js";
import { Text } from "../../ink.js";

type ActivityMarkFrame = {
  readonly glyph: string;
  readonly inverse: boolean;
};

/**
 * Two terminal cells give Braille a 4×4 pixel matrix. The twelve outer pixels
 * stay fixed as a square while a one/two-pixel comet walks clockwise through
 * the four inner positions. After each orbit the whole micro-display reverses
 * polarity (white-on-black → black-on-white), giving the mark a distinctive
 * monochrome "data core" feel without moving the adjacent label.
 */
const BRAILLE_SPIRAL = [
  "⣟⣹",
  "⣟⣻",
  "⣏⣻",
  "⣏⣿",
  "⣏⣽",
  "⣯⣽",
  "⣯⣹",
  "⣿⣹",
] as const;

const ASCII_SPIRAL = [
  "[.",
  "[:",
  "[#",
  "#]",
  ":]",
  ".]",
  "[]",
  "[]",
] as const;

function polarityCycle(frames: readonly string[]): readonly ActivityMarkFrame[] {
  return [
    ...frames.map((glyph) => ({ glyph, inverse: false })),
    ...frames.map((glyph) => ({ glyph, inverse: true })),
  ];
}

export const AGENC_ACTIVITY_MARK_FRAMES = polarityCycle(BRAILLE_SPIRAL);
export const AGENC_ACTIVITY_MARK_ASCII_FRAMES = polarityCycle(ASCII_SPIRAL);
export const AGENC_ACTIVITY_MARK_FRAME_MS = 90;
export const AGENC_ACTIVITY_MARK_STATIC = "⣏⣹";

export function AgenCActivityMark({
  color = "suggestion",
  reducedMotion = false,
}: {
  readonly color?: keyof Theme;
  readonly reducedMotion?: boolean;
}): React.ReactElement {
  const ascii = resolveAgenCTuiGlyphMode() === "ascii";
  const frames = ascii
    ? AGENC_ACTIVITY_MARK_ASCII_FRAMES
    : AGENC_ACTIVITY_MARK_FRAMES;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(
      () => setFrame((value) => (value + 1) % frames.length),
      AGENC_ACTIVITY_MARK_FRAME_MS,
    );
    return () => clearInterval(timer);
  }, [frames, reducedMotion]);

  const current: ActivityMarkFrame = reducedMotion
    ? {
        glyph: ascii ? "[]" : AGENC_ACTIVITY_MARK_STATIC,
        inverse: false,
      }
    : frames[frame] ?? frames[0];

  return (
    <Text color={color} inverse={current.inverse}>
      {current.glyph}
    </Text>
  );
}
