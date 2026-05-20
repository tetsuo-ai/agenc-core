import { expect, test } from 'vitest'

import type { Frame } from './frame.ts'
import { LogUpdate } from './log-update.ts'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from './screen.ts'

function stdoutText(diff: ReturnType<LogUpdate['render']>): string {
  return diff
    .filter(
      (patch): patch is Extract<(typeof diff)[number], { type: 'stdout' }> =>
        patch.type === 'stdout',
    )
    .map(patch => patch.content)
    .join('')
}

function frameFromRows(
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
  rows: string[],
  scrollHint?: Frame['scrollHint'],
): Frame {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const screen = createScreen(width, rows.length, stylePool, charPool, hyperlinkPool)

  for (const [y, row] of rows.entries()) {
    for (const [x, char] of [...row].entries()) {
      setCellAt(screen, x, y, {
        char,
        styleId: stylePool.none,
        width: CellWidth.Narrow,
      })
    }
  }

  return {
    cursor: { x: 0, y: 0, visible: false },
    screen,
    scrollHint,
    viewport: { width, height: rows.length },
  }
}

test('alt-screen scroll hints use DECSTBM and repaint only the newly exposed row', () => {
  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  const log = new LogUpdate({ isTTY: true, stylePool })

  const prev = frameFromRows(stylePool, charPool, hyperlinkPool, [
    'TOP0',
    'OLD1',
    'OLD2',
    'KEEP',
  ])
  const next = frameFromRows(
    stylePool,
    charPool,
    hyperlinkPool,
    ['TOP0', 'OLD2', 'NEW2', 'KEEP'],
    { top: 1, bottom: 2, delta: 1 },
  )

  const diff = log.render(prev, next, true)
  const stdout = stdoutText(diff)

  expect(diff[0]).toEqual({
    type: 'stdout',
    content: '\x1b[2;3r\x1b[1S\x1b[r\x1b[H',
  })
  expect(stdout).toContain('NEW2')
  expect(stdout).not.toContain('OLD2')
  expect(diff.some(patch => patch.type === 'clearTerminal')).toBe(false)
})
