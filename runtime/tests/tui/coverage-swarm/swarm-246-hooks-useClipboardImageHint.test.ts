import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  addNotification: vi.fn(),
  hasImageInClipboard: vi.fn(),
}))

vi.mock('../../../src/tui/context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: fixture.addNotification,
  }),
}))

vi.mock('../../../src/tui/keybindings/shortcutFormat.js', () => ({
  getShortcutDisplay: vi.fn(() => 'Ctrl+V'),
}))

vi.mock('../../../src/utils/imagePaste.js', () => ({
  hasImageInClipboard: fixture.hasImageInClipboard,
}))

import { createRoot } from '../../../src/tui/ink.js'
import { useClipboardImageHint } from '../../../src/tui/hooks/useClipboardImageHint.js'

type HookProps = {
  readonly enabled: boolean
  readonly isFocused: boolean
}

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough & {
    columns: number
    isTTY: boolean
    rows: number
  }
}

function createStreams(): TestStreams {
  const stdin = new PassThrough() as TestStreams['stdin']
  const stdout = new PassThrough() as TestStreams['stdout']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 100
  stdout.rows = 24
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

async function flushEffects(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await Promise.resolve()
  })
}

async function renderHookHarness(
  initialProps: HookProps,
): Promise<{
  readonly dispose: () => Promise<void>
  readonly render: (next: Partial<HookProps>) => Promise<void>
}> {
  let props = initialProps
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    useClipboardImageHint(props.isFocused, props.enabled)
    return null
  }

  async function render(next: Partial<HookProps> = {}): Promise<void> {
    props = { ...props, ...next }
    await act(async () => {
      root.render(React.createElement(Harness))
    })
    await flushEffects()
  }

  await render()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushEffects()
    },
    render,
  }
}

describe('useClipboardImageHint coverage swarm row 246', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(60_000)
    fixture.addNotification.mockClear()
    fixture.hasImageInClipboard.mockReset()
    fixture.hasImageInClipboard.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('does not inspect the clipboard on initial focus or disabled focus regain', async () => {
    const rendered = await renderHookHarness({
      enabled: true,
      isFocused: true,
    })

    try {
      await flushEffects(1_000)
      expect(fixture.hasImageInClipboard).not.toHaveBeenCalled()

      await rendered.render({ isFocused: false })
      await rendered.render({ enabled: false, isFocused: true })
      await flushEffects(1_000)

      expect(fixture.hasImageInClipboard).not.toHaveBeenCalled()
      expect(fixture.addNotification).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('clears a pending debounce when focus is lost before the check fires', async () => {
    const rendered = await renderHookHarness({
      enabled: true,
      isFocused: false,
    })

    try {
      await rendered.render({ isFocused: true })
      await flushEffects(999)
      await rendered.render({ isFocused: false })
      await flushEffects(1)

      expect(fixture.hasImageInClipboard).not.toHaveBeenCalled()
      expect(fixture.addNotification).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('notifies for clipboard images and suppresses checks during cooldown', async () => {
    fixture.hasImageInClipboard.mockResolvedValue(true)
    const rendered = await renderHookHarness({
      enabled: true,
      isFocused: false,
    })

    try {
      await rendered.render({ isFocused: true })
      await flushEffects(1_000)

      expect(fixture.hasImageInClipboard).toHaveBeenCalledTimes(1)
      expect(fixture.addNotification).toHaveBeenCalledWith({
        key: 'clipboard-image-hint',
        text: 'Image in clipboard · Ctrl+V to paste',
        priority: 'immediate',
        timeoutMs: 8000,
      })

      await rendered.render({ isFocused: false })
      await rendered.render({ isFocused: true })
      await flushEffects(1_000)

      expect(fixture.hasImageInClipboard).toHaveBeenCalledTimes(1)
      expect(fixture.addNotification).toHaveBeenCalledTimes(1)

      await rendered.render({ isFocused: false })
      await flushEffects(30_000)
      await rendered.render({ isFocused: true })
      await flushEffects(1_000)

      expect(fixture.hasImageInClipboard).toHaveBeenCalledTimes(2)
      expect(fixture.addNotification).toHaveBeenCalledTimes(2)
    } finally {
      await rendered.dispose()
    }
  })
})
