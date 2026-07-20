import React from 'react'
import { marked, type Tokens } from 'marked'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { ContentWidthProvider } from '../../context/contentWidthContext.js'
import { Box } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { HighlightedCode } from './HighlightedCode.js'
import { HighlightedCodeFallback } from './HighlightedCodeFallback.js'
import { Markdown } from './Markdown.js'
import { MarkdownTable } from './MarkdownTable.js'

const settingsMock = vi.hoisted(() => ({
  syntaxHighlightingDisabled: true,
}))
const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

const colorFileMock = vi.hoisted(() => ({
  instances: [] as Array<{ code: string; filePath: string }>,
  ColorFile: class {
    code: string
    filePath: string

    constructor(code: string, filePath: string) {
      this.code = code
      this.filePath = filePath
      colorFileMock.instances.push({ code, filePath })
    }

    render(_theme: unknown, width: number, dim: boolean) {
      return [`color:${this.filePath}:${width}:${dim}:${this.code}`]
    }
  },
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: settingsMock.syntaxHighlightingDisabled,
  }),
}))

vi.mock('../../../utils/messages.js', () => ({
  stripPromptXMLTags: (input: string) =>
    input.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''),
}))

vi.mock('../diff/StructuredDiff/colorDiff.js', () => ({
  expectColorFile: () => colorFileMock.ColorFile,
}))

function parseTable(markdown: string): Tokens.Table {
  const table = marked.lexer(markdown).find(token => token.type === 'table')
  if (!table || table.type !== 'table') {
    throw new Error('expected markdown fixture to parse as a table')
  }
  return table
}

describe('markdown rendering components', () => {
  beforeEach(() => {
    settingsMock.syntaxHighlightingDisabled = true
    colorFileMock.instances.length = 0
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode
    }
  })

  test('renders markdown text while stripping prompt XML tags', async () => {
    const output = await renderToString(
      <Markdown>
        {"# Visible\\n\\n<system-reminder>hidden</system-reminder>\\n\\n`code`"}
      </Markdown>,
      80,
    )

    expect(output).toContain('Visible')
    expect(output).toContain('code')
    expect(output).not.toContain('hidden')
    expect(output).not.toContain('system-reminder')
  })

  test('renders CommonMark soft breaks as spaces while preserving paragraph gaps', async () => {
    const output = await renderToString(
      <Markdown>
        {'First sentence.\nSecond sentence.\n\nThird sentence.'}
      </Markdown>,
      80,
    )

    expect(output).toContain('First sentence. Second sentence.')
    expect(output).toContain('Second sentence.\n\nThird sentence.')
  })

  test('renders markdown tables through Markdown integration', async () => {
    const output = await renderToString(
      <Markdown>
        {[
          'Before',
          '',
          '| Name | Count |',
          '| :--- | ---: |',
          '| Alpha | 7 |',
          '| Beta wraps here | 42 |',
          '',
          'After',
        ].join('\n')}
      </Markdown>,
      80,
    )

    expect(output).toContain('Before')
    expect(output).toContain('After')
    expect(output).toContain('Name')
    expect(output).toContain('Count')
    expect(output).toContain('Alpha')
    expect(output).toContain('42')
    expect(output).toContain('┌')
    expect(output).toContain('┘')
  })

  test('uses inherited content width for long markdown tables in constrained panes', async () => {
    const output = await renderToString(
      <ContentWidthProvider width={72}>
        <Box width={72}>
          <Markdown>
            {[
              '| Contract Row | Status | Evidence |',
              '| --- | --- | --- |',
              '| Row 1 - provider-boundary | Implemented | types.ts defines full BufferEditorProvider plus seven capability flags; InlineBufferProvider, ExternalEditorProvider, NeovimBufferProvider, selectBufferEditorProvider, and BufferProviderController all exist and are wired. |',
              '| Row 2 - neovim-discovery | Scaffolding present | NeovimDiscovery.ts implements binary detection, version check, embed mode, clean fallback, explicit usable false reason codes, and all runtime modules exist. |',
            ].join('\n')}
          </Markdown>
        </Box>
      </ContentWidthProvider>,
      160,
    )

    expect(output).toContain('Contract Row:')
    expect(output).toContain('BufferEditorProvider')
    expect(output).not.toContain('┌')
    for (const line of output.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(72)
    }
  })

  test('renders MarkdownTable with wrapping and right-aligned numeric column', async () => {
    const token = parseTable([
      '| Item | Count |',
      '| :--- | ---: |',
      '| Alpha wraps over several words | 7 |',
      '| Beta | 42 |',
    ].join('\n'))

    const output = await renderToString(
      <MarkdownTable token={token} highlight={null} forceWidth={34} />,
      80,
    )

    expect(output).toContain('Item')
    expect(output).toContain('Count')
    expect(output).toContain('Alpha')
    expect(output).toContain('several')
    expect(output).toContain('Beta')
    expect(output).toMatch(/│\s+7\s+│/)
    expect(output).toMatch(/│\s+42\s+│/)
  })

  test('renders MarkdownTable with ASCII borders when ASCII glyphs are requested', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'
    const token = parseTable([
      '| Item | Count |',
      '| :--- | ---: |',
      '| Alpha wraps over several words | 7 |',
      '| Beta | 42 |',
    ].join('\n'))

    const output = await renderToString(
      <MarkdownTable token={token} highlight={null} forceWidth={34} />,
      80,
    )

    expect(output).toContain('+')
    expect(output).toContain('-')
    expect(output).toMatch(/\|\s+7\s+\|/)
    expect(output).toMatch(/\|\s+42\s+\|/)
    expect(output).not.toContain('┌')
    expect(output).not.toContain('┘')
    expect(output).not.toContain('│')
  })

  test('renders HighlightedCode through the disabled fallback path', async () => {
    const output = await renderToString(
      <HighlightedCode
        code="const fallback = 1"
        filePath="fallback.ts"
        width={40}
      />,
      80,
    )

    expect(output).toContain('const fallback = 1')
    expect(colorFileMock.instances).toHaveLength(0)
  })

  test('renders HighlightedCode with mocked color output when highlighting is enabled', async () => {
    settingsMock.syntaxHighlightingDisabled = false

    const output = await renderToString(
      <HighlightedCode
        code="let colored = 2"
        filePath="colored.ts"
        width={42}
        dim
      />,
      80,
    )

    expect(output).toContain('color:colored.ts:42:true:let colored = 2')
    expect(colorFileMock.instances).toEqual([
      { code: 'let colored = 2', filePath: 'colored.ts' },
    ])
  })

  test('renders highlighted-code fallback with leading tabs normalized', async () => {
    const output = await renderToString(
      <HighlightedCodeFallback
        code={String.fromCharCode(9) + 'const value = 1'}
        filePath="example.ts"
        skipColoring
      />,
      80,
    )

    expect(output).toContain('  const value = 1')
    expect(output).not.toContain('\\tconst value = 1')
  })

  test('wraps assistant bullet continuations to a uniform left edge (no stray leading space)', async () => {
    // BUG B regression: when an assistant markdown bullet soft-wraps at a space
    // boundary, the leftover inter-word space used to survive as a leading space
    // on the continuation line — so sibling continuations in the same list
    // started at different columns (a one-column jitter, e.g. "the page." at
    // lead 0 vs " fonts." at lead 1). The markdown body now wraps with
    // "wrap-trim", which strips that boundary whitespace so every continuation
    // row shares the same left edge.
    const width = 24
    const output = await renderToString(
      <Box width={width}>
        <Markdown>
          {[
            '- Centered heading that is large and clearly centered on the page.',
            '- Clean layout with plenty of whitespace and system fonts.',
          ].join('\n')}
        </Markdown>
      </Box>,
      width,
    )

    const lines = output.split('\n').filter((line) => line.trim().length > 0)
    // Sanity: the content actually wrapped (more rows than the 2 source bullets).
    expect(lines.length).toBeGreaterThan(2)

    const leadingSpaces = (line: string): number =>
      line.length - line.replace(/^ +/u, '').length

    // The two bullet markers ("- ") sit flush-left (lead 0). Every other row is
    // a soft-wrap continuation and must ALSO start at column 0 — no stray leading
    // space. Revert-sensitivity: without "wrap-trim" the final continuation
    // ("system fonts.") keeps the boundary space and renders at lead 1, so the
    // uniform-edge assertion below fails.
    const leads = lines.map(leadingSpaces)
    expect(leads.every((lead) => lead === 0)).toBe(true)
    // And the specific measured jitter case is gone: no continuation begins with
    // a space.
    expect(lines.some((line) => /^ /u.test(line))).toBe(false)
  })
})
