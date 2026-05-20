import { describe, expect, test } from 'vitest'

import { createSelectionState, shiftSelection } from './selection.ts'

describe('selection shift coverage', () => {
  test('prunes stale scroll accumulators and clamps anchor spans', () => {
    const staleAbove = createSelectionState()
    staleAbove.anchor = { col: 1, row: 0 }
    staleAbove.focus = { col: 2, row: 1 }
    staleAbove.anchorSpan = {
      hi: { col: 2, row: 1 },
      kind: 'word',
      lo: { col: 1, row: 0 },
    }
    staleAbove.scrolledOffAbove = ['old-above']
    staleAbove.scrolledOffAboveSW = [true]

    shiftSelection(staleAbove, 0, 0, 2, 5)

    expect(staleAbove.scrolledOffAbove).toEqual([])
    expect(staleAbove.scrolledOffAboveSW).toEqual([])
    expect(staleAbove.anchorSpan).toEqual({
      hi: { col: 2, row: 1 },
      kind: 'word',
      lo: { col: 1, row: 0 },
    })

    const staleBelow = createSelectionState()
    staleBelow.anchor = { col: 1, row: 0 }
    staleBelow.focus = { col: 2, row: 1 }
    staleBelow.scrolledOffBelow = ['old-below']
    staleBelow.scrolledOffBelowSW = [false]

    shiftSelection(staleBelow, 0, 0, 2, 5)

    expect(staleBelow.scrolledOffBelow).toEqual([])
    expect(staleBelow.scrolledOffBelowSW).toEqual([])

    const restoringBelowDebt = createSelectionState()
    restoringBelowDebt.anchor = { col: 1, row: 0 }
    restoringBelowDebt.focus = { col: 2, row: 2 }
    restoringBelowDebt.virtualFocusRow = 4
    restoringBelowDebt.scrolledOffBelow = ['near', 'far']
    restoringBelowDebt.scrolledOffBelowSW = [true, false]

    shiftSelection(restoringBelowDebt, -1, 0, 2, 5)

    expect(restoringBelowDebt.focus).toEqual({ col: 4, row: 2 })
    expect(restoringBelowDebt.virtualFocusRow).toBe(3)
    expect(restoringBelowDebt.scrolledOffBelow).toEqual(['far'])
    expect(restoringBelowDebt.scrolledOffBelowSW).toEqual([false])

    const topClampedSpan = createSelectionState()
    topClampedSpan.anchor = { col: 1, row: 1 }
    topClampedSpan.focus = { col: 2, row: 1 }
    topClampedSpan.anchorSpan = {
      hi: { col: 3, row: 1 },
      kind: 'line',
      lo: { col: 1, row: 0 },
    }

    shiftSelection(topClampedSpan, -1, 0, 2, 5)

    expect(topClampedSpan.anchorSpan).toEqual({
      hi: { col: 3, row: 0 },
      kind: 'line',
      lo: { col: 0, row: 0 },
    })

    const bottomClampedSpan = createSelectionState()
    bottomClampedSpan.anchor = { col: 1, row: 1 }
    bottomClampedSpan.focus = { col: 2, row: 1 }
    bottomClampedSpan.anchorSpan = {
      hi: { col: 3, row: 2 },
      kind: 'line',
      lo: { col: 1, row: 1 },
    }

    shiftSelection(bottomClampedSpan, 1, 0, 2, 5)

    expect(bottomClampedSpan.anchorSpan).toEqual({
      hi: { col: 4, row: 2 },
      kind: 'line',
      lo: { col: 1, row: 2 },
    })
  })
})
