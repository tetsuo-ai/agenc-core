import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import Text from '../../ink/components/Text.js'
import { createRoot } from '../../ink/root.js'
import type { OptionWithDescription } from './select.js'
import {
  optionsNavigateEqual,
  type SelectNavigation,
  useSelectNavigation,
} from './use-select-navigation.js'

vi.mock('../../../utils/debug.js', () => ({
  logForDebugging: () => {},
}))
vi.mock('../../../bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  markScrollActivity: () => {},
  updateLastInteractionTime: () => {},
}))
vi.mock('../../../utils/earlyInput.js', () => ({
  stopCapturingEarlyInput: () => {},
}))
vi.mock('../../../utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
}))
vi.mock('../../../utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => true,
}))
vi.mock('../../../utils/log.js', () => ({
  logError: () => {},
}))

type TestStreams = {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
}

type Snapshot = {
  focusedValue: string | undefined
  focusedIndex: number
  visibleFromIndex: number
  visibleToIndex: number
  visibleValues: string[]
  isInInput: boolean
}

function createTestStreams(): TestStreams {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStreams['stdin']

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120

  return { stdout, stdin }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for select navigation state')
}

function snapshotOf(navigation: SelectNavigation<string>): Snapshot {
  return {
    focusedValue: navigation.focusedValue,
    focusedIndex: navigation.focusedIndex,
    visibleFromIndex: navigation.visibleFromIndex,
    visibleToIndex: navigation.visibleToIndex,
    visibleValues: navigation.visibleOptions.map(option => option.value),
    isInInput: navigation.isInInput,
  }
}

function expectSnapshot(
  snapshots: Snapshot[],
  expected: Partial<Snapshot>,
): Promise<void> {
  return waitForCondition(() =>
    snapshots.some(snapshot =>
      Object.entries(expected).every(([key, value]) =>
        Array.isArray(value)
          ? JSON.stringify(snapshot[key as keyof Snapshot]) === JSON.stringify(value)
          : snapshot[key as keyof Snapshot] === value,
      ),
    ),
  )
}

function options(
  values: string[],
  inputValue?: string,
): OptionWithDescription<string>[] {
  return values.map(value =>
    value === inputValue
      ? {
          type: 'input',
          value,
          label: value,
          onChange: () => {},
        }
      : {
          value,
          label: value,
        },
  )
}

function Harness({
  controlsRef,
  focusValue,
  initialFocusValue,
  onFocus,
  optionItems,
  snapshots,
  visibleOptionCount = 2,
}: {
  controlsRef: { current: SelectNavigation<string> | null }
  focusValue?: string
  initialFocusValue?: string
  onFocus?: (value: string) => void
  optionItems: OptionWithDescription<string>[]
  snapshots: Snapshot[]
  visibleOptionCount?: number
}): React.ReactNode {
  const navigation = useSelectNavigation({
    visibleOptionCount,
    options: optionItems,
    initialFocusValue,
    focusValue,
    onFocus,
  })

  controlsRef.current = navigation

  React.useEffect(() => {
    snapshots.push(snapshotOf(navigation))
  }, [navigation, snapshots])

  return <Text>{navigation.focusedValue ?? 'none'}</Text>
}

describe('optionsNavigateEqual', () => {
  test('compares only navigation-relevant option fields', () => {
    expect(
      optionsNavigateEqual(
        [{ value: 'a', label: 'A' }],
        [{ value: 'a', label: <Text>A</Text> }],
      ),
    ).toBe(true)

    expect(
      optionsNavigateEqual(
        [{ value: 'a', label: 'A' }],
        [{ value: 'a', label: 'A', disabled: true }],
      ),
    ).toBe(false)

    expect(
      optionsNavigateEqual(
        [{ type: 'input', value: 'a', label: 'A', onChange: () => {} }],
        [{ value: 'a', label: 'A' }],
      ),
    ).toBe(false)
  })
})

describe('useSelectNavigation', () => {
  test('moves focus one row at a time, scrolls, and wraps at list boundaries', async () => {
    const snapshots: Snapshot[] = []
    const controlsRef = { current: null as SelectNavigation<string> | null }
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <Harness
          controlsRef={controlsRef}
          optionItems={options(['one', 'two', 'three', 'four'])}
          snapshots={snapshots}
        />,
      )

      await expectSnapshot(snapshots, {
        focusedValue: 'one',
        focusedIndex: 1,
        visibleValues: ['one', 'two'],
      })

      controlsRef.current?.focusNextOption()
      await expectSnapshot(snapshots, {
        focusedValue: 'two',
        visibleFromIndex: 0,
        visibleToIndex: 2,
      })

      controlsRef.current?.focusNextOption()
      await expectSnapshot(snapshots, {
        focusedValue: 'three',
        visibleFromIndex: 1,
        visibleToIndex: 3,
        visibleValues: ['two', 'three'],
      })

      controlsRef.current?.focusNextOption()
      await expectSnapshot(snapshots, {
        focusedValue: 'four',
        visibleFromIndex: 2,
        visibleToIndex: 4,
      })

      controlsRef.current?.focusNextOption()
      await expectSnapshot(snapshots, {
        focusedValue: 'one',
        visibleFromIndex: 0,
        visibleToIndex: 2,
      })

      controlsRef.current?.focusPreviousOption()
      await expectSnapshot(snapshots, {
        focusedValue: 'four',
        visibleFromIndex: 2,
        visibleToIndex: 4,
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('moves by pages and focuses specific options with minimal scrolling', async () => {
    const snapshots: Snapshot[] = []
    const controlsRef = { current: null as SelectNavigation<string> | null }
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <Harness
          controlsRef={controlsRef}
          initialFocusValue="two"
          optionItems={options(['one', 'two', 'three', 'four', 'five'])}
          snapshots={snapshots}
        />,
      )

      await expectSnapshot(snapshots, {
        focusedValue: 'two',
        visibleFromIndex: 0,
        visibleToIndex: 2,
      })

      controlsRef.current?.focusNextPage()
      await expectSnapshot(snapshots, {
        focusedValue: 'four',
        visibleFromIndex: 2,
        visibleToIndex: 4,
      })

      controlsRef.current?.focusPreviousPage()
      await expectSnapshot(snapshots, {
        focusedValue: 'two',
        visibleFromIndex: 1,
        visibleToIndex: 3,
      })

      controlsRef.current?.focusOption('five')
      await expectSnapshot(snapshots, {
        focusedValue: 'five',
        visibleFromIndex: 3,
        visibleToIndex: 5,
      })

      controlsRef.current?.focusOption('missing')
      await expectSnapshot(snapshots, {
        focusedValue: 'five',
        visibleFromIndex: 3,
        visibleToIndex: 5,
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('responds to controlled focus, option replacement, and input-option focus state', async () => {
    const snapshots: Snapshot[] = []
    const controlsRef = { current: null as SelectNavigation<string> | null }
    const onFocus = vi.fn()
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <Harness
          controlsRef={controlsRef}
          focusValue="name"
          onFocus={onFocus}
          optionItems={options(['keep', 'name', 'remove'], 'name')}
          snapshots={snapshots}
        />,
      )

      await expectSnapshot(snapshots, {
        focusedValue: 'name',
        focusedIndex: 2,
        isInInput: true,
      })
      expect(onFocus).toHaveBeenCalledWith('name')

      root.render(
        <Harness
          controlsRef={controlsRef}
          focusValue="remove"
          onFocus={onFocus}
          optionItems={options(['keep', 'name', 'remove'], 'name')}
          snapshots={snapshots}
        />,
      )
      await expectSnapshot(snapshots, {
        focusedValue: 'remove',
        isInInput: false,
      })

      root.render(
        <Harness
          controlsRef={controlsRef}
          onFocus={onFocus}
          optionItems={options(['fallback', 'name'], 'name')}
          snapshots={snapshots}
        />,
      )
      await expectSnapshot(snapshots, {
        focusedValue: 'fallback',
        focusedIndex: 1,
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })
})
