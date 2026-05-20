import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const imagePasteMocks = vi.hoisted(() => ({
  getImageFromClipboard: vi.fn(),
  isImageFilePath: vi.fn(),
  tryReadImageFromPath: vi.fn(),
}))

const logMocks = vi.hoisted(() => ({
  logError: vi.fn(),
}))

const platformMock = vi.hoisted(() => ({
  current: 'linux' as 'linux' | 'macos' | 'unknown' | 'windows' | 'wsl',
}))

vi.mock('../../utils/imagePaste.js', () => ({
  PASTE_THRESHOLD: 800,
  getImageFromClipboard: imagePasteMocks.getImageFromClipboard,
  isImageFilePath: imagePasteMocks.isImageFilePath,
  tryReadImageFromPath: imagePasteMocks.tryReadImageFromPath,
}))

vi.mock('../../utils/log.js', () => ({
  logError: logMocks.logError,
}))

vi.mock('../../utils/platform.js', () => ({
  getPlatform: () => platformMock.current,
}))

import { recordInputBurst, resetBurstDetector } from '../input/burst-detector.js'
import { createRoot } from '../ink/root.js'
import type { InputEvent, Key } from '../ink.js'
import type { ImageDimensions } from '../../utils/imageResizer.js'
import {
  shouldHandleInputAsPaste,
  supportsClipboardImageFallback,
  usePasteHandler,
} from './usePasteHandler.js'

type PasteHandlerProps = Parameters<typeof usePasteHandler>[0]
type PasteHandlerState = ReturnType<typeof usePasteHandler>

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

function defaultIsImageFilePath(text: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(
    text.trim().replace(/^['"]|['"]$/g, ''),
  )
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly reject: (error: unknown) => void
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, reject, resolve }
}

function inputEvent(isPasted: boolean): InputEvent {
  return {
    keypress: {
      isPasted,
    },
  } as InputEvent
}

function key(overrides: Partial<Key> = {}): Key {
  return { ...BASE_KEY, ...overrides }
}

async function sleep(ms = 0): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForPasteFlush(): Promise<void> {
  await sleep(140)
  await sleep()
}

async function renderPasteHandler(
  initialProps: PasteHandlerProps,
): Promise<{
  readonly dispose: () => Promise<void>
  readonly latest: () => PasteHandlerState
  readonly render: (next?: Partial<PasteHandlerProps>) => Promise<void>
}> {
  let props = initialProps
  let latest: PasteHandlerState | undefined
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    latest = usePasteHandler(props)
    return null
  }

  async function render(next: Partial<PasteHandlerProps> = {}): Promise<void> {
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
    render,
  }
}

beforeEach(() => {
  platformMock.current = 'linux'
  imagePasteMocks.getImageFromClipboard.mockReset()
  imagePasteMocks.getImageFromClipboard.mockResolvedValue(null)
  imagePasteMocks.isImageFilePath.mockReset()
  imagePasteMocks.isImageFilePath.mockImplementation(defaultIsImageFilePath)
  imagePasteMocks.tryReadImageFromPath.mockReset()
  imagePasteMocks.tryReadImageFromPath.mockResolvedValue(null)
  logMocks.logError.mockReset()
  resetBurstDetector()
})

afterEach(() => {
  resetBurstDetector()
})

describe('supportsClipboardImageFallback', () => {
  test('supports clipboard image fallback on Windows', () => {
    expect(supportsClipboardImageFallback('windows')).toBe(true)
  })

  test('supports clipboard image fallback on macOS', () => {
    expect(supportsClipboardImageFallback('macos')).toBe(true)
  })

  test('supports clipboard image fallback on Linux', () => {
    expect(supportsClipboardImageFallback('linux')).toBe(true)
  })

  test('does not support clipboard image fallback on WSL', () => {
    expect(supportsClipboardImageFallback('wsl')).toBe(false)
  })

  test('does not support clipboard image fallback on unknown platforms', () => {
    expect(supportsClipboardImageFallback('unknown')).toBe(false)
  })
})

describe('shouldHandleInputAsPaste', () => {
  test('does not treat a bracketed paste as pending when no paste handlers are provided', () => {
    expect(
      shouldHandleInputAsPaste({
        hasTextPasteHandler: false,
        hasImagePasteHandler: false,
        inputLength: 'kimi-k2.5'.length,
        pastePending: false,
        hasImageFilePath: false,
        isFromPaste: true,
      }),
    ).toBe(false)
  })

  test('treats bracketed text paste as pending when a text paste handler exists', () => {
    expect(
      shouldHandleInputAsPaste({
        hasTextPasteHandler: true,
        hasImagePasteHandler: false,
        inputLength: 'kimi-k2.5'.length,
        pastePending: false,
        hasImageFilePath: false,
        isFromPaste: true,
      }),
    ).toBe(true)
  })

  test('treats image path paste as pending when only an image handler exists', () => {
    expect(
      shouldHandleInputAsPaste({
        hasTextPasteHandler: false,
        hasImagePasteHandler: true,
        inputLength: 'C:\\Users\\jat\\image.png'.length,
        pastePending: false,
        hasImageFilePath: true,
        isFromPaste: false,
      }),
    ).toBe(true)
  })
})

describe('usePasteHandler', () => {
  test('routes a large plain paste through onPaste without calling onInput', async () => {
    const pastedText = 'p'.repeat(801)
    const onInput = vi.fn()
    const onPaste = vi.fn()
    const rendered = await renderPasteHandler({ onInput, onPaste })

    try {
      rendered.latest().wrappedOnInput(pastedText, key(), inputEvent(false))

      expect(onInput).not.toHaveBeenCalled()
      expect(onPaste).not.toHaveBeenCalled()

      await waitForPasteFlush()

      expect(onPaste).toHaveBeenCalledTimes(1)
      expect(onPaste).toHaveBeenCalledWith(pastedText)
      expect(onInput).not.toHaveBeenCalled()
      expect(rendered.latest().isPasting).toBe(false)
    } finally {
      await rendered.dispose()
    }
  })

  test('routes short bracketed paste content through onPaste', async () => {
    const onInput = vi.fn()
    const onPaste = vi.fn()
    const rendered = await renderPasteHandler({ onInput, onPaste })

    try {
      rendered.latest().wrappedOnInput('short', key(), inputEvent(true))

      await waitForPasteFlush()

      expect(onPaste).toHaveBeenCalledTimes(1)
      expect(onPaste).toHaveBeenCalledWith('short')
      expect(onInput).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('preserves callback ordering while a paste continuation is pending', async () => {
    const calls: string[] = []
    const onInput = vi.fn(input => calls.push(`input:${input}`))
    const onPaste = vi.fn(input => calls.push(`paste:${input}`))
    const rendered = await renderPasteHandler({ onInput, onPaste })

    try {
      rendered.latest().wrappedOnInput('first', key(), inputEvent(true))
      rendered.latest().wrappedOnInput('\nsecond', key(), inputEvent(false))

      await waitForPasteFlush()

      expect(onInput).not.toHaveBeenCalled()
      expect(onPaste).toHaveBeenCalledTimes(1)
      expect(onPaste).toHaveBeenCalledWith('first\nsecond')
      expect(calls).toEqual(['paste:first\nsecond'])
    } finally {
      await rendered.dispose()
    }
  })

  test('preserves image paste metadata from pasted file paths', async () => {
    const imagePath = '/tmp/agenc-screenshot.png'
    const dimensions: ImageDimensions = {
      displayHeight: 360,
      displayWidth: 640,
      originalHeight: 720,
      originalWidth: 1280,
    }
    imagePasteMocks.tryReadImageFromPath.mockResolvedValue({
      base64: 'image-data',
      dimensions,
      mediaType: 'image/png',
      path: imagePath,
    })
    const onImagePaste = vi.fn()
    const onInput = vi.fn()
    const onPaste = vi.fn()
    const rendered = await renderPasteHandler({
      onImagePaste,
      onInput,
      onPaste,
    })

    try {
      rendered.latest().wrappedOnInput(imagePath, key(), inputEvent(false))

      await waitForPasteFlush()

      expect(imagePasteMocks.tryReadImageFromPath).toHaveBeenCalledWith(imagePath)
      expect(onImagePaste).toHaveBeenCalledTimes(1)
      expect(onImagePaste).toHaveBeenCalledWith(
        'image-data',
        'image/png',
        'agenc-screenshot.png',
        dimensions,
        imagePath,
      )
      expect(onPaste).not.toHaveBeenCalled()
      expect(onInput).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('ignores empty bracketed paste when clipboard image lookup misses', async () => {
    platformMock.current = 'macos'
    imagePasteMocks.getImageFromClipboard.mockResolvedValue(null)
    const onImagePaste = vi.fn()
    const onInput = vi.fn()
    const onPaste = vi.fn()
    const rendered = await renderPasteHandler({
      onImagePaste,
      onInput,
      onPaste,
    })

    try {
      rendered.latest().wrappedOnInput('', key(), inputEvent(true))

      await sleep(90)

      expect(imagePasteMocks.getImageFromClipboard).toHaveBeenCalledTimes(1)
      expect(onImagePaste).not.toHaveBeenCalled()
      expect(onPaste).not.toHaveBeenCalled()
      expect(onInput).not.toHaveBeenCalled()
      expect(rendered.latest().isPasting).toBe(false)
    } finally {
      await rendered.dispose()
    }
  })

  test('logs rejected clipboard image lookup without routing paste callbacks', async () => {
    platformMock.current = 'macos'
    const error = new Error('clipboard unavailable')
    imagePasteMocks.getImageFromClipboard.mockRejectedValue(error)
    const onImagePaste = vi.fn()
    const onInput = vi.fn()
    const onPaste = vi.fn()
    const rendered = await renderPasteHandler({
      onImagePaste,
      onInput,
      onPaste,
    })

    try {
      rendered.latest().wrappedOnInput('', key(), inputEvent(true))

      await sleep(90)

      expect(logMocks.logError).toHaveBeenCalledWith(error)
      expect(onImagePaste).not.toHaveBeenCalled()
      expect(onPaste).not.toHaveBeenCalled()
      expect(onInput).not.toHaveBeenCalled()
      expect(rendered.latest().isPasting).toBe(false)
    } finally {
      await rendered.dispose()
    }
  })

  test('does not call image paste after clipboard lookup resolves post-cleanup', async () => {
    platformMock.current = 'macos'
    const pendingClipboard = deferred<{
      base64: string
      dimensions: ImageDimensions
      mediaType: string
    } | null>()
    imagePasteMocks.getImageFromClipboard.mockReturnValue(pendingClipboard.promise)
    const onImagePaste = vi.fn()
    const rendered = await renderPasteHandler({
      onImagePaste,
      onInput: vi.fn(),
    })

    rendered.latest().wrappedOnInput('', key(), inputEvent(true))
    await vi.waitFor(() => {
      expect(imagePasteMocks.getImageFromClipboard).toHaveBeenCalledTimes(1)
    })

    await rendered.dispose()
    pendingClipboard.resolve({
      base64: 'late-image',
      dimensions: { displayHeight: 2, displayWidth: 1 },
      mediaType: 'image/png',
    })
    await sleep()

    expect(onImagePaste).not.toHaveBeenCalled()
  })

  test('exposes suspected raw paste as a one-shot confirmation flag', async () => {
    const rendered = await renderPasteHandler({ onInput: vi.fn() })

    try {
      expect(rendered.latest().isSuspectedPaste()).toBe(false)

      recordInputBurst(60, false)

      expect(rendered.latest().isSuspectedPaste()).toBe(true)
      expect(rendered.latest().consumeSuspectedPaste()).toBe(true)
      expect(rendered.latest().isSuspectedPaste()).toBe(false)
      expect(rendered.latest().consumeSuspectedPaste()).toBe(false)

      recordInputBurst(60, true)

      expect(rendered.latest().isSuspectedPaste()).toBe(false)
    } finally {
      await rendered.dispose()
    }
  })
})
