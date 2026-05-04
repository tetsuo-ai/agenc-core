import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../agenc/upstream/utils/staticRender.js'
import { Text } from '../../ink.js'
import { useShimmerAnimation } from './useShimmerAnimation.js'
import {
  getDefaultCharacters,
  hueToRgb,
  interpolateColor,
  parseRGB,
  toRGBColor,
} from './utils.js'
import type { SpinnerMode } from './types.js'

const originalTerm = process.env.TERM

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

afterEach(() => {
  if (originalTerm === undefined) {
    delete process.env.TERM
  } else {
    process.env.TERM = originalTerm
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

  test('computes shimmer positions from render-time hook state', async () => {
    expect(await renderToString(
      <ShimmerProbe mode="requesting" message="working" isStalled={false} />,
      80,
    )).toContain('-10')

    expect(await renderToString(
      <ShimmerProbe mode="responding" message="go" isStalled={false} />,
      80,
    )).toContain('12')

    expect(await renderToString(
      <ShimmerProbe mode="thinking" message="working" isStalled />,
      80,
    )).toContain('-100')
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
