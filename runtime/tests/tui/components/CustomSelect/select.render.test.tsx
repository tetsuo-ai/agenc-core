import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../ink/root.js'
import { Select, type OptionWithDescription } from './select.js'

vi.mock('../../../utils/debug.js', () => ({
  logForDebugging: () => {},
}))
vi.mock('../../../bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  getActiveTimeCounter: () => 0,
  markScrollActivity: () => {},
  updateLastInteractionTime: () => {},
}))
vi.mock('../../../utils/earlyInput.js', () => ({
  stopCapturingEarlyInput: () => {},
}))
vi.mock('../../../utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
}))
vi.mock('../../../utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => true,
}))
vi.mock('../../../utils/log.js', () => ({
  logError: () => {},
}))

const OPTIONS: OptionWithDescription<string>[] = [
  {
    value: 'alpha',
    label: 'Alpha model',
    description: 'Primary option',
  },
  {
    value: 'beta',
    label: 'Beta model',
    description: 'Disabled option',
    disabled: true,
  },
  {
    value: 'gamma',
    label: 'Gamma model',
    description: 'Hidden below the viewport',
  },
]

async function renderSelectToText(node: React.ReactNode): Promise<string> {
  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(node)
    await new Promise(resolve => setTimeout(resolve, 30))
    return stripAnsi(output)
  } finally {
    root.unmount()
    stdin.end()
  }
}

describe('Select rendering', () => {
  test('renders compact rows with indexes, selected state, descriptions, and highlighted text', async () => {
    const output = await renderSelectToText(
      <Select
        options={OPTIONS}
        defaultValue="beta"
        defaultFocusValue="alpha"
        visibleOptionCount={2}
        highlightText="Beta"
      />,
    )

    expect(output).toContain('1.')
    expect(output).toContain('Alpha model')
    expect(output).toContain('Primary option')
    expect(output).toContain('2.')
    expect(output).toContain('Beta model')
    expect(output).toContain('Disabled option')
    expect(output).not.toContain('Gamma model')
  })

  test('renders compact vertical rows without indexes when requested', async () => {
    const output = await renderSelectToText(
      <Select
        options={OPTIONS}
        defaultFocusValue="gamma"
        hideIndexes={true}
        layout="compact-vertical"
        visibleOptionCount={2}
      />,
    )

    expect(output).toContain('Beta model')
    expect(output).toContain('Disabled option')
    expect(output).toContain('Gamma model')
    expect(output).toContain('Hidden below the viewport')
    expect(output).not.toContain('2.')
    expect(output).not.toContain('3.')
  })

  test('renders expanded rows with descriptions', async () => {
    const options: OptionWithDescription<string>[] = [
      {
        value: 'plain',
        label: 'Plain choice',
        description: 'Expanded description',
      },
      {
        value: 'second',
        label: 'Second choice',
        description: 'Another expanded description',
      },
    ]

    const output = await renderSelectToText(
      <Select
        options={options}
        defaultFocusValue="feedback"
        inlineDescriptions={true}
        layout="expanded"
        visibleOptionCount={2}
      />,
    )

    expect(output).toContain('Plain choice')
    expect(output).toContain('Expanded description')
    expect(output).toContain('Second choice')
    expect(output).toContain('Another expanded description')
  })
})
