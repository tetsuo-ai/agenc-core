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
  isModifierPressed: (modifier: string) => harness.modifiers[modifier] === true,
  prewarmModifiers: harness.prewarmModifiers,
}))

import { createRoot } from '../ink/root.js'
import type { Key } from '../ink.js'
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
  overrides: Partial<UseTextInputProps> = {},
): Promise<{
  readonly latest: () => HookState
  readonly onChange: ReturnType<typeof vi.fn>
  readonly onOffsetChange: ReturnType<typeof vi.fn>
  readonly render: (next?: Partial<UseTextInputProps>) => Promise<void>
  readonly dispose: () => Promise<void>
}> {
  const onChange = vi.fn()
  const onOffsetChange = vi.fn()
  let props: UseTextInputProps = {
    columns: 20,
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
    onOffsetChange,
    render,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
  }
}

describe('useTextInput', () => {
  const originalTerminal = env.terminal

  beforeEach(() => {
    harness.reset()
    env.terminal = originalTerminal
  })

  afterEach(() => {
    env.terminal = originalTerminal
    vi.restoreAllMocks()
  })

  test('handles filtered input, mode characters, DEL bytes, and prop resync', async () => {
    const inputFilter = vi.fn((input: string) =>
      input === 'blocked' ? '' : input,
    )
    const rendered = await renderHookHarness({
      externalOffset: 0,
      inputFilter,
      value: '',
    })

    try {
      rendered.latest().onInput('blocked', key())
      await sleep()
      expect(rendered.latest().value).toBe('')
      expect(rendered.onChange).not.toHaveBeenCalled()

      rendered.latest().onInput('!', key())
      await sleep()
      expect(rendered.latest().value).toBe('!')
      expect(rendered.latest().offset).toBe(0)

      rendered.latest().onInput('abc', key())
      await sleep()
      expect(rendered.latest().value).toBe('abc!')

      rendered.latest().onInput('\x7f\x7f', key())
      await sleep()
      expect(rendered.latest().value).toBe('a!')

      rendered.latest().setOffset(2)
      await sleep()
      expect(rendered.latest().offset).toBe(2)
      rendered.latest().setOffset(2)
      await sleep()
      expect(rendered.onOffsetChange).toHaveBeenCalledTimes(3)

      await rendered.render({ externalOffset: 1, value: 'parent' })
      expect(rendered.latest().value).toBe('parent')
      expect(rendered.latest().offset).toBe(1)
    } finally {
      await rendered.dispose()
    }
  })

  test('handles cursor movement, kill ring, yank, and yank-pop editing', async () => {
    const rendered = await renderHookHarness({
      columns: 80,
      externalOffset: 'alpha beta gamma'.length,
      value: 'alpha beta gamma',
    })

    try {
      rendered.latest().onInput('a', key({ ctrl: true }))
      await sleep()
      expect(rendered.latest().offset).toBe(0)

      rendered.latest().onInput('e', key({ ctrl: true }))
      await sleep()
      expect(rendered.latest().offset).toBe('alpha beta gamma'.length)

      rendered.latest().onInput('b', key({ meta: true }))
      await sleep()
      expect(rendered.latest().offset).toBe('alpha beta '.length)

      rendered.latest().onInput('d', key({ meta: true }))
      await sleep()
      expect(rendered.latest().value).toBe('alpha beta ')

      await rendered.render({
        externalOffset: 'alpha '.length,
        value: 'alpha beta gamma',
      })
      rendered.latest().onInput('k', key({ ctrl: true }))
      await sleep()
      expect(rendered.latest().value).toBe('alpha ')

      rendered.latest().onInput('y', key({ ctrl: true }))
      await sleep()
      expect(rendered.latest().value).toBe('alpha beta gamma')

      rendered.latest().onInput('w', key({ ctrl: true }))
      await sleep()
      expect(rendered.latest().value).toBe('alpha beta ')

      rendered.latest().onInput('u', key({ ctrl: true }))
      await sleep()
      expect(rendered.latest().value).toBe('')

      rendered.latest().onInput('y', key({ ctrl: true }))
      await sleep()
      const firstYank = rendered.latest().value
      expect(firstYank.length).toBeGreaterThan(0)

      rendered.latest().onInput('y', key({ meta: true }))
      await sleep()
      expect(rendered.latest().value).not.toBe(firstYank)

      rendered.latest().onInput('h', key({ ctrl: true }))
      await sleep()
      expect(rendered.latest().value.length).toBeLessThan(firstYank.length)
    } finally {
      await rendered.dispose()
    }
  })

  test('handles enter variants and terminal control sequences', async () => {
    const onSubmit = vi.fn()
    const rendered = await renderHookHarness({
      externalOffset: 4,
      multiline: true,
      onSubmit,
      value: 'run\\',
    })

    try {
      rendered.latest().onInput('\r', key({ return: true }))
      await sleep()
      expect(harness.markBackslashReturnUsed).toHaveBeenCalledTimes(1)
      expect(rendered.latest().value).toBe('run\n')

      rendered.latest().onInput('\r', key({ meta: true, return: true }))
      await sleep()
      expect(rendered.latest().value).toBe('run\n\n')

      env.terminal = 'Apple_Terminal'
      harness.modifiers.shift = true
      await rendered.render({
        externalOffset: 4,
        value: 'line',
      })
      expect(harness.prewarmModifiers).toHaveBeenCalled()
      rendered.latest().onInput('\r', key({ return: true }))
      await sleep()
      expect(rendered.latest().value).toBe('line\n')

      env.terminal = originalTerminal
      harness.modifiers.shift = false
      await rendered.render({
        externalOffset: 'submit'.length,
        value: 'submit',
      })
      rendered.latest().onInput('\r', key({ return: true }))
      await sleep()
      expect(onSubmit).toHaveBeenLastCalledWith('submit')

      rendered.latest().onInput('x\r', key())
      await sleep()
      expect(onSubmit).toHaveBeenLastCalledWith('submitx')

      rendered.latest().onInput('\\\r', key())
      await sleep()
      expect(rendered.latest().value).toContain('\\\n')

      rendered.latest().onInput('\x1b[H', key())
      await sleep()
      expect(rendered.latest().offset).toBe(0)
      rendered.latest().onInput('\x1b[F', key())
      await sleep()
      expect(rendered.latest().offset).toBeGreaterThan(0)

      harness.fullscreen = true
      const beforePageKeys = {
        offset: rendered.latest().offset,
        value: rendered.latest().value,
      }
      rendered.latest().onInput('', key({ pageUp: true }))
      rendered.latest().onInput('', key({ pageDown: true }))
      rendered.latest().onInput('', key({ wheelUp: true }))
      rendered.latest().onInput('', key({ wheelDown: true }))
      rendered.latest().onInput('', key({ tab: true }))
      await sleep()
      expect(rendered.latest().value).toBe(beforePageKeys.value)
      expect(rendered.latest().offset).toBe(beforePageKeys.offset)
    } finally {
      await rendered.dispose()
    }
  })

  test('handles escape, ctrl-c, ctrl-d, and history callbacks', async () => {
    const onClearInput = vi.fn()
    const onExit = vi.fn()
    const onExitMessage = vi.fn()
    const onHistoryDown = vi.fn()
    const onHistoryReset = vi.fn()
    const onHistoryUp = vi.fn()
    const rendered = await renderHookHarness({
      disableCursorMovementForUpDownKeys: true,
      externalOffset: 'clear me'.length,
      onClearInput,
      onExit,
      onExitMessage,
      onHistoryDown,
      onHistoryReset,
      onHistoryUp,
      value: 'clear me',
    })

    try {
      rendered.latest().onInput('', key({ escape: true }))
      await sleep()
      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'escape-again-to-clear' }),
      )

      rendered.latest().onInput('', key({ escape: true }))
      await sleep()
      expect(harness.removeNotification).toHaveBeenCalledWith(
        'escape-again-to-clear',
      )
      expect(onClearInput).toHaveBeenCalledTimes(1)
      expect(harness.addToHistory).toHaveBeenCalledWith('clear me')
      expect(rendered.latest().value).toBe('')
      expect(onHistoryReset).toHaveBeenCalled()

      await rendered.render({
        externalOffset: 'interrupt'.length,
        value: 'interrupt',
      })
      rendered.latest().onInput('c', key({ ctrl: true }))
      await sleep()
      expect(rendered.latest().value).toBe('')
      expect(onExitMessage).toHaveBeenCalledWith(true, 'Ctrl-C')
      rendered.latest().onInput('c', key({ ctrl: true }))
      await sleep()
      expect(onExitMessage).toHaveBeenCalledWith(false, 'Ctrl-C')
      expect(onExit).toHaveBeenCalledTimes(1)

      rendered.latest().onInput('p', key({ ctrl: true }))
      rendered.latest().onInput('n', key({ ctrl: true }))
      await sleep()
      expect(onHistoryUp).toHaveBeenCalled()
      expect(onHistoryDown).toHaveBeenCalled()

      rendered.latest().onInput('d', key({ ctrl: true }))
      await sleep()
      expect(onExitMessage).toHaveBeenCalledWith(true, 'Ctrl-D')
      rendered.latest().onInput('d', key({ ctrl: true }))
      await sleep()
      expect(onExit).toHaveBeenCalledTimes(2)

      await rendered.render({
        externalOffset: 1,
        value: 'xy',
      })
      rendered.latest().onInput('d', key({ ctrl: true }))
      await sleep()
      expect(rendered.latest().value).toBe('x')
    } finally {
      await rendered.dispose()
    }
  })
})
