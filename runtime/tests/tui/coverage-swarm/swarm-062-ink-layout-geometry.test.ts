import { describe, expect, test } from 'vitest'

import {
  ZERO_EDGES,
  addEdges,
  clamp,
  clampRect,
  edges,
  resolveEdges,
  unionRect,
  withinBounds,
} from '../../../src/tui/ink/layout/geometry.js'

describe('ink layout geometry coverage swarm row 062', () => {
  test('creates and combines edge values across overloads', () => {
    expect(edges(3)).toEqual({ top: 3, right: 3, bottom: 3, left: 3 })
    expect(edges(2, 5)).toEqual({ top: 2, right: 5, bottom: 2, left: 5 })
    expect(edges(1, 2, 3, 4)).toEqual({
      top: 1,
      right: 2,
      bottom: 3,
      left: 4,
    })

    expect(addEdges(edges(1, 2, 3, 4), edges(4, 3, 2, 1))).toEqual({
      top: 5,
      right: 5,
      bottom: 5,
      left: 5,
    })
  })

  test('resolves missing edge values to zero while preserving provided values', () => {
    expect(ZERO_EDGES).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    expect(resolveEdges()).toEqual(ZERO_EDGES)
    expect(resolveEdges({ top: 1, bottom: 0 })).toEqual({
      top: 1,
      right: 0,
      bottom: 0,
      left: 0,
    })
    expect(resolveEdges({ right: -2, left: 4 })).toEqual({
      top: 0,
      right: -2,
      bottom: 0,
      left: 4,
    })
  })

  test('unions rectangles using the outermost occupied coordinates', () => {
    expect(
      unionRect(
        { x: 3, y: 4, width: 5, height: 2 },
        { x: -1, y: 6, width: 2, height: 3 },
      ),
    ).toEqual({ x: -1, y: 4, width: 9, height: 5 })

    expect(
      unionRect(
        { x: 0, y: 0, width: 2, height: 2 },
        { x: 1, y: 1, width: 1, height: 1 },
      ),
    ).toEqual({ x: 0, y: 0, width: 2, height: 2 })
  })

  test('clamps rectangles to the available size including empty intersections', () => {
    expect(
      clampRect({ x: -2, y: -1, width: 5, height: 4 }, { width: 4, height: 3 }),
    ).toEqual({ x: 0, y: 0, width: 3, height: 3 })

    expect(
      clampRect({ x: 1, y: 1, width: 2, height: 2 }, { width: 5, height: 5 }),
    ).toEqual({ x: 1, y: 1, width: 2, height: 2 })

    expect(
      clampRect({ x: 7, y: 2, width: 3, height: 3 }, { width: 5, height: 5 }),
    ).toEqual({ x: 7, y: 2, width: 0, height: 3 })

    expect(
      clampRect({ x: 2, y: 8, width: 3, height: 3 }, { width: 5, height: 5 }),
    ).toEqual({ x: 2, y: 8, width: 3, height: 0 })
  })

  test('checks points against inclusive lower and exclusive upper bounds', () => {
    const size = { width: 3, height: 2 }

    expect(withinBounds(size, { x: 0, y: 0 })).toBe(true)
    expect(withinBounds(size, { x: 2, y: 1 })).toBe(true)
    expect(withinBounds(size, { x: -1, y: 0 })).toBe(false)
    expect(withinBounds(size, { x: 0, y: -1 })).toBe(false)
    expect(withinBounds(size, { x: 3, y: 1 })).toBe(false)
    expect(withinBounds(size, { x: 1, y: 2 })).toBe(false)
  })

  test('clamps numbers only when bounds are provided and exceeded', () => {
    expect(clamp(5)).toBe(5)
    expect(clamp(-2, 0)).toBe(0)
    expect(clamp(3, 0)).toBe(3)
    expect(clamp(9, undefined, 4)).toBe(4)
    expect(clamp(2, undefined, 4)).toBe(2)
    expect(clamp(7, 0, 10)).toBe(7)
  })
})
