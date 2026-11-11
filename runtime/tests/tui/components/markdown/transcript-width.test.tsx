/**
 * Display-width checks of the chat transcript, from the owner's report of
 * 2026-11-11: table rows with a check mark emoji had a border out of place,
 * and words, values and numbers came out deformed.
 *
 * Every fixture is rendered at six terminal widths. The frame is then read
 * the way a terminal lays it out (fixtures/terminalCells.ts), not with the
 * product's own width function.
 */
import React from 'react'
import { marked, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

import { applyMarkdown, formatToken } from '../../../utils/markdown.js'
import { renderToString } from '../../../utils/staticRender.js'
import { ContentWidthProvider } from '../../context/contentWidthContext.js'
import { Box } from '../../ink.js'
import { Markdown } from './Markdown.js'
import { cellColumnsOf, terminalCells } from './fixtures/terminalCells.js'
import {
  OWNER_TABLE,
  TRANSCRIPT_FIXTURES,
  type TranscriptFixture,
} from './fixtures/transcriptWidthFixtures.js'

vi.mock('bun:bundle', () => ({ feature: () => false }))
vi.mock('../../hooks/useSettings.js', () => ({
  useSettings: () => ({ syntaxHighlightingDisabled: true }),
}))

const WIDTHS = [60, 80, 100, 120, 160, 200]
/** The transcript is inset by two cells on each side. */
const INSET = 2
/** Words up to this width must never be split (MarkdownTable.tsx). */
const MAX_UNBROKEN_WORD_WIDTH = 24
const VERTICAL_BORDERS = '│'
const JOINTS = '┌┬┐├┼┤└┴┘'

async function renderFrame(markdown: string, width: number): Promise<string[]> {
  const output = await renderToString(
    <ContentWidthProvider width={width - 2 * INSET}>
      <Box width={width} paddingX={INSET} flexDirection="column">
        <Markdown>{markdown}</Markdown>
      </Box>
    </ContentWidthProvider>,
    { columns: width, rows: 400 },
  )
  return stripAnsi(output)
    .split('\n')
    .map(line => line.trimEnd())
}

const squeeze = (text: string): string => text.normalize('NFC').replace(/\s+/g, '')
const wordsOf = (text: string): string[] =>
  text.normalize('NFC').split(/\s+/).filter(word => word.length > 0)

function expectLinesFit(lines: string[], width: number): void {
  for (const line of lines) {
    expect([line, terminalCells(line) <= width - INSET]).toEqual([line, true])
  }
}

/** A word that fits is shown whole on one line: never cut in two. */
function expectShortWordsWhole(words: string[], lines: string[], limit: number): void {
  for (const word of words) {
    if (terminalCells(word) > limit) continue
    expect([word, lines.some(line => line.includes(word))]).toEqual([word, true])
  }
}

type TableText = { headers: string[]; rows: string[][] }

function tableText(markdown: string): TableText {
  const table = marked.lexer(markdown).find(token => token.type === 'table') as Tokens.Table
  const cellText = (cell: Tokens.TableCell): string =>
    stripAnsi(cell.tokens.map(token => formatToken(token, 'dark')).join('')).trim()
  return {
    headers: table.header.map(cellText),
    rows: table.rows.map(row => row.map(cellText)),
  }
}

function checkBoxTable(lines: string[], expected: TableText): void {
  const tableLines = lines.filter(line => line.trim().length > 0)
  // Same width on every line.
  expect(new Set(tableLines.map(line => terminalCells(line))).size).toBe(1)
  // Vertical borders stand in the columns of the joints of the top rule.
  const borderColumns = cellColumnsOf(tableLines[0]!, JOINTS)
  expect(borderColumns.length).toBe(expected.headers.length + 1)
  const rowGroups: string[][][] = []
  let group: string[][] | null = null
  for (const line of tableLines) {
    if (JOINTS.includes(line.trim()[0]!)) {
      expect([line, cellColumnsOf(line, JOINTS)]).toEqual([line, borderColumns])
      group = null
      continue
    }
    expect([line, cellColumnsOf(line, VERTICAL_BORDERS)]).toEqual([line, borderColumns])
    if (group === null) {
      group = []
      rowGroups.push(group)
    }
    group.push(line.trim().slice(1, -1).split(VERTICAL_BORDERS))
  }
  // Every cell holds exactly its text: nothing lost, nothing doubled, and no
  // short word cut in two.
  const expectedRows = [expected.headers, ...expected.rows]
  expect(rowGroups.length).toBe(expectedRows.length)
  rowGroups.forEach((rowLines, rowIndex) => {
    expectedRows[rowIndex]!.forEach((cell, columnIndex) => {
      const fragments = rowLines.map(parts => parts[columnIndex]!.trim())
      expect(squeeze(fragments.join(''))).toBe(squeeze(cell))
      expectShortWordsWhole(wordsOf(cell), fragments, MAX_UNBROKEN_WORD_WIDTH)
    })
  })
}

function checkKeyValueTable(lines: string[], expected: TableText, width: number): void {
  const content = lines.filter(line => line.trim().length > 0 && !/^\s*─+$/u.test(line))
  const expectedText = expected.rows
    .map(row => row.map((cell, index) => `${expected.headers[index]}:${cell}`).join(''))
    .join('')
  expect(squeeze(content.join(''))).toBe(squeeze(expectedText))
  // A word is cut only when it cannot fit on a line of its own.
  const room = width - 2 * INSET - 4
  for (const row of expected.rows) {
    for (const cell of row) expectShortWordsWhole(wordsOf(cell), content, room)
  }
}

function checkTable(fixture: TranscriptFixture, lines: string[], width: number): void {
  const expected = tableText(fixture.markdown)
  expectLinesFit(lines, width)
  if (lines.some(line => line.includes('┌'))) {
    checkBoxTable(lines, expected)
  } else {
    checkKeyValueTable(lines, expected, width)
  }
}

function checkText(fixture: TranscriptFixture, lines: string[], width: number): void {
  const expected = stripAnsi(applyMarkdown(fixture.markdown, 'dark'))
  expectLinesFit(lines, width)
  // Same characters in the same order: a wrap neither drops nor repeats one.
  expect(squeeze(lines.join('\n'))).toBe(squeeze(expected))
  expectShortWordsWhole(wordsOf(expected), lines, width - 2 * INSET - 8)
}

const indentOf = (lines: string[], needle: string): number => {
  const line = lines.find(candidate => candidate.includes(needle))
  expect([needle, line !== undefined]).toEqual([needle, true])
  return line!.length - line!.trimStart().length - INSET
}

describe('transcript display width', () => {
  for (const fixture of TRANSCRIPT_FIXTURES) {
    test.each(WIDTHS)(`${fixture.name} at %i columns`, async width => {
      const lines = await renderFrame(fixture.markdown, width)
      if (fixture.kind === 'table') {
        checkTable(fixture, lines, width)
      } else {
        checkText(fixture, lines, width)
      }
    })
  }

  test("the owner's table keeps its box at 80 columns and wider", async () => {
    for (const width of [80, 100, 120, 160, 200]) {
      const lines = await renderFrame(OWNER_TABLE, width)
      expect(lines.some(line => line.includes('┌'))).toBe(true)
      const emojiRows = lines.filter(line => line.includes('✅'))
      const hourglassRows = lines.filter(line => line.includes('⏳'))
      expect(emojiRows.length).toBe(3)
      expect(hourglassRows.length).toBe(3)
      const columns = cellColumnsOf(hourglassRows[0]!, VERTICAL_BORDERS)
      for (const row of emojiRows) {
        expect(cellColumnsOf(row, VERTICAL_BORDERS)).toEqual(columns)
      }
    }
  })

  test('a table whose columns cannot hold their words is shown as key and value lines', async () => {
    const fixture = TRANSCRIPT_FIXTURES.find(candidate => candidate.name === 'many-column-table')!
    const lines = await renderFrame(fixture.markdown, 80)
    expect(lines.some(line => line.includes('┌'))).toBe(false)
    expect(lines.some(line => line.includes('Speed: 142.7 tok/s'))).toBe(true)
    expect(lines.some(line => line.includes('Tokens in: 1,204,331'))).toBe(true)
  })

  test('continuation lines of a cell start in the column of its first line', async () => {
    const lines = await renderFrame(OWNER_TABLE, 80)
    const rows = lines.filter(line => line.trim().startsWith('│'))
    for (const row of rows) {
      for (const cell of row.trim().slice(1, -1).split('│')) {
        // One space of padding, then text or an empty cell: never two spaces
        // followed by text in a left-aligned column.
        if (cell.trim().length > 0 && row.includes('Fase') === false) {
          expect([row, cell.startsWith('  ')]).toEqual([row, false])
        }
      }
    }
  })

  test.each(WIDTHS)('nested lists, quotes and code keep their indent at %i columns', async width => {
    const blocks = TRANSCRIPT_FIXTURES.find(candidate => candidate.name === 'blocks')!
    const lines = await renderFrame(blocks.markdown, width)
    expect(indentOf(lines, '- First item')).toBe(0)
    expect(indentOf(lines, '- Nested item')).toBe(2)
    expect(indentOf(lines, '- Third level')).toBe(4)
    expect(indentOf(lines, '- Second item')).toBe(0)
    expect(indentOf(lines, 'function width')).toBe(0)
    expect(indentOf(lines, 'if (text.length')).toBe(2)
    expect(indentOf(lines, 'return 0')).toBe(4)
    expect(indentOf(lines, 'return measure')).toBe(2)
    expect(lines.some(line => line.trimStart().startsWith('▎ A block quote'))).toBe(true)
    // A wrapped row of a nested item stays at the level of its item.
    const nested = lines.findIndex(line => line.includes('- Nested item'))
    if (!lines[nested]!.includes('96 MiB')) {
      expect(lines[nested + 1]!.length - lines[nested + 1]!.trimStart().length - INSET).toBe(2)
    }
  })

  test.each(WIDTHS)('list markers, task boxes and sibling indents at %i columns', async width => {
    const lists = TRANSCRIPT_FIXTURES.find(candidate => candidate.name === 'lists')!
    const lines = await renderFrame(lists.markdown, width)
    expect(indentOf(lines, '- Loose item one')).toBe(0)
    expect(indentOf(lines, '- Loose item two')).toBe(0)
    expect(indentOf(lines, 'A second paragraph')).toBe(2)
    expect(indentOf(lines, '- Parent')).toBe(0)
    expect(indentOf(lines, '- Child one')).toBe(2)
    expect(indentOf(lines, '- Child two')).toBe(2)
    expect(indentOf(lines, '- Grandchild one')).toBe(4)
    expect(indentOf(lines, '- Grandchild two')).toBe(4)
    expect(indentOf(lines, '- Child three')).toBe(2)
    expect(indentOf(lines, '1. Step one')).toBe(0)
    expect(indentOf(lines, 'fastboot flash')).toBe(3)
    expect(indentOf(lines, '2. Step two')).toBe(0)
    expect(indentOf(lines, '- [ ] Open task')).toBe(0)
    expect(indentOf(lines, '- [x] Closed task')).toBe(0)
  })
})
