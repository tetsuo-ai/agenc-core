import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type HistoryEntryLike = {
  display: string
}

type TimestampedEntryLike = {
  display: string
  timestamp: number
  resolve: () => Promise<HistoryEntryLike>
}

type PickerItem = {
  entry: TimestampedEntryLike
  display: string
  firstLine: string
}

type CapturedPickerProps = {
  title: string
  placeholder?: string
  initialQuery?: string
  items: readonly PickerItem[]
  getKey: (item: PickerItem) => string
  onQueryChange: (query: string) => void
  onSelect: (item: PickerItem) => void
  onCancel: () => void
  emptyMessage?: string | ((query: string) => string)
  selectAction?: string
  direction?: 'up' | 'down'
  previewPosition?: 'bottom' | 'right'
  renderItem: (item: PickerItem, isFocused: boolean) => React.ReactNode
  renderPreview: (item: PickerItem) => React.ReactNode
}

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const harness = vi.hoisted(() => ({
  entries: [] as TimestampedEntryLike[],
  getTimestampedHistory: vi.fn(() => {
    let index = 0
    const reader = {
      next: vi.fn(async (): Promise<IteratorResult<TimestampedEntryLike>> => {
        await harness.historyGate?.promise
        if (harness.readerNextError) {
          throw harness.readerNextError
        }
        if (index >= harness.entries.length) {
          return { done: true, value: undefined }
        }

        const value = harness.entries[index]
        index += 1
        return { done: false, value: value! }
      }),
      return: vi.fn(async (): Promise<IteratorResult<TimestampedEntryLike>> => {
        if (harness.readerReturnError) {
          throw harness.readerReturnError
        }
        return {
          done: true,
          value: undefined,
        }
      }),
      [Symbol.asyncIterator]() {
        return this
      },
    }

    harness.readers.push(reader)
    return reader
  }),
  historyGate: undefined as Deferred | undefined,
  logError: vi.fn(),
  pickerProps: undefined as CapturedPickerProps | undefined,
  readerNextError: undefined as unknown | undefined,
  readerReturnError: undefined as unknown | undefined,
  readers: [] as Array<{
    next: ReturnType<typeof vi.fn>
    return: ReturnType<typeof vi.fn>
  }>,
  registerOverlay: vi.fn(),
  terminal: {
    columns: 120,
    rows: 30,
  },
}))

vi.mock('../context/overlayContext.js', () => ({
  useRegisterOverlay: harness.registerOverlay,
}))

vi.mock('./history.js', () => ({
  getTimestampedHistory: harness.getTimestampedHistory,
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => harness.terminal,
}))

vi.mock('../../utils/log.js', () => ({
  logError: harness.logError,
}))

vi.mock('../components/design-system/FuzzyPicker.js', () => ({
  FuzzyPicker: (props: CapturedPickerProps) => {
    harness.pickerProps = props
    return null
  },
}))

import { createRoot } from '../ink/root.js'
import { renderToString } from '../../utils/staticRender.js'
import { HistorySearchDialog } from './HistorySearchDialog.js'

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })

  return { promise, resolve }
}

function resetHarness() {
  harness.entries = []
  harness.getTimestampedHistory.mockClear()
  harness.historyGate = undefined
  harness.logError.mockClear()
  harness.pickerProps = undefined
  harness.readerNextError = undefined
  harness.readerReturnError = undefined
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

describe('HistorySearchDialog coverage', () => {
  beforeEach(() => {
    resetHarness()
  })

  it('loads history into the picker, filters exact before fuzzy matches, previews, and selects', async () => {
    const exactResolvedEntry = { display: 'deploy api route' }
    const exactResolve = vi.fn(async () => exactResolvedEntry)
    const fuzzyResolve = vi.fn(async () => ({ display: 'archive project notes' }))
    const missResolve = vi.fn(async () => ({ display: 'unrelated' }))

    harness.historyGate = deferred()
    harness.entries = [
      {
        display: [
          'deploy api route',
          '',
          'preview detail 1',
          'preview detail 2',
          'preview detail 3',
          'preview detail 4',
          'preview detail 5',
          'preview detail 6',
          'preview detail 7',
        ].join('\n'),
        timestamp: 1710000000000,
        resolve: exactResolve,
      },
      {
        display: 'archive project notes',
        timestamp: 1700000000000,
        resolve: fuzzyResolve,
      },
      {
        display: 'zzz unrelated',
        timestamp: 1690000000000,
        resolve: missResolve,
      },
    ]

    const rendered = await renderDialog('ap')

    try {
      const loadingProps = pickerProps()
      expect(harness.registerOverlay).toHaveBeenCalledWith('history-search')
      expect(loadingProps.title).toBe('Search prompts')
      expect(loadingProps.placeholder).toMatch(/^Filter history/)
      expect(loadingProps.initialQuery).toBe('ap')
      expect(loadingProps.selectAction).toBe('use')
      expect(loadingProps.direction).toBe('up')
      expect(loadingProps.previewPosition).toBe('right')
      expect(loadingProps.items).toEqual([])
      expect(emptyMessage(loadingProps, '')).toMatch(/^Loading/)

      harness.historyGate.resolve()
      await waitFor(
        () => pickerProps().items.map(item => item.firstLine).join('\0') ===
          'deploy api route\0archive project notes',
        'History search did not filter exact and fuzzy matches',
      )

      const filteredProps = pickerProps()
      expect(filteredProps.items.map(item => item.firstLine)).toEqual([
        'deploy api route',
        'archive project notes',
      ])
      expect(filteredProps.getKey(filteredProps.items[0]!)).toBe('1710000000000')
      expect(emptyMessage(filteredProps, 'absent')).toBe('No matching prompts')

      filteredProps.onQueryChange('   ')
      await waitFor(
        () => pickerProps().items.length === 3,
        'History search did not return all items for a blank query',
      )
      expect(emptyMessage(pickerProps(), '')).toBe('No history yet')

      pickerProps().onQueryChange('ap')
      await waitFor(
        () => pickerProps().items.length === 2,
        'History search did not restore filtered items',
      )

      const props = pickerProps()
      const exactItem = props.items[0]!
      const fuzzyItem = props.items[1]!
      const focusedItem = await renderToString(props.renderItem(exactItem, true), 120)
      const plainItem = await renderToString(props.renderItem(fuzzyItem, false), 120)
      expect(focusedItem).toContain('deploy api route')
      expect(plainItem).toContain('archive project notes')

      const overflowingPreview = await renderToString(props.renderPreview(exactItem), 120)
      expect(overflowingPreview).toContain('deploy api route')
      expect(overflowingPreview).toContain('preview detail 4')
      expect(overflowingPreview).toContain('+3 more lines')

      const shortPreview = await renderToString(props.renderPreview(fuzzyItem), 120)
      expect(shortPreview).toContain('archive project notes')
      expect(shortPreview).not.toContain('more lines')

      props.onSelect(exactItem)
      await waitFor(
        () => rendered.onSelect.mock.calls.length === 1,
        'History search selection did not resolve',
      )
      expect(exactResolve).toHaveBeenCalledTimes(1)
      expect(rendered.onSelect).toHaveBeenCalledWith(exactResolvedEntry)

      props.onCancel()
      expect(rendered.onCancel).toHaveBeenCalledTimes(1)
    } finally {
      await rendered.dispose()
    }
  })

  it('does not resolve a history selection more than once while it is pending', async () => {
    const resolvedEntry = { display: 'slow prompt' }
    const pendingSelection = deferred<HistoryEntryLike>()
    const resolveEntry = vi.fn(() => pendingSelection.promise)
    harness.entries = [
      {
        display: 'slow prompt',
        timestamp: 1710000000000,
        resolve: resolveEntry,
      },
    ]

    const rendered = await renderDialog()

    try {
      await waitFor(
        () => pickerProps().items.length === 1,
        'History search item did not load',
      )

      const selectedItem = pickerProps().items[0]!
      pickerProps().onSelect(selectedItem)
      pickerProps().onSelect(selectedItem)

      expect(resolveEntry).toHaveBeenCalledTimes(1)
      pendingSelection.resolve(resolvedEntry)

      await waitFor(
        () => rendered.onSelect.mock.calls.length === 1,
        'History search selection did not resolve exactly once',
      )
      expect(rendered.onSelect).toHaveBeenCalledWith(resolvedEntry)
    } finally {
      await rendered.dispose()
    }
  })

  it('does not apply a pending history selection after the dialog unmounts', async () => {
    const pendingSelection = deferred<HistoryEntryLike>()
    const resolveEntry = vi.fn(() => pendingSelection.promise)
    harness.entries = [
      {
        display: 'cancelled slow prompt',
        timestamp: 1710000000000,
        resolve: resolveEntry,
      },
    ]

    const rendered = await renderDialog()
    await waitFor(
      () => pickerProps().items.length === 1,
      'History search item did not load',
    )

    pickerProps().onSelect(pickerProps().items[0]!)
    await rendered.dispose()
    pendingSelection.resolve({ display: 'cancelled slow prompt' })
    await sleep(25)

    expect(resolveEntry).toHaveBeenCalledTimes(1)
    expect(rendered.onSelect).not.toHaveBeenCalled()
  })

  it('logs rejected history selection resolution and allows retry', async () => {
    const selectError = new Error('history entry resolve failed')
    const resolvedEntry = { display: 'retry prompt' }
    const resolveEntry = vi
      .fn<() => Promise<HistoryEntryLike>>()
      .mockRejectedValueOnce(selectError)
      .mockResolvedValueOnce(resolvedEntry)
    harness.entries = [
      {
        display: 'retry prompt',
        timestamp: 1710000000000,
        resolve: resolveEntry,
      },
    ]

    const rendered = await renderDialog()

    try {
      await waitFor(
        () => pickerProps().items.length === 1,
        'History search item did not load',
      )

      const selectedItem = pickerProps().items[0]!
      pickerProps().onSelect(selectedItem)

      await waitFor(
        () => harness.logError.mock.calls.some(call => call[0] === selectError),
        'History selection failure was not logged',
      )
      expect(rendered.onSelect).not.toHaveBeenCalled()

      pickerProps().onSelect(selectedItem)
      await waitFor(
        () => rendered.onSelect.mock.calls.length === 1,
        'History selection did not allow retry after rejection',
      )

      expect(resolveEntry).toHaveBeenCalledTimes(2)
      expect(rendered.onSelect).toHaveBeenCalledWith(resolvedEntry)
    } finally {
      await rendered.dispose()
    }
  })

  it('logs rejected history loads and clears the loading state', async () => {
    const error = new Error('history reader failed')
    harness.readerNextError = error

    const rendered = await renderDialog()

    try {
      await waitFor(
        () => harness.readers[0]?.next.mock.calls.length === 1,
        'History reader did not attempt to load',
      )
      await waitFor(
        () => harness.logError.mock.calls.length === 1,
        'History reader failure was not logged',
      )
      await waitFor(
        () => emptyMessage(pickerProps(), '') === 'No history yet',
        'History reader failure did not clear loading state',
      )

      const props = pickerProps()
      expect(harness.logError).toHaveBeenCalledWith(error)
      expect(props.items).toEqual([])
      expect(emptyMessage(props, '')).toBe('No history yet')
    } finally {
      await rendered.dispose()
    }
  })

  it('logs rejected history reader closes during unmount', async () => {
    const closeError = new Error('history reader close failed')
    harness.historyGate = deferred()
    harness.readerReturnError = closeError

    const rendered = await renderDialog()

    try {
      await waitFor(
        () => harness.readers.length === 1,
        'History reader was not created',
      )
    } finally {
      await rendered.dispose()
    }

    await waitFor(
      () => harness.logError.mock.calls.some(call => call[0] === closeError),
      'History reader close failure was not logged',
    )
    expect(harness.readers[0]?.return).toHaveBeenCalledWith(undefined)
  })
})
