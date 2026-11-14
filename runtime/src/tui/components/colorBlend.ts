import type { Color } from '../ink/styles.js';

const RGB_RE = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/;

/** Whether a theme color is an `rgb()` value; the ANSI themes use palette names. */
export function isRgbColor(value: string): boolean {
  return RGB_RE.test(value);
}

/**
 * Mix two `rgb()` colors: weight 0 gives `base`, 1 gives `peak`. Null when
 * either is not an RGB color (the ANSI themes), so callers can fall back to a
 * change of shape instead of a change of tone.
 */
export function blendRgb(base: string, peak: string, weight: number): Color | null {
  const a = RGB_RE.exec(base);
  const b = RGB_RE.exec(peak);
  if (a === null || b === null) return null;
  const w = Math.min(1, Math.max(0, weight));
  const mix = (i: number) => Math.round(Number(a[i]) + (Number(b[i]) - Number(a[i])) * w);
  return `rgb(${mix(1)},${mix(2)},${mix(3)})` as Color;
}
