import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { createRoot } from '../ink/root.js'
import { FallbackToolUseErrorMessage } from './FallbackToolUseErrorMessage.js'

async function renderError(result: unknown, verbose = false): Promise<string> {
  return renderToString(
    <FallbackToolUseErrorMessage result={result as never} verbose={verbose} />,
    100,
  )
}

function createStreams(): {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough
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
  ;(stdout as unknown as { columns: number }).columns = 100
  return { stdin, stdout }
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('FallbackToolUseErrorMessage', () => {
  test('renders a generic failure for non-string tool results', async () => {
    const output = await renderError([{ type: 'text', text: 'ignored' }])

    expect(output).toContain('Tool execution failed')
  })

  test('condenses validation failures and strips wrapper tags in brief mode', async () => {
    const output = await renderError(
      [
        '<tool_use_error>',
        '<error>InputValidationError: Missing required field</error>',
        '<sandbox_violations>blocked path details</sandbox_violations>',
        '</tool_use_error>',
      ].join('\n'),
    )

    expect(output).toContain('Invalid tool parameters')
    expect(output).not.toContain('InputValidationError')
    expect(output).not.toContain('blocked path details')
    expect(output).not.toContain('<error>')
  })

  test('truncates long errors and keeps an existing Error prefix', async () => {
    const lines = Array.from({ length: 11 }, (_, index) =>
      index === 0 ? 'Error: first line' : `line ${index + 1}`,
    )

    const output = await renderError(lines.join('\n'))

    expect(output).toContain('Error: first line')
    expect(output).toContain('line 10')
    expect(output).not.toContain('line 11')
    expect(output).toContain('+1 line')
    expect(output).toContain('ctrl+o')
  })

  test('uses plural truncation text and preserves Cancelled prefixes', async () => {
    const lines = Array.from({ length: 12 }, (_, index) =>
      index === 0 ? 'Cancelled: stopped by user' : `cancel line ${index + 1}`,
    )

    const output = await renderError(lines.join('\n'))

    expect(output).toContain('Cancelled: stopped by user')
    expect(output).not.toContain('Error: Cancelled')
    expect(output).toContain('+2 lines')
  })

  test('adds an Error prefix and shows every line in verbose mode', async () => {
    const lines = Array.from({ length: 12 }, (_, index) =>
      index === 0 ? 'plain failure' : `verbose line ${index + 1}`,
    )

    const output = await renderError(lines.join('\n'), true)

    expect(output).toContain('Error: plain failure')
    expect(output).toContain('verbose line 12')
    expect(output).not.toContain('to see all')
  })

  test('reuses memoized render parts across identical rerenders', async () => {
    const { stdin, stdout } = createStreams()
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })
    const renderNode = () => (
      <FallbackToolUseErrorMessage
        result={'Error: cached failure'}
        verbose={false}
      />
    )

    try {
      root.render(renderNode())
      await sleep()
      root.render(renderNode())
      await sleep()

      expect(stripAnsi(output)).toContain('Error: cached failure')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
