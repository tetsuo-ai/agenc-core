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
  isModifierPressed: (modifier: string) =>
    harness.modifiers[modifier] === true,
  prewarmModifiers: harness.prewarmModifiers,
}))

import { createRoot } from 'src/tui/ink/root.js'
import type { Key } from 'src/tui/ink.js'
import { useVimInput } from 'src/tui/hooks/useVimInput.js'

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
  readonly onSubmit: ReturnType<typeof vi.fn>
  readonly send: (input: string, inputKey?: Partial<Key>) => Promise<void>
}> {
  const onChange = vi.fn()
  const onModeChange = vi.fn()
  const onOffsetChange = vi.fn()
  const onSubmit = vi.fn()
  let props: VimHookProps = {
    columns: 20,
    cursorChar: '|',
    externalOffset: overrides.value?.length ?? 0,
    invert: text => text,
    onChange,
    onModeChange,
    onOffsetChange,
    onSubmit,
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

  root.render(React.createElement(Harness))
  await sleep()

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
    onSubmit,
    send: async (input: string, inputKey: Partial<Key> = {}) => {
      if (latest === undefined) throw new Error('hook did not render')
      latest.onInput(input, key(inputKey))
      await sleep()
    },
  }
}

async function switchToNormal(rendered: {
  readonly latest: () => VimHookState
}): Promise<void> {
  rendered.latest().setMode('NORMAL')
  await sleep()
}

describe('useVimInput swarm coverage', () => {
  beforeEach(() => {
    harness.reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('replays character edits through dot repeat', async () => {
    const rendered = await renderHookHarness({
      externalOffset: 0,
      value: 'abc',
    })

    try {
      await switchToNormal(rendered)

      await rendered.send('x')
      expect(rendered.latest().value).toBe('bc')

      await rendered.send('.')
      expect(rendered.latest().value).toBe('c')
    } finally {
      await rendered.dispose()
    }

    const toggleRendered = await renderHookHarness({
      externalOffset: 0,
      value: 'aBc',
    })

    try {
      await switchToNormal(toggleRendered)

      await toggleRendered.send('~')
      expect(toggleRendered.latest().value).toBe('ABc')

      await toggleRendered.send('.')
      expect(toggleRendered.latest().value).toBe('Abc')
    } finally {
      await toggleRendered.dispose()
    }
  })

  test('replays line edits through dot repeat', async () => {
    const indentRendered = await renderHookHarness({
      externalOffset: 0,
      value: 'one\ntwo',
    })

    try {
      await switchToNormal(indentRendered)

      await indentRendered.send('>')
      await indentRendered.send('>')
      expect(indentRendered.latest().value).toBe('  one\ntwo')

      await indentRendered.send('.')
      expect(indentRendered.latest().value).toBe('    one\ntwo')
    } finally {
      await indentRendered.dispose()
    }

    const joinRendered = await renderHookHarness({
      externalOffset: 0,
      value: 'one\ntwo\nthree',
    })

    try {
      await switchToNormal(joinRendered)

      await joinRendered.send('J')
      expect(joinRendered.latest().value).toBe('one two\nthree')

      await joinRendered.send('.')
      expect(joinRendered.latest().value).toBe('one two three')
    } finally {
      await joinRendered.dispose()
    }

    const openLineRendered = await renderHookHarness({
      externalOffset: 0,
      value: 'one\ntwo',
    })

    try {
      await switchToNormal(openLineRendered)

      await openLineRendered.send('o')
      expect(openLineRendered.latest().value).toBe('one\n\ntwo')
      expect(openLineRendered.latest().mode).toBe('INSERT')

      await openLineRendered.send('', { escape: true })
      expect(openLineRendered.latest().mode).toBe('NORMAL')

      await openLineRendered.send('.')
      expect(openLineRendered.latest().value).toBe('one\n\n\ntwo')
      expect(openLineRendered.latest().mode).toBe('INSERT')
    } finally {
      await openLineRendered.dispose()
    }
  })

  test('replays find and text object operators through dot repeat', async () => {
    const findRendered = await renderHookHarness({
      externalOffset: 0,
      value: 'abc def ghi',
    })

    try {
      await switchToNormal(findRendered)

      await findRendered.send('d')
      await findRendered.send('f')
      await findRendered.send(' ')
      expect(findRendered.latest().value).toBe('def ghi')

      await findRendered.send('.')
      expect(findRendered.latest().value).toBe('ghi')
    } finally {
      await findRendered.dispose()
    }

    const textObjectRendered = await renderHookHarness({
      externalOffset: 1,
      value: '"one" "two"',
    })

    try {
      await switchToNormal(textObjectRendered)

      await textObjectRendered.send('d')
      await textObjectRendered.send('i')
      await textObjectRendered.send('"')
      expect(textObjectRendered.latest().value).toBe('"" "two"')

      await textObjectRendered.send('f')
      await textObjectRendered.send('"')
      await textObjectRendered.send('.')
      expect(textObjectRendered.latest().value).toBe('"" ""')
    } finally {
      await textObjectRendered.dispose()
    }
  })

  test('handles normal mode cancellation and passthrough branches', async () => {
    const rendered = await renderHookHarness({
      externalOffset: 1,
      value: 'abc',
    })

    try {
      await switchToNormal(rendered)

      await rendered.send('r')
      await rendered.send('', { escape: true })
      await rendered.send('z')
      expect(rendered.latest().value).toBe('abc')

      await rendered.send('', { backspace: true })
      expect(rendered.latest().offset).toBe(0)

      await rendered.send('2')
      await rendered.send('', { delete: true })
      await rendered.send('x')
      expect(rendered.latest().value).toBe('bc')

      await rendered.send('', { return: true })
      expect(rendered.onSubmit).toHaveBeenCalledWith('bc')
    } finally {
      await rendered.dispose()
    }

    const searchRendered = await renderHookHarness({
      externalOffset: 0,
      value: '',
    })

    try {
      await switchToNormal(searchRendered)

      await searchRendered.send('?')
      expect(searchRendered.onChange).toHaveBeenCalledWith('?')
    } finally {
      await searchRendered.dispose()
    }
  })
})
