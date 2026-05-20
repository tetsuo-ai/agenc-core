import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
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
    addNotification: harness.addNotification,
    removeNotification: harness.removeNotification,
  }),
}))

vi.mock('../../commands/terminalSetup/terminalSetup.js', () => ({
  markBackslashReturnUsed: harness.markBackslashReturnUsed,
}))

vi.mock('../history/history.js', () => ({
  addToHistory: harness.addToHistory,
}))

vi.mock('../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => harness.fullscreen,
}))

vi.mock('../../utils/modifiers.js', () => ({
  isModifierPressed: (modifier: string) =>
    harness.modifiers[modifier] === true,
  prewarmModifiers: harness.prewarmModifiers,
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

describe('useVimInput wave200 coverage', () => {
  beforeEach(() => {
    harness.reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('replays normal-mode edits after dot repeat and preserves mode transitions', async () => {
    const rendered = await renderHookHarness({
      externalOffset: 0,
      value: 'abc def ghi',
    })

    try {
      rendered.latest().setMode('NORMAL')
      await sleep()

      await rendered.send('.')
      expect(rendered.latest().value).toBe('abc def ghi')

      await rendered.send('f')
      await rendered.send('d')
      expect(rendered.latest().offset).toBe(4)

      await rendered.send(';')
      expect(rendered.latest().offset).toBe(4)

      await rendered.send('d')
      await rendered.send('w')
      expect(rendered.latest().value).toBe('abc ghi')

      await rendered.send('.')
      expect(rendered.latest().value).toBe('abc ')

      rendered.latest().setMode('INSERT')
      await sleep()
      expect(rendered.latest().mode).toBe('INSERT')
      expect(rendered.onModeChange).toHaveBeenLastCalledWith('INSERT')

      rendered.latest().setMode('NORMAL')
      await sleep()
      await rendered.send('A')
      expect(rendered.latest().mode).toBe('INSERT')
      expect(rendered.latest().offset).toBe(4)
    } finally {
      await rendered.dispose()
    }
  })
})
