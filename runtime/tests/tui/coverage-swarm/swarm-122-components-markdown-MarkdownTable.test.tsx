import React from 'react'
import { marked, type Tokens } from 'marked'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { MarkdownTable } from '../../../src/tui/components/markdown/MarkdownTable.js'
import { renderToString } from '../../../src/utils/staticRender.js'

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

function parseTable(markdown: string): Tokens.Table {
  const table = marked.lexer(markdown).find(token => token.type === 'table')
  if (!table || table.type !== 'table') {
    throw new Error('expected markdown fixture to parse as a table')
  }
  return table
}

async function renderTable(markdown: string, forceWidth: number): Promise<string> {
  const token = parseTable(markdown)
  return renderToString(
    <MarkdownTable token={token} highlight={null} forceWidth={forceWidth} />,
    100,
  )
}

function nonEmptyLines(output: string): string[] {
  return output.split('\n').filter(line => line.length > 0)
}

describe('MarkdownTable coverage swarm row 122', () => {
  beforeEach(() => {
    delete process.env.AGENC_TUI_GLYPHS
  })

  afterEach(() => {
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode
    }
  })

  test('renders a compact table with centered headers and aligned data cells', async () => {
    const output = await renderTable(
      [
        '| Agent | Status | Score |',
        '| :--- | :---: | ---: |',
        '| Alpha | ready | 7 |',
        '| Empty |  | 1024 |',
      ].join('\n'),
      80,
    )

    expect(output).toContain('┌')
    expect(output).toContain('┘')
    expect(output).toMatch(/│ Agent\s+│\s+Status\s+│ Score │/)
    expect(output).toMatch(/│ Alpha\s+│\s+ready\s+│\s+7 │/)
    expect(output).toMatch(/│ Empty\s+│\s+│\s+1024 │/)
  })

  test('shrinks ideal column widths and wraps multiline rows without switching layouts', async () => {
    const output = await renderTable(
      [
        '| Item | Count |',
        '| :--- | ---: |',
        '| Alpha wraps over several compact words | 7 |',
        '| Beta | 42 |',
      ].join('\n'),
      34,
    )
    const lines = nonEmptyLines(output)

    expect(output).toContain('┌')
    expect(output).toContain('Alpha wraps')
    expect(output).toContain('several compact')
    expect(output).toMatch(/│\s+7 │/)
    expect(output).toMatch(/│\s+42 │/)
    expect(lines.every(line => line.length <= 34)).toBe(true)
  })

  test('hard-wraps long words in horizontal layout when minimum widths exceed the terminal', async () => {
    const output = await renderTable(
      [
        '| Key | Value |',
        '| :--- | :--- |',
        '| abcdef | uvwxyz |',
      ].join('\n'),
      17,
    )
    const lines = nonEmptyLines(output)

    expect(output).toContain('┌')
    expect(output).toContain('abc')
    expect(output).toContain('def')
    expect(output).toContain('uvw')
    expect(output).toContain('xyz')
    expect(lines.every(line => line.length <= 17)).toBe(true)
    expect(output).not.toContain('Key:')
  })

  test('uses ascii borders when ascii glyph mode is requested', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const output = await renderTable(
      [
        '| Item | Count |',
        '| :--- | ---: |',
        '| Alpha | 7 |',
      ].join('\n'),
      40,
    )

    expect(output).toContain('+')
    expect(output).toContain('|')
    expect(output).toContain('-')
    expect(output).not.toContain('┌')
    expect(output).not.toContain('│')
  })

  test('falls back to vertical rows when the horizontal table would hit the safety margin', async () => {
    const output = await renderTable(
      [
        '| Name | Value |',
        '| :--- | :--- |',
        '| Alpha | ok |',
        '| Beta | done |',
      ].join('\n'),
      10,
    )
    const lines = nonEmptyLines(output)

    expect(output).toContain('Name: Alpha')
    expect(output).toContain('Value: ok')
    expect(output).toContain('Name: Beta')
    expect(output).toContain('Value: done')
    expect(lines).toContain('─'.repeat(9))
    expect(output).not.toContain('┌')
  })
})
