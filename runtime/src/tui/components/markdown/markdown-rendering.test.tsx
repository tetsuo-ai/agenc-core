import React from 'react'
import { marked, type Tokens } from 'marked'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../agenc/upstream/utils/staticRender.js'
import { HighlightedCode } from './HighlightedCode.js'
import { HighlightedCodeFallback } from './HighlightedCodeFallback.js'
import { Markdown } from './Markdown.js'
import { MarkdownTable } from './MarkdownTable.js'

const settingsMock = vi.hoisted(() => ({
  syntaxHighlightingDisabled: true,
}))

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

vi.mock('../../../agenc/upstream/utils/messages.js', () => ({
  stripPromptXMLTags: (input: string) =>
    input.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''),
}))

vi.mock('../StructuredDiff/colorDiff.js', () => ({
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
})
