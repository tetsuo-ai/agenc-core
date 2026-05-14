const TOOL_SELECTOR_HORIZONTAL_PADDING = 2
const TOOL_SELECTOR_STATIC_ROWS = 8
const TOOL_SELECTOR_MAX_DIVIDER_COLUMNS = 40
const TOOL_SELECTOR_MAX_VISIBLE_ITEMS = 18

function normalizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

export function getToolSelectorContentColumns(columns: number): number {
  return Math.max(1, normalizeDimension(columns) - TOOL_SELECTOR_HORIZONTAL_PADDING)
}

export function getToolSelectorDividerColumns(columns: number): number {
  return Math.min(
    TOOL_SELECTOR_MAX_DIVIDER_COLUMNS,
    getToolSelectorContentColumns(columns),
  )
}

export function getToolSelectorVisibleItemLimit(rows: number): number {
  return Math.max(
    1,
    Math.min(
      TOOL_SELECTOR_MAX_VISIBLE_ITEMS,
      normalizeDimension(rows) - TOOL_SELECTOR_STATIC_ROWS,
    ),
  )
}

export function getToolSelectorVisibleWindow<T>(
  items: readonly T[],
  focusIndex: number,
  visibleItemLimit: number,
  fixedLeadingItems = 1,
): {
  visibleItems: Array<{ item: T; index: number }>
  hiddenAbove: number
  hiddenBelow: number
} {
  const leadingCount = Math.max(0, Math.trunc(fixedLeadingItems))
  const listItems = items.slice(leadingCount)
  const itemLimit = Math.max(1, Math.trunc(visibleItemLimit))

  if (listItems.length <= itemLimit) {
    return {
      visibleItems: listItems.map((item, index) => ({
        item,
        index: index + leadingCount,
      })),
      hiddenAbove: 0,
      hiddenBelow: 0,
    }
  }

  const listFocusIndex = Math.max(0, focusIndex - leadingCount)
  const preferredStart = listFocusIndex - Math.floor(itemLimit / 2)
  const maxStart = Math.max(0, listItems.length - itemLimit)
  const start = Math.min(maxStart, Math.max(0, preferredStart))
  const end = start + itemLimit

  return {
    visibleItems: listItems.slice(start, end).map((item, index) => ({
      item,
      index: start + index + leadingCount,
    })),
    hiddenAbove: start,
    hiddenBelow: listItems.length - end,
  }
}
