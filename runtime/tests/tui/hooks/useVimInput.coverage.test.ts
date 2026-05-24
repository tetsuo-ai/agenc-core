import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const hookHarness = vi.hoisted(() => ({
  addNotification: vi.fn(),
  addToHistory: vi.fn(),
  fullscreen: false,
  markBackslashReturnUsed: vi.fn(),
  modifiers: {
    shift: false,
  } as Record<string, boolean>,
  prewarmModifiers: vi.fn(),
  removeNotification: vi.fn(),
  reset() {
    this.addNotification.mockClear()
    this.addToHistory.mockClear()
    this.fullscreen = false
    this.markBackslashReturnUsed.mockClear()
    this.modifiers = { shift: false }
    this.prewarmModifiers.mockClear()
    this.removeNotification.mockClear()
  },
}))

vi.mock('../context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: hookHarness.addNotification,
    removeNotification: hookHarness.removeNotification,
  }),
}))

vi.mock('../../commands/terminalSetup/terminalSetup.js', () => ({
  markBackslashReturnUsed: hookHarness.markBackslashReturnUsed,
}))

vi.mock('../history/history.js', () => ({
  addToHistory: hookHarness.addToHistory,
}))

vi.mock('../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => hookHarness.fullscreen,
}))

vi.mock('../../utils/modifiers.js', () => ({
  isModifierPressed: (modifier: string) =>
    hookHarness.modifiers[modifier] === true,
  prewarmModifiers: hookHarness.prewarmModifiers,
}))

import { createRoot } from '../ink/root.js'
import type { Key } from '../ink.js'
import { useVimInput } from './useVimInput.js'

type VimHookProps = Parameters<typeof useVimInput>[0]
type VimHookState = ReturnType<typeof useVimInput>

const BASE_KEY: Key = {
  backspace: false,
  ctrl: false,
  delete: false,
  downArrow: false,
  end: false,
  escape: false,
  fn: false,
  home: false,
  leftArrow: false,
  meta: false,
  pageDown: false,
  pageUp: false,
  return: false,
  rightArrow: false,
  shift: false,
  super: false,
  tab: false,
  upArrow: false,
  wheelDown: false,
  wheelUp: false,
}

function key(overrides: Partial<Key> = {}): Key {
  return { ...BASE_KEY, ...overrides }
}

function createStreams(): {
  readonly stdout: PassThrough
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
  stdout.resume()
  ;(stdout as unknown as { columns: number }).columns = 80
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
  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function renderHookHarness(
  overrides: Partial<VimHookProps> = {},
): Promise<{
  readonly dispose: () => Promise<void>
  readonly latest: () => VimHookState
  readonly onChange: ReturnType<typeof vi.fn>
  readonly onModeChange: ReturnType<typeof vi.fn>
  readonly onOffsetChange: ReturnType<typeof vi.fn>
  readonly render: (next?: Partial<VimHookProps>) => Promise<void>
  readonly send: (input: string, inputKey?: Partial<Key>) => Promise<void>
}> {
  const onChange = vi.fn()
  const onModeChange = vi.fn()
  const onOffsetChange = vi.fn()
  let props: VimHookProps = {
    columns: 20,
    cursorChar: '|',
    externalOffset: overrides.value?.length ?? 0,
    invert: text => text,
    onChange,
    onModeChange,
    onOffsetChange,
    themeText: text => text,
    value: '',
    ...overrides,
  }
  let latest: VimHookState | undefined
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    latest = useVimInput(props)
    return null
  }

  async function render(next: Partial<VimHookProps> = {}): Promise<void> {
    props = { ...props, ...next }
    root.render(React.createElement(Harness))
    await sleep()
  }

  await render()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
    onChange,
    onModeChange,
    onOffsetChange,
    render,
    send: async (input: string, inputKey: Partial<Key> = {}) => {
      if (latest === undefined) throw new Error('hook did not render')
      latest.onInput(input, key(inputKey))
      await sleep()
    },
  }
}

describe('useVimInput coverage', () => {
  beforeEach(() => {
    hookHarness.reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('runs the filter in every mode while routing NORMAL commands with raw input', async () => {
    const inputFilter = vi.fn((input: string) =>
      input === 'x' ? 'l' : input.toUpperCase(),
    )
    const rendered = await renderHookHarness({ inputFilter })

    try {
      await rendered.send('a')
      await rendered.send('b')
      expect(rendered.latest().value).toBe('AB')

      await rendered.send('', { escape: true })
      expect(rendered.latest().mode).toBe('NORMAL')
      expect(rendered.latest().offset).toBe(1)
      expect(rendered.onModeChange).toHaveBeenLastCalledWith('NORMAL')

      await rendered.send('.')
      expect(rendered.latest().value).toBe('AABB')
      expect(rendered.latest().mode).toBe('NORMAL')

      await rendered.send('r')
      await rendered.send('', { escape: true })
      await rendered.send('x')
      expect(rendered.latest().value).toBe('AAB')

      await rendered.send('.')
      expect(rendered.latest().value).toBe('AA')

      expect(inputFilter).toHaveBeenCalledWith('x', expect.any(Object))
    } finally {
      await rendered.dispose()
    }
  })

  test('leaves insert mode on a grapheme boundary before normal edits', async () => {
    const rendered = await renderHookHarness()

    try {
      await rendered.send('😀')
      expect(rendered.latest().value).toBe('😀')
      expect(rendered.latest().offset).toBe('😀'.length)

      await rendered.send('', { escape: true })
      expect(rendered.latest().mode).toBe('NORMAL')
      expect(rendered.latest().offset).toBe(0)

      await rendered.send('x')
      expect(rendered.latest().value).toBe('')
      expect(rendered.latest().offset).toBe(0)
    } finally {
      await rendered.dispose()
    }
  })
})
