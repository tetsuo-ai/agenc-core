import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import TerminalFocusContext, {
  TerminalFocusProvider,
  type TerminalFocusContextProps,
} from '../../../src/tui/ink/components/TerminalFocusContext.js'
import { createRoot } from '../../../src/tui/ink/root.js'
import {
  resetTerminalFocusState,
  setTerminalFocused,
} from '../../../src/tui/ink/terminal-focus-state.js'

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

const realSetImmediate = setImmediate

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

async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
  await new Promise<void>(resolve => realSetImmediate(resolve))
  await act(async () => {
    await Promise.resolve()
  })
}

async function waitFor(assertion: () => void): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown

  while (Date.now() - startedAt < 1_000) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await flushReact()
    }
  }

  throw lastError
}

function FocusProbe({
  onValue,
}: {
  readonly onValue: (value: TerminalFocusContextProps) => void
}): null {
  onValue(React.useContext(TerminalFocusContext))
  return null
}

function StableChildrenHarness({
  onReady,
  onValue,
}: {
  readonly onReady: (forceRender: () => void) => void
  readonly onValue: (value: TerminalFocusContextProps) => void
}): React.ReactNode {
  const [, forceRender] = React.useReducer((tick: number) => tick + 1, 0)
  const child = React.useMemo(() => <FocusProbe onValue={onValue} />, [onValue])

  React.useEffect(() => {
    onReady(forceRender)
  }, [forceRender, onReady])

  return <TerminalFocusProvider>{child}</TerminalFocusProvider>
}

afterEach(() => {
  resetTerminalFocusState()
})

describe('TerminalFocusContext coverage swarm row 238', () => {
  test('exposes the default focused unknown context outside a provider', async () => {
    const values: TerminalFocusContextProps[] = []
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      await act(async () => {
        root.render(<FocusProbe onValue={value => values.push(value)} />)
      })
      await waitFor(() => {
        expect(values.at(-1)).toEqual({
          isTerminalFocused: true,
          terminalFocusState: 'unknown',
        })
      })

      expect(TerminalFocusContext.displayName).toBe('TerminalFocusContext')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushReact()
    }
  })

  test('publishes terminal focus snapshots and updates subscribers', async () => {
    const values: TerminalFocusContextProps[] = []
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      await act(async () => {
        root.render(
          <TerminalFocusProvider>
            <FocusProbe onValue={value => values.push(value)} />
          </TerminalFocusProvider>,
        )
      })

      await waitFor(() => {
        expect(values.at(-1)).toEqual({
          isTerminalFocused: true,
          terminalFocusState: 'unknown',
        })
      })

      await act(async () => {
        setTerminalFocused(false)
      })
      await waitFor(() => {
        expect(values.at(-1)).toEqual({
          isTerminalFocused: false,
          terminalFocusState: 'blurred',
        })
      })

      await act(async () => {
        setTerminalFocused(true)
      })
      await waitFor(() => {
        expect(values.at(-1)).toEqual({
          isTerminalFocused: true,
          terminalFocusState: 'focused',
        })
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushReact()
    }
  })

  test('keeps stable children from rendering again when focus is unchanged', async () => {
    const values: TerminalFocusContextProps[] = []
    let forceRender: (() => void) | undefined
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      await act(async () => {
        root.render(
          <StableChildrenHarness
            onReady={nextForceRender => {
              forceRender = nextForceRender
            }}
            onValue={value => values.push(value)}
          />,
        )
      })

      await waitFor(() => {
        expect(forceRender).toBeDefined()
        expect(values).toHaveLength(1)
      })

      await act(async () => {
        forceRender?.()
      })
      await flushReact()

      expect(values).toHaveLength(1)

      await act(async () => {
        setTerminalFocused(false)
      })
      await waitFor(() => {
        expect(values).toHaveLength(2)
        expect(values.at(-1)).toEqual({
          isTerminalFocused: false,
          terminalFocusState: 'blurred',
        })
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushReact()
    }
  })
})
