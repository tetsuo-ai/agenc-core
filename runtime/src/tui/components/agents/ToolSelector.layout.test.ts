import { describe, expect, test } from 'vitest'

import {
  getToolSelectorContentColumns,
  getToolSelectorDividerColumns,
  getToolSelectorVisibleItemLimit,
  getToolSelectorVisibleWindow,
} from './ToolSelector.layout.js'

describe('ToolSelector layout helpers', () => {
  test('derives bounded content and divider widths from terminal columns', () => {
    expect(getToolSelectorContentColumns(120)).toBe(118)
    expect(getToolSelectorDividerColumns(120)).toBe(40)

    expect(getToolSelectorContentColumns(20)).toBe(18)
    expect(getToolSelectorDividerColumns(20)).toBe(18)

    expect(getToolSelectorContentColumns(1)).toBe(1)
    expect(getToolSelectorDividerColumns(1)).toBe(1)
  })

  test('caps visible rows while preserving at least one item on tiny terminals', () => {
    expect(getToolSelectorVisibleItemLimit(40)).toBe(18)
    expect(getToolSelectorVisibleItemLimit(14)).toBe(6)
    expect(getToolSelectorVisibleItemLimit(4)).toBe(1)
    expect(getToolSelectorVisibleItemLimit(0)).toBe(1)
  })

  test('keeps the focused item inside the scroll window', () => {
    const items = Array.from({ length: 20 }, (_, index) => `item-${index}`)

    expect(getToolSelectorVisibleWindow(items, 0, 5).visibleItems.map(x => x.item)).toEqual([
      'item-1',
      'item-2',
      'item-3',
      'item-4',
      'item-5',
    ])

    const middle = getToolSelectorVisibleWindow(items, 10, 5)
    expect(middle.visibleItems.map(x => x.item)).toEqual([
      'item-8',
      'item-9',
      'item-10',
      'item-11',
      'item-12',
    ])
    expect(middle.hiddenAbove).toBe(7)
    expect(middle.hiddenBelow).toBe(7)

    const end = getToolSelectorVisibleWindow(items, 19, 5)
    expect(end.visibleItems.map(x => x.item)).toEqual([
      'item-15',
      'item-16',
      'item-17',
      'item-18',
      'item-19',
    ])
    expect(end.hiddenAbove).toBe(14)
    expect(end.hiddenBelow).toBe(0)
  })
})
