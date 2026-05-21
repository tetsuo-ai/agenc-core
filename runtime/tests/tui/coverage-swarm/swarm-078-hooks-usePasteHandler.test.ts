import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const imagePasteMocks = vi.hoisted(() => ({
  getImageFromClipboard: vi.fn(),
  isImageFilePath: vi.fn(),
  tryReadImageFromPath: vi.fn(),
}))

const platformMock = vi.hoisted(() => ({
  current: 'linux' as 'linux' | 'macos' | 'unknown' | 'windows' | 'wsl',
}))

vi.mock('../../../src/utils/imagePaste.js', () => ({
  PASTE_THRESHOLD: 800,
  getImageFromClipboard: imagePasteMocks.getImageFromClipboard,
  isImageFilePath: imagePasteMocks.isImageFilePath,
  tryReadImageFromPath: imagePasteMocks.tryReadImageFromPath,
}))

vi.mock('../../../src/utils/log.js', () => ({
  logError: vi.fn(),
}))

vi.mock('../../../src/utils/platform.js', () => ({
  getPlatform: () => platformMock.current,
}))

import { createRoot } from '../../../src/tui/ink/root.js'
import type { InputEvent, Key } from '../../../src/tui/ink.js'
import type { ImageDimensions } from '../../../src/utils/imageResizer.js'
import {
  shouldHandleInputAsPaste,
  usePasteHandler,
} from '../../../src/tui/hooks/usePasteHandler.js'

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
  await sleep(180)
  await sleep()
}

async function renderPasteHandler(
  initialProps: PasteHandlerProps,
): Promise<{
  readonly dispose: () => Promise<void>
  readonly latest: () => PasteHandlerState
}> {
  let latest: PasteHandlerState | undefined
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    latest = usePasteHandler(initialProps)
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
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shouldHandleInputAsPaste coverage swarm 078', () => {
  test('requires a matching handler before treating short non-pasted input as paste', () => {
    expect(
      shouldHandleInputAsPaste({
        hasTextPasteHandler: false,
        hasImagePasteHandler: false,
        inputLength: 4,
        pastePending: true,
        hasImageFilePath: true,
        isFromPaste: true,
      }),
    ).toBe(false)

    expect(
      shouldHandleInputAsPaste({
        hasTextPasteHandler: true,
        hasImagePasteHandler: false,
        inputLength: 4,
        pastePending: true,
        hasImageFilePath: false,
        isFromPaste: false,
      }),
    ).toBe(true)
  })
})

describe('usePasteHandler coverage swarm 078', () => {
  test('passes ordinary input through without entering paste handling', async () => {
    const onInput = vi.fn()
    const onPaste = vi.fn()
    const rendered = await renderPasteHandler({ onInput, onPaste })

    try {
      rendered.latest().wrappedOnInput('a', key({ ctrl: true }), inputEvent(false))

      expect(onInput).toHaveBeenCalledTimes(1)
      expect(onInput).toHaveBeenCalledWith('a', key({ ctrl: true }))
      expect(onPaste).not.toHaveBeenCalled()
      expect(rendered.latest().isPasting).toBe(false)
    } finally {
      await rendered.dispose()
    }
  })

  test('strips orphaned terminal focus suffixes from pasted text', async () => {
    const onInput = vi.fn()
    const onPaste = vi.fn()
    const rendered = await renderPasteHandler({ onInput, onPaste })

    try {
      rendered.latest().wrappedOnInput('alpha[I', key(), inputEvent(true))
      await waitForPasteFlush()

      expect(onPaste).toHaveBeenCalledWith('alpha')
      expect(onInput).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('routes unreadable image paths back through text paste', async () => {
    const imagePath = '/tmp/agenc-missing.png'
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
      expect(onImagePaste).not.toHaveBeenCalled()
      expect(onPaste).toHaveBeenCalledTimes(1)
      expect(onPaste).toHaveBeenCalledWith(imagePath)
      expect(onInput).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('pastes readable dragged images and preserves non-image text lines', async () => {
    const dimensions: ImageDimensions = {
      displayHeight: 12,
      displayWidth: 20,
    }
    imagePasteMocks.tryReadImageFromPath.mockImplementation(
      async (path: string) => ({
        base64: `data:${path}`,
        dimensions,
        mediaType: 'image/png',
        path,
      }),
    )
    const onImagePaste = vi.fn()
    const onInput = vi.fn()
    const onPaste = vi.fn()
    const rendered = await renderPasteHandler({
      onImagePaste,
      onInput,
      onPaste,
    })

    try {
      rendered
        .latest()
        .wrappedOnInput(
          '/tmp/agenc-one.png\nnote for upload /tmp/agenc-two.jpg',
          key(),
          inputEvent(false),
        )
      await waitForPasteFlush()

      expect(onImagePaste).toHaveBeenCalledTimes(2)
      expect(onImagePaste).toHaveBeenNthCalledWith(
        1,
        'data:/tmp/agenc-one.png',
        'image/png',
        'agenc-one.png',
        dimensions,
        '/tmp/agenc-one.png',
      )
      expect(onImagePaste).toHaveBeenNthCalledWith(
        2,
        'data:/tmp/agenc-two.jpg',
        'image/png',
        'agenc-two.jpg',
        dimensions,
        '/tmp/agenc-two.jpg',
      )
      expect(onPaste).toHaveBeenCalledWith('note for upload')
      expect(onInput).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('falls back to clipboard image data for expired macOS screenshots', async () => {
    platformMock.current = 'macos'
    const dimensions: ImageDimensions = {
      displayHeight: 32,
      displayWidth: 40,
    }
    imagePasteMocks.getImageFromClipboard.mockResolvedValue({
      base64: 'clipboard-image',
      dimensions,
      mediaType: 'image/png',
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
      rendered
        .latest()
        .wrappedOnInput(
          '/private/var/folders/x/T/TemporaryItems/com.apple.screencaptureui/session/Screenshot 2026-05-20 at 1.00.00 PM.png',
          key(),
          inputEvent(false),
        )
      await waitForPasteFlush()

      expect(imagePasteMocks.getImageFromClipboard).toHaveBeenCalledTimes(1)
      expect(onImagePaste).toHaveBeenCalledWith(
        'clipboard-image',
        'image/png',
        undefined,
        dimensions,
      )
      expect(onPaste).not.toHaveBeenCalled()
      expect(onInput).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })
})
