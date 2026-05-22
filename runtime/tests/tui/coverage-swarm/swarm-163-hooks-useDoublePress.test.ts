import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../../src/tui/ink.js'
import {
  DOUBLE_PRESS_TIMEOUT_MS,
  useDoublePress,
} from '../../../src/tui/hooks/useDoublePress.js'

type HookProps = {
  readonly onDoublePress: () => void
  readonly onFirstPress?: () => void
  readonly setPending: (pending: boolean) => void
  readonly sharedKey?: string
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

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

async function renderHookHarness(
  initialProps: HookProps,
): Promise<{
  readonly dispose: () => Promise<void>
  readonly press: () => Promise<void>
  readonly render: (next: Partial<HookProps>) => Promise<void>
}> {
  let props = initialProps
  let press: (() => void) | undefined
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    press = useDoublePress(
      props.setPending,
      props.onDoublePress,
      props.onFirstPress,
      props.sharedKey,
    )
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
    press: async () => {
      const currentPress = press
      if (currentPress === undefined) throw new Error('hook did not render')
      await act(async () => {
        currentPress()
      })
      await flushEffects()
    },
    render,
  }
}

async function renderSharedHookHarness(
  left: HookProps,
  right: HookProps,
): Promise<{
  readonly dispose: () => Promise<void>
  readonly pressLeft: () => Promise<void>
  readonly pressRight: () => Promise<void>
}> {
  let leftPress: (() => void) | undefined
  let rightPress: (() => void) | undefined
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    leftPress = useDoublePress(
      left.setPending,
      left.onDoublePress,
      left.onFirstPress,
      left.sharedKey,
    )
    rightPress = useDoublePress(
      right.setPending,
      right.onDoublePress,
      right.onFirstPress,
      right.sharedKey,
    )
    return null
  }

  await act(async () => {
    root.render(React.createElement(Harness))
  })
  await flushEffects()

  async function runPress(currentPress: (() => void) | undefined): Promise<void> {
    if (currentPress === undefined) throw new Error('hook did not render')
    await act(async () => {
      currentPress()
    })
    await flushEffects()
  }

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushEffects()
    },
    pressLeft: () => runPress(leftPress),
    pressRight: () => runPress(rightPress),
  }
}

describe('useDoublePress coverage swarm 163', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('runs first-press and double-press callbacks on the local pending window', async () => {
    const setPending = vi.fn()
    const onDoublePress = vi.fn()
    const onFirstPress = vi.fn()
    const rendered = await renderHookHarness({
      onDoublePress,
      onFirstPress,
      setPending,
    })

    try {
      await rendered.press()

      expect(onFirstPress).toHaveBeenCalledTimes(1)
      expect(setPending).toHaveBeenLastCalledWith(true)
      expect(onDoublePress).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(DOUBLE_PRESS_TIMEOUT_MS - 1)
      })
      await rendered.press()

      expect(onFirstPress).toHaveBeenCalledTimes(1)
      expect(setPending).toHaveBeenLastCalledWith(false)
      expect(onDoublePress).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(DOUBLE_PRESS_TIMEOUT_MS)
      })
      expect(setPending).toHaveBeenCalledTimes(2)
    } finally {
      await rendered.dispose()
    }
  })

  test('expires pending state and treats the next local press as a new first press', async () => {
    const setPending = vi.fn()
    const onDoublePress = vi.fn()
    const onFirstPress = vi.fn()
    const rendered = await renderHookHarness({
      onDoublePress,
      onFirstPress,
      setPending,
    })

    try {
      await rendered.press()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DOUBLE_PRESS_TIMEOUT_MS)
      })

      expect(setPending).toHaveBeenNthCalledWith(1, true)
      expect(setPending).toHaveBeenNthCalledWith(2, false)
      expect(onDoublePress).not.toHaveBeenCalled()

      await rendered.press()

      expect(onFirstPress).toHaveBeenCalledTimes(2)
      expect(setPending).toHaveBeenNthCalledWith(3, true)
      expect(onDoublePress).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('clears pending timeout on unmount', async () => {
    const setPending = vi.fn()
    const rendered = await renderHookHarness({
      onDoublePress: vi.fn(),
      setPending,
    })

    await rendered.press()
    await rendered.dispose()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOUBLE_PRESS_TIMEOUT_MS)
    })

    expect(setPending).toHaveBeenCalledTimes(1)
    expect(setPending).toHaveBeenLastCalledWith(true)
  })

  test('shares a double-press window between hook instances with the same key', async () => {
    const leftSetPending = vi.fn()
    const leftDoublePress = vi.fn()
    const leftFirstPress = vi.fn()
    const rightSetPending = vi.fn()
    const rightDoublePress = vi.fn()
    const rightFirstPress = vi.fn()
    const rendered = await renderSharedHookHarness(
      {
        onDoublePress: leftDoublePress,
        onFirstPress: leftFirstPress,
        setPending: leftSetPending,
        sharedKey: 'shared-confirm',
      },
      {
        onDoublePress: rightDoublePress,
        onFirstPress: rightFirstPress,
        setPending: rightSetPending,
        sharedKey: 'shared-confirm',
      },
    )

    try {
      await rendered.pressLeft()

      expect(leftFirstPress).toHaveBeenCalledTimes(1)
      expect(leftSetPending).toHaveBeenLastCalledWith(true)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      await rendered.pressRight()

      expect(rightFirstPress).not.toHaveBeenCalled()
      expect(rightSetPending).toHaveBeenLastCalledWith(false)
      expect(rightDoublePress).toHaveBeenCalledTimes(1)
      expect(leftDoublePress).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('keeps newer shared-key presses when an older shared timeout resolves', async () => {
    const leftSetPending = vi.fn()
    const leftFirstPress = vi.fn()
    const rightSetPending = vi.fn()
    const rightDoublePress = vi.fn()
    const rightFirstPress = vi.fn()
    const rendered = await renderSharedHookHarness(
      {
        onDoublePress: vi.fn(),
        onFirstPress: leftFirstPress,
        setPending: leftSetPending,
        sharedKey: 'stale-shared-token',
      },
      {
        onDoublePress: rightDoublePress,
        onFirstPress: rightFirstPress,
        setPending: rightSetPending,
        sharedKey: 'stale-shared-token',
      },
    )

    try {
      await rendered.pressLeft()

      vi.setSystemTime(1_000_000 + DOUBLE_PRESS_TIMEOUT_MS + 1)
      await rendered.pressRight()

      expect(leftFirstPress).toHaveBeenCalledTimes(1)
      expect(rightFirstPress).toHaveBeenCalledTimes(1)
      expect(rightDoublePress).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(DOUBLE_PRESS_TIMEOUT_MS)
      })

      expect(leftSetPending).toHaveBeenLastCalledWith(false)
      expect(rightSetPending).toHaveBeenLastCalledWith(false)
    } finally {
      await rendered.dispose()
    }
  })
})
