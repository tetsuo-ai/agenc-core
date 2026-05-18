import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { Text } from '../../ink.js'
import { useShimmerAnimation } from './useShimmerAnimation.js'
import {
  computeBriefRightStatusLayout,
  computeSpinnerMessageMaxWidth,
  getDefaultCharacters,
  getReducedMotionDot,
  getSpinnerEllipsis,
  hueToRgb,
  interpolateColor,
  parseRGB,
  truncateSpinnerText,
  toRGBColor,
} from './utils.js'
import type { SpinnerMode } from './types.js'

const originalTerm = process.env.TERM
const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

afterEach(() => {
  if (originalTerm === undefined) {
    delete process.env.TERM
  } else {
    process.env.TERM = originalTerm
  }
  if (originalGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = originalGlyphMode
  }
})

describe('spinner primitives', () => {
  test('interpolates and formats RGB colors', () => {
    expect(interpolateColor({ r: 10, g: 20, b: 30 }, { r: 30, g: 60, b: 90 }, 0.5))
      .toEqual({ r: 20, g: 40, b: 60 })
    expect(toRGBColor({ r: 20, g: 40, b: 60 })).toBe('rgb(20,40,60)')
    expect(parseRGB('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3 })
    expect(parseRGB('not-rgb')).toBeNull()
  })

  test('uses deterministic voice hue conversion and terminal spinner frames', () => {
    process.env.TERM = 'xterm-ghostty'

    expect(hueToRgb(0)).toEqual({ r: 224, g: 82, b: 82 })
    expect(hueToRgb(120)).toEqual({ r: 82, g: 224, b: 82 })
    expect(getDefaultCharacters()).toEqual(['·', '✢', '✳', '✶', '✻', '*'])
  })

  test('uses ASCII spinner glyph primitives when ASCII glyphs are requested', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' }

    expect(getDefaultCharacters(env)).toEqual(['-', '\\', '|', '/'])
    expect(getReducedMotionDot(env)).toBe('*')
    expect(getSpinnerEllipsis(env)).toBe('...')
  })

  test('keeps shimmer disabled for the v2 terminal visual contract', async () => {
    expect(await renderToString(
      <ShimmerProbe mode="requesting" message="working" isStalled={false} />,
      80,
    )).toContain('-100')

    expect(await renderToString(
      <ShimmerProbe mode="responding" message="go" isStalled={false} />,
      80,
    )).toContain('-100')

    expect(await renderToString(
      <ShimmerProbe mode="thinking" message="working" isStalled />,
      80,
    )).toContain('-100')
  })

  test('truncates spinner messages to the visible row budget', () => {
    expect(computeSpinnerMessageMaxWidth(20)).toBe(17)
    expect(computeSpinnerMessageMaxWidth(2)).toBe(0)
    expect(truncateSpinnerText('Reading a very long task subject', 12, '...')).toBe('Reading a...')
    expect(truncateSpinnerText('Reading', 12, '...')).toBe('Reading')
  })

  test('hides or truncates brief right-side status before overflow', () => {
    expect(computeBriefRightStatusLayout(24, 8, '3 in background')).toEqual({
      pad: 1,
      rightText: '3 in backgro…',
    })
    expect(computeBriefRightStatusLayout(16, 14, '3 in background')).toEqual({
      pad: 0,
      rightText: '',
    })
  })
})

function ShimmerProbe({
  mode,
  message,
  isStalled,
}: {
  mode: SpinnerMode
  message: string
  isStalled: boolean
}): React.ReactNode {
  const [, glimmerIndex] = useShimmerAnimation(mode, message, isStalled)
  return <Text>{String(glimmerIndex)}</Text>
}
