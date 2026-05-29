import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SearchMatch = {
  file: string
  line: number
  text: string
}

type PickerAction = {
  action: string
  handler: (item: SearchMatch) => void
}

type CapturedPickerProps = {
  items: readonly SearchMatch[]
  visibleCount: number
  previewPosition: 'bottom' | 'right'
  onQueryChange: (query: string) => void
  onFocus?: (item: SearchMatch | undefined) => void
  onSelect: (item: SearchMatch) => void
  onTab?: PickerAction
  onShiftTab?: PickerAction
  onCancel: () => void
  emptyMessage?: string | ((query: string) => string)
  matchLabel?: string
  renderItem: (item: SearchMatch, isFocused: boolean) => React.ReactNode
  renderPreview?: (item: SearchMatch) => React.ReactNode
}

const harness = vi.hoisted(() => ({
  cwd: '/workspace/project',
  logError: vi.fn(),
  openFileInExternalEditor: vi.fn(),
  pickerProps: undefined as CapturedPickerProps | undefined,
  readFileInRange: vi.fn(),
  registerOverlay: vi.fn(),
  ripGrepStream: vi.fn(),
  terminal: {
    columns: 180,
    rows: 30,
  },
}))

vi.mock('../context/overlayContext', () => ({
  useRegisterOverlay: harness.registerOverlay,
}))

vi.mock('../hooks/useTerminalSize', () => ({
  useTerminalSize: () => harness.terminal,
}))

vi.mock('../../utils/cwd', () => ({
  getCwd: () => harness.cwd,
}))

vi.mock('../../utils/editor', () => ({
  openFileInExternalEditor: harness.openFileInExternalEditor,
}))

vi.mock('../../utils/readFileInRange', () => ({
  readFileInRange: harness.readFileInRange,
}))

vi.mock('../../utils/log', () => ({
  logError: harness.logError,
}))

vi.mock('../../utils/ripgrep', () => ({
  ripGrepStream: harness.ripGrepStream,
}))

vi.mock('./design-system/FuzzyPicker', () => ({
  FuzzyPicker: (props: CapturedPickerProps) => {
    harness.pickerProps = props
    return null
  },
}))

import { createRoot } from '../ink/root.js'
import { renderToString } from '../../utils/staticRender.js'
import { GlobalSearchDialog } from './GlobalSearchDialog.js'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function resetHarness() {
  harness.terminal.columns = 180
  harness.terminal.rows = 30
  harness.pickerProps = undefined
  harness.registerOverlay.mockClear()
  harness.logError.mockClear()
  harness.openFileInExternalEditor.mockReset()
  harness.openFileInExternalEditor.mockReturnValue(true)
  harness.readFileInRange.mockReset()
  harness.ripGrepStream.mockReset()
  harness.ripGrepStream.mockResolvedValue(undefined)
}

function pickerProps(): CapturedPickerProps {
  const props = harness.pickerProps
  if (!props) throw new Error('Global search picker props were not captured')
  return props
}

function emptyMessage(props: CapturedPickerProps, query: string): string {
  const message = props.emptyMessage
  return typeof message === 'function' ? message(query) : message ?? ''
}

function jsonMatchLine(file: string, line: number, text: string): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: file },
      line_number: line,
      lines: { text: `${text}\n` },
    },
  })
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

async function waitForRenderedText(
  node: () => React.ReactNode,
  predicate: (output: string) => boolean,
  message: string,
): Promise<string> {
  const startedAt = Date.now()
  let lastOutput = ''
  while (Date.now() - startedAt < 1000) {
    lastOutput = await renderToString(node(), 120)
    if (predicate(lastOutput)) return lastOutput
    await sleep(10)
  }
  throw new Error(`${message}\nLast output:\n${lastOutput}`)
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

async function renderDialog() {
  const onDone = vi.fn()
  const onInsert = vi.fn()
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  root.render(<GlobalSearchDialog onDone={onDone} onInsert={onInsert} />)
  await waitFor(() => harness.pickerProps !== undefined, 'GlobalSearchDialog did not render')

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    },
  }
}

describe('GlobalSearchDialog wave 200 worker 129 coverage', () => {
  beforeEach(() => {
    resetHarness()
  })

  it('caps large result streams, reports preview failures, and clears stale matches', async () => {
    const rendered = await renderDialog()

    try {
      const query = 'needle'
      const lines = Array.from(
        { length: 501 },
        (_, i) =>
          jsonMatchLine(
            `/workspace/project/src/file-${i}.ts`,
            i + 1,
            `Needle ${i}`,
          ),
      )
      let searchSignal: AbortSignal | undefined

      const previewError = new Error('preview failed')
      harness.readFileInRange.mockRejectedValue(previewError)
      harness.ripGrepStream.mockImplementation(
        async (
          args: string[],
          cwd: string,
          signal: AbortSignal,
          onLines: (chunk: readonly string[]) => void,
        ) => {
          expect(args).toEqual([
            '--json',
            '-i',
            '-m',
            '10',
            '-F',
            '-e',
            query,
          ])
          expect(cwd).toBe(harness.cwd)
          expect(signal.aborted).toBe(false)
          searchSignal = signal
          onLines(lines)
        },
      )

      expect(pickerProps().previewPosition).toBe('right')

      pickerProps().onQueryChange(query)
      await waitFor(
        () => emptyMessage(pickerProps(), query) === 'Searching...',
        'Global search did not enter searching state',
      )
      await waitFor(
        () =>
          pickerProps().items.length === 500 &&
          pickerProps().matchLabel === '500+ matches',
        'Global search did not cap and label the large result set',
      )
      expect(searchSignal?.aborted).toBe(true)
      expect(harness.ripGrepStream).toHaveBeenCalledTimes(1)

      const first = pickerProps().items[0]
      expect(first).toEqual({
        file: 'src/file-0.ts',
        line: 1,
        text: 'Needle 0',
      })
      expect(pickerProps().items.at(-1)).toEqual({
        file: 'src/file-499.ts',
        line: 500,
        text: 'Needle 499',
      })

      pickerProps().onFocus?.(first)
      await waitFor(
        () => harness.readFileInRange.mock.calls.length === 1,
        'Global search did not request focused preview content',
      )
      expect(harness.readFileInRange).toHaveBeenCalledWith(
        '/workspace/project/src/file-0.ts',
        0,
        9,
        undefined,
        expect.any(AbortSignal),
      )

      const previewOutput = await waitForRenderedText(
        () => pickerProps().renderPreview?.(first),
        output => output.includes('(preview unavailable)'),
        'Global search did not render the preview failure fallback',
      )
      expect(previewOutput).toContain('src/file-0.ts:1')
      expect(harness.logError).toHaveBeenCalledWith(previewError)

      pickerProps().onQueryChange('   ')
      await waitFor(
        () => pickerProps().items.length === 0 && pickerProps().matchLabel === ' ',
        'Global search did not clear stale matches for a blank query',
      )
      expect(harness.ripGrepStream).toHaveBeenCalledTimes(1)
    } finally {
      await rendered.dispose()
    }
  })
})
