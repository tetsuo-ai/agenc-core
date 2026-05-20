import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const keybindingMocks = vi.hoisted(() => ({
  useKeybindings: vi.fn(),
}))

vi.mock('../keybindings/useKeybinding.js', () => ({
  useKeybindings: keybindingMocks.useKeybindings,
}))

import { createRoot, type Root } from '../ink/root.js'
import { MessageActionsKeybindings } from './messageActions.js'

function createStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
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
  stdout.resume()
  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function createInkRoot(): Promise<{
  dispose: () => Promise<void>
  root: Root
}> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    root,
  }
}

describe('MessageActionsKeybindings coverage', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  test('registers message-action handlers and memoizes options until activity changes', async () => {
    const handlers = {
      'messageActions:next': vi.fn(),
      'messageActions:prev': vi.fn(),
    }
    const rendered = await createInkRoot()

    try {
      rendered.root.render(
        <MessageActionsKeybindings handlers={handlers} isActive={true} />,
      )
      await sleep()

      expect(keybindingMocks.useKeybindings).toHaveBeenCalledTimes(1)
      expect(keybindingMocks.useKeybindings).toHaveBeenLastCalledWith(
        handlers,
        {
          context: 'MessageActions',
          isActive: true,
        },
      )
      const activeOptions = keybindingMocks.useKeybindings.mock.calls[0]?.[1]

      rendered.root.render(
        <MessageActionsKeybindings handlers={handlers} isActive={true} />,
      )
      await sleep()

      expect(keybindingMocks.useKeybindings).toHaveBeenCalledTimes(2)
      expect(keybindingMocks.useKeybindings.mock.calls[1]?.[1]).toBe(
        activeOptions,
      )

      rendered.root.render(
        <MessageActionsKeybindings handlers={handlers} isActive={false} />,
      )
      await sleep()

      expect(keybindingMocks.useKeybindings).toHaveBeenCalledTimes(3)
      expect(keybindingMocks.useKeybindings.mock.calls[2]?.[1]).toEqual({
        context: 'MessageActions',
        isActive: false,
      })
      expect(keybindingMocks.useKeybindings.mock.calls[2]?.[1]).not.toBe(
        activeOptions,
      )
    } finally {
      await rendered.dispose()
    }
  })
})
