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
  title: string
  placeholder?: string
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
  selectAction?: string
  renderItem: (item: SearchMatch, isFocused: boolean) => React.ReactNode
  renderPreview?: (item: SearchMatch) => React.ReactNode
}

const harness = vi.hoisted(() => ({
  cwd: '/workspace/project',
  logEvent: vi.fn(),
  openFileInExternalEditor: vi.fn(),
  pickerProps: undefined as CapturedPickerProps | undefined,
  readFileInRange: vi.fn(),
  registerOverlay: vi.fn(),
  ripGrepStream: vi.fn(),
  terminal: {
    columns: 100,
    rows: 30,
  },
}))

vi.mock('../context/overlayContext', () => ({
  useRegisterOverlay: harness.registerOverlay,
}))

vi.mock('../hooks/useTerminalSize', () => ({
  useTerminalSize: () => harness.terminal,
}))

vi.mock('../../services/analytics/index', () => ({
  logEvent: harness.logEvent,
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
  harness.terminal.columns = 100
  harness.terminal.rows = 30
  harness.pickerProps = undefined
  harness.registerOverlay.mockClear()
  harness.logEvent.mockClear()
  harness.openFileInExternalEditor.mockReset()
  harness.openFileInExternalEditor.mockReturnValue(true)
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

async function searchFor(query: string, lines: readonly string[]) {
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
      onLines(lines)
    },
  )

  pickerProps().onQueryChange(query)
  await waitFor(
    () => emptyMessage(pickerProps(), query) === 'Searching...',
    'Global search did not enter searching state',
  )
  await waitFor(
    () => harness.ripGrepStream.mock.calls.length === 1,
    'Global search did not invoke ripgrep',
  )
}

describe('GlobalSearchDialog render and interactions', () => {
  beforeEach(() => {
    resetHarness()
  })

  it('renders the initial picker state and cancel wiring', async () => {
    const rendered = await renderDialog()

    try {
      const props = pickerProps()

      expect(harness.registerOverlay).toHaveBeenCalledWith('global-search')
      expect(props.title).toBe('Global Search')
      expect(props.placeholder).toBe('Type to search...')
      expect(props.items).toEqual([])
      expect(props.visibleCount).toBe(12)
      expect(props.previewPosition).toBe('bottom')
      expect(props.matchLabel).toBe(' ')
      expect(props.selectAction).toBe('open in editor')
      expect(props.onTab?.action).toBe('mention')
      expect(props.onShiftTab?.action).toBe('insert path')
      expect(emptyMessage(props, '')).toBe('Type to search...')

      props.onCancel()
      expect(rendered.onDone).toHaveBeenCalledTimes(1)
    } finally {
      await rendered.dispose()
    }
  })

  it('streams query results, renders matches, and loads focused preview content', async () => {
    const rendered = await renderDialog()

    try {
      harness.readFileInRange.mockResolvedValue({
        content: 'before\nNeedle alpha\ncontext',
      })

      await searchFor('needle', [
        jsonMatchLine('/workspace/project/src/app.tsx', 12, 'Needle alpha'),
        jsonMatchLine('/workspace/project/..config', 4, 'Needle config'),
        jsonMatchLine('/tmp/outside.ts', 3, 'needle beta'),
        'not a ripgrep match',
      ])

      await waitFor(
        () => pickerProps().items.length === 3 && pickerProps().matchLabel === '3 matches',
        'Global search results did not render',
      )

      const props = pickerProps()
      const first = props.items[0]
      expect(first).toEqual({
        file: 'src/app.tsx',
        line: 12,
        text: 'Needle alpha',
      })
      expect(props.items[1]).toEqual({
        file: '..config',
        line: 4,
        text: 'Needle config',
      })
      expect(props.items[2]).toEqual({
        file: '/tmp/outside.ts',
        line: 3,
        text: 'needle beta',
      })

      const itemOutput = await renderToString(props.renderItem(first, true), 120)
      expect(itemOutput).toContain('src/app.tsx:12')
      expect(itemOutput).toContain('Needle alpha')

      props.onFocus?.(first)
      const loadingOutput = await renderToString(props.renderPreview?.(first), 120)
      expect(loadingOutput).toContain('Loading...')

      await waitFor(
        () => harness.readFileInRange.mock.calls.length === 1,
        'Global search did not request preview content',
      )
      expect(harness.readFileInRange).toHaveBeenCalledWith(
        '/workspace/project/src/app.tsx',
        7,
        9,
        undefined,
        expect.any(AbortSignal),
      )

      const previewOutput = await waitForRenderedText(
        () => pickerProps().renderPreview?.(first),
        output => output.includes('Needle alpha'),
        'Global search preview content did not render',
      )
      expect(previewOutput).toContain('src/app.tsx:12')
      expect(previewOutput).toContain('before')
      expect(previewOutput).toContain('context')
    } finally {
      await rendered.dispose()
    }
  })

  it('preserves file paths that contain colon-number segments in search results', async () => {
    const rendered = await renderDialog()

    try {
      const rawPath = '/workspace/project/src/topic:12/app.ts'
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
            'needle',
          ])
          expect(cwd).toBe(harness.cwd)
          expect(signal.aborted).toBe(false)
          onLines([
            JSON.stringify({
              type: 'match',
              data: {
                path: { text: rawPath },
                line_number: 4,
                lines: { text: 'Needle in colon path\n' },
              },
            }),
          ])
        },
      )

      pickerProps().onQueryChange('needle')

      await waitFor(
        () =>
          pickerProps().items.length === 1 &&
          pickerProps().items[0]?.file === 'src/topic:12/app.ts',
        'Global search did not preserve the full colon-number path',
      )
      expect(pickerProps().items[0]).toEqual({
        file: 'src/topic:12/app.ts',
        line: 4,
        text: 'Needle in colon path',
      })
    } finally {
      await rendered.dispose()
    }
  })

  it('shows no-match state after a completed empty search', async () => {
    const rendered = await renderDialog()

    try {
      await searchFor('absent', [])

      await waitFor(
        () =>
          pickerProps().items.length === 0 &&
          emptyMessage(pickerProps(), 'absent') === 'No matches',
        'Global search did not render the no-match state',
      )
      expect(pickerProps().matchLabel).toBe(' ')
    } finally {
      await rendered.dispose()
    }
  })

  it('opens and inserts the focused match through picker actions', async () => {
    const rendered = await renderDialog()

    try {
      await searchFor('needle', [
        jsonMatchLine('/workspace/project/src/app.tsx', 12, 'Needle alpha'),
      ])
      await waitFor(
        () => pickerProps().items.length === 1 && pickerProps().matchLabel === '1 matches',
        'Global search result did not render for action test',
      )

      const match = pickerProps().items[0]

      pickerProps().onSelect(match)
      expect(harness.openFileInExternalEditor).toHaveBeenCalledWith(
        '/workspace/project/src/app.tsx',
        12,
      )
      expect(harness.logEvent).toHaveBeenCalledWith('agenc_global_search_select', {
        result_count: 1,
        opened_editor: true,
      })

      pickerProps().onTab?.handler(match)
      expect(rendered.onInsert).toHaveBeenCalledWith('@src/app.tsx#L12 ')
      expect(harness.logEvent).toHaveBeenCalledWith('agenc_global_search_insert', {
        result_count: 1,
        mention: true,
      })

      pickerProps().onShiftTab?.handler(match)
      expect(rendered.onInsert).toHaveBeenCalledWith('src/app.tsx:12 ')
      expect(harness.logEvent).toHaveBeenCalledWith('agenc_global_search_insert', {
        result_count: 1,
        mention: false,
      })
      expect(rendered.onDone).toHaveBeenCalledTimes(3)
    } finally {
      await rendered.dispose()
    }
  })
})
