import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import type { OptionWithDescription } from '../../../src/tui/components/CustomSelect/select.js'
import {
  optionsNavigateEqual,
  type SelectNavigation,
  useSelectNavigation,
} from '../../../src/tui/components/CustomSelect/use-select-navigation.js'
import { createRoot } from '../../../src/tui/ink/root.js'

type TestStreams = {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
}

type Snapshot = {
  focusedIndex: number
  focusedValue: string | undefined
  isInInput: boolean
  visibleFromIndex: number
  visibleToIndex: number
  visibleValues: string[]
}

type NumberSnapshot = {
  focusedIndex: number
  focusedValue: number | undefined
  visibleValues: number[]
}

function createTestStreams(): TestStreams {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStreams['stdin']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120

  return { stdout, stdin }
}

function options(
  values: string[],
  overrides: Record<string, Partial<OptionWithDescription<string>>> = {},
): OptionWithDescription<string>[] {
  return values.map(value => ({
    value,
    label: value,
    ...overrides[value],
  }))
}

function snapshotOf(navigation: SelectNavigation<string>): Snapshot {
  return {
    focusedIndex: navigation.focusedIndex,
    focusedValue: navigation.focusedValue,
    isInInput: navigation.isInInput,
    visibleFromIndex: navigation.visibleFromIndex,
    visibleToIndex: navigation.visibleToIndex,
    visibleValues: navigation.visibleOptions.map(option => option.value),
  }
}

function numberSnapshotOf(
  navigation: SelectNavigation<number>,
): NumberSnapshot {
  return {
    focusedIndex: navigation.focusedIndex,
    focusedValue: navigation.focusedValue,
    visibleValues: navigation.visibleOptions.map(option => option.value),
  }
}

async function waitForNavigation(
  controlsRef: { current: SelectNavigation<string> | null },
  expected: Partial<Snapshot>,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 2_000) {
    const current = controlsRef.current
    if (current) {
      const snapshot = snapshotOf(current)
      const matches = Object.entries(expected).every(([key, value]) => {
        const actual = snapshot[key as keyof Snapshot]
        return Array.isArray(value)
          ? JSON.stringify(actual) === JSON.stringify(value)
          : actual === value
      })

      if (matches) {
        return
      }
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  const latest = controlsRef.current ? snapshotOf(controlsRef.current) : null
  throw new Error(
    `Timed out waiting for select navigation ${JSON.stringify({
      expected,
      latest,
    })}`,
  )
}

async function waitForNumberNavigation(
  controlsRef: { current: SelectNavigation<number> | null },
  expected: Partial<NumberSnapshot & Pick<Snapshot, 'visibleFromIndex' | 'visibleToIndex'>>,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 2_000) {
    const current = controlsRef.current
    if (current) {
      const snapshot = {
        ...numberSnapshotOf(current),
        visibleFromIndex: current.visibleFromIndex,
        visibleToIndex: current.visibleToIndex,
      }
      const matches = Object.entries(expected).every(([key, value]) => {
        const actual = snapshot[key as keyof typeof snapshot]
        return Array.isArray(value)
          ? JSON.stringify(actual) === JSON.stringify(value)
          : actual === value
      })

      if (matches) {
        return
      }
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  const latest = controlsRef.current
    ? {
        ...numberSnapshotOf(controlsRef.current),
        visibleFromIndex: controlsRef.current.visibleFromIndex,
        visibleToIndex: controlsRef.current.visibleToIndex,
      }
    : null
  throw new Error(
    `Timed out waiting for numeric select navigation ${JSON.stringify({
      expected,
      latest,
    })}`,
  )
}

function Harness({
  controlsRef,
  focusValue,
  initialFocusValue,
  onFocus,
  optionItems,
  visibleOptionCount,
}: {
  controlsRef: { current: SelectNavigation<string> | null }
  focusValue?: string
  initialFocusValue?: string
  onFocus?: (value: string) => void
  optionItems: OptionWithDescription<string>[]
  visibleOptionCount?: number
}): null {
  controlsRef.current = useSelectNavigation({
    focusValue,
    initialFocusValue,
    onFocus,
    options: optionItems,
    visibleOptionCount,
  })

  return null
}

function NumberHarness({
  controlsRef,
  focusSnapshots,
  focusValue,
  onFocus,
  optionItems,
  visibleOptionCount,
}: {
  controlsRef: { current: SelectNavigation<number> | null }
  focusSnapshots: NumberSnapshot[]
  focusValue?: number
  onFocus?: (value: number) => void
  optionItems: OptionWithDescription<number>[]
  visibleOptionCount?: number
}): null {
  const navigation = useSelectNavigation({
    focusValue,
    onFocus,
    options: optionItems,
    visibleOptionCount,
  })
  controlsRef.current = navigation
  focusSnapshots.push(numberSnapshotOf(navigation))

  return null
}

async function renderNavigation(
  props: Omit<React.ComponentProps<typeof Harness>, 'controlsRef'>,
): Promise<{
  controlsRef: { current: SelectNavigation<string> | null }
  dispose: () => void
  rerender: (
    nextProps: Omit<React.ComponentProps<typeof Harness>, 'controlsRef'>,
  ) => void
}> {
  const controlsRef = { current: null as SelectNavigation<string> | null }
  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  const render = (
    nextProps: Omit<React.ComponentProps<typeof Harness>, 'controlsRef'>,
  ) => {
    root.render(React.createElement(Harness, { ...nextProps, controlsRef }))
  }

  render(props)

  return {
    controlsRef,
    dispose: () => {
      root.unmount()
      stdin.end()
      stdout.end()
    },
    rerender: render,
  }
}

async function renderNumberNavigation(
  props: Omit<
    React.ComponentProps<typeof NumberHarness>,
    'controlsRef' | 'focusSnapshots'
  >,
): Promise<{
  controlsRef: { current: SelectNavigation<number> | null }
  dispose: () => void
  focusSnapshots: NumberSnapshot[]
}> {
  const controlsRef = { current: null as SelectNavigation<number> | null }
  const focusSnapshots: NumberSnapshot[] = []
  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  root.render(
    React.createElement(NumberHarness, {
      ...props,
      controlsRef,
      focusSnapshots,
    }),
  )

  return {
    controlsRef,
    focusSnapshots,
    dispose: () => {
      root.unmount()
      stdin.end()
      stdout.end()
    },
  }
}

describe('useSelectNavigation coverage swarm row 101', () => {
  test('compares option arrays using only navigation fields', () => {
    expect(
      optionsNavigateEqual(
        [{ value: 'same', label: 'Original' }],
        [{ value: 'same', label: React.createElement('span', null, 'New') }],
      ),
    ).toBe(true)

    expect(
      optionsNavigateEqual(
        [{ value: 'one', label: 'One' }],
        [
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
        ],
      ),
    ).toBe(false)

    expect(
      optionsNavigateEqual(
        [{ value: 'one', label: 'One' }],
        [{ value: 'two', label: 'One' }],
      ),
    ).toBe(false)

    expect(
      optionsNavigateEqual(
        [{ value: 'one', label: 'One' }],
        [{ value: 'one', label: 'One', disabled: true }],
      ),
    ).toBe(false)

    expect(
      optionsNavigateEqual(
        [{ type: 'input', value: 'one', label: 'One', onChange: vi.fn() }],
        [{ value: 'one', label: 'One' }],
      ),
    ).toBe(false)
  })

  test('uses the default page size when initial focus starts below the viewport', async () => {
    const rendered = await renderNavigation({
      initialFocusValue: 'seven',
      optionItems: options([
        'one',
        'two',
        'three',
        'four',
        'five',
        'six',
        'seven',
      ]),
    })

    try {
      await waitForNavigation(rendered.controlsRef, {
        focusedIndex: 7,
        focusedValue: 'seven',
        isInInput: false,
        visibleFromIndex: 2,
        visibleToIndex: 7,
        visibleValues: ['three', 'four', 'five', 'six', 'seven'],
      })

      rendered.controlsRef.current?.focusPreviousOption()
      await waitForNavigation(rendered.controlsRef, {
        focusedIndex: 6,
        focusedValue: 'six',
        visibleFromIndex: 2,
        visibleToIndex: 7,
        visibleValues: ['three', 'four', 'five', 'six', 'seven'],
      })
    } finally {
      rendered.dispose()
    }
  })

  test('preserves the current viewport when option metadata changes without moving focus', async () => {
    const onFocus = vi.fn()
    const rendered = await renderNavigation({
      initialFocusValue: 'two',
      onFocus,
      optionItems: options(['one', 'two', 'three', 'four']),
      visibleOptionCount: 2,
    })

    try {
      await waitForNavigation(rendered.controlsRef, {
        focusedValue: 'two',
        visibleFromIndex: 0,
        visibleToIndex: 2,
        visibleValues: ['one', 'two'],
      })

      rendered.rerender({
        initialFocusValue: 'two',
        onFocus,
        optionItems: options(['one', 'two', 'three', 'four'], {
          one: { disabled: true },
        }),
        visibleOptionCount: 2,
      })

      await waitForNavigation(rendered.controlsRef, {
        focusedIndex: 2,
        focusedValue: 'two',
        visibleFromIndex: 0,
        visibleToIndex: 2,
        visibleValues: ['one', 'two'],
      })
      expect(onFocus).toHaveBeenLastCalledWith('two')
    } finally {
      rendered.dispose()
    }
  })

  test('reports empty navigation as unfocused and non-input', async () => {
    const rendered = await renderNavigation({
      optionItems: [],
      visibleOptionCount: 3,
    })

    try {
      await waitForNavigation(rendered.controlsRef, {
        focusedIndex: 0,
        focusedValue: undefined,
        isInInput: false,
        visibleFromIndex: 0,
        visibleToIndex: 0,
        visibleValues: [],
      })

      rendered.controlsRef.current?.focusNextOption()
      rendered.controlsRef.current?.focusPreviousOption()
      rendered.controlsRef.current?.focusNextPage()
      rendered.controlsRef.current?.focusPreviousPage()
      rendered.controlsRef.current?.focusOption(undefined)

      await waitForNavigation(rendered.controlsRef, {
        focusedIndex: 0,
        focusedValue: undefined,
        visibleFromIndex: 0,
        visibleToIndex: 0,
        visibleValues: [],
      })
    } finally {
      rendered.dispose()
    }
  })

  test('honors falsy controlled focus values on the initial render', async () => {
    const onFocus = vi.fn()
    const rendered = await renderNumberNavigation({
      focusValue: 0,
      onFocus,
      optionItems: [
        { value: 1, label: 'one' },
        { value: 0, label: 'zero' },
        { value: 2, label: 'two' },
      ],
      visibleOptionCount: 2,
    })

    try {
      await waitForNumberNavigation(rendered.controlsRef, {
        focusedIndex: 2,
        focusedValue: 0,
        visibleFromIndex: 0,
        visibleToIndex: 2,
        visibleValues: [1, 0],
      })

      expect(rendered.focusSnapshots[0]).toEqual({
        focusedIndex: 2,
        focusedValue: 0,
        visibleValues: [1, 0],
      })
      expect(onFocus.mock.calls.map(([value]) => value)).toEqual([0])
    } finally {
      rendered.dispose()
    }
  })
})
