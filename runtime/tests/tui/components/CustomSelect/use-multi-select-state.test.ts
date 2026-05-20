import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import Text from '../../ink/components/Text.js'
import { createRoot } from '../../ink/root.js'
import type { OptionWithDescription } from './select.js'
import {
  type MultiSelectState,
  type UseMultiSelectStateProps,
  useMultiSelectState,
} from './use-multi-select-state.js'

vi.mock('../../../utils/debug.js', () => ({
  logForDebugging: () => {},
}))
vi.mock('../../../bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  getActiveTimeCounter: () => 0,
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
  selectedValues: string[]
  inputValues: Record<string, string>
  isSubmitFocused: boolean
}

type HarnessProps = UseMultiSelectStateProps<string> & {
  controlsRef?: { current: MultiSelectState<string> | null }
  snapshots: Snapshot[]
}

const DOWN = '\u001B[B'
const UP = '\u001B[A'
const PAGE_DOWN = '\u001B[6~'
const PAGE_UP = '\u001B[5~'
const SHIFT_TAB = '\u001B[Z'
const CTRL_ENTER = '\u001B[13;5u'
const ESCAPE = '\u001B[27u'

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

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForCondition(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function snapshotsMatch(
  snapshot: Snapshot,
  expected: Partial<Snapshot>,
): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const actual = snapshot[key as keyof Snapshot]
    return Array.isArray(value) || typeof value === 'object'
      ? JSON.stringify(actual) === JSON.stringify(value)
      : actual === value
  })
}

async function expectSnapshot(
  snapshots: Snapshot[],
  expected: Partial<Snapshot>,
): Promise<void> {
  await waitForCondition(
    () => snapshots.some(snapshot => snapshotsMatch(snapshot, expected)),
    `multi-select state ${JSON.stringify(expected)}`,
  )
}

function latestSnapshot(snapshots: Snapshot[]): Snapshot {
  const snapshot = snapshots.at(-1)
  if (!snapshot) {
    throw new Error('No multi-select snapshots were captured')
  }
  return snapshot
}

function snapshotOf(state: MultiSelectState<string>): Snapshot {
  return {
    focusedValue: state.focusedValue,
    focusedIndex: state.focusedIndex,
    visibleFromIndex: state.visibleFromIndex,
    visibleToIndex: state.visibleToIndex,
    visibleValues: state.visibleOptions.map(option => option.value),
    isInInput: state.isInInput,
    selectedValues: [...state.selectedValues],
    inputValues: Object.fromEntries(state.inputValues.entries()),
    isSubmitFocused: state.isSubmitFocused,
  }
}

function option(
  value: string,
  overrides: Partial<OptionWithDescription<string>> = {},
): OptionWithDescription<string> {
  return {
    value,
    label: value,
    ...overrides,
  } as OptionWithDescription<string>
}

function inputOption({
  initialValue,
  onChange = () => {},
  value,
}: {
  initialValue?: string
  onChange?: (value: string) => void
  value: string
}): OptionWithDescription<string> {
  return {
    type: 'input',
    value,
    label: value,
    initialValue,
    onChange,
  }
}

function Harness({
  controlsRef,
  snapshots,
  ...props
}: HarnessProps): React.ReactNode {
  const state = useMultiSelectState(props)

  if (controlsRef) {
    controlsRef.current = state
  }

  React.useEffect(() => {
    snapshots.push(snapshotOf(state))
  }, [snapshots, state])

  return React.createElement(Text, null, state.focusedValue ?? 'none')
}

async function writeKey(stdin: PassThrough, key: string): Promise<void> {
  stdin.write(key)
  await sleep(20)
}

async function renderHarness(props: HarnessProps): Promise<{
  root: Awaited<ReturnType<typeof createRoot>>
  stdin: TestStreams['stdin']
  stdout: PassThrough
}> {
  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(React.createElement(Harness, props))
  await expectSnapshot(props.snapshots, {})

  return { root, stdin, stdout }
}

async function cleanupHarness(
  root: Awaited<ReturnType<typeof createRoot>>,
  stdin: TestStreams['stdin'],
  stdout: PassThrough,
): Promise<void> {
  root.unmount()
  stdin.end()
  await sleep(30)
  stdout.end()
}

describe('useMultiSelectState', () => {
  test('initializes focus, visible bounds, selected values, and input values', async () => {
    const snapshots: Snapshot[] = []
    const onFocus = vi.fn()
    const { root, stdin, stdout } = await renderHarness({
      visibleOptionCount: 2,
      options: [
        option('alpha'),
        inputOption({ value: 'name', initialValue: 'preset' }),
        option('omega'),
      ],
      defaultValue: ['name'],
      initialFocusLast: true,
      onFocus,
      onCancel: () => {},
      snapshots,
    })

    try {
      await expectSnapshot(snapshots, {
        focusedValue: 'omega',
        focusedIndex: 3,
        visibleFromIndex: 1,
        visibleToIndex: 3,
        visibleValues: ['name', 'omega'],
        selectedValues: ['name'],
        inputValues: { name: 'preset' },
        isInInput: false,
        isSubmitFocused: false,
      })
      expect(onFocus).toHaveBeenCalledWith('omega')
    } finally {
      await cleanupHarness(root, stdin, stdout)
    }
  })

  test('toggles selections with space and number keys while preserving bounds', async () => {
    const snapshots: Snapshot[] = []
    const onChange = vi.fn()
    const props: HarnessProps = {
      visibleOptionCount: 3,
      options: [option('alpha'), option('beta'), option('gamma')],
      defaultValue: ['beta'],
      onChange,
      onCancel: () => {},
      snapshots,
    }
    const { root, stdin, stdout } = await renderHarness(props)

    try {
      await expectSnapshot(snapshots, {
        focusedValue: 'alpha',
        selectedValues: ['beta'],
      })

      await writeKey(stdin, ' ')
      await expectSnapshot(snapshots, {
        selectedValues: ['beta', 'alpha'],
      })

      await writeKey(stdin, '　')
      await expectSnapshot(snapshots, {
        selectedValues: ['beta'],
      })

      await writeKey(stdin, '3')
      await expectSnapshot(snapshots, {
        selectedValues: ['beta', 'gamma'],
      })

      await writeKey(stdin, '0')
      await writeKey(stdin, '9')
      await sleep(30)
      expect(latestSnapshot(snapshots).selectedValues).toEqual([
        'beta',
        'gamma',
      ])

      root.render(
        React.createElement(Harness, {
          ...props,
          hideIndexes: true,
        }),
      )
      await sleep(30)
      await writeKey(stdin, '1')
      await sleep(30)
      expect(latestSnapshot(snapshots).selectedValues).toEqual([
        'beta',
        'gamma',
      ])

      expect(onChange).toHaveBeenLastCalledWith(['beta', 'gamma'])
    } finally {
      await cleanupHarness(root, stdin, stdout)
    }
  })

  test('ignores keyboard input when the multi-select is disabled', async () => {
    const snapshots: Snapshot[] = []
    const onCancel = vi.fn()
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    const { root, stdin, stdout } = await renderHarness({
      isDisabled: true,
      options: [option('alpha'), option('beta')],
      onCancel,
      onChange,
      onSubmit,
      snapshots,
    })

    try {
      await expectSnapshot(snapshots, {
        focusedValue: 'alpha',
        selectedValues: [],
      })

      await writeKey(stdin, ' ')
      await writeKey(stdin, '2')
      await writeKey(stdin, DOWN)
      await writeKey(stdin, '\r')
      await writeKey(stdin, ESCAPE)
      await sleep(30)

      expect(latestSnapshot(snapshots)).toMatchObject({
        focusedValue: 'alpha',
        selectedValues: [],
      })
      expect(onCancel).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
      expect(onSubmit).not.toHaveBeenCalled()
    } finally {
      await cleanupHarness(root, stdin, stdout)
    }
  })

  test('does not select disabled options by focus or visible number', async () => {
    const snapshots: Snapshot[] = []
    const onChange = vi.fn()
    const { root, stdin, stdout } = await renderHarness({
      options: [
        option('alpha'),
        option('beta', { disabled: true }),
        option('gamma'),
      ],
      focusValue: 'beta',
      onChange,
      onCancel: () => {},
      snapshots,
    })

    try {
      await expectSnapshot(snapshots, {
        focusedValue: 'beta',
        selectedValues: [],
      })

      await writeKey(stdin, ' ')
      await sleep(30)
      expect(latestSnapshot(snapshots).selectedValues).toEqual([])

      await writeKey(stdin, '2')
      await sleep(30)
      expect(latestSnapshot(snapshots).selectedValues).toEqual([])
      expect(onChange).not.toHaveBeenCalled()
    } finally {
      await cleanupHarness(root, stdin, stdout)
    }
  })

  test('navigates with arrows, vi keys, pages, tabs, and boundary callbacks', async () => {
    const snapshots: Snapshot[] = []
    const controlsRef = { current: null as MultiSelectState<string> | null }
    const onDownFromLastItem = vi.fn()
    const onUpFromFirstItem = vi.fn()
    const { root, stdin, stdout } = await renderHarness({
      visibleOptionCount: 2,
      options: [
        option('alpha'),
        option('beta'),
        option('gamma'),
        option('delta'),
      ],
      submitButtonText: 'Apply',
      onSubmit: () => {},
      onDownFromLastItem,
      onUpFromFirstItem,
      onCancel: () => {},
      controlsRef,
      snapshots,
    })

    try {
      await expectSnapshot(snapshots, {
        focusedValue: 'alpha',
        visibleValues: ['alpha', 'beta'],
      })

      await writeKey(stdin, DOWN)
      await expectSnapshot(snapshots, {
        focusedValue: 'beta',
        visibleFromIndex: 0,
        visibleToIndex: 2,
      })

      await writeKey(stdin, PAGE_DOWN)
      await expectSnapshot(snapshots, {
        focusedValue: 'delta',
        visibleFromIndex: 2,
        visibleToIndex: 4,
        visibleValues: ['gamma', 'delta'],
      })

      await writeKey(stdin, PAGE_UP)
      await expectSnapshot(snapshots, {
        focusedValue: 'beta',
        visibleFromIndex: 1,
        visibleToIndex: 3,
        visibleValues: ['beta', 'gamma'],
      })

      await writeKey(stdin, 'k')
      await expectSnapshot(snapshots, {
        focusedValue: 'alpha',
        visibleFromIndex: 0,
      })
      await writeKey(stdin, UP)
      expect(onUpFromFirstItem).toHaveBeenCalledTimes(1)

      controlsRef.current?.focusOption('delta')
      await waitForCondition(
        () => latestSnapshot(snapshots).focusedValue === 'delta',
        'focus delta',
      )
      await writeKey(stdin, DOWN)
      await expectSnapshot(snapshots, {
        isSubmitFocused: true,
      })
      await writeKey(stdin, DOWN)
      expect(onDownFromLastItem).toHaveBeenCalledTimes(1)

      await writeKey(stdin, SHIFT_TAB)
      await expectSnapshot(snapshots, {
        focusedValue: 'delta',
        isSubmitFocused: false,
      })

      await writeKey(stdin, '\t')
      await expectSnapshot(snapshots, {
        isSubmitFocused: true,
      })
      await writeKey(stdin, UP)
      await expectSnapshot(snapshots, {
        isSubmitFocused: false,
      })

      await writeKey(stdin, 'j')
      await expectSnapshot(snapshots, {
        isSubmitFocused: true,
      })
    } finally {
      await cleanupHarness(root, stdin, stdout)
    }
  })

  test('submits, cancels, and resets only when option navigation data changes', async () => {
    const snapshots: Snapshot[] = []
    const onCancel = vi.fn()
    const onSubmit = vi.fn()
    const props: HarnessProps = {
      options: [option('alpha'), option('beta')],
      defaultValue: ['alpha'],
      onCancel,
      onSubmit,
      snapshots,
    }
    const { root, stdin, stdout } = await renderHarness(props)

    try {
      await expectSnapshot(snapshots, {
        selectedValues: ['alpha'],
      })

      await writeKey(stdin, ' ')
      await expectSnapshot(snapshots, {
        selectedValues: [],
      })

      root.render(
        React.createElement(Harness, {
          ...props,
          options: [
            option('alpha', { label: 'Alpha changed' }),
            option('beta', { label: 'Beta changed' }),
          ],
          defaultValue: ['beta'],
        }),
      )
      await sleep(30)
      expect(latestSnapshot(snapshots).selectedValues).toEqual([])

      root.render(
        React.createElement(Harness, {
          ...props,
          options: [option('alpha'), option('gamma')],
          defaultValue: ['gamma'],
        }),
      )
      await expectSnapshot(snapshots, {
        selectedValues: ['gamma'],
      })

      await writeKey(stdin, '\r')
      expect(onSubmit).toHaveBeenLastCalledWith(['gamma'])

      await writeKey(stdin, ESCAPE)
      expect(onCancel).toHaveBeenCalledTimes(1)
    } finally {
      await cleanupHarness(root, stdin, stdout)
    }
  })

  test('uses submit button focus for final submission', async () => {
    const snapshots: Snapshot[] = []
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    const { root, stdin, stdout } = await renderHarness({
      options: [option('alpha'), option('beta')],
      submitButtonText: 'Apply',
      onChange,
      onSubmit,
      onCancel: () => {},
      snapshots,
    })

    try {
      await writeKey(stdin, '\r')
      await expectSnapshot(snapshots, {
        selectedValues: ['alpha'],
      })
      expect(onChange).toHaveBeenLastCalledWith(['alpha'])
      expect(onSubmit).not.toHaveBeenCalled()

      await writeKey(stdin, DOWN)
      await expectSnapshot(snapshots, {
        focusedValue: 'beta',
      })
      await writeKey(stdin, DOWN)
      await expectSnapshot(snapshots, {
        isSubmitFocused: true,
      })
      await writeKey(stdin, '\r')
      expect(onSubmit).toHaveBeenLastCalledWith(['alpha'])
    } finally {
      await cleanupHarness(root, stdin, stdout)
    }
  })

  test('updates input option values and keeps text input keystrokes local', async () => {
    const snapshots: Snapshot[] = []
    const controlsRef = { current: null as MultiSelectState<string> | null }
    const onInputChange = vi.fn()
    const onSubmit = vi.fn()
    const { root, stdin, stdout } = await renderHarness({
      options: [
        inputOption({
          value: 'query',
          initialValue: 'seed',
          onChange: onInputChange,
        }),
        option('other'),
      ],
      focusValue: 'query',
      onSubmit,
      onCancel: () => {},
      controlsRef,
      snapshots,
    })

    try {
      await expectSnapshot(snapshots, {
        focusedValue: 'query',
        isInInput: true,
        inputValues: { query: 'seed' },
      })

      await writeKey(stdin, '2')
      await sleep(30)
      expect(latestSnapshot(snapshots).selectedValues).toEqual([])

      controlsRef.current?.updateInputValue('query', 'abc')
      await expectSnapshot(snapshots, {
        selectedValues: ['query'],
        inputValues: { query: 'abc' },
      })
      expect(onInputChange).toHaveBeenLastCalledWith('abc')

      controlsRef.current?.updateInputValue('query', '')
      await expectSnapshot(snapshots, {
        selectedValues: [],
        inputValues: { query: '' },
      })
      expect(onInputChange).toHaveBeenLastCalledWith('')

      await writeKey(stdin, CTRL_ENTER)
      expect(onSubmit).toHaveBeenLastCalledWith([])
    } finally {
      await cleanupHarness(root, stdin, stdout)
    }
  })
})
