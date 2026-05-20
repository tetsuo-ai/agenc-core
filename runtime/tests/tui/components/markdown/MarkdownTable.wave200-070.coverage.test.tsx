import React from 'react'
import { marked, type Tokens } from 'marked'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { MarkdownTable } from './MarkdownTable.js'

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

function parseTable(markdown: string): Tokens.Table {
  const table = marked.lexer(markdown).find(token => token.type === 'table')
  if (!table || table.type !== 'table') {
    throw new Error('expected markdown fixture to parse as a table')
  }
  return table
}

describe('MarkdownTable narrow layout', () => {
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

  test('switches to vertical key-value rows when wrapped cells would be too tall', async () => {
    const token = parseTable([
      '| Field | Value |',
      '| :--- | :--- |',
      '| Status | First sentence with compact words that should wrap onto continuation lines for the vertical fallback renderer. |',
      '| Owner | Ada |',
    ].join('\n'))

    const output = await renderToString(
      <MarkdownTable token={token} highlight={null} forceWidth={30} />,
      80,
    )
    const lines = output.split('\n').filter(line => line.length > 0)

    expect(output).toContain('Field: Status')
    expect(output).toContain('Value: First sentence with')
    expect(output).toContain('  compact words that should')
    expect(output).toContain('Field: Owner')
    expect(output).toContain('Value: Ada')
    expect(lines).toContain('─'.repeat(29))
    expect(output).not.toContain('┌')
    expect(output).not.toContain('┬')
    expect(lines.every(line => line.length <= 30)).toBe(true)
  })
})
