import { afterEach, describe, expect, test, vi } from 'vitest'

import type { Diff, Frame } from '../ink/frame.ts'
import { LogUpdate } from '../ink/log-update.ts'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from '../ink/screen.ts'
import { LINK_END } from '../ink/termio/osc.ts'

type Pools = {
  stylePool: StylePool
  charPool: CharPool
  hyperlinkPool: HyperlinkPool
}

type CellSpec =
  | null
  | string
  | {
      char: string
      hyperlink?: string
      styleId?: number
      width?: CellWidth
    }

type RowSpec = string | CellSpec[]

function createPools(): Pools {
  return {
    stylePool: new StylePool(),
    charPool: new CharPool(),
    hyperlinkPool: new HyperlinkPool(),
  }
}

function rowWidth(row: RowSpec): number {
  return typeof row === 'string' ? Array.from(row).length : row.length
}

function frameFromRows(
  pools: Pools,
  rows: RowSpec[],
  options: {
    cursor?: Frame['cursor']
    scrollHint?: Frame['scrollHint']
    softWrap?: Record<number, number>
    viewportHeight?: number
    viewportWidth?: number
    width?: number
  } = {},
): Frame {
  const width =
    options.width ?? rows.reduce((max, row) => Math.max(max, rowWidth(row)), 0)
  const screen = createScreen(
    width,
    rows.length,
    pools.stylePool,
    pools.charPool,
    pools.hyperlinkPool,
  )

  rows.forEach((row, y) => {
    const cells: CellSpec[] =
      typeof row === 'string' ? Array.from(row) : row
    cells.forEach((spec, x) => {
      if (spec === null) return
      const cell =
        typeof spec === 'string'
          ? { char: spec }
          : spec
      setCellAt(screen, x, y, {
        char: cell.char,
        hyperlink: cell.hyperlink,
        styleId: cell.styleId ?? pools.stylePool.none,
        width: cell.width ?? CellWidth.Narrow,
      })
    })
  })

  for (const [y, value] of Object.entries(options.softWrap ?? {})) {
    screen.softWrap[Number(y)] = value
  }

  return {
    cursor: options.cursor ?? { x: 0, y: rows.length, visible: true },
    screen,
    scrollHint: options.scrollHint,
    viewport: {
      height: options.viewportHeight ?? 10,
      width: options.viewportWidth ?? Math.max(width, 1),
    },
  }
}

function stdoutText(diff: Diff): string {
  return diff
    .filter((patch): patch is Extract<Diff[number], { type: 'stdout' }> => {
      return patch.type === 'stdout'
    })
    .map(patch => patch.content)
    .join('')
}

function redStyle(stylePool: StylePool): number {
  return stylePool.intern([
    { code: '\x1b[31m', endCode: '\x1b[39m', type: 'ansi' },
  ])
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('coverage swarm row 021: LogUpdate', () => {
  test('non-TTY rendering closes trailing hyperlinks and resets styles', () => {
    const pools = createPools()
    const styleId = redStyle(pools.stylePool)
    const log = new LogUpdate({ isTTY: false, stylePool: pools.stylePool })
    const prev = frameFromRows(pools, [], { width: 1 })
    const next = frameFromRows(
      pools,
      [
        [
          {
            char: 'R',
            hyperlink: 'https://example.test/item',
            styleId,
          },
        ],
      ],
      { width: 1 },
    )

    const diff = log.render(prev, next)
    const stdout = stdoutText(diff)

    expect(diff).toHaveLength(1)
    expect(stdout).toContain('https://example.test/item')
    expect(stdout).toContain('\x1b[31m')
    expect(stdout).toContain('\x1b[39m')
    expect(stdout).toContain(LINK_END)
  })

  test('preservePreviousOutput emits newline for pipes and cursor show for hidden TTY cursors', () => {
    const pools = createPools()
    const frame = frameFromRows(pools, ['done'], {
      cursor: { x: 0, y: 1, visible: false },
    })

    expect(
      new LogUpdate({
        isTTY: false,
        stylePool: pools.stylePool,
      }).preservePreviousOutput(frame),
    ).toEqual([{ type: 'stdout', content: '\n' }])
    expect(
      new LogUpdate({
        isTTY: true,
        stylePool: pools.stylePool,
      }).preservePreviousOutput(frame),
    ).toEqual([{ type: 'cursorShow' }])
  })

  test('scrollback changes trigger a full reset with source line debug context', () => {
    const pools = createPools()
    const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
    const prev = frameFromRows(pools, ['old', 'same', 'tail'], {
      cursor: { x: 0, y: 3, visible: true },
      viewportHeight: 2,
      viewportWidth: 4,
    })
    const next = frameFromRows(pools, ['new', 'same', 'tail'], {
      cursor: { x: 0, y: 3, visible: true },
      viewportHeight: 2,
      viewportWidth: 4,
    })

    expect(log.render(prev, next)[0]).toEqual({
      debug: { nextLine: 'new', prevLine: 'old', triggerY: 0 },
      reason: 'offscreen',
      type: 'clearTerminal',
    })
  })

  test('growing output still resets when changed rows are above the viewport', () => {
    const pools = createPools()
    const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
    const prev = frameFromRows(pools, ['old', 'same', 'tail'], {
      cursor: { x: 0, y: 3, visible: true },
      viewportHeight: 2,
      viewportWidth: 4,
    })
    const next = frameFromRows(pools, ['new', 'same', 'tail', 'more'], {
      cursor: { x: 0, y: 4, visible: true },
      viewportHeight: 2,
      viewportWidth: 4,
    })

    expect(log.render(prev, next)[0]).toEqual({
      debug: { nextLine: 'new', prevLine: 'old', triggerY: 0 },
      reason: 'offscreen',
      type: 'clearTerminal',
    })
  })

  test('shrinking by more lines than the viewport can erase falls back to a full reset', () => {
    const pools = createPools()
    const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
    const prev = frameFromRows(pools, ['a', 'b', 'c', 'd', 'e'], {
      cursor: { x: 0, y: 0, visible: true },
      viewportHeight: 2,
      viewportWidth: 1,
    })
    const next = frameFromRows(pools, ['a'], {
      cursor: { x: 0, y: 1, visible: true },
      viewportHeight: 2,
      viewportWidth: 1,
    })

    expect(log.render(prev, next)[0]).toMatchObject({
      reason: 'offscreen',
      type: 'clearTerminal',
    })
  })

  test('alt-screen negative scroll hints use DECSTBM scroll-down patches', () => {
    const pools = createPools()
    const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
    const prev = frameFromRows(pools, ['TOP', 'NEW', 'OLD', 'END'], {
      cursor: { x: 0, y: 0, visible: false },
      viewportHeight: 4,
      viewportWidth: 3,
    })
    const next = frameFromRows(pools, ['TOP', 'NEW', 'MID', 'END'], {
      cursor: { x: 0, y: 0, visible: false },
      scrollHint: { bottom: 2, delta: -1, top: 1 },
      viewportHeight: 4,
      viewportWidth: 3,
    })

    const diff = log.render(prev, next, true)

    expect(diff[0]).toEqual({
      content: '\x1b[2;3r\x1b[1T\x1b[r\x1b[H',
      type: 'stdout',
    })
    expect(stdoutText(diff)).toContain('MID')
  })

  test('wide spacer cells are skipped when added or removed', () => {
    const pools = createPools()
    const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
    const wide = '\u4e00'
    const empty = frameFromRows(pools, [[null, null]], {
      cursor: { x: 0, y: 0, visible: true },
      viewportWidth: 2,
      width: 2,
    })
    const wideRow = frameFromRows(
      pools,
      [[{ char: wide, width: CellWidth.Wide }, null]],
      {
        cursor: { x: 0, y: 0, visible: true },
        viewportWidth: 2,
        width: 2,
      },
    )

    expect(stdoutText(log.render(empty, wideRow))).toContain(wide)

    const cleared = frameFromRows(pools, [], {
      cursor: { x: 0, y: 0, visible: true },
      viewportWidth: 2,
      width: 2,
    })
    const removedStdout = stdoutText(log.render(wideRow, cleared))

    expect(removedStdout.match(/ /g)).toHaveLength(1)
  })

  test('wide cells at the viewport edge are not written across the boundary', () => {
    const pools = createPools()
    const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
    const wide = '\u4e00'
    const prev = frameFromRows(pools, [[null]], {
      cursor: { x: 0, y: 0, visible: true },
      viewportWidth: 1,
      width: 1,
    })
    const next = frameFromRows(
      pools,
      [[{ char: wide, width: CellWidth.Wide }]],
      {
        cursor: { x: 0, y: 1, visible: true },
        viewportWidth: 1,
        width: 1,
      },
    )

    expect(stdoutText(log.render(prev, next))).not.toContain(wide)
  })

  test('compensates newer wide emoji and variation-selector emoji widths', () => {
    const pools = createPools()
    const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
    const prev = frameFromRows(pools, [[null, null, null, null]], {
      cursor: { x: 0, y: 0, visible: true },
      viewportWidth: 4,
      width: 4,
    })

    for (const char of ['\u{1fae0}', '\u{1fb00}', '\u2764\ufe0f']) {
      const next = frameFromRows(
        pools,
        [[null, { char, width: CellWidth.Wide }, null, null]],
        {
          cursor: { x: 0, y: 0, visible: true },
          viewportWidth: 4,
          width: 4,
        },
      )
      const diff = log.render(prev, next)

      expect(diff).toContainEqual({ col: 3, type: 'cursorTo' })
      expect(diff).toContainEqual({ col: 2, type: 'cursorTo' })
      expect(diff).toContainEqual({ col: 4, type: 'cursorTo' })
      expect(stdoutText(diff)).toContain(char)
    }
  })

  test('empty wide cells avoid width compensation and produce empty writes', () => {
    const pools = createPools()
    const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
    const prev = frameFromRows(pools, [[null, null, null]], {
      cursor: { x: 0, y: 0, visible: true },
      viewportWidth: 3,
      width: 3,
    })
    const next = frameFromRows(
      pools,
      [[{ char: '', width: CellWidth.Wide }, null, null]],
      {
        cursor: { x: 0, y: 0, visible: true },
        viewportWidth: 3,
        width: 3,
      },
    )

    expect(log.render(prev, next)).toContainEqual({
      content: '',
      type: 'stdout',
    })
  })

  test('cells beyond the viewport advance the virtual cursor to the next row', () => {
    const pools = createPools()
    const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
    const prev = frameFromRows(pools, [[null, null]], {
      cursor: { x: 0, y: 0, visible: true },
      viewportWidth: 1,
      width: 2,
    })
    const next = frameFromRows(pools, [[null, 'Z']], {
      cursor: { x: 0, y: 0, visible: true },
      viewportWidth: 1,
      width: 2,
    })

    expect(stdoutText(log.render(prev, next))).toContain('Z')
  })

  test('main-screen rewrite handles growth without clearing existing rows', () => {
    const pools = createPools()
    const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
    const prev = frameFromRows(pools, ['top'], {
      cursor: { x: 0, y: 1, visible: true },
      viewportWidth: 4,
      width: 4,
    })
    const next = frameFromRows(pools, ['top', 'next'], {
      cursor: { x: 0, y: 2, visible: true },
      viewportWidth: 4,
      width: 4,
    })

    const diff = log.render(prev, next, false, true, true)

    expect(diff.some(patch => patch.type === 'clear')).toBe(false)
    expect(stdoutText(diff)).toContain('next')
  })

  test('main-screen rewrite ignores identical frames and honors width or wrap changes', () => {
    const pools = createPools()
    const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
    const samePrev = frameFromRows(pools, ['same'], {
      cursor: { x: 0, y: 0, visible: true },
      viewportWidth: 5,
    })
    const sameNext = frameFromRows(pools, ['same'], {
      cursor: { x: 1, y: 0, visible: true },
      viewportWidth: 5,
    })

    expect(log.render(samePrev, sameNext, false, true, true)).toContainEqual({
      type: 'cursorMove',
      x: 1,
      y: 0,
    })

    const narrow = frameFromRows(pools, ['abc'], {
      cursor: { x: 0, y: 1, visible: true },
      viewportWidth: 5,
    })
    const wide = frameFromRows(pools, ['abcd'], {
      cursor: { x: 0, y: 1, visible: true },
      viewportWidth: 5,
    })
    expect(log.render(narrow, wide, false, true, true)).toContainEqual({
      count: 1,
      type: 'clear',
    })

    const wrapped = frameFromRows(pools, ['abc'], {
      cursor: { x: 0, y: 1, visible: true },
      softWrap: { 0: 1 },
      viewportWidth: 5,
    })
    expect(log.render(wrapped, narrow, false, true, true)).toContainEqual({
      count: 1,
      type: 'clear',
    })
  })

  test('slow incremental renders collect damage details for debug logging', () => {
    const pools = createPools()
    const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
    const prev = frameFromRows(pools, ['a'], {
      cursor: { x: 0, y: 0, visible: true },
      viewportWidth: 1,
    })
    const next = frameFromRows(pools, ['b'], {
      cursor: { x: 0, y: 0, visible: true },
      viewportWidth: 1,
    })
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(75)

    expect(stdoutText(log.render(prev, next))).toContain('b')
  })
})
