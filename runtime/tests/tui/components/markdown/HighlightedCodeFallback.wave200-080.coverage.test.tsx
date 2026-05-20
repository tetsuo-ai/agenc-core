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
  const supportsLanguage = vi.fn((language: string) => language === 'tsx')

  return {
    getCliHighlightPromise: vi.fn(),
    highlight,
    supportsLanguage,
  }
})

vi.mock('../../../utils/cliHighlight.js', () => ({
  getCliHighlightPromise: highlightMock.getCliHighlightPromise,
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

async function renderToText(
  node: React.ReactNode,
  expected: string,
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
    return stripAnsi(output)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
}

describe('HighlightedCodeFallback wave200-080 coverage', () => {
  beforeEach(() => {
    const highlighter = {
      highlight: highlightMock.highlight,
      supportsLanguage: highlightMock.supportsLanguage,
    }
    highlightMock.getCliHighlightPromise.mockReturnValue(
      Promise.resolve(highlighter),
    )
    highlightMock.getCliHighlightPromise.mockClear()
    highlightMock.highlight.mockClear()
    highlightMock.supportsLanguage.mockClear()
  })

  test('reuses supported-language highlighted output from the module cache after remounting', async () => {
    const code = 'const wave200080 = true'
    const expected = `highlighted:tsx:${code}`
    const node = (
      <HighlightedCodeFallback code={code} filePath="fixture.tsx" />
    )

    const first = await renderToText(node, expected)
    const second = await renderToText(node, expected)

    expect(first).toContain(expected)
    expect(second).toContain(expected)
    expect(highlightMock.supportsLanguage).toHaveBeenCalledWith('tsx')
    expect(highlightMock.highlight).toHaveBeenCalledTimes(1)
    expect(highlightMock.highlight).toHaveBeenCalledWith(code, {
      language: 'tsx',
    })
  })
})
