import React, { useEffect, useState } from "react";

import { getTheme, type Theme } from "../../../utils/theme.js";
import type { Color } from "../../ink/styles.js";
import { useTheme } from "../design-system/ThemeProvider.js";
import ThemedText from "../design-system/ThemedText.js";

/** One frame of the sweep; about twelve frames a second. */
export const SHIMMER_FRAME_MS = 80;
/** Half-width of the band of light, in characters. */
const SHIMMER_RADIUS = 2.5;
/** Pause between sweeps, in frames. */
const SHIMMER_REST_FRAMES = 6;

const RGB_RE = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/;

/** Mix two `rgb()` colors; null when either is not an RGB color (ANSI). */
function blend(base: string, peak: string, weight: number): Color | null {
  const a = RGB_RE.exec(base);
  const b = RGB_RE.exec(peak);
  if (a === null || b === null) return null;
  const mix = (i: number) =>
    Math.round(Number(a[i]) + (Number(b[i]) - Number(a[i])) * weight);
  return `rgb(${mix(1)},${mix(2)},${mix(3)})` as Color;
}

/**
 * Where the band of light sits on a given frame: it enters from the left,
 * crosses the word, then rests off the word before the next pass.
 */
export function shimmerCenter(frame: number, length: number): number {
  const cycle = Math.ceil(length + 2 * SHIMMER_RADIUS) + SHIMMER_REST_FRAMES;
  return (frame % cycle) - SHIMMER_RADIUS;
}

/**
 * The working verb with a band of light sweeping across it, so the line
 * reads as alive without a spinner glyph. It runs only while mounted (a
 * turn is in flight) and holds still under reduced motion. Themes without
 * RGB colors (ANSI) switch letters between the two colors instead of
 * blending.
 */
export function ShimmerVerb({
  text,
  base,
  peak,
  reducedMotion = false,
}: {
  readonly text: string;
  readonly base: keyof Theme;
  readonly peak: keyof Theme;
  readonly reducedMotion?: boolean;
}): React.ReactNode {
  const [frame, setFrame] = useState(0);
  const [themeName] = useTheme();
  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(() => setFrame((value) => value + 1), SHIMMER_FRAME_MS);
    return () => clearInterval(timer);
  }, [reducedMotion]);

  if (reducedMotion) {
    return <ThemedText color={base}>{text}</ThemedText>;
  }
  const theme = getTheme(themeName);
  const chars = [...text];
  const center = shimmerCenter(frame, chars.length);
  return (
    <>
      {chars.map((char, index) => {
        const weight = Math.max(0, 1 - Math.abs(index - center) / SHIMMER_RADIUS);
        const color =
          (weight > 0 ? blend(theme[base], theme[peak], weight) : null) ??
          (weight >= 0.5 ? peak : base);
        return (
          <ThemedText key={index} color={color}>
            {char}
          </ThemedText>
        );
      })}
    </>
  );
}
