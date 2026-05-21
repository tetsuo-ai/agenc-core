import { describe, expect, test } from 'vitest'

import Output from '../../../src/tui/ink/output.js'
import {
  cellAt,
  CellWidth,
  CharPool,
  charInCellAt,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
  type Screen,
} from '../../../src/tui/ink/screen.js'

function makeScreen(
  width: number,
  height: number,
  stylePool = new StylePool(),
  charPool = new CharPool(),
  hyperlinkPool = new HyperlinkPool(),
): Screen {
  return createScreen(width, height, stylePool, charPool, hyperlinkPool)
}

function makeOutput(width: number, height: number): {
  output: Output
  screen: Screen
  stylePool: StylePool
} {
  const stylePool = new StylePool()
  const screen = makeScreen(width, height, stylePool)

  return {
    output: new Output({ height, screen, stylePool, width }),
    screen,
    stylePool,
  }
}

function writePlain(
  screen: Screen,
  stylePool: StylePool,
  y: number,
  text: string,
): void {
  for (let x = 0; x < text.length; x += 1) {
    setCellAt(screen, x, y, {
      char: text[x]!,
      hyperlink: undefined,
      styleId: stylePool.none,
      width: CellWidth.Narrow,
    })
  }
}

function rowText(screen: Screen, y: number): string {
  let text = ''
  for (let x = 0; x < screen.width; x += 1) {
    text += charInCellAt(screen, x, y) ?? ''
  }
  return text
}

describe('Output coverage swarm row 085', () => {
  test('reset clears queued operations and caps the line cache', () => {
    const { output, stylePool } = makeOutput(5, 1)
    output.write(0, 0, 'stale')

    const cache = (output as unknown as {
      charCache: Map<string, unknown>
    }).charCache
    for (let i = 0; i < 16385; i += 1) {
      cache.set(`line-${i}`, [])
    }

    const nextScreen = makeScreen(3, 1, stylePool)
    output.reset(3, 1, nextScreen)

    expect(output.width).toBe(3)
    expect(output.height).toBe(1)
    expect(cache.size).toBe(0)
    expect(charInCellAt(output.get(), 0, 0)).toBe(' ')
  })

  test('intersects nested clips and preserves soft-wrap provenance after vertical clipping', () => {
    const { output } = makeOutput(6, 4)

    output.clip({ x1: 1, x2: 5, y1: 1, y2: 4 })
    output.clip({ x1: undefined, x2: 4, y1: undefined, y2: 3 })
    output.write(0, 0, 'abcd\nEFGH\nIJKL', [false, true, true])
    output.write(5, 1, 'NO')
    output.write(1, 3, 'NO')
    output.unclip()
    output.write(0, 3, 'tail')

    const screen = output.get()

    expect(rowText(screen, 0)).toBe('      ')
    expect(rowText(screen, 1)).toBe(' FGH  ')
    expect(rowText(screen, 2)).toBe(' JKL  ')
    expect(rowText(screen, 3)).toBe(' ail  ')
    expect(screen.softWrap[1]).toBe(4)
    expect(screen.softWrap[2]).toBe(4)
  })

  test('absolute clears suppress fully covered blit rows and no-select marks win last', () => {
    const { output, screen: destination, stylePool } = makeOutput(4, 3)
    const source = makeScreen(
      4,
      3,
      stylePool,
      destination.charPool,
      destination.hyperlinkPool,
    )
    writePlain(source, stylePool, 0, 'ABCD')
    writePlain(source, stylePool, 1, 'WXYZ')
    writePlain(source, stylePool, 2, 'EFGH')

    output.clear({ x: -3, y: -3, width: 1, height: 1 })
    output.clear({ x: 0, y: 1, width: 4, height: 1 }, true)
    output.blit(source, 0, 0, 4, 3)
    output.noSelect({ x: 1, y: 0, width: 2, height: 3 })

    const screen = output.get()

    expect(rowText(screen, 0)).toBe('ABCD')
    expect(rowText(screen, 1)).toBe('    ')
    expect(rowText(screen, 2)).toBe('EFGH')
    expect(screen.noSelect[1]).toBe(1)
    expect(screen.noSelect[5]).toBe(1)
    expect(screen.noSelect[9]).toBe(1)
  })

  test('shift moves blitted rows upward and clears the exposed row', () => {
    const { output, screen: destination, stylePool } = makeOutput(3, 3)
    const source = makeScreen(
      3,
      3,
      stylePool,
      destination.charPool,
      destination.hyperlinkPool,
    )
    writePlain(source, stylePool, 0, 'one')
    writePlain(source, stylePool, 1, 'two')
    writePlain(source, stylePool, 2, 'tre')

    output.blit(source, 0, 0, 3, 3)
    output.shift(0, 2, 1)

    const screen = output.get()

    expect(rowText(screen, 0)).toBe('two')
    expect(rowText(screen, 1)).toBe('tre')
    expect(rowText(screen, 2)).toBe('   ')
  })

  test('writes tabs, escape controls, zero-width characters, and wide-cell edges', () => {
    const { output } = makeOutput(10, 4)

    output.write(0, 0, 'A\tB')
    output.write(
      0,
      1,
      'C\x1b[2JD\x1b(0E\x1b]2;title\x07F\x1bPpayload\x1b\\G\x1b7H\x08I',
    )
    output.write(0, 2, 'a\u200Bb')
    output.write(0, 3, '界Z')
    output.write(9, 3, '界')

    const screen = output.get()

    expect(charInCellAt(screen, 0, 0)).toBe('A')
    expect(charInCellAt(screen, 1, 0)).toBe(' ')
    expect(charInCellAt(screen, 7, 0)).toBe(' ')
    expect(charInCellAt(screen, 8, 0)).toBe('B')
    expect(rowText(screen, 1)).toBe('CDEFGHI   ')
    expect(charInCellAt(screen, 0, 2)).toBe('a')
    expect(charInCellAt(screen, 1, 2)).toBe('b')
    expect(cellAt(screen, 0, 3)).toMatchObject({
      char: '界',
      width: CellWidth.Wide,
    })
    expect(cellAt(screen, 1, 3)).toMatchObject({
      char: '',
      width: CellWidth.SpacerTail,
    })
    expect(charInCellAt(screen, 2, 3)).toBe('Z')
    expect(cellAt(screen, 9, 3)).toMatchObject({
      char: ' ',
      width: CellWidth.SpacerHead,
    })
  })

  test('extracts OSC 8 hyperlinks without leaking close codes into styles', () => {
    const { output } = makeOutput(4, 1)

    output.write(0, 0, '\x1b]8;;https://agenc.test/row-085\x07A\x1b]8;;\x07B')

    const screen = output.get()

    expect(cellAt(screen, 0, 0)).toMatchObject({
      char: 'A',
      hyperlink: 'https://agenc.test/row-085',
    })
    expect(cellAt(screen, 1, 0)).toMatchObject({
      char: 'B',
      hyperlink: undefined,
      styleId: 0,
    })
  })
})
