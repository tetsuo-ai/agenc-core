import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  addNotification: vi.fn(),
  addToHistory: vi.fn(),
  fullscreen: false,
  markBackslashReturnUsed: vi.fn(),
  modifiers: {} as Record<string, boolean>,
  prewarmModifiers: vi.fn(),
  removeNotification: vi.fn(),
  reset() {
    this.addNotification.mockClear()
    this.addToHistory.mockClear()
    this.fullscreen = false
    this.markBackslashReturnUsed.mockClear()
    this.modifiers = {}
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
  isModifierPressed: (modifier: string) => harness.modifiers[modifier] === true,
  prewarmModifiers: harness.prewarmModifiers,
}))

import { createRoot } from '../ink/root.js'
import type { Key } from '../ink.js'
import { clearKillRing } from '../../utils/TextCursor.js'
import { env } from '../../utils/env.js'
import { useTextInput, type UseTextInputProps } from './useTextInput.js'

type HookState = ReturnType<typeof useTextInput>

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
  ;(stdout as unknown as { columns: number }).columns = 100
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
  overrides: Partial<UseTextInputProps> = {},
): Promise<{
  readonly latest: () => HookState
  readonly onChange: ReturnType<typeof vi.fn>
  readonly render: (next?: Partial<UseTextInputProps>) => Promise<void>
  readonly dispose: () => Promise<void>
}> {
  const onChange = vi.fn()
  const onOffsetChange = vi.fn()
  let props: UseTextInputProps = {
    columns: 80,
    cursorChar: '|',
    externalOffset: overrides.value?.length ?? 0,
    invert: text => text,
    onChange,
    onOffsetChange,
    themeText: text => text,
    value: '',
    ...overrides,
  }
  let latest: HookState | undefined
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    latest = useTextInput(props)
    return null
  }

  async function render(next: Partial<UseTextInputProps> = {}): Promise<void> {
    props = { ...props, ...next }
    root.render(<Harness />)
    await sleep()
  }

  await render()

  return {
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
    onChange,
    render,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
  }
}

describe('useTextInput wave200 coverage', () => {
  const originalTerminal = env.terminal

  beforeEach(() => {
    harness.reset()
    clearKillRing()
    env.terminal = originalTerminal
  })

  afterEach(() => {
    clearKillRing()
    env.terminal = originalTerminal
    vi.restoreAllMocks()
  })

  test('maps uncovered editing and navigation key branches through onInput', async () => {
    const rendered = await renderHookHarness({
      disableEscapeDoublePress: true,
      externalOffset: 'alpha beta gamma'.length,
      value: 'alpha beta gamma',
    })

    try {
      rendered.latest().onInput('', key({ escape: true }))
      rendered.latest().onInput('y', key({ ctrl: true }))
      rendered.latest().onInput('y', key({ meta: true }))
      await sleep()
      expect(harness.addNotification).not.toHaveBeenCalled()
      expect(rendered.latest().value).toBe('alpha beta gamma')

      rendered.latest().onInput('', key({ leftArrow: true, ctrl: true }))
      await sleep()
      expect(rendered.latest().offset).toBe('alpha beta '.length)

      rendered.latest().onInput('', key({ rightArrow: true, meta: true }))
      await sleep()
      expect(rendered.latest().offset).toBe('alpha beta gamma'.length)

      rendered.latest().onInput('b', key({ ctrl: true }))
      await sleep()
      expect(rendered.latest().offset).toBe('alpha beta gamm'.length)

      rendered.latest().onInput('f', key({ ctrl: true }))
      await sleep()
      expect(rendered.latest().offset).toBe('alpha beta gamma'.length)

      rendered.latest().onInput('', key({ home: true }))
      await sleep()
      expect(rendered.latest().offset).toBe(0)

      rendered.latest().onInput('', key({ end: true }))
      await sleep()
      expect(rendered.latest().offset).toBe('alpha beta gamma'.length)

      rendered.latest().onInput('', key({ pageUp: true }))
      await sleep()
      expect(rendered.latest().offset).toBe(0)

      rendered.latest().onInput('', key({ pageDown: true }))
      await sleep()
      expect(rendered.latest().offset).toBe('alpha beta gamma'.length)

      rendered.latest().onInput('', key({ leftArrow: true }))
      await sleep()
      expect(rendered.latest().offset).toBe('alpha beta gamm'.length)

      rendered.latest().onInput('', key({ rightArrow: true }))
      await sleep()
      expect(rendered.latest().offset).toBe('alpha beta gamma'.length)

      rendered.latest().onInput('', key({ backspace: true }))
      await sleep()
      expect(rendered.latest().value).toBe('alpha beta gamm')

      rendered.latest().onInput('', key({ backspace: true, meta: true }))
      await sleep()
      expect(rendered.latest().value).toBe('alpha beta ')

      await rendered.render({
        externalOffset: 'alpha '.length,
        value: 'alpha beta gamma',
      })
      rendered.latest().onInput('f', key({ meta: true }))
      await sleep()
      expect(rendered.latest().offset).toBe('alpha beta '.length)

      await rendered.render({
        externalOffset: 'alpha '.length,
        value: 'alpha beta',
      })
      rendered.latest().onInput('', key({ delete: true }))
      await sleep()
      expect(rendered.latest().value).toBe('alpha eta')

      await rendered.render({
        externalOffset: 'alpha '.length,
        value: 'alpha beta',
      })
      rendered.latest().onInput('', key({ delete: true, meta: true }))
      await sleep()
      expect(rendered.latest().value).toBe('alpha ')
    } finally {
      await rendered.dispose()
    }
  })
})
