import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../ink.js'
import { HighlightedCodeFallback } from './HighlightedCodeFallback.js'

const highlightMock = vi.hoisted(() => {
  const highlight = vi.fn(
    (code: string, options: { readonly language: string }) =>
      `highlighted:${options.language}:${code}`,
  )
  const supportsLanguage = vi.fn((language: string) => language === 'ts')
  return {
    getCliHighlightPromise: vi.fn(),
    highlight,
    logForDebugging: vi.fn(),
    supportsLanguage,
  }
})

vi.mock('../../../utils/cliHighlight.js', () => ({
  getCliHighlightPromise: highlightMock.getCliHighlightPromise,
}))

vi.mock('../../../utils/debug.js', () => ({
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
}

async function renderToText(node: React.ReactNode, expected: string): Promise<string> {
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
    return stripAnsi(output)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
}

describe('HighlightedCodeFallback', () => {
  beforeEach(() => {
    const highlighter = {
      highlight: highlightMock.highlight,
      supportsLanguage: highlightMock.supportsLanguage,
    }
    highlightMock.getCliHighlightPromise.mockReturnValue(
      Promise.resolve(highlighter),
    )
    highlightMock.highlight.mockClear()
    highlightMock.supportsLanguage.mockClear()
    highlightMock.logForDebugging.mockClear()
  })

  test('falls back unsupported extensions to markdown highlighting after normalizing leading tabs', async () => {
    const expected = 'highlighted:markdown:  const value = 1'

    const output = await renderToText(
      <HighlightedCodeFallback
        code={`${String.fromCharCode(9)}const value = 1`}
        filePath="fixture.unknown"
      />,
      expected,
    )

    expect(output).toContain(expected)
    expect(highlightMock.supportsLanguage).toHaveBeenCalledWith('unknown')
    expect(highlightMock.highlight).toHaveBeenCalledWith('  const value = 1', {
      language: 'markdown',
    })
    expect(highlightMock.logForDebugging).toHaveBeenCalledWith(
      expect.stringContaining('falling back to markdown: unknown'),
    )
  })
})
