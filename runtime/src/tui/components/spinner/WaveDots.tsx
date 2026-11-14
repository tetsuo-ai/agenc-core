import React, { useEffect, useState } from 'react';

import { getTheme, type ThemeName } from '../../../utils/theme.js';
import { blendRgb, isRgbColor } from '../colorBlend.js';
import { useTheme } from '../design-system/ThemeProvider.js';
import ThemedText from '../design-system/ThemedText.js';
import { Text } from '../../ink.js';

/** One step of the wave, on the clock the verb shimmer used (12.5 steps a second). */
export const WAVE_FRAME_MS = 80;
/** Steps in one pass: the light crosses the three dots, then rests. */
export const WAVE_CYCLE_FRAMES = 12;
export const WAVE_DOT_COUNT = 3;
export const WAVE_DOT = '•';
/** An unlit dot in the ANSI themes, which cannot blend tones. */
export const WAVE_DOT_UNLIT = '·';
/** Columns the mark takes before the verb: the dots and one space. */
export const WAVE_PREFIX_WIDTH = WAVE_DOT_COUNT + 1;
/** How far the light reaches on each side of its center, in dots. */
const WAVE_RADIUS = 1.2;
/** An unlit dot sits this far from the accent toward the surface. */
const WAVE_UNLIT_MIX = 0.65;
/**
 * The unlit tone of the owner-approved mockup (2026-11-14) for the themes it
 * showed; the other RGB themes mix their own accent toward the surface.
 */
const WAVE_UNLIT: Partial<Record<ThemeName, string>> = {
  olive: 'rgb(84,60,58)',
  light: 'rgb(216,196,236)',
  'light-daltonized': 'rgb(216,196,236)',
};

/**
 * How lit one dot is on a given step, 0 to 1. The light enters at the first
 * dot, moves right across all three, then rests off the end before the next
 * pass, so the row reads like someone typing.
 */
export function waveWeight(frame: number, dot: number): number {
  const head = (((frame % WAVE_CYCLE_FRAMES) + WAVE_CYCLE_FRAMES) % WAVE_CYCLE_FRAMES) / 2;
  return Math.max(0, 1 - Math.abs(head - dot) / WAVE_RADIUS);
}

/**
 * The mark before "Working…": three dots that light up left to right in the
 * accent color while a turn is in flight. Under reduced motion the dots hold
 * still. The ANSI themes cannot blend tones, so a lit dot is a full dot in the
 * accent and an unlit one a small gray dot.
 */
export function WaveDots({ reducedMotion = false }: { readonly reducedMotion?: boolean }): React.ReactNode {
  const [frame, setFrame] = useState(0);
  const [themeSetting] = useTheme();
  const themeName: ThemeName = themeSetting;
  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(() => setFrame(value => value + 1), WAVE_FRAME_MS);
    return () => clearInterval(timer);
  }, [reducedMotion]);

  if (reducedMotion) {
    return <ThemedText color="accentSoft">{WAVE_DOT.repeat(WAVE_DOT_COUNT)}</ThemedText>;
  }
  const theme = getTheme(themeName);
  // The ANSI themes have no RGB accent to light, so they change shape instead.
  const unlit = isRgbColor(theme.accent)
    ? WAVE_UNLIT[themeName] ?? blendRgb(theme.accent, theme.background, WAVE_UNLIT_MIX)
    : null;
  // One inline text run, so the dots stay on one line wherever they sit.
  return (
    <Text>
      {Array.from({ length: WAVE_DOT_COUNT }, (_, dot) => {
        const weight = waveWeight(frame, dot);
        if (unlit === null) {
          const lit = weight >= 0.5;
          return (
            <ThemedText key={dot} color={lit ? 'accent' : 'subtle'}>
              {lit ? WAVE_DOT : WAVE_DOT_UNLIT}
            </ThemedText>
          );
        }
        return (
          <ThemedText key={dot} color={blendRgb(unlit, theme.accent, weight) ?? 'accent'}>
            {WAVE_DOT}
          </ThemedText>
        );
      })}
    </Text>
  );
}
