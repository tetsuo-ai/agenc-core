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

vi.mock('src/tui/context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: harness.addNotification,
    removeNotification: harness.removeNotification,
  }),
}))

vi.mock('src/commands/terminalSetup/terminalSetup.js', () => ({
  markBackslashReturnUsed: harness.markBackslashReturnUsed,
}))

vi.mock('src/tui/history/history.js', () => ({
  addToHistory: harness.addToHistory,
}))

vi.mock('src/utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => harness.fullscreen,
}))

vi.mock('src/utils/modifiers.js', () => ({
  isModifierPressed: (modifier: string) => harness.modifiers[modifier] === true,
  prewarmModifiers: harness.prewarmModifiers,
}))

import { createRoot } from 'src/tui/ink/root.js'
import type { Key } from 'src/tui/ink.js'
import { clearKillRing } from 'src/utils/TextCursor.js'
import { useTextInput, type UseTextInputProps } from 'src/tui/hooks/useTextInput.js'

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
  readonly onExitMessage: ReturnType<typeof vi.fn>
  readonly onHistoryDown: ReturnType<typeof vi.fn>
  readonly onHistoryUp: ReturnType<typeof vi.fn>
  readonly onOffsetChange: ReturnType<typeof vi.fn>
  readonly render: (next?: Partial<UseTextInputProps>) => Promise<void>
  readonly dispose: () => Promise<void>
}> {
  const onChange = vi.fn()
  const onExitMessage = vi.fn()
  const onHistoryDown = vi.fn()
  const onHistoryUp = vi.fn()
  const onOffsetChange = vi.fn()
  let props: UseTextInputProps = {
    columns: 20,
    cursorChar: '|',
    externalOffset: overrides.value?.length ?? 0,
    invert: text => `<${text}>`,
    onChange,
    onExitMessage,
    onHistoryDown,
    onHistoryUp,
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
    root.render(React.createElement(Harness))
    await sleep()
  }

  await render()

  return {
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
    onChange,
    onExitMessage,
    onHistoryDown,
    onHistoryUp,
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

describe('useTextInput coverage swarm row 037', () => {
  beforeEach(() => {
    harness.reset()
    clearKillRing()
  })

  afterEach(() => {
    clearKillRing()
    vi.restoreAllMocks()
  })

  test('routes plain up and down arrows through wrapped cursor movement', async () => {
    const input = 'alpha beta gamma delta'
    const rendered = await renderHookHarness({
      columns: 8,
      externalOffset: input.length,
      value: input,
    })

    try {
      const endOffset = rendered.latest().offset

      rendered.latest().onInput('', key({ upArrow: true }))
      await sleep()
      const offsetAfterUp = rendered.latest().offset

      expect(offsetAfterUp).toBeLessThan(endOffset)
      expect(rendered.onHistoryUp).not.toHaveBeenCalled()

      rendered.latest().onInput('', key({ downArrow: true }))
      await sleep()
      expect(rendered.latest().offset).toBe(endOffset)
      expect(rendered.onHistoryDown).not.toHaveBeenCalled()

      rendered.latest().onInput('', key({ upArrow: true, shift: true }))
      await sleep()
      expect(rendered.latest().offset).toBe(endOffset)
    } finally {
      await rendered.dispose()
    }
  })

  test('falls back to history callbacks for multiline boundary arrows', async () => {
    const rendered = await renderHookHarness({
      externalOffset: 0,
      multiline: true,
      value: 'solo',
    })

    try {
      rendered.latest().onInput('', key({ upArrow: true }))
      await sleep()
      expect(rendered.onHistoryUp).toHaveBeenCalledTimes(1)
      expect(rendered.latest().offset).toBe(0)

      await rendered.render({ externalOffset: 'solo'.length, value: 'solo' })
      rendered.latest().onInput('', key({ downArrow: true }))
      await sleep()
      expect(rendered.onHistoryDown).toHaveBeenCalledTimes(1)
      expect(rendered.latest().offset).toBe('solo'.length)
    } finally {
      await rendered.dispose()
    }
  })

  test('renders inline ghost text only when insert position matches the cursor', async () => {
    const rendered = await renderHookHarness({
      dim: text => `[${text}]`,
      externalOffset: 3,
      inlineGhostText: { insertPosition: 3, text: ' there' },
      value: 'say',
    })

    try {
      expect(rendered.latest().renderedValue).toContain('< >[there]')

      await rendered.render({
        inlineGhostText: { insertPosition: 1, text: ' ignored' },
      })
      expect(rendered.latest().renderedValue).not.toContain('[ignored]')
    } finally {
      await rendered.dispose()
    }
  })

  test('ignores stale empty-input Ctrl-D timeout after local value changes', async () => {
    const rendered = await renderHookHarness({
      externalOffset: 0,
      value: '',
    })

    try {
      rendered.latest().onInput('x\x7f', key())
      await sleep()
      expect(rendered.latest().value).toBe('')
      expect(rendered.onChange).not.toHaveBeenCalled()

      rendered.latest().onInput('', key({ ctrl: true }))
      await sleep()
      expect(rendered.onExitMessage).not.toHaveBeenCalled()

      rendered.latest().onInput('d', key({ ctrl: true }))
      await sleep()
      expect(rendered.onExitMessage).toHaveBeenCalledWith(true, 'Ctrl-D')

      rendered.latest().setValue('busy', 4)
      await sleep()
      expect(rendered.latest().value).toBe('busy')

      rendered.latest().setValue('busy', 4)
      await sleep(850)
      expect(rendered.onExitMessage).not.toHaveBeenCalledWith(false, 'Ctrl-D')
    } finally {
      await rendered.dispose()
    }
  })
})
