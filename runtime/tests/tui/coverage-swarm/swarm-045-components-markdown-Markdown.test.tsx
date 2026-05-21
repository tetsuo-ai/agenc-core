import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot, type Root } from '../../../src/tui/ink.js'
import {
  Markdown,
  StreamingMarkdown,
} from '../../../src/tui/components/markdown/Markdown.js'

type MockToken = {
  align?: Array<'center' | 'left' | 'right' | null>
  header?: MockToken[]
  lang?: string
  raw: string
  rows?: MockToken[][]
  text?: string
  tokens?: MockToken[]
  type: string
}

const settingsMock = vi.hoisted(() => ({
  syntaxHighlightingDisabled: true,
}))

const highlightMock = vi.hoisted(() => {
  const highlighter = {
    highlight: vi.fn(
      (code: string, options: { readonly language: string }) =>
        `highlighted:${options.language}:${code}`,
    ),
    supportsLanguage: vi.fn((language: string) => language === 'ts'),
  }

  return {
    getCliHighlightPromise: vi.fn(),
    highlighter,
  }
})

const markedMock = vi.hoisted(() => ({
  lexer: vi.fn<(content: string) => MockToken[]>(),
  use: vi.fn(),
}))

const tableMock = vi.hoisted(() => ({
  render: vi.fn((props: { readonly token: MockToken }) => {
    return `TABLE:${props.token.raw}`
  }),
}))

vi.mock('marked', () => ({
  marked: {
    lexer: markedMock.lexer,
    use: markedMock.use,
  },
}))

vi.mock('../../../src/tui/hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: settingsMock.syntaxHighlightingDisabled,
  }),
}))

vi.mock('../../../src/utils/cliHighlight.js', () => ({
  getCliHighlightPromise: highlightMock.getCliHighlightPromise,
}))

vi.mock('../../../src/utils/messages.js', () => ({
  stripPromptXMLTags: (input: string) =>
    input.replace(/<context>[\s\S]*?<\/context>/g, ''),
}))

vi.mock('../../../src/tui/components/markdown/MarkdownTable.js', () => ({
  MarkdownTable: (props: { readonly token: MockToken }) =>
    tableMock.render(props),
}))

function textToken(text: string, raw = text): MockToken {
  return {
    raw,
    text,
    tokens: [
      {
        raw: text,
        text,
        type: 'text',
      },
    ],
    type: 'paragraph',
  }
}

function codeToken(code: string, raw: string): MockToken {
  return {
    lang: 'ts',
    raw,
    text: code,
    type: 'code',
  }
}

function lexBlocks(content: string): MockToken[] {
  if (content.length === 0) return []
  const tokens: MockToken[] = []
  let offset = 0

  while (offset < content.length) {
    const boundary = content.indexOf('\n\n', offset)
    if (boundary === -1) {
      const tail = content.slice(offset)
      if (tail.trim() === '') {
        tokens.push({ raw: tail, type: 'space' })
      } else {
        tokens.push(textToken(tail))
      }
      break
    }

    const text = content.slice(offset, boundary)
    const raw = content.slice(offset, boundary + 2)
    if (text.trim() === '') {
      tokens.push({ raw, type: 'space' })
    } else {
      tokens.push(textToken(text, raw))
    }
    offset = boundary + 2
  }

  return tokens
}

function defaultLexer(content: string): MockToken[] {
  if (content.includes('ROW045_CODE')) {
    return [codeToken('const row045Highlight = true', content)]
  }

  if (content.includes('ROW045_TABLE')) {
    return [
      textToken('before row045 table', 'before row045 table\n\n'),
      {
        align: ['left'],
        header: [textToken('Column')],
        raw: 'ROW045_TABLE',
        rows: [[textToken('cell')]],
        type: 'table',
      },
      textToken('after row045 table', '\n\nafter row045 table'),
    ]
  }

  return lexBlocks(content)
}

function createStreams(): {
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdout: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  return { stdin, stdout }
}

async function waitForOutput(
  readOutput: () => string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (readOutput().includes(expected)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for rendered output: ${expected}`)
}

async function createRenderHarness(): Promise<{
  cleanup: () => void
  readOutput: () => string
  root: Root
}> {
  let output = ''
  const { stdin, stdout } = createStreams()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  return {
    cleanup: () => {
      root.unmount()
      stdin.end()
      stdout.end()
    },
    readOutput: () => stripAnsi(output),
    root,
  }
}

async function renderToText(
  node: React.ReactNode,
  expected: string,
): Promise<string> {
  const harness = await createRenderHarness()
  try {
    harness.root.render(node)
    await waitForOutput(harness.readOutput, expected)
    return harness.readOutput()
  } finally {
    harness.cleanup()
  }
}

describe('Markdown coverage swarm row 045', () => {
  beforeEach(() => {
    settingsMock.syntaxHighlightingDisabled = true
    highlightMock.getCliHighlightPromise.mockReset()
    highlightMock.getCliHighlightPromise.mockReturnValue(
      Promise.resolve(highlightMock.highlighter),
    )
    highlightMock.highlighter.highlight.mockClear()
    highlightMock.highlighter.supportsLanguage.mockClear()
    markedMock.lexer.mockClear()
    markedMock.lexer.mockImplementation(defaultLexer)
    markedMock.use.mockClear()
    tableMock.render.mockClear()
  })

  test('uses the plain-text fast path for long content whose markdown marker is outside the syntax sample', async () => {
    const content = `${'a'.repeat(510)} # row045 marker after sample`

    const output = await renderToText(
      <Markdown>{content}</Markdown>,
      'row045 marker after sample',
    )

    expect(output).toContain('row045 marker after sample')
    expect(markedMock.lexer).not.toHaveBeenCalled()
  })

  test('reuses cached markdown tokens across remounts for the same content', async () => {
    const content = '# row045 cached branch\n\nstill cached'

    await renderToText(<Markdown>{content}</Markdown>, 'row045 cached branch')
    await renderToText(<Markdown>{content}</Markdown>, 'row045 cached branch')

    expect(markedMock.lexer).toHaveBeenCalledTimes(1)
    expect(markedMock.lexer).toHaveBeenCalledWith(content)
  })

  test('flushes text around table tokens and passes the table token through', async () => {
    const output = await renderToText(
      <Markdown>{'ROW045_TABLE'}</Markdown>,
      'after row045 table',
    )

    expect(output).toContain('before row045 table')
    expect(output).toContain('after row045 table')
    expect(tableMock.render).toHaveBeenCalledTimes(1)
    expect(tableMock.render).toHaveBeenCalledWith(
      expect.objectContaining({
        highlight: null,
        token: expect.objectContaining({ raw: 'ROW045_TABLE' }),
      }),
    )
  })

  test('loads a highlighter when syntax highlighting is enabled', async () => {
    settingsMock.syntaxHighlightingDisabled = false

    const output = await renderToText(
      <Markdown>{'```ts\nROW045_CODE\n```'}</Markdown>,
      'highlighted:ts:const row045Highlight = true',
    )

    expect(output).toContain('highlighted:ts:const row045Highlight = true')
    expect(highlightMock.getCliHighlightPromise).toHaveBeenCalled()
    expect(highlightMock.highlighter.supportsLanguage).toHaveBeenCalledWith(
      'ts',
    )
    expect(highlightMock.highlighter.highlight).toHaveBeenCalledWith(
      'const row045Highlight = true',
      { language: 'ts' },
    )
  })

  test('resets the streaming stable prefix when the streamed text is replaced', async () => {
    const harness = await createRenderHarness()
    try {
      harness.root.render(
        <StreamingMarkdown>
          {'row045 stable block\n\nrow045 growing block'}
        </StreamingMarkdown>,
      )
      await waitForOutput(harness.readOutput, 'row045 growing block')

      markedMock.lexer.mockClear()
      harness.root.render(
        <StreamingMarkdown>{'row045 replacement text'}</StreamingMarkdown>,
      )
      await waitForOutput(harness.readOutput, 'row045 replacement text')

      expect(markedMock.lexer).toHaveBeenCalledWith('row045 replacement text')
    } finally {
      harness.cleanup()
    }
  })
})
