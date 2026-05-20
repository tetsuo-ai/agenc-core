import { PassThrough } from 'node:stream'

import figures from 'figures'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../ink/root.js'
import { SelectMulti } from './SelectMulti.js'
import type { OptionWithDescription } from './select.js'

type InputKey = Partial<{
  ctrl: boolean
  downArrow: boolean
  escape: boolean
  pageDown: boolean
  pageUp: boolean
  return: boolean
  shift: boolean
  tab: boolean
  upArrow: boolean
}>

type InputEventStub = {
  stopImmediatePropagation: () => void
}

type CapturedInput = {
  handler: (input: string, key: InputKey, event: InputEventStub) => void
  options: { isActive?: boolean }
}

const inputMock = vi.hoisted(() => ({
  current: undefined as CapturedInput | undefined,
}))

vi.mock('../../ink.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../ink.js')>()
  return {
    ...actual,
    useInput: (
      handler: CapturedInput['handler'],
      options: CapturedInput['options'],
    ) => {
      inputMock.current = { handler, options }
    },
  }
})

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
    label: 'Alpha server',
    description: 'Already selected',
  },
  {
    value: 'beta',
    label: 'Beta server',
    description: 'Unavailable option',
    disabled: true,
  },
  {
    value: 'gamma',
    label: 'Gamma server',
    description: 'Hidden below the first page',
  },
]

type RenderedSelect = {
  text: () => string
  unmount: () => void
}

async function waitForRender(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30))
}

async function renderSelectMulti(node: React.ReactNode): Promise<RenderedSelect> {
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

  root.render(node)
  await waitForRender()

  return {
    text: () => stripAnsi(output),
    unmount: () => {
      root.unmount()
      stdin.end()
      stdout.end()
    },
  }
}

function pressKey(input: string, key: InputKey = {}): InputEventStub {
  const event = {
    stopImmediatePropagation: vi.fn(),
  }

  expect(inputMock.current).toBeDefined()
  inputMock.current!.handler(input, key, event)
  return event
}

function lineContaining(output: string, text: string): string {
  const line = output
    .split('\n')
    .findLast(candidate => candidate.includes(text))
  expect(line).toBeDefined()
  return line!
}

describe('SelectMulti', () => {
  beforeEach(() => {
    inputMock.current = undefined
  })

  test('renders visible rows with indexes, selected checks, descriptions, focus, and scroll hints', async () => {
    const view = await renderSelectMulti(
      <SelectMulti
        options={OPTIONS}
        defaultValue={['alpha', 'beta']}
        onCancel={() => {}}
        visibleOptionCount={2}
      />,
    )

    try {
      const output = view.text()

      expect(output).toContain('1.')
      expect(output).toContain('Alpha server')
      expect(output).toContain('Already selected')
      expect(output).toContain('2.')
      expect(output).toContain('Beta server')
      expect(output).toContain('Unavailable option')
      expect(output).toContain(`[${figures.tick}]`)
      expect(output).toContain(figures.arrowDown)
      expect(output).not.toContain('Gamma server')
      expect(lineContaining(output, 'Alpha server')).toContain(figures.pointer)
    } finally {
      view.unmount()
    }
  })

  test('honors external focus and hides numeric indexes', async () => {
    const onFocus = vi.fn()
    const view = await renderSelectMulti(
      <SelectMulti
        options={OPTIONS}
        focusValue="gamma"
        hideIndexes={true}
        onCancel={() => {}}
        onFocus={onFocus}
        visibleOptionCount={2}
      />,
    )

    try {
      const output = view.text()

      expect(output).toContain('Beta server')
      expect(output).toContain('Gamma server')
      expect(output).not.toContain('1.')
      expect(output).not.toContain('2.')
      expect(output).not.toContain('3.')
      expect(lineContaining(output, 'Gamma server')).toContain(figures.pointer)
      expect(onFocus).toHaveBeenCalledWith('gamma')
    } finally {
      view.unmount()
    }
  })

  test('toggles selections, focuses the submit button, submits, and cancels', async () => {
    const onCancel = vi.fn()
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    const view = await renderSelectMulti(
      <SelectMulti
        options={[
          OPTIONS[0]!,
          {
            ...OPTIONS[1]!,
            disabled: false,
          },
        ]}
        onCancel={onCancel}
        onChange={onChange}
        onSubmit={onSubmit}
        submitButtonText="Import selected"
      />,
    )

    try {
      expect(inputMock.current?.options.isActive).toBe(true)

      pressKey('', { downArrow: true })
      await waitForRender()
      pressKey(' ', {})
      await waitForRender()
      expect(onChange).toHaveBeenLastCalledWith(['beta'])

      pressKey('', { downArrow: true })
      await waitForRender()
      expect(lineContaining(view.text(), 'Import selected')).toContain(
        figures.pointer,
      )

      pressKey('', { return: true })
      expect(onSubmit).toHaveBeenLastCalledWith(['beta'])

      const escapeEvent = pressKey('', { escape: true })
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(escapeEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
    }
  })

  test('submits current values directly on return when no submit button is shown', async () => {
    const onSubmit = vi.fn()
    const view = await renderSelectMulti(
      <SelectMulti
        options={OPTIONS}
        defaultValue={['alpha']}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    )

    try {
      pressKey('', { return: true })
      expect(onSubmit).toHaveBeenCalledWith(['alpha'])
    } finally {
      view.unmount()
    }
  })

  test('renders an empty option list and submits an empty selection', async () => {
    const onSubmit = vi.fn()
    const view = await renderSelectMulti(
      <SelectMulti options={[]} onCancel={() => {}} onSubmit={onSubmit} />,
    )

    try {
      const output = view.text()

      expect(output).not.toContain('Alpha server')
      expect(output).not.toContain('1.')

      pressKey('', { return: true })
      expect(onSubmit).toHaveBeenCalledWith([])
    } finally {
      view.unmount()
    }
  })

  test('does not toggle disabled options with index keys or focused space', async () => {
    const onChange = vi.fn()
    const view = await renderSelectMulti(
      <SelectMulti
        options={OPTIONS}
        focusValue="beta"
        onCancel={() => {}}
        onChange={onChange}
      />,
    )

    try {
      pressKey('2', {})
      expect(onChange).not.toHaveBeenCalled()

      pressKey(' ', {})
      expect(onChange).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  })
})
