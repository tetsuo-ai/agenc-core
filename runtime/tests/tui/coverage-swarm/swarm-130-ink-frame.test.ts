import { describe, expect, test } from 'vitest'

import {
  emptyFrame,
  shouldClearScreen,
  type Frame,
} from '../../../src/tui/ink/frame.js'
import {
  CharPool,
  createScreen,
  HyperlinkPool,
  isEmptyCellAt,
  StylePool,
} from '../../../src/tui/ink/screen.js'

function makePools(): {
  stylePool: StylePool
  charPool: CharPool
  hyperlinkPool: HyperlinkPool
} {
  return {
    charPool: new CharPool(),
    hyperlinkPool: new HyperlinkPool(),
    stylePool: new StylePool(),
  }
}

function makeFrame({
  screenHeight,
  viewportHeight,
  viewportWidth = 12,
}: {
  screenHeight: number
  viewportHeight: number
  viewportWidth?: number
}): Frame {
  const pools = makePools()

  return {
    cursor: { visible: true, x: 0, y: 0 },
    screen: createScreen(
      4,
      screenHeight,
      pools.stylePool,
      pools.charPool,
      pools.hyperlinkPool,
    ),
    viewport: { height: viewportHeight, width: viewportWidth },
  }
}

describe('frame coverage swarm row 130', () => {
  test('emptyFrame builds a zero-sized screen while preserving viewport and cursor defaults', () => {
    const pools = makePools()
    const frame = emptyFrame(
      24,
      80,
      pools.stylePool,
      pools.charPool,
      pools.hyperlinkPool,
    )

    expect(frame.viewport).toEqual({ height: 24, width: 80 })
    expect(frame.cursor).toEqual({ visible: true, x: 0, y: 0 })
    expect(frame.screen.width).toBe(0)
    expect(frame.screen.height).toBe(0)
    expect(frame.screen.charPool).toBe(pools.charPool)
    expect(frame.screen.hyperlinkPool).toBe(pools.hyperlinkPool)
    expect(frame.screen.emptyStyleId).toBe(pools.stylePool.none)
    expect(isEmptyCellAt(frame.screen, 0, 0)).toBe(true)
    expect(frame.scrollHint).toBeUndefined()
    expect(frame.scrollDrainPending).toBeUndefined()
  })

  test('shouldClearScreen returns undefined when viewport is unchanged and frames fit', () => {
    const prev = makeFrame({ screenHeight: 2, viewportHeight: 4 })
    const next = makeFrame({ screenHeight: 3, viewportHeight: 4 })

    expect(shouldClearScreen(prev, next)).toBeUndefined()
  })

  test('shouldClearScreen reports resize for viewport height changes before overflow checks', () => {
    const prev = makeFrame({ screenHeight: 6, viewportHeight: 6 })
    const next = makeFrame({ screenHeight: 7, viewportHeight: 8 })

    expect(shouldClearScreen(prev, next)).toBe('resize')
  })

  test('shouldClearScreen reports resize for viewport width changes', () => {
    const prev = makeFrame({
      screenHeight: 1,
      viewportHeight: 4,
      viewportWidth: 12,
    })
    const next = makeFrame({
      screenHeight: 1,
      viewportHeight: 4,
      viewportWidth: 10,
    })

    expect(shouldClearScreen(prev, next)).toBe('resize')
  })

  test('shouldClearScreen reports offscreen when the current screen reaches the viewport height', () => {
    const prev = makeFrame({ screenHeight: 2, viewportHeight: 4 })
    const next = makeFrame({ screenHeight: 4, viewportHeight: 4 })

    expect(shouldClearScreen(prev, next)).toBe('offscreen')
  })

  test('shouldClearScreen keeps clearing while the previous frame was offscreen', () => {
    const prev = makeFrame({ screenHeight: 4, viewportHeight: 4 })
    const next = makeFrame({ screenHeight: 2, viewportHeight: 4 })

    expect(shouldClearScreen(prev, next)).toBe('offscreen')
  })
})
