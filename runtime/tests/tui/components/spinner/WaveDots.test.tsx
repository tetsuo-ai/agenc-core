import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import {
  WAVE_CYCLE_FRAMES,
  WAVE_DOT,
  WAVE_DOT_COUNT,
  WAVE_FRAME_MS,
  WaveDots,
  waveWeight,
} from './WaveDots.js'

/** The dot that is most lit on a step, or -1 while the light rests. */
function litDot(frame: number): number {
  let best = -1
  let bestWeight = 0.5
  for (let dot = 0; dot < WAVE_DOT_COUNT; dot += 1) {
    const weight = waveWeight(frame, dot)
    if (weight >= bestWeight) {
      best = dot
      bestWeight = weight
    }
  }
  return best
}

/**
 * The Working line's mark (owner pick, 2026-11-14, mockup C "Wave"): three
 * dots light up left to right, then the light rests before the next pass.
 */
describe('wave dots', () => {
  test('the light crosses the dots left to right, then rests', () => {
    const order = Array.from({ length: WAVE_CYCLE_FRAMES }, (_, frame) => litDot(frame))
    const passes = order.filter((dot, index) => dot !== -1 && dot !== order[index - 1])
    expect(passes).toEqual([0, 1, 2])
    expect(order.at(-1)).toBe(-1)
  })

  test('every step repeats after one cycle', () => {
    for (let frame = 0; frame < WAVE_CYCLE_FRAMES; frame += 1) {
      for (let dot = 0; dot < WAVE_DOT_COUNT; dot += 1) {
        expect(waveWeight(frame + WAVE_CYCLE_FRAMES, dot)).toBe(waveWeight(frame, dot))
      }
    }
  })

  test('runs on the shimmer clock, about a second a pass', () => {
    expect(WAVE_FRAME_MS).toBe(80)
    expect(WAVE_FRAME_MS * WAVE_CYCLE_FRAMES).toBeGreaterThanOrEqual(900)
  })

  test('draws three dots, still under reduced motion', async () => {
    expect(await renderToString(<WaveDots />, 20)).toContain(WAVE_DOT.repeat(WAVE_DOT_COUNT))
    expect(await renderToString(<WaveDots reducedMotion />, 20)).toContain(WAVE_DOT.repeat(WAVE_DOT_COUNT))
  })
})
