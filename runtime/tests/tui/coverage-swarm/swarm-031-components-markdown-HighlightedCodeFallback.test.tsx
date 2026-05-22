import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../../src/tui/ink.js'
import { HighlightedCodeFallback } from '../../../src/tui/components/markdown/HighlightedCodeFallback.js'

const highlightMock = vi.hoisted(() => {
  const highlight = vi.fn(
    (code: string, options: { readonly language: string }) =>
      `highlighted:${options.language}:${code}`,
  )
  const supportsLanguage = vi.fn((language: string) =>
    ['js', 'rs', 'markdown'].includes(language),
  )

  return {
    getCliHighlightPromise: vi.fn(),
    highlight,
    logForDebugging: vi.fn(),
    supportsLanguage,
  }
})

vi.mock('../../../src/utils/cliHighlight.js', () => ({
  getCliHighlightPromise: highlightMock.getCliHighlightPromise,
}))

vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: highlightMock.logForDebugging,
}))

function createStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
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

async function waitForCondition(
  isReady: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (isReady()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function renderToText(
  node: React.ReactNode,
  expected: string,
  options: {
    readonly afterExpected?: () => boolean
  } = {},
): Promise<string> {
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

  try {
    root.render(node)
    await waitForOutput(() => stripAnsi(output), expected)
    if (options.afterExpected) {
      await waitForCondition(options.afterExpected, 'post-render condition')
    }
    return stripAnsi(output)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
}

function fulfilledPromise<T>(value: T): Promise<T> {
  const promise = Promise.resolve(value) as Promise<T> & {
    status: 'fulfilled'
    value: T
  }
  promise.status = 'fulfilled'
  promise.value = value
  return promise
}

describe('HighlightedCodeFallback coverage swarm row 031', () => {
  beforeEach(() => {
    const highlighter = {
      highlight: highlightMock.highlight,
      supportsLanguage: highlightMock.supportsLanguage,
    }
    highlightMock.getCliHighlightPromise.mockReset()
    highlightMock.highlight.mockReset()
    highlightMock.logForDebugging.mockReset()
    highlightMock.supportsLanguage.mockReset()
    highlightMock.highlight.mockImplementation(
      (code: string, options: { readonly language: string }) =>
        `highlighted:${options.language}:${code}`,
    )
    highlightMock.supportsLanguage.mockImplementation((language: string) =>
      ['js', 'rs', 'markdown'].includes(language),
    )
    highlightMock.getCliHighlightPromise.mockReturnValue(
      fulfilledPromise(highlighter),
    )
  })

  test('renders normalized plain ANSI text without loading a highlighter when coloring is skipped', async () => {
    const expected = '  const row031Skip = true'

    const output = await renderToText(
      <HighlightedCodeFallback
        code={`${String.fromCharCode(9)}const row031Skip = true`}
        dim={true}
        filePath="fixture.js"
        skipColoring={true}
      />,
      expected,
    )

    expect(output).toContain(expected)
    expect(highlightMock.getCliHighlightPromise).not.toHaveBeenCalled()
    expect(highlightMock.supportsLanguage).not.toHaveBeenCalled()
    expect(highlightMock.highlight).not.toHaveBeenCalled()
  })

  test('falls back to plain code when the highlighter promise resolves without a highlighter', async () => {
    highlightMock.getCliHighlightPromise.mockReturnValue(fulfilledPromise(null))
    const code = 'const row031NoHighlighter = true'

    const output = await renderToText(
      <HighlightedCodeFallback code={code} filePath="fixture.js" />,
      code,
    )

    expect(output).toContain(code)
    expect(highlightMock.getCliHighlightPromise).toHaveBeenCalled()
    expect(highlightMock.supportsLanguage).not.toHaveBeenCalled()
    expect(highlightMock.highlight).not.toHaveBeenCalled()
  })

  test('retries markdown highlighting when the supported language throws an unknown-language error', async () => {
    const code = 'let row031_retry = true;'
    const expected = `highlighted:markdown:${code}`
    highlightMock.highlight.mockImplementation(
      (receivedCode: string, options: { readonly language: string }) => {
        if (options.language === 'rs') {
          throw new Error('Unknown language: rs')
        }
        return `highlighted:${options.language}:${receivedCode}`
      },
    )

    const output = await renderToText(
      <HighlightedCodeFallback code={code} filePath="fixture.rs" />,
      expected,
    )

    expect(output).toContain(expected)
    expect(highlightMock.supportsLanguage).toHaveBeenCalledWith('rs')
    expect(highlightMock.highlight).toHaveBeenCalledTimes(2)
    expect(highlightMock.highlight).toHaveBeenNthCalledWith(1, code, {
      language: 'rs',
    })
    expect(highlightMock.highlight).toHaveBeenNthCalledWith(2, code, {
      language: 'markdown',
    })
    expect(highlightMock.logForDebugging).toHaveBeenCalledWith(
      expect.stringContaining('falling back to markdown: Error: Unknown language: rs'),
    )
  })

  test('falls back to unhighlighted code when highlighting fails for a non-language reason', async () => {
    const code = 'const row031GenericError = true'
    highlightMock.highlight.mockImplementation(() => {
      throw new Error('theme failed')
    })

    const output = await renderToText(
      <HighlightedCodeFallback code={code} filePath="fixture.js" />,
      code,
      { afterExpected: () => highlightMock.highlight.mock.calls.length > 0 },
    )

    expect(output).toContain(code)
    expect(highlightMock.supportsLanguage).toHaveBeenCalledWith('js')
    expect(highlightMock.highlight).toHaveBeenCalledWith(code, {
      language: 'js',
    })
    expect(
      highlightMock.logForDebugging.mock.calls.some(([message]) =>
        String(message).includes('falling back to markdown'),
      ),
    ).toBe(false)
  })
})
