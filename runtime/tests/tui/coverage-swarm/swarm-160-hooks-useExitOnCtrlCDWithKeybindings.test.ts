import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { ExitState } from '../../../src/tui/hooks/useExitOnCtrlCDWithKeybindings.js'

type CapturedKeybindings = {
  handlers: Record<string, () => void>
  options: {
    context?: string
    isActive?: boolean
  }
}

const fixture = vi.hoisted(() => ({
  appExit: vi.fn(),
  keybindings: [] as CapturedKeybindings[],
  reset() {
    this.appExit.mockClear()
    this.keybindings = []
  },
}))

vi.mock(
  '../../../src/tui/ink/components/AppContext.js',
  async importOriginal => {
    const actual =
      await importOriginal<
        typeof import('../../../src/tui/ink/components/AppContext.js')
      >()

    return {
      ...actual,
      useApp: () => ({
        exit: fixture.appExit,
      }),
    }
  },
)

vi.mock('../../../src/tui/keybindings/useKeybinding.js', () => ({
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: CapturedKeybindings['options'],
  ) => {
    fixture.keybindings.push({ handlers, options })
  },
}))

import { createRoot } from '../../../src/tui/ink/root.js'
import { useExitOnCtrlCDWithKeybindings } from '../../../src/tui/hooks/useExitOnCtrlCDWithKeybindings.js'

type HookProps = {
  isActive?: boolean
  onExit?: () => void
  onInterrupt?: () => boolean
}

type TestStreams = {
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdout: PassThrough & {
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
  await new Promise(resolve => setTimeout(resolve, 0))
}

function latestKeybindings(): CapturedKeybindings {
  const keybindings = fixture.keybindings.at(-1)
  if (keybindings === undefined) {
    throw new Error('keybindings were not registered')
  }
  return keybindings
}

async function renderHookHarness(props: HookProps = {}): Promise<{
  dispose: () => Promise<void>
  latest: () => ExitState
  press: (action: 'app:exit' | 'app:interrupt') => Promise<void>
}> {
  let latest: ExitState | undefined
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    latest = useExitOnCtrlCDWithKeybindings(
      props.onExit,
      props.onInterrupt,
      props.isActive,
    )
    return null
  }

  root.render(React.createElement(Harness))
  await flushEffects()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushEffects()
    },
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
    press: async action => {
      const handler = latestKeybindings().handlers[action]
      if (handler === undefined) {
        throw new Error(`missing handler for ${action}`)
      }

      handler()
      await flushEffects()
    },
  }
}

describe('useExitOnCtrlCDWithKeybindings coverage swarm 160', () => {
  beforeEach(() => {
    fixture.reset()
  })

  test('registers global bindings as active by default and exits on Ctrl-D double press', async () => {
    const rendered = await renderHookHarness()

    try {
      expect(rendered.latest()).toEqual({ pending: false, keyName: null })
      expect(latestKeybindings().options).toEqual({
        context: 'Global',
        isActive: true,
      })

      await rendered.press('app:exit')
      expect(rendered.latest()).toEqual({ pending: true, keyName: 'Ctrl-D' })
      expect(fixture.appExit).not.toHaveBeenCalled()

      await rendered.press('app:exit')
      expect(rendered.latest()).toEqual({ pending: false, keyName: 'Ctrl-D' })
      expect(fixture.appExit).toHaveBeenCalledTimes(1)
    } finally {
      await rendered.dispose()
    }
  })

  test('lets onInterrupt consume Ctrl-C before the double-press exit path', async () => {
    const onExit = vi.fn()
    const onInterrupt = vi.fn(() => true)
    const rendered = await renderHookHarness({
      isActive: false,
      onExit,
      onInterrupt,
    })

    try {
      expect(latestKeybindings().options).toEqual({
        context: 'Global',
        isActive: false,
      })

      await rendered.press('app:interrupt')
      expect(onInterrupt).toHaveBeenCalledTimes(1)
      expect(rendered.latest()).toEqual({ pending: false, keyName: null })
      expect(onExit).not.toHaveBeenCalled()
      expect(fixture.appExit).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('falls through to Ctrl-C double press when onInterrupt declines to handle it', async () => {
    const onExit = vi.fn()
    const onInterrupt = vi.fn(() => false)
    const rendered = await renderHookHarness({ onExit, onInterrupt })

    try {
      await rendered.press('app:interrupt')
      expect(onInterrupt).toHaveBeenCalledTimes(1)
      expect(rendered.latest()).toEqual({ pending: true, keyName: 'Ctrl-C' })
      expect(onExit).not.toHaveBeenCalled()

      await rendered.press('app:interrupt')
      expect(onInterrupt).toHaveBeenCalledTimes(2)
      expect(rendered.latest()).toEqual({ pending: false, keyName: 'Ctrl-C' })
      expect(onExit).toHaveBeenCalledTimes(1)
      expect(fixture.appExit).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })
})
