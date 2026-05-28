import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  context: undefined as undefined | {
    activeContexts: Set<string>
    registrations: Array<{
      action: string
      context: string
      handler: () => void | false | Promise<void>
    }>
    registerHandler: ReturnType<typeof vi.fn>
    resolve: ReturnType<typeof vi.fn>
    setPendingChord: ReturnType<typeof vi.fn>
  },
  inputHandlers: [] as Array<{
    handler: (input: string, key: unknown, event: unknown) => void
    options: unknown
  }>,
  unregisters: [] as Array<ReturnType<typeof vi.fn>>,
}))

vi.mock('../ink.js', () => ({
  useInput: (handler: unknown, options: unknown) => {
    harness.inputHandlers.push({
      handler: handler as (input: string, key: unknown, event: unknown) => void,
      options,
    })
  },
}))

vi.mock('./KeybindingContext.js', () => ({
  useOptionalKeybindingContext: () => harness.context,
}))

import { createRoot } from '../ink/root.js'
import type { Key } from '../ink.js'
import type { InputEvent } from '../ink/events/input-event.js'
import { useKeybinding, useKeybindings } from './useKeybinding.js'

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

function event(): InputEvent & {
  stopImmediatePropagation: ReturnType<typeof vi.fn>
} {
  return {
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  } as unknown as InputEvent & {
    stopImmediatePropagation: ReturnType<typeof vi.fn>
  }
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

function makeContext() {
  harness.unregisters = []
  const registrations: Array<{
    action: string
    context: string
    handler: () => void | false | Promise<void>
  }> = []
  const context = {
    activeContexts: new Set(['Autocomplete', 'Chat']),
    registrations,
    registerHandler: vi.fn(registration => {
      registrations.push(registration)
      const unregister = vi.fn()
      harness.unregisters.push(unregister)
      return unregister
    }),
    resolve: vi.fn(),
    setPendingChord: vi.fn(),
  }
  harness.context = context
  return context
}

async function renderNode(node: React.ReactNode): Promise<{
  rerender: (nextNode: React.ReactNode) => Promise<void>
  dispose: () => Promise<void>
}> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  root.render(node)
  await sleep()
  return {
    rerender: async (nextNode: React.ReactNode) => {
      root.render(nextNode)
      await sleep()
    },
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
  }
}

function SingularProbe({
  handler,
  isActive = true,
}: {
  handler: () => void | false
  isActive?: boolean
}): null {
  useKeybinding('chat:submit', handler, { context: 'Chat', isActive })
  return null
}

function AggregateProbe({
  handlers,
}: {
  handlers: Record<string, (() => void | false) | undefined>
}): null {
  useKeybindings(handlers as Record<string, () => void | false>, {
    context: 'Chat',
  })
  return null
}

describe('useKeybinding wave200 coverage', () => {
  beforeEach(() => {
    harness.context = undefined
    harness.inputHandlers = []
    harness.unregisters = []
  })

  test('drives singular and aggregate resolver outcomes through captured input handlers', async () => {
    const inactive = await renderNode(
      React.createElement(SingularProbe, {
        handler: vi.fn(),
        isActive: false,
      }),
    )
    try {
      expect(harness.inputHandlers.at(-1)?.options).toEqual({
        isActive: false,
      })
      harness.inputHandlers.at(-1)?.handler('x', key(), event())
    } finally {
      await inactive.dispose()
    }

    harness.inputHandlers = []
    const singularContext = makeContext()
    const singularHandler = vi.fn()
    const singular = await renderNode(
      React.createElement(SingularProbe, { handler: singularHandler }),
    )
    const singularInput = harness.inputHandlers.at(-1)?.handler
    if (!singularInput) throw new Error('singular input handler was not captured')

    try {
      expect(singularContext.registerHandler).toHaveBeenCalledWith({
        action: 'chat:submit',
        context: 'Chat',
        handler: expect.any(Function),
      })

      const registeredSingularHandler = singularContext.registrations[0]?.handler
      if (!registeredSingularHandler) {
        throw new Error('singular registry handler was not captured')
      }
      registeredSingularHandler()
      expect(singularHandler).toHaveBeenCalledTimes(1)

      const nextSingularHandler = vi.fn()
      await singular.rerender(
        React.createElement(SingularProbe, {
          handler: nextSingularHandler,
        }),
      )
      expect(singularContext.registerHandler).toHaveBeenCalledTimes(1)
      registeredSingularHandler()
      expect(singularHandler).toHaveBeenCalledTimes(1)
      expect(nextSingularHandler).toHaveBeenCalledTimes(1)

      singularContext.resolve.mockReturnValueOnce({
        type: 'match',
        action: 'chat:submit',
      })
      const matched = event()
      singularInput('s', key({ ctrl: true }), matched)
      expect(singularContext.resolve).toHaveBeenLastCalledWith(
        's',
        key({ ctrl: true }),
        ['Autocomplete', 'Chat', 'Global'],
      )
      expect(singularContext.setPendingChord).toHaveBeenLastCalledWith(null)
      expect(nextSingularHandler).toHaveBeenCalledTimes(2)
      expect(matched.stopImmediatePropagation).toHaveBeenCalledTimes(1)

      nextSingularHandler.mockReturnValueOnce(false)
      singularContext.resolve.mockReturnValueOnce({
        type: 'match',
        action: 'chat:submit',
      })
      const fallThrough = event()
      singularInput('s', key(), fallThrough)
      expect(nextSingularHandler).toHaveBeenCalledTimes(3)
      expect(fallThrough.stopImmediatePropagation).not.toHaveBeenCalled()

      singularContext.resolve.mockReturnValueOnce({
        type: 'match',
        action: 'chat:cancel',
      })
      const otherAction = event()
      singularInput('c', key(), otherAction)
      expect(nextSingularHandler).toHaveBeenCalledTimes(3)
      expect(otherAction.stopImmediatePropagation).not.toHaveBeenCalled()

      const pendingChord = [{ key: 'x', ctrl: true }]
      singularContext.resolve.mockReturnValueOnce({
        type: 'chord_started',
        pending: pendingChord,
      })
      const chordStarted = event()
      singularInput('x', key({ ctrl: true }), chordStarted)
      expect(singularContext.setPendingChord).toHaveBeenLastCalledWith(
        pendingChord,
      )
      expect(chordStarted.stopImmediatePropagation).toHaveBeenCalledTimes(1)

      singularContext.resolve.mockReturnValueOnce({ type: 'chord_cancelled' })
      const chordCancelled = event()
      singularInput('', key({ escape: true }), chordCancelled)
      expect(singularContext.setPendingChord).toHaveBeenLastCalledWith(null)
      expect(chordCancelled.stopImmediatePropagation).not.toHaveBeenCalled()

      singularContext.resolve.mockReturnValueOnce({ type: 'unbound' })
      const unbound = event()
      singularInput('u', key(), unbound)
      expect(singularContext.setPendingChord).toHaveBeenLastCalledWith(null)
      expect(unbound.stopImmediatePropagation).toHaveBeenCalledTimes(1)

      singularContext.resolve.mockReturnValueOnce({ type: 'none' })
      const none = event()
      singularInput('z', key(), none)
      expect(none.stopImmediatePropagation).not.toHaveBeenCalled()
    } finally {
      await singular.dispose()
    }
    expect(harness.unregisters).toHaveLength(1)
    expect(harness.unregisters[0]).toHaveBeenCalledTimes(1)

    harness.inputHandlers = []
    const aggregateContext = makeContext()
    const submitHandler = vi.fn()
    const cancelHandler = vi.fn()
    const aggregate = await renderNode(
      React.createElement(AggregateProbe, {
        handlers: {
          'chat:cancel': cancelHandler,
          'chat:maybe': undefined,
          'chat:submit': submitHandler,
        },
      }),
    )
    const aggregateInput = harness.inputHandlers.at(-1)?.handler
    if (!aggregateInput) {
      throw new Error('aggregate input handler was not captured')
    }

    try {
      expect(aggregateContext.registerHandler).toHaveBeenCalledTimes(3)
      const registeredSubmitHandler = aggregateContext.registrations.find(
        registration => registration.action === 'chat:submit',
      )?.handler
      if (!registeredSubmitHandler) {
        throw new Error('aggregate registry handler was not captured')
      }
      registeredSubmitHandler()
      expect(submitHandler).toHaveBeenCalledTimes(1)

      const nextSubmitHandler = vi.fn()
      await aggregate.rerender(
        React.createElement(AggregateProbe, {
          handlers: {
            'chat:cancel': cancelHandler,
            'chat:maybe': undefined,
            'chat:submit': nextSubmitHandler,
          },
        }),
      )
      expect(aggregateContext.registerHandler).toHaveBeenCalledTimes(3)
      registeredSubmitHandler()
      expect(submitHandler).toHaveBeenCalledTimes(1)
      expect(nextSubmitHandler).toHaveBeenCalledTimes(1)

      aggregateContext.resolve.mockReturnValueOnce({
        type: 'match',
        action: 'chat:submit',
      })
      const aggregateMatched = event()
      aggregateInput('s', key(), aggregateMatched)
      expect(aggregateContext.resolve).toHaveBeenLastCalledWith(
        's',
        key(),
        ['Autocomplete', 'Chat', 'Global'],
      )
      expect(nextSubmitHandler).toHaveBeenCalledTimes(2)
      expect(aggregateMatched.stopImmediatePropagation).toHaveBeenCalledTimes(1)

      nextSubmitHandler.mockReturnValueOnce(false)
      aggregateContext.resolve.mockReturnValueOnce({
        type: 'match',
        action: 'chat:submit',
      })
      const aggregateFallThrough = event()
      aggregateInput('s', key(), aggregateFallThrough)
      expect(nextSubmitHandler).toHaveBeenCalledTimes(3)
      expect(aggregateFallThrough.stopImmediatePropagation).not.toHaveBeenCalled()

      aggregateContext.resolve.mockReturnValueOnce({
        type: 'match',
        action: 'chat:missing',
      })
      const missingAction = event()
      aggregateInput('m', key(), missingAction)
      expect(missingAction.stopImmediatePropagation).not.toHaveBeenCalled()

      aggregateContext.resolve.mockReturnValueOnce({
        type: 'match',
        action: 'chat:maybe',
      })
      const undefinedHandler = event()
      aggregateInput('u', key(), undefinedHandler)
      expect(undefinedHandler.stopImmediatePropagation).not.toHaveBeenCalled()

      aggregateContext.resolve.mockReturnValueOnce({
        type: 'chord_started',
        pending: [{ key: 'k', ctrl: true }],
      })
      const aggregateChord = event()
      aggregateInput('k', key({ ctrl: true }), aggregateChord)
      expect(aggregateContext.setPendingChord).toHaveBeenLastCalledWith([
        { key: 'k', ctrl: true },
      ])
      expect(aggregateChord.stopImmediatePropagation).toHaveBeenCalledTimes(1)

      aggregateContext.resolve.mockReturnValueOnce({
        type: 'chord_cancelled',
      })
      const aggregateCancelled = event()
      aggregateInput('', key({ escape: true }), aggregateCancelled)
      expect(aggregateContext.setPendingChord).toHaveBeenLastCalledWith(null)
      expect(aggregateCancelled.stopImmediatePropagation).not.toHaveBeenCalled()

      aggregateContext.resolve.mockReturnValueOnce({ type: 'unbound' })
      const aggregateUnbound = event()
      aggregateInput('u', key(), aggregateUnbound)
      expect(aggregateContext.setPendingChord).toHaveBeenLastCalledWith(null)
      expect(aggregateUnbound.stopImmediatePropagation).toHaveBeenCalledTimes(1)

      aggregateContext.resolve.mockReturnValueOnce({ type: 'none' })
      const aggregateNone = event()
      aggregateInput('n', key(), aggregateNone)
      expect(aggregateNone.stopImmediatePropagation).not.toHaveBeenCalled()
      expect(cancelHandler).not.toHaveBeenCalled()
    } finally {
      await aggregate.dispose()
    }

    expect(harness.unregisters).toHaveLength(3)
    expect(harness.unregisters.every(unregister => unregister.mock.calls.length === 1)).toBe(
      true,
    )
  })
})
