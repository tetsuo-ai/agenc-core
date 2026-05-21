import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  computeFuzzyPickerVisibleCount,
  FuzzyPicker,
  getFuzzyPickerDefaultPlaceholder,
  getFuzzyPickerNavigationShortcut,
} from '../../../src/tui/components/design-system/FuzzyPicker.tsx'
import type { DOMElement, DOMNode } from '../../../src/tui/ink/dom.ts'
import instances from '../../../src/tui/ink/instances.ts'
import { createRoot, Text } from '../../../src/tui/ink.ts'

type PickerItem = {
  readonly id: string
  readonly label: string
}

type PickerAction = {
  readonly action: string
  readonly handler: (item: PickerItem) => void
}

type PickerProps = {
  title: string
  placeholder?: string
  initialQuery?: string
  items: readonly PickerItem[]
  renderItem: (item: PickerItem, isFocused: boolean) => React.ReactNode
  visibleCount?: number
  direction?: 'down' | 'up'
  onQueryChange: (query: string) => void
  onSelect: (item: PickerItem) => void
  onTab?: PickerAction
  onShiftTab?: PickerAction
  onFocus?: (item: PickerItem | undefined) => void
  onCancel: () => void
  emptyMessage?: string | ((query: string) => string)
  matchLabel?: string
  selectAction?: string
  extraHints?: React.ReactNode
}

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  rows: number
  isTTY: boolean
}

type PickerHarness = {
  readonly stdin: TestStdin
  readonly stdout: TestStdout
  readonly render: (next?: Partial<PickerProps>) => void
  readonly text: () => string
  readonly send: (sequence: string) => Promise<void>
  readonly dispose: () => Promise<void>
}

const ITEMS: readonly PickerItem[] = [
  { id: 'alpha', label: 'Alpha result' },
  { id: 'bravo', label: 'Bravo result' },
  { id: 'charlie', label: 'Charlie result' },
]

const mountedHarnesses: PickerHarness[] = []

afterEach(async () => {
  while (mountedHarnesses.length > 0) {
    await mountedHarnesses.pop()?.dispose()
  }
})

function createStreams(columns = 120, rows = 30): {
  readonly stdin: TestStdin
  readonly stdout: TestStdout
  readonly stderr: PassThrough
} {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout
  const stderr = new PassThrough()

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}

  stdout.columns = columns
  stdout.rows = rows
  stdout.isTTY = true
  stdout.on('data', () => {})
  stderr.on('data', () => {})

  return { stdin, stdout, stderr }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 2_000) {
    if (predicate()) return
    await sleep(10)
  }

  throw new Error(message)
}

function rootNode(stdout: TestStdout): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined

  if (!instance?.rootNode) {
    throw new Error('Ink root node not found')
  }

  return instance.rootNode
}

function collectText(node: DOMNode): string {
  if (node.nodeName === '#text') return node.nodeValue
  return node.childNodes.map(collectText).join('')
}

function renderItem(item: PickerItem, isFocused: boolean): React.ReactNode {
  return (
    <Text>
      {isFocused ? 'focused' : 'plain'}:{item.label}
    </Text>
  )
}

async function createPickerHarness(
  overrides: Partial<PickerProps> = {},
  viewport: { readonly columns?: number; readonly rows?: number } = {},
): Promise<PickerHarness> {
  const { stdin, stdout, stderr } = createStreams(
    viewport.columns ?? 120,
    viewport.rows ?? 30,
  )
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
  })

  const props: PickerProps = {
    title: 'Pick result',
    items: ITEMS,
    renderItem,
    onQueryChange: vi.fn(),
    onSelect: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }

  const render = (next: Partial<PickerProps> = {}) => {
    Object.assign(props, next)
    root.render(
      <FuzzyPicker<PickerItem>
        title={props.title}
        placeholder={props.placeholder}
        initialQuery={props.initialQuery}
        items={props.items}
        getKey={item => item.id}
        renderItem={props.renderItem}
        visibleCount={props.visibleCount}
        direction={props.direction}
        onQueryChange={props.onQueryChange}
        onSelect={props.onSelect}
        onTab={props.onTab}
        onShiftTab={props.onShiftTab}
        onFocus={props.onFocus}
        onCancel={props.onCancel}
        emptyMessage={props.emptyMessage}
        matchLabel={props.matchLabel}
        selectAction={props.selectAction}
        extraHints={props.extraHints}
      />,
    )
  }

  render()

  const harness: PickerHarness = {
    stdin,
    stdout,
    render,
    text: () => collectText(rootNode(stdout)),
    send: async (sequence: string) => {
      stdin.write(sequence)
      await sleep(sequence === '\x1b' ? 90 : 30)
    },
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      stderr.end()
      instances.delete(stdout as unknown as NodeJS.WriteStream)
      await sleep(20)
    },
  }

  mountedHarnesses.push(harness)

  await waitForCondition(
    () => harness.text().includes(props.title),
    'FuzzyPicker did not mount',
  )

  return harness
}

describe('FuzzyPicker coverage swarm row 092', () => {
  test('normalizes fallback layout inputs and default glyph helpers', () => {
    expect(computeFuzzyPickerVisibleCount(0, 0)).toBe(1)
    expect(computeFuzzyPickerVisibleCount(2.8, 99)).toBe(2)
    expect(computeFuzzyPickerVisibleCount(6, 13, true)).toBe(2)

    expect(getFuzzyPickerDefaultPlaceholder()).toMatch(/^Type to search/)
    expect(getFuzzyPickerNavigationShortcut()).toContain('/')
  })

  test('renders compact hints with explicit placeholder and extra byline content', async () => {
    const onTab = { action: 'insert item', handler: vi.fn() }
    const onShiftTab = { action: 'open details', handler: vi.fn() }
    const harness = await createPickerHarness(
      {
        placeholder: 'Search custom picks',
        onTab,
        onShiftTab,
        selectAction: 'open selected',
        extraHints: <Text>Ctrl+K to filter</Text>,
      },
      { columns: 80 },
    )

    await waitForCondition(
      () => harness.text().includes('Search custom picks'),
      'Explicit placeholder did not render',
    )
    expect(harness.text()).toContain('to nav')
    expect(harness.text()).not.toContain('to navigate')
    expect(harness.text()).toContain('Enter to open')
    expect(harness.text()).not.toContain('Enter to open selected')
    expect(harness.text()).toContain('Tab to insert item')
    expect(harness.text()).not.toContain('shift+tab')
    expect(harness.text()).toContain('Ctrl+K to filter')

    harness.render({ selectAction: 'choose' })
    await waitForCondition(
      () => harness.text().includes('Enter to choose'),
      'Compact single-word select action did not render',
    )
  })

  test('reports initial query and routes shift-tab to the tab fallback handler', async () => {
    const onQueryChange = vi.fn()
    const onTab = { action: 'insert', handler: vi.fn() }
    const harness = await createPickerHarness({
      initialQuery: 'bra',
      onQueryChange,
      onTab,
    })

    await waitForCondition(
      () => onQueryChange.mock.calls.some(([query]) => query === 'bra'),
      'Initial query was not reported',
    )
    expect(harness.text()).toContain('bra')

    await harness.send('\x1b[Z')
    expect(onTab.handler).toHaveBeenLastCalledWith(ITEMS[0])
  })

  test('clamps focus to undefined when the item list is cleared', async () => {
    const onFocus = vi.fn()
    const harness = await createPickerHarness({
      items: ITEMS.slice(0, 2),
      onFocus,
      visibleCount: 2,
    })

    await waitForCondition(
      () => onFocus.mock.calls.some(([item]) => item?.id === 'alpha'),
      'Initial focus was not reported',
    )

    harness.render({
      items: [],
      emptyMessage: 'Nothing available',
    })

    await waitForCondition(
      () => onFocus.mock.calls.some(([item]) => item === undefined),
      'Empty focus state was not reported',
    )
    expect(harness.text()).toContain('Nothing available')
  })
})
