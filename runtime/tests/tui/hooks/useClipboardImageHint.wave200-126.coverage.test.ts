import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  addNotification: vi.fn(),
  hasImageInClipboard: vi.fn(),
}))

vi.mock('../context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: harness.addNotification,
  }),
}))

vi.mock('../keybindings/shortcutFormat.js', () => ({
  getShortcutDisplay: () => 'Ctrl+V',
}))

vi.mock('../../utils/imagePaste.js', () => ({
  hasImageInClipboard: harness.hasImageInClipboard,
}))

import { createRoot } from '../ink/root.js'
import { useClipboardImageHint } from './useClipboardImageHint.js'

type HookProps = {
  enabled: boolean
  isFocused: boolean
}

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough
}

function createStreams(): TestStreams {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStreams['stdin']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  ;(stdout as unknown as { columns: number }).columns = 100

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

describe('useClipboardImageHint coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(60_000)
    harness.addNotification.mockClear()
    harness.hasImageInClipboard.mockReset()
    harness.hasImageInClipboard.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('debounces focus-regain checks, skips disabled and missed images, notifies once per cooldown window', async () => {
    const rendered = await renderHookHarness({
      enabled: true,
      isFocused: true,
    })

    try {
      await flushEffects(1_000)
      expect(harness.hasImageInClipboard).not.toHaveBeenCalled()

      await rendered.render({ enabled: true, isFocused: false })
      await rendered.render({ enabled: false, isFocused: true })
      await flushEffects(1_000)
      expect(harness.hasImageInClipboard).not.toHaveBeenCalled()

      await rendered.render({ enabled: true, isFocused: false })
      await rendered.render({ isFocused: true })
      await rendered.render({ isFocused: false })
      await flushEffects(1_000)
      expect(harness.hasImageInClipboard).not.toHaveBeenCalled()

      await rendered.render({ isFocused: true })
      await flushEffects(1_000)
      expect(harness.hasImageInClipboard).toHaveBeenCalledTimes(1)
      expect(harness.addNotification).not.toHaveBeenCalled()

      harness.hasImageInClipboard.mockResolvedValue(true)
      await rendered.render({ isFocused: false })
      await rendered.render({ isFocused: true })
      await flushEffects(1_000)
      expect(harness.hasImageInClipboard).toHaveBeenCalledTimes(2)
      expect(harness.addNotification).toHaveBeenCalledWith({
        key: 'clipboard-image-hint',
        text: 'Image in clipboard · Ctrl+V to paste',
        priority: 'immediate',
        timeoutMs: 8000,
      })

      await rendered.render({ isFocused: false })
      await rendered.render({ isFocused: true })
      await flushEffects(1_000)
      expect(harness.hasImageInClipboard).toHaveBeenCalledTimes(2)
      expect(harness.addNotification).toHaveBeenCalledTimes(1)

      await rendered.render({ isFocused: false })
      await flushEffects(30_000)
      await rendered.render({ isFocused: true })
      await flushEffects(1_000)
      expect(harness.hasImageInClipboard).toHaveBeenCalledTimes(3)
      expect(harness.addNotification).toHaveBeenCalledTimes(2)
    } finally {
      await rendered.dispose()
    }
  })
})
