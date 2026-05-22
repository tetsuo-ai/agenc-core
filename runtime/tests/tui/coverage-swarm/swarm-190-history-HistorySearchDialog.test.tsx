import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

type HistoryEntryLike = {
  display: string
}

type TimestampedEntryLike = {
  display: string
  timestamp: number
  resolve: () => Promise<HistoryEntryLike>
}

type PickerItem = {
  age: string
  display: string
  entry: TimestampedEntryLike
  firstLine: string
}

type CapturedPickerProps = {
  direction?: 'down' | 'up'
  emptyMessage?: string | ((query: string) => string)
  getKey: (item: PickerItem) => string
  initialQuery?: string
  items: readonly PickerItem[]
  onCancel: () => void
  onQueryChange: (query: string) => void
  onSelect: (item: PickerItem) => void
  placeholder?: string
  previewPosition?: 'bottom' | 'right'
  renderItem: (item: PickerItem, isFocused: boolean) => React.ReactNode
  renderPreview: (item: PickerItem) => React.ReactNode
  selectAction?: string
  title: string
}

type HistoryReader = AsyncIterator<TimestampedEntryLike> &
  AsyncIterable<TimestampedEntryLike> & {
    next: ReturnType<typeof vi.fn>
    return: ReturnType<typeof vi.fn>
  }

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const harness = vi.hoisted(() => ({
  entries: [] as TimestampedEntryLike[],
  getTimestampedHistory: vi.fn(() => {
    if (harness.readerFactory) return harness.readerFactory()

    let index = 0
    const reader = {
      next: vi.fn(async (): Promise<IteratorResult<TimestampedEntryLike>> => {
        if (index >= harness.entries.length) {
          return { done: true, value: undefined }
        }

        const value = harness.entries[index]
        index += 1
        return { done: false, value: value! }
      }),
      return: vi.fn(async (): Promise<IteratorResult<TimestampedEntryLike>> => ({
        done: true,
        value: undefined,
      })),
      [Symbol.asyncIterator]() {
        return this
      },
    } satisfies HistoryReader

    harness.readers.push(reader)
    return reader
  }),
  logEvent: vi.fn(),
  pickerProps: undefined as CapturedPickerProps | undefined,
  readerFactory: undefined as (() => HistoryReader) | undefined,
  readers: [] as HistoryReader[],
  registerOverlay: vi.fn(),
  terminal: {
    columns: 120,
    rows: 30,
  },
}))

vi.mock('../../../src/tui/context/overlayContext.js', () => ({
  useRegisterOverlay: harness.registerOverlay,
}))

vi.mock('../../../src/tui/history/history.js', () => ({
  getTimestampedHistory: harness.getTimestampedHistory,
}))

vi.mock('../../../src/tui/hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => harness.terminal,
}))

vi.mock('../../../src/services/analytics/index.js', () => ({
  logEvent: harness.logEvent,
}))

vi.mock('../../../src/tui/components/design-system/FuzzyPicker.js', () => ({
  FuzzyPicker: (props: CapturedPickerProps) => {
    harness.pickerProps = props
    return null
  },
}))

import { createRoot } from '../../../src/tui/ink/root.js'
import { HistorySearchDialog } from '../../../src/tui/history/HistorySearchDialog.js'
import { renderToString } from '../../../src/utils/staticRender.js'

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })

  return { promise, resolve }
}

function resetHarness() {
  harness.entries = []
  harness.getTimestampedHistory.mockClear()
  harness.logEvent.mockClear()
  harness.pickerProps = undefined
  harness.readerFactory = undefined
  harness.readers = []
  harness.registerOverlay.mockClear()
  harness.terminal.columns = 120
  harness.terminal.rows = 30
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep(10)
  }

  throw new Error(message)
}

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
  ;(stdout as unknown as { columns: number }).columns = harness.terminal.columns
  ;(stdout as unknown as { rows: number }).rows = harness.terminal.rows
  stdout.resume()

  return { stdin, stdout }
}

function pickerProps(): CapturedPickerProps {
  const props = harness.pickerProps
  if (!props) throw new Error('History search picker props were not captured')
  return props
}

function emptyMessage(props: CapturedPickerProps, query: string): string {
  const message = props.emptyMessage
  return typeof message === 'function' ? message(query) : message ?? ''
}

async function renderDialog(initialQuery?: string) {
  const onCancel = vi.fn()
  const onSelect = vi.fn()
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  root.render(
    <HistorySearchDialog
      initialQuery={initialQuery}
      onCancel={onCancel}
      onSelect={onSelect}
    />,
  )
  await waitFor(() => harness.pickerProps !== undefined, 'Dialog did not render')

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    },
    onCancel,
    onSelect,
  }
}

describe('HistorySearchDialog coverage swarm row 190', () => {
  beforeEach(() => {
    resetHarness()
  })

  test('uses bottom preview layout on narrow terminals and handles empty filtered results', async () => {
    harness.terminal.columns = 28
    harness.entries = [
      {
        display: [
          'first line that is deliberately long for the row',
          '',
          'second preview line',
        ].join('\n'),
        timestamp: Date.now(),
        resolve: vi.fn(async () => ({ display: 'resolved prompt' })),
      },
    ]

    const rendered = await renderDialog()

    try {
      await waitFor(
        () => pickerProps().items.length === 1,
        'History search did not load the narrow-layout item',
      )

      const loadedProps = pickerProps()
      const item = loadedProps.items[0]!

      expect(harness.registerOverlay).toHaveBeenCalledWith('history-search')
      expect(loadedProps.initialQuery).toBeUndefined()
      expect(loadedProps.previewPosition).toBe('bottom')
      expect(loadedProps.getKey(item)).toBe(String(item.entry.timestamp))
      expect(item.firstLine).toBe(
        'first line that is deliberately long for the row',
      )

      const row = await renderToString(loadedProps.renderItem(item, false), 80)
      expect(row).toContain('first line')
      expect(row).not.toContain('second preview line')

      const preview = await renderToString(loadedProps.renderPreview(item), 80)
      expect(preview).toContain('first line')
      expect(preview).toContain('second preview line')

      loadedProps.onQueryChange('missing')
      await waitFor(
        () => pickerProps().items.length === 0,
        'History search did not apply an empty filter result',
      )
      expect(emptyMessage(pickerProps(), 'missing')).toBe('No matching prompts')
    } finally {
      await rendered.dispose()
    }
  })

  test('returns the history reader when unmounted while streaming entries', async () => {
    const secondEntry = deferred<TimestampedEntryLike>()
    let nextCount = 0
    const reader = {
      next: vi.fn(async (): Promise<IteratorResult<TimestampedEntryLike>> => {
        nextCount += 1
        if (nextCount === 1) {
          return {
            done: false,
            value: {
              display: 'already yielded',
              timestamp: 1,
              resolve: vi.fn(async () => ({ display: 'already yielded' })),
            },
          }
        }

        if (nextCount === 2) {
          return { done: false, value: await secondEntry.promise }
        }

        return { done: true, value: undefined }
      }),
      return: vi.fn(async (): Promise<IteratorResult<TimestampedEntryLike>> => ({
        done: true,
        value: undefined,
      })),
      [Symbol.asyncIterator]() {
        return this
      },
    } satisfies HistoryReader
    harness.readerFactory = () => {
      harness.readers.push(reader)
      return reader
    }

    const rendered = await renderDialog('pending')
    await waitFor(
      () => reader.next.mock.calls.length === 2,
      'History reader did not start waiting for the second entry',
    )

    await rendered.dispose()
    secondEntry.resolve({
      display: 'cancelled entry',
      timestamp: 2,
      resolve: vi.fn(async () => ({ display: 'cancelled entry' })),
    })

    await waitFor(
      () => reader.return.mock.calls.length > 0,
      'History reader was not returned after cancellation',
    )
    expect(reader.return).toHaveBeenCalledWith(undefined)
  })
})
