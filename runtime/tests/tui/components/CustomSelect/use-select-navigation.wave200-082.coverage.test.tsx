import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../ink/root.js'
import type { OptionWithDescription } from './select.js'
import {
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

function options(values: string[]): OptionWithDescription<string>[] {
  return values.map(value => ({
    value,
    label: value,
  }))
}

function snapshotOf(navigation: SelectNavigation<string>): Snapshot {
  return {
    focusedValue: navigation.focusedValue,
    focusedIndex: navigation.focusedIndex,
    visibleFromIndex: navigation.visibleFromIndex,
    visibleToIndex: navigation.visibleToIndex,
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
    `Timed out waiting for navigation state ${JSON.stringify({
      expected,
      latest,
    })}`,
  )
}

function Harness({
  controlsRef,
  initialFocusValue,
  optionItems,
}: {
  controlsRef: { current: SelectNavigation<string> | null }
  initialFocusValue?: string
  optionItems: OptionWithDescription<string>[]
}): null {
  const navigation = useSelectNavigation({
    visibleOptionCount: 2,
    options: optionItems,
    initialFocusValue,
  })

  controlsRef.current = navigation
  return null
}

describe('useSelectNavigation wave200 coverage', () => {
  test('keeps focus and viewport coherent across empty and reordered options', async () => {
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
          initialFocusValue="missing"
          optionItems={[]}
        />,
      )
      await waitForNavigation(controlsRef, {
        focusedValue: undefined,
        focusedIndex: 0,
        visibleFromIndex: 0,
        visibleToIndex: 0,
        visibleValues: [],
      })

      controlsRef.current?.focusNextOption()
      controlsRef.current?.focusPreviousOption()
      controlsRef.current?.focusNextPage()
      controlsRef.current?.focusPreviousPage()
      controlsRef.current?.focusOption(undefined)
      await waitForNavigation(controlsRef, {
        focusedValue: undefined,
        focusedIndex: 0,
        visibleFromIndex: 0,
        visibleToIndex: 0,
        visibleValues: [],
      })

      root.render(
        <Harness
          controlsRef={controlsRef}
          initialFocusValue="four"
          optionItems={options(['one', 'two', 'three', 'four', 'five'])}
        />,
      )
      await waitForNavigation(controlsRef, {
        focusedValue: 'four',
        focusedIndex: 4,
        visibleFromIndex: 2,
        visibleToIndex: 4,
        visibleValues: ['three', 'four'],
      })

      root.render(
        <Harness
          controlsRef={controlsRef}
          initialFocusValue="four"
          optionItems={options(['four', 'five', 'six'])}
        />,
      )
      await waitForNavigation(controlsRef, {
        focusedValue: 'four',
        focusedIndex: 1,
        visibleFromIndex: 0,
        visibleToIndex: 2,
        visibleValues: ['four', 'five'],
      })

      root.render(
        <Harness
          controlsRef={controlsRef}
          initialFocusValue="four"
          optionItems={options(['zero', 'one', 'two', 'three', 'four'])}
        />,
      )
      await waitForNavigation(controlsRef, {
        focusedValue: 'four',
        focusedIndex: 5,
        visibleFromIndex: 3,
        visibleToIndex: 5,
        visibleValues: ['three', 'four'],
      })

      controlsRef.current?.focusOption('three')
      await waitForNavigation(controlsRef, {
        focusedValue: 'three',
        focusedIndex: 4,
        visibleFromIndex: 3,
        visibleToIndex: 5,
        visibleValues: ['three', 'four'],
      })

      controlsRef.current?.focusOption('one')
      await waitForNavigation(controlsRef, {
        focusedValue: 'one',
        focusedIndex: 2,
        visibleFromIndex: 1,
        visibleToIndex: 3,
        visibleValues: ['one', 'two'],
      })

      controlsRef.current?.focusOption('missing')
      await waitForNavigation(controlsRef, {
        focusedValue: 'one',
        focusedIndex: 2,
        visibleFromIndex: 1,
        visibleToIndex: 3,
        visibleValues: ['one', 'two'],
      })

      controlsRef.current?.focusPreviousOption()
      await waitForNavigation(controlsRef, {
        focusedValue: 'zero',
        focusedIndex: 1,
        visibleFromIndex: 0,
        visibleToIndex: 2,
        visibleValues: ['zero', 'one'],
      })

      controlsRef.current?.focusPreviousOption()
      await waitForNavigation(controlsRef, {
        focusedValue: 'four',
        focusedIndex: 5,
        visibleFromIndex: 3,
        visibleToIndex: 5,
        visibleValues: ['three', 'four'],
      })

      controlsRef.current?.focusNextOption()
      await waitForNavigation(controlsRef, {
        focusedValue: 'zero',
        focusedIndex: 1,
        visibleFromIndex: 0,
        visibleToIndex: 2,
        visibleValues: ['zero', 'one'],
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })
})
