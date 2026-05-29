import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

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
  openFileInExternalEditor: vi.fn(),
  pickerProps: undefined as CapturedPickerProps | undefined,
  readFileInRange: vi.fn(),
  registerOverlay: vi.fn(),
  ripGrepStream: vi.fn(),
  terminal: {
    columns: 4,
    rows: 5,
  },
}))

vi.mock('src/tui/context/overlayContext.js', () => ({
  useRegisterOverlay: harness.registerOverlay,
}))

vi.mock('src/tui/hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => harness.terminal,
}))

vi.mock('src/utils/cwd.js', () => ({
  getCwd: () => harness.cwd,
}))

vi.mock('src/utils/editor.js', () => ({
  openFileInExternalEditor: harness.openFileInExternalEditor,
}))

vi.mock('src/utils/readFileInRange.js', () => ({
  readFileInRange: harness.readFileInRange,
}))

vi.mock('src/utils/ripgrep.js', () => ({
  ripGrepStream: harness.ripGrepStream,
}))

vi.mock('src/tui/components/design-system/FuzzyPicker.js', () => ({
  FuzzyPicker: (props: CapturedPickerProps) => {
    harness.pickerProps = props
    return null
  },
}))

import { createRoot } from 'src/tui/ink/root.js'
import { renderToString } from 'src/utils/staticRender.js'
import {
  GlobalSearchDialog,
  computeGlobalSearchLayout,
  parseRipgrepLine,
} from 'src/tui/components/GlobalSearchDialog.js'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function resetHarness() {
  harness.terminal.columns = 4
  harness.terminal.rows = 5
  harness.pickerProps = undefined
  harness.registerOverlay.mockClear()
  harness.openFileInExternalEditor.mockReset()
  harness.openFileInExternalEditor.mockReturnValue(false)
  harness.readFileInRange.mockReset()
  harness.readFileInRange.mockResolvedValue({ content: '' })
  harness.ripGrepStream.mockReset()
  harness.ripGrepStream.mockResolvedValue(undefined)
}

function pickerProps(): CapturedPickerProps {
  const props = harness.pickerProps
  if (!props) throw new Error('Global search picker props were not captured')
  return props
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
    onDone,
    onInsert,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    },
  }
}

describe('GlobalSearchDialog coverage swarm row 127', () => {
  beforeEach(() => {
    resetHarness()
  })

  test('handles parser and layout edge cases', () => {
    expect(
      parseRipgrepLine('C:\\repo\\src\\app.ts:7:needle: with colon'),
    ).toEqual({
      file: 'C:\\repo\\src\\app.ts',
      line: 7,
      text: 'needle: with colon',
    })
    expect(parseRipgrepLine(':12:missing file')).toBeNull()
    expect(parseRipgrepLine(`src/app.ts:${'9'.repeat(400)}:overflow`)).toBeNull()
    expect(parseRipgrepLine('src/app.ts:not-a-line:needle')).toBeNull()

    expect(
      computeGlobalSearchLayout(
        undefined as unknown as number,
        undefined as unknown as number,
      ),
    ).toMatchObject({
      listWidth: 1,
      maxPathWidth: 1,
      maxTextWidth: 1,
      previewOnRight: false,
      previewWidth: 1,
      visibleResults: 4,
    })
  })

  test('filters stale matches, suppresses duplicate stream results, and records failed editor opens', async () => {
    const rendered = await renderDialog()
    const searchSignals: AbortSignal[] = []

    try {
      harness.ripGrepStream.mockImplementation(
        async (
          args: string[],
          cwd: string,
          signal: AbortSignal,
          onLines: (chunk: readonly string[]) => void,
        ) => {
          searchSignals.push(signal)
          expect(args.slice(0, 7)).toEqual([
            '--json',
            '-i',
            '-m',
            '10',
            '-F',
            '-e',
            args[6],
          ])
          expect(cwd).toBe(harness.cwd)

          if (args[6] === 'needle') {
            onLines([
              jsonMatchLine('/workspace/project/src/alpha.ts', 2, 'Needle alpha'),
              jsonMatchLine('/workspace/project/src/beta.ts', 3, 'Needle beta'),
            ])
            return
          }

          onLines([jsonMatchLine('/workspace/project/src/alpha.ts', 2, 'Needle alpha')])
        },
      )

      expect(pickerProps().visibleCount).toBe(4)
      expect(pickerProps().previewPosition).toBe('bottom')

      pickerProps().onQueryChange('needle')
      await waitFor(
        () => pickerProps().items.length === 2,
        'Initial global search results did not render',
      )

      const narrowOutput = await renderToString(
        pickerProps().renderItem(pickerProps().items[0], false),
        10,
      )
      expect(narrowOutput).not.toContain('Needle alpha')

      pickerProps().onQueryChange('alpha')
      await waitFor(
        () =>
          pickerProps().items.length === 1 &&
          pickerProps().items[0]?.file === 'src/alpha.ts',
        'Global search did not filter stale results while the next search was pending',
      )
      expect(searchSignals[0]?.aborted).toBe(true)

      await waitFor(
        () => harness.ripGrepStream.mock.calls.length === 2,
        'Global search did not run the second query',
      )
      await sleep(25)
      expect(pickerProps().items).toEqual([
        {
          file: 'src/alpha.ts',
          line: 2,
          text: 'Needle alpha',
        },
      ])

      pickerProps().onSelect(pickerProps().items[0])
      expect(harness.openFileInExternalEditor).toHaveBeenCalledWith(
        '/workspace/project/src/alpha.ts',
        2,
      )
      expect(rendered.onDone).toHaveBeenCalledTimes(1)
    } finally {
      await rendered.dispose()
    }
  })
})
