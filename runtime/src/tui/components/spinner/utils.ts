import {
  resolveAgenCTuiGlyphMode,
  selectAgenCTuiGlyphs,
} from '../../glyphs.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../../../utils/intl.js'
import type { RGBColor as RGBColorString } from '../../ink/styles.js'
import type { RGBColor as RGBColorType, SpinnerMode } from './types.js'

/**
 * Single source of truth for the plain-language phase label of a streaming
 * turn. Both the workbench title-bar indicator and the composer status line
 * read this so they always agree (e.g. the title bar showing "responding…"
 * while the status line shows a different word is a known confusion bug).
 *
 * This is an HONEST description of what the model is actually doing right now,
 * derived from the real SpinnerMode — never a random flavor word that could be
 * misread as a system fault (e.g. "Booting…" stuck for minutes).
 */
export function verbForMode(mode: SpinnerMode): string {
  switch (mode) {
    case 'tool-use':
      return 'running tools'
    case 'tool-input':
      return 'preparing tools'
    case 'thinking':
      return 'thinking'
    case 'responding':
      return 'responding'
    case 'requesting':
      return 'working'
    // Any unexpected/legacy mode value degrades to the neutral honest label
    // rather than blank or a crash.
    default:
      return 'working'
  }
}

/** Title-case variant for the composer status line ("Responding…"). */
export function titleVerbForMode(mode: SpinnerMode): string {
  const verb = verbForMode(mode)
  return verb.charAt(0).toUpperCase() + verb.slice(1)
}

type SpinnerGlyphEnv = {
  readonly AGENC_TUI_GLYPHS?: string
  readonly TERM?: string
}

export function getDefaultCharacters(
  env: SpinnerGlyphEnv = process.env,
): string[] {
  const glyphs = selectAgenCTuiGlyphs(env)
  if (resolveAgenCTuiGlyphMode(env) === 'ascii') {
    return [...glyphs.spinnerFrames]
  }
  if (env.TERM === 'xterm-ghostty') {
    return ['·', '✢', '✳', '✶', '✻', '*'] // Use * instead of ✽ for Ghostty because the latter renders in a way that's slightly offset
  }
  return process.platform === 'darwin'
    ? [...glyphs.spinnerFrames]
    : // Mirror the macOS flower-star frame family (glyphs.spinnerFrames). The
      // index-2 frame is `✳`, NOT a bare ASCII `*`: the asterisk renders as a
      // thin glyph between the fat unicode stars and visibly flickers each
      // animation cycle. (The Ghostty branch above keeps a `*` deliberately,
      // with a documented offset-rendering rationale.)
      ['·', '✢', '✳', '✶', '✻', '✽']
}

export function getReducedMotionDot(
  env: SpinnerGlyphEnv = process.env,
): string {
  return selectAgenCTuiGlyphs(env).spinnerReducedMotionDot
}

export function getSpinnerEllipsis(
  env: SpinnerGlyphEnv = process.env,
): string {
  return selectAgenCTuiGlyphs(env).ellipsis
}

export function truncateSpinnerText(
  text: string,
  maxWidth: number,
  ellipsis: string = getSpinnerEllipsis(),
): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text

  const ellipsisWidth = stringWidth(ellipsis)
  if (ellipsisWidth >= maxWidth) {
    let width = 0
    let result = ''
    for (const { segment } of getGraphemeSegmenter().segment(ellipsis)) {
      const segmentWidth = stringWidth(segment)
      if (width + segmentWidth > maxWidth) break
      result += segment
      width += segmentWidth
    }
    return result
  }

  let width = 0
  let result = ''
  const textWidth = maxWidth - ellipsisWidth
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const segmentWidth = stringWidth(segment)
    if (width + segmentWidth > textWidth) break
    result += segment
    width += segmentWidth
  }
  return result + ellipsis
}

export function computeSpinnerMessageMaxWidth(columns: number): number {
  return Math.max(0, Math.floor(columns) - 3)
}

export function computeBriefRightStatusLayout(
  columns: number,
  leftWidth: number,
  rightText: string,
): { pad: number; rightText: string } {
  if (!rightText) return { pad: 0, rightText: '' }

  const contentWidth = Math.max(0, Math.floor(columns) - 2)
  if (contentWidth <= leftWidth) return { pad: 0, rightText: '' }

  const maxRightWidth = contentWidth - leftWidth - 1
  if (maxRightWidth < 4) return { pad: 0, rightText: '' }

  const visibleRightText = truncateSpinnerText(rightText, maxRightWidth)
  const visibleRightWidth = stringWidth(visibleRightText)
  if (visibleRightWidth === 0) return { pad: 0, rightText: '' }

  return {
    pad: Math.max(1, contentWidth - leftWidth - visibleRightWidth),
    rightText: visibleRightText,
  }
}

// Interpolate between two RGB colors
export function interpolateColor(
  color1: RGBColorType,
  color2: RGBColorType,
  t: number, // 0 to 1
): RGBColorType {
  return {
    r: Math.round(color1.r + (color2.r - color1.r) * t),
    g: Math.round(color1.g + (color2.g - color1.g) * t),
    b: Math.round(color1.b + (color2.b - color1.b) * t),
  }
}

// Convert RGB object to rgb() color string for Text component
export function toRGBColor(color: RGBColorType): RGBColorString {
  return `rgb(${color.r},${color.g},${color.b})`
}

// HSL hue (0-360) to RGB, using voice-mode waveform parameters (s=0.7, l=0.6).
export function hueToRgb(hue: number): RGBColorType {
  const h = ((hue % 360) + 360) % 360
  const s = 0.7
  const l = 0.6
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) {
    r = c
    g = x
  } else if (h < 120) {
    r = x
    g = c
  } else if (h < 180) {
    g = c
    b = x
  } else if (h < 240) {
    g = x
    b = c
  } else if (h < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

const RGB_CACHE = new Map<string, RGBColorType | null>()

export function parseRGB(colorStr: string): RGBColorType | null {
  const cached = RGB_CACHE.get(colorStr)
  if (cached !== undefined) return cached

  const match = colorStr.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/)
  const result = match
    ? {
        r: parseInt(match[1]!, 10),
        g: parseInt(match[2]!, 10),
        b: parseInt(match[3]!, 10),
      }
    : null
  RGB_CACHE.set(colorStr, result)
  return result
}
