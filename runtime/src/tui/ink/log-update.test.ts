import { expect, test } from 'vitest'

import type { Frame } from './frame.js'
import { LogUpdate } from './log-update.js'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from './screen.js'

function collectStdout(diff: ReturnType<LogUpdate['render']>): string {
  return diff
    .filter((patch): patch is Extract<(typeof diff)[number], { type: 'stdout' }> => patch.type === 'stdout')
    .map(patch => patch.content)
    .join('')
}

function createHarness() {
  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()

  return {
    stylePool,
    charPool,
    hyperlinkPool,
    log: new LogUpdate({ isTTY: true, stylePool }),
  }
}

function frameFromLines(
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
  lines: string[],
  cursor = { x: 0, y: lines.length, visible: true },
): Frame {
  const width = lines.reduce((max, line) => Math.max(max, line.length), 0)
  const screen = createScreen(width, lines.length, stylePool, charPool, hyperlinkPool)

  for (const [y, line] of lines.entries()) {
    for (const [x, char] of [...line].entries()) {
      setCellAt(screen, x, y, {
        char,
        styleId: stylePool.none,
        width: CellWidth.Narrow,
      })
    }
  }

  return {
    screen,
    viewport: {
      width: Math.max(width, 1),
      height: 10,
    },
    cursor,
  }
}

test('ghostty main-screen rewrite paints prompt content without full terminal reset when width is stable', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = frameFromLines(stylePool, charPool, hyperlinkPool, ['      '])
  const next = frameFromLines(stylePool, charPool, hyperlinkPool, ['prompt'])

  const diff = log.render(prev, next, false, true, true)
  const stdout = collectStdout(diff)

  expect(diff.some(patch => patch.type === 'clearTerminal')).toBe(false)
  expect(diff.some(patch => patch.type === 'clear' && patch.count === 1)).toBe(
    true,
  )
  expect(stdout).toContain('prompt')
})

test('ghostty main-screen rewrite clears only the changed prompt tail before repainting', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = frameFromLines(
    stylePool,
    charPool,
    hyperlinkPool,
    ['status', '> abc'],
  )
  const next = frameFromLines(
    stylePool,
    charPool,
    hyperlinkPool,
    ['status', '> abcd'],
  )

  const diff = log.render(prev, next, false, true, true)
  const stdout = collectStdout(diff)

  expect(diff.some(patch => patch.type === 'clearTerminal')).toBe(false)
  expect(diff.some(patch => patch.type === 'clear' && patch.count === 1)).toBe(
    true,
  )
  expect(stdout).toContain('abcd')
})

test('ghostty main-screen rewrite falls back to incremental diff for larger changes', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = frameFromLines(
    stylePool,
    charPool,
    hyperlinkPool,
    ['row 0', 'row 1', 'row 2', 'row 3', 'row 4', '> abc'],
  )
  const next = frameFromLines(
    stylePool,
    charPool,
    hyperlinkPool,
    ['row 0 updated', 'row 1', 'row 2', 'row 3', 'row 4', '> abcd'],
  )

  const diff = log.render(prev, next, false, true, true)
  const stdout = collectStdout(diff)

  expect(diff.some(patch => patch.type === 'clear')).toBe(false)
  expect(stdout).toContain('updated')
  expect(stdout).toContain('abcd')
})

test('alt-screen scroll hint uses DECSTBM hardware scroll when synchronized output is safe', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = frameFromLines(
    stylePool,
    charPool,
    hyperlinkPool,
    ['row 0', 'row 1', 'row 2', 'row 3'],
    { x: 0, y: 3, visible: false },
  )
  const next = {
    ...frameFromLines(
      stylePool,
      charPool,
      hyperlinkPool,
      ['row 1', 'row 2', 'row 3', 'row 4'],
      { x: 0, y: 3, visible: false },
    ),
    scrollHint: { top: 0, bottom: 3, delta: 1 },
  } satisfies Frame

  const diff = log.render(prev, next, true, true, false)
  const stdout = collectStdout(diff)

  expect(stdout).toContain('\x1B[1;4r')
  expect(stdout).toContain('\x1B[1S')
  expect(stdout).toContain('\x1B[r')
  expect(stdout).toContain('row4')
  expect(diff.some(patch => patch.type === 'clearTerminal')).toBe(false)
})

test('alt-screen scroll hint falls back to normal diff when synchronized output is unsafe', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = frameFromLines(
    stylePool,
    charPool,
    hyperlinkPool,
    ['row 0', 'row 1', 'row 2', 'row 3'],
    { x: 0, y: 3, visible: false },
  )
  const next = {
    ...frameFromLines(
      stylePool,
      charPool,
      hyperlinkPool,
      ['row 1', 'row 2', 'row 3', 'row 4'],
      { x: 0, y: 3, visible: false },
    ),
    scrollHint: { top: 0, bottom: 3, delta: 1 },
  } satisfies Frame

  const diff = log.render(prev, next, true, false, false)
  const stdout = collectStdout(diff)

  expect(stdout).not.toContain('\x1B[1;4r')
  expect(stdout).not.toContain('\x1B[1S')
  expect(stdout).toContain('1234')
  expect(diff.some(patch => patch.type === 'clearTerminal')).toBe(false)
})
