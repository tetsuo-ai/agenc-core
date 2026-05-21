import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { describe, expect, test, vi } from 'vitest'

import type { OptionWithDescription } from '../../../src/tui/components/CustomSelect/select.js'
import {
  type SelectState,
  type UseSelectStateProps,
  useSelectState,
} from '../../../src/tui/components/CustomSelect/use-select-state.js'
import { createRoot } from '../../../src/tui/ink/root.js'

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

type Snapshot = {
  focusedIndex: number
  focusedValue: string | undefined
  isInInput: boolean
  value: string | undefined
  visibleValues: string[]
}

type HarnessProps = UseSelectStateProps<string> & {
  controlsRef: { current: SelectState<string> | null }
  snapshots: Snapshot[]
}

function createTestStreams(): TestStreams {
  const stdin = new PassThrough() as TestStreams['stdin']
  const stdout = new PassThrough() as TestStreams['stdout']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 120
  stdout.rows = 30
  stdout.isTTY = true

  return { stdin, stdout }
}

function option(
  value: string,
  overrides: Partial<OptionWithDescription<string>> = {},
): OptionWithDescription<string> {
  return {
    value,
    label: value,
    ...overrides,
  }
}

function snapshotOf(state: SelectState<string>): Snapshot {
  return {
    focusedIndex: state.focusedIndex,
    focusedValue: state.focusedValue,
    isInInput: state.isInInput,
    value: state.value,
    visibleValues: state.visibleOptions.map(visible => visible.value),
  }
}

function snapshotsMatch(
  snapshot: Snapshot,
  expected: Partial<Snapshot>,
): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const actual = snapshot[key as keyof Snapshot]
    return Array.isArray(value)
      ? JSON.stringify(actual) === JSON.stringify(value)
      : actual === value
  })
}

async function waitForSnapshot(
  snapshots: Snapshot[],
  expected: Partial<Snapshot>,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 2_000) {
    if (snapshots.some(snapshot => snapshotsMatch(snapshot, expected))) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error(
    `Timed out waiting for select state ${JSON.stringify({
      expected,
      latest: snapshots.at(-1),
    })}`,
  )
}

function Harness({
  controlsRef,
  snapshots,
  ...props
}: HarnessProps): null {
  const state = useSelectState(props)
  controlsRef.current = state

  React.useEffect(() => {
    snapshots.push(snapshotOf(state))
  }, [snapshots, state])

  return null
}

async function renderHarness(props: HarnessProps): Promise<{
  dispose: () => Promise<void>
}> {
  const { stdin, stdout } = createTestStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  await act(async () => {
    root.render(React.createElement(Harness, props))
  })

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await act(async () => {
        await Promise.resolve()
      })
    },
  }
}

describe('useSelectState coverage swarm row 241', () => {
  test('keeps selected value local and selects the currently focused option', async () => {
    const controlsRef = { current: null as SelectState<string> | null }
    const snapshots: Snapshot[] = []
    const onCancel = vi.fn()
    const onChange = vi.fn()
    const onFocus = vi.fn()
    const rendered = await renderHarness({
      controlsRef,
      defaultFocusValue: 'prompt',
      defaultValue: 'alpha',
      onCancel,
      onChange,
      onFocus,
      options: [
        option('alpha'),
        option('prompt', { type: 'input', onChange: vi.fn() }),
        option('omega'),
      ],
      snapshots,
    })

    try {
      await waitForSnapshot(snapshots, {
        focusedIndex: 2,
        focusedValue: 'prompt',
        isInInput: true,
        value: 'alpha',
        visibleValues: ['alpha', 'prompt', 'omega'],
      })

      expect(onFocus).toHaveBeenCalledWith('prompt')
      expect(controlsRef.current?.onCancel).toBe(onCancel)
      expect(controlsRef.current?.onChange).toBe(onChange)

      await act(async () => {
        controlsRef.current?.selectFocusedOption()
      })
      await waitForSnapshot(snapshots, {
        focusedValue: 'prompt',
        value: 'prompt',
      })

      await act(async () => {
        controlsRef.current?.focusOption('omega')
      })
      await waitForSnapshot(snapshots, {
        focusedIndex: 3,
        focusedValue: 'omega',
        isInInput: false,
      })

      await act(async () => {
        controlsRef.current?.selectFocusedOption()
      })
      await waitForSnapshot(snapshots, {
        focusedValue: 'omega',
        value: 'omega',
      })
    } finally {
      await rendered.dispose()
    }
  })
})
