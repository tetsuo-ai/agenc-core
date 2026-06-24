import { describe, expect, test, vi } from 'vitest'

import {
  computeBriefRightStatusLayout,
  getDefaultCharacters,
  hueToRgb,
  parseRGB,
  truncateSpinnerText,
} from './utils.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: platform,
  })
  try {
    return callback()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
}

describe('spinner utility coverage edges', () => {
  test('handles narrow layouts, unicode frame fallbacks, hue sectors, and cached RGB parsing', () => {
    // The Linux/default unicode fallback now mirrors the macOS flower-star
    // frame family: index 2 is `✳`, not a bare ASCII `*` (the `*` rendered as a
    // thin glyph that flickered between the fat unicode stars each cycle).
    expect(withPlatform('linux', () => getDefaultCharacters({ TERM: 'xterm-256color' }))).toEqual([
      '·',
      '✢',
      '✳',
      '✶',
      '✻',
      '✽',
    ])
    expect(withPlatform('darwin', () => getDefaultCharacters({ TERM: 'xterm-256color' }))).toEqual([
      '·',
      '✢',
      '✳',
      '✶',
      '✻',
      '✽',
    ])

    expect(truncateSpinnerText('waiting', 0, '...')).toBe('')
    expect(truncateSpinnerText('waiting', 2, '...')).toBe('..')

    expect(computeBriefRightStatusLayout(20, 4, '')).toEqual({
      pad: 0,
      rightText: '',
    })
    expect(computeBriefRightStatusLayout(10, 5, 'busy')).toEqual({
      pad: 0,
      rightText: '',
    })
    expect(computeBriefRightStatusLayout(20, 4, '\u200b')).toEqual({
      pad: 0,
      rightText: '',
    })

    expect(hueToRgb(60)).toEqual({ r: 224, g: 224, b: 82 })
    expect(hueToRgb(180)).toEqual({ r: 82, g: 224, b: 224 })
    expect(hueToRgb(240)).toEqual({ r: 82, g: 82, b: 224 })
    expect(hueToRgb(300)).toEqual({ r: 224, g: 82, b: 224 })

    const parsed = parseRGB('rgb(9, 8, 7)')
    expect(parsed).toEqual({ r: 9, g: 8, b: 7 })
    expect(parseRGB('rgb(9, 8, 7)')).toBe(parsed)
  })
})
