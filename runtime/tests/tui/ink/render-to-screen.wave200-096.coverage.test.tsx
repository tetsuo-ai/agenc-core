import { expect, test } from 'vitest'

import Box from './components/Box.tsx'
import Text from './components/Text.tsx'
import {
  applyPositionedHighlight,
  renderToScreen,
  scanPositions,
} from './render-to-screen.ts'
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAt,
  charInCellAt,
  createScreen,
  setCellAt,
  type Screen,
} from './screen.ts'

function makeScreen(width: number, height: number): {
  screen: Screen
  styles: StylePool
} {
  const styles = new StylePool()
  return {
    screen: createScreen(width, height, styles, new CharPool(), new HyperlinkPool()),
    styles,
  }
}

function writeCell(
  screen: Screen,
  styles: StylePool,
  x: number,
  y: number,
  char: string,
  width = CellWidth.Narrow,
): void {
  setCellAt(screen, x, y, {
    char,
    hyperlink: undefined,
    styleId: styles.none,
    width,
  })
}

function rowText(screen: Screen, row: number): string {
  return Array.from({ length: screen.width }, (_, col) =>
    charInCellAt(screen, col, row),
  ).join('')
}

test('renders reusable search screens and clips positioned highlights', () => {
  const element = (
    <Box flexDirection="column" width={12}>
      <Text>Alpha</Text>
      <Text>Beta</Text>
    </Box>
  )
  let rendered = renderToScreen(element, 12)
  for (let index = 1; index < 20; index++) {
    rendered = renderToScreen(element, 12)
  }

  expect(rendered.height).toBeGreaterThanOrEqual(2)
  expect(rowText(rendered.screen, 0)).toContain('Alpha')
  expect(rowText(rendered.screen, 1)).toContain('Beta')
  expect(scanPositions(rendered.screen, 'ta')).toContainEqual({
    col: 2,
    len: 2,
    row: 1,
  })

  const { screen, styles } = makeScreen(7, 2)
  writeCell(screen, styles, 0, 0, 'A')
  writeCell(screen, styles, 1, 0, '好', CellWidth.Wide)
  writeCell(screen, styles, 3, 0, 'B')
  writeCell(screen, styles, 4, 0, 'x')
  writeCell(screen, styles, 5, 0, 'A')
  writeCell(screen, styles, 6, 0, 'B')
  screen.noSelect[4] = 1

  expect(scanPositions(screen, '')).toEqual([])
  expect(scanPositions(screen, 'BA')).toEqual([{ col: 3, len: 3, row: 0 }])

  expect(applyPositionedHighlight(screen, styles, [], 0, 0)).toBe(false)
  expect(
    applyPositionedHighlight(screen, styles, [{ col: 0, len: 1, row: 0 }], -1, 0),
  ).toBe(false)
  expect(
    applyPositionedHighlight(screen, styles, [{ col: -1, len: 9, row: 1 }], 0, 0),
  ).toBe(true)

  const currentMatch = styles.withCurrentMatch(styles.none)
  for (let col = 0; col < screen.width; col++) {
    expect(cellAt(screen, col, 1)?.styleId).toBe(currentMatch)
  }
})
