import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { describe, expect, test, vi } from 'vitest'

import StdinContext, {
  type Props as StdinProps,
} from '../../../src/tui/ink/components/StdinContext.js'
import { EventEmitter } from '../../../src/tui/ink/events/emitter.js'
import type { InputEvent, Key } from '../../../src/tui/ink/events/input-event.js'
import useInput from '../../../src/tui/ink/hooks/use-input.js'
import { createRoot, type Root } from '../../../src/tui/ink/root.js'

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

type InputHandler = (input: string, key: Key, event: InputEvent) => void

type HarnessContext = StdinProps & {
  readonly setRawMode: ReturnType<typeof vi.fn>
  readonly internal_eventEmitter: EventEmitter | undefined
}

function createStreams(): TestStreams {
  const stdin = new PassThrough() as TestStreams['stdin']
  const stdout = new PassThrough() as TestStreams['stdout']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 80
  stdout.rows = 24
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

function createKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    wheelUp: false,
    wheelDown: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    fn: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    ...overrides,
  }
}

function inputEvent(input: string, keyOverrides: Partial<Key> = {}): InputEvent {
  const key = createKey(keyOverrides)

  return {
    input,
    key,
  } as InputEvent
}

function createContext(
  overrides: Partial<HarnessContext> = {},
): HarnessContext {
  const { stdin } = createStreams()

  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    setRawMode: vi.fn(),
    isRawModeSupported: true,
    internal_exitOnCtrlC: true,
    internal_eventEmitter: new EventEmitter(),
    internal_querier: null,
    ...overrides,
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
  await new Promise(resolve => setImmediate(resolve))
  await act(async () => {
    await Promise.resolve()
  })
}

function InputProbe({
  handler,
  isActive,
}: {
  readonly handler: InputHandler
  readonly isActive?: boolean
}): null {
  useInput(handler, { isActive })
  return null
}

async function renderHookHarness(
  initialContext: HarnessContext,
  initialHandler: InputHandler,
  initialIsActive?: boolean,
): Promise<{
  readonly dispose: () => Promise<void>
  readonly render: (
    context: HarnessContext,
    handler: InputHandler,
    isActive?: boolean,
  ) => Promise<void>
}> {
  const { stdin, stdout } = createStreams()
  const root: Root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  async function render(
    context: HarnessContext,
    handler: InputHandler,
    isActive?: boolean,
  ): Promise<void> {
    await act(async () => {
      root.render(
        React.createElement(
          StdinContext.Provider,
          { value: context as StdinProps },
          React.createElement(InputProbe, { handler, isActive }),
        ),
      )
    })
    await flushEffects()
  }

  await render(initialContext, initialHandler, initialIsActive)

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

describe('useInput coverage swarm row 226', () => {
  test('enables raw mode while active and removes the input listener on unmount', async () => {
    const context = createContext({ internal_exitOnCtrlC: false })
    const handler = vi.fn<InputHandler>()
    const rendered = await renderHookHarness(context, handler)
    const event = inputEvent('x')

    try {
      expect(context.setRawMode.mock.calls).toEqual([[true]])
      expect(context.internal_eventEmitter?.listenerCount('input')).toBe(1)

      context.internal_eventEmitter?.emit('input', event)

      expect(handler).toHaveBeenCalledWith('x', event.key, event)
    } finally {
      await rendered.dispose()
    }

    expect(context.setRawMode.mock.calls).toEqual([[true], [false]])
    expect(context.internal_eventEmitter?.listenerCount('input')).toBe(0)

    context.internal_eventEmitter?.emit('input', inputEvent('after-unmount'))

    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('keeps the listener stable while inactive and gates handler dispatch', async () => {
    const context = createContext({ internal_exitOnCtrlC: false })
    const inactiveHandler = vi.fn<InputHandler>()
    const activeHandler = vi.fn<InputHandler>()
    const rendered = await renderHookHarness(context, inactiveHandler, false)

    try {
      const initialListener = context.internal_eventEmitter?.rawListeners('input')[0]

      expect(context.setRawMode).not.toHaveBeenCalled()
      expect(context.internal_eventEmitter?.listenerCount('input')).toBe(1)

      context.internal_eventEmitter?.emit('input', inputEvent('i'))

      expect(inactiveHandler).not.toHaveBeenCalled()

      await rendered.render(context, activeHandler)

      expect(context.internal_eventEmitter?.rawListeners('input')[0]).toBe(
        initialListener,
      )
      expect(context.setRawMode.mock.calls).toEqual([[true]])

      const activeEvent = inputEvent('a')
      context.internal_eventEmitter?.emit('input', activeEvent)

      expect(inactiveHandler).not.toHaveBeenCalled()
      expect(activeHandler).toHaveBeenCalledWith('a', activeEvent.key, activeEvent)

      await rendered.render(context, activeHandler, false)

      expect(context.setRawMode.mock.calls).toEqual([[true], [false]])

      context.internal_eventEmitter?.emit('input', inputEvent('off-again'))

      expect(activeHandler).toHaveBeenCalledTimes(1)
    } finally {
      await rendered.dispose()
    }
  })

  test('suppresses Ctrl+C for exit handling unless exitOnCtrlC is disabled', async () => {
    const context = createContext({ internal_exitOnCtrlC: true })
    const handler = vi.fn<InputHandler>()
    const rendered = await renderHookHarness(context, handler)

    try {
      context.internal_eventEmitter?.emit('input', inputEvent('c', { ctrl: true }))

      expect(handler).not.toHaveBeenCalled()

      await rendered.render(
        {
          ...context,
          internal_exitOnCtrlC: false,
        },
        handler,
      )

      const delegatedCtrlC = inputEvent('c', { ctrl: true })
      context.internal_eventEmitter?.emit('input', delegatedCtrlC)

      expect(handler).toHaveBeenCalledWith(
        'c',
        delegatedCtrlC.key,
        delegatedCtrlC,
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('tolerates a missing internal event emitter', async () => {
    const context = createContext({ internal_eventEmitter: undefined })
    const handler = vi.fn<InputHandler>()
    const rendered = await renderHookHarness(context, handler)

    await rendered.dispose()

    expect(context.setRawMode.mock.calls).toEqual([[true], [false]])
    expect(handler).not.toHaveBeenCalled()
  })
})
