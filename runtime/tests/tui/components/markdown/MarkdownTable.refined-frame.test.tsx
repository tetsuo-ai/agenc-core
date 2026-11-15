import React from 'react'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { marked, type Tokens } from 'marked'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { MarkdownTable } from '../../../../src/tui/components/markdown/MarkdownTable.js'
import { renderToAnsiString, renderToString } from '../../../../src/utils/staticRender.js'

/**
 * The refined table look the owner picked (chat look A, 2026-11-14): a thin
 * gray frame with rounded corners, bold headers, one rule under the header
 * and no rules between body rows. Rows that wrap stay apart through an empty
 * framed line, and every cell starts on its row's first line.
 */

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS
const originalChalkLevel = chalk.level

function parseTable(markdown: string): Tokens.Table {
  const table = marked.lexer(markdown).find(token => token.type === 'table')
  if (!table || table.type !== 'table') throw new Error('expected a table')
  return table
}

async function render(markdown: string, width: number): Promise<string> {
  return renderToString(
    <MarkdownTable token={parseTable(markdown)} highlight={null} forceWidth={width} />,
    100,
  )
}

async function renderAnsi(markdown: string, width: number): Promise<string> {
  return renderToAnsiString(
    <MarkdownTable token={parseTable(markdown)} highlight={null} forceWidth={width} />,
    100,
  )
}

const SHORT = ['| Phase | State | Evidence |', '| --- | --- | --- |', '| P1 Backup | done | read twice |', '| P2 Patch | done | unpack valid |', '| P3 Root | next | su -c id |'].join('\n')
const WRAPPED = [
  '| Phase | State | Evidence |',
  '| --- | --- | --- |',
  '| P1 | done | edl/boot_stock.img (96 MiB, read twice, same sha256) |',
  '| P2 | done | magisk_patched.img (17.1 MB, unpack valid) |',
].join('\n')

describe('MarkdownTable refined frame', () => {
  beforeEach(() => {
    delete process.env.AGENC_TUI_GLYPHS
    chalk.level = 3
  })
  afterEach(() => {
    chalk.level = originalChalkLevel
    if (originalGlyphMode === undefined) delete process.env.AGENC_TUI_GLYPHS
    else process.env.AGENC_TUI_GLYPHS = originalGlyphMode
  })

  test('rounded corners, one rule under the header, no rules between rows', async () => {
    const lines = stripAnsi(await render(SHORT, 80)).split('\n').filter(line => line.trim().length > 0)
    expect(lines[0]!.trimStart().startsWith('╭')).toBe(true)
    expect(lines.at(-1)!.trimStart().startsWith('╰')).toBe(true)
    expect(lines.filter(line => line.includes('┼'))).toHaveLength(1)
    // Header, rule, then the three body rows back to back.
    expect(lines).toHaveLength(7)
    expect(lines[1]).toMatch(/│ Phase\s+│ State\s+│ Evidence\s+│/)
    expect(lines[2]!.trimStart().startsWith('├')).toBe(true)
    expect(lines[3]).toContain('P1 Backup')
    expect(lines[4]).toContain('P2 Patch')
    expect(lines[5]).toContain('P3 Root')
  })

  test('the frame is painted gray and the header is bold', async () => {
    const raw = await renderAnsi(SHORT, 80)
    const top = raw.split('\n').find(line => line.includes('╭'))!
    // The rule starts with a foreground color escape, not plain ink.
    expect(top).toMatch(/\x1b\[(?:38;[25];[\d;]+|9\dm|3\dm)[^\n]*╭/)
    const header = raw.split('\n').find(line => line.includes('Phase'))!
    expect(header).toMatch(/\x1b\[1m[^\n]*Phase/)
    // Body text is not bold.
    const body = raw.split('\n').find(line => line.includes('read twice'))!
    expect(body).not.toMatch(/\x1b\[1m[^\x1b]*read twice/)
  })

  test('wrapped rows start on their first line and stay apart', async () => {
    const lines = stripAnsi(await render(WRAPPED, 60)).split('\n').filter(line => line.trim().length > 0)
    const first = lines.findIndex(line => line.includes('│ P1 '))
    expect(first).toBeGreaterThan(0)
    // The label shares its line with the start of the wrapped evidence.
    expect(lines[first]).toContain('edl/boot_stock.img')
    const second = lines.findIndex(line => line.includes('│ P2 '))
    // Between the rows: the continuation, then one empty framed line.
    const between = lines.slice(first + 1, second)
    expect(between.length).toBeGreaterThanOrEqual(2)
    expect(between.at(-1)!.replace(/[│\s]/gu, '')).toBe('')
    expect(lines.filter(line => line.includes('┼'))).toHaveLength(1)
  })

  test('ascii glyph mode keeps plain borders', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'
    const output = stripAnsi(await render(SHORT, 80))
    expect(output).toContain('+')
    expect(output).not.toMatch(/[╭╮╰╯│]/)
  })
})
