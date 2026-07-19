import { PassThrough } from 'node:stream'
import * as path from 'node:path'

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type PickerAction = {
  action: string
  handler: (item: string) => void
}

type CapturedPickerProps = {
  title: string
  placeholder?: string
  items: readonly string[]
  visibleCount: number
  previewPosition: 'bottom' | 'right'
  onQueryChange: (query: string) => void
  onFocus?: (item: string | undefined) => void
  onSelect: (item: string) => void
  onTab?: PickerAction
  onShiftTab?: PickerAction
  onCancel: () => void
  emptyMessage?: string | ((query: string) => string)
  selectAction?: string
  renderItem: (item: string, isFocused: boolean) => React.ReactNode
  renderPreview?: (item: string) => React.ReactNode
}

type Suggestion = {
  id: string
  displayText: string
}

const harness = vi.hoisted(() => ({
  cwd: '/workspace/project',
  generateFileSuggestions: vi.fn(),
  logError: vi.fn(),
  openFileInExternalEditor: vi.fn(),
  pickerProps: undefined as CapturedPickerProps | undefined,
  readFileInRange: vi.fn(),
  registerOverlay: vi.fn(),
  terminal: {
    columns: 100,
    rows: 30,
  },
}))

vi.mock('../context/overlayContext', () => ({
  useRegisterOverlay: harness.registerOverlay,
}))

vi.mock('../hooks/fileSuggestions', () => ({
  generateFileSuggestions: harness.generateFileSuggestions,
}))

vi.mock('../hooks/useTerminalSize', () => ({
  useTerminalSize: () => harness.terminal,
}))

vi.mock('../../utils/log', () => ({
  logError: harness.logError,
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

vi.mock('./design-system/FuzzyPicker', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./design-system/FuzzyPicker')>()
  return {
    ...actual,
    FuzzyPicker: (props: CapturedPickerProps) => {
      harness.pickerProps = props
      return null
    },
  }
})

import { createRoot } from '../ink/root.js'
import { renderToString } from '../../utils/staticRender.js'
import { QuickOpenDialog } from './QuickOpenDialog.js'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function resetHarness() {
  harness.terminal.columns = 100
  harness.terminal.rows = 30
  harness.pickerProps = undefined
  harness.registerOverlay.mockClear()
  harness.generateFileSuggestions.mockReset()
  harness.generateFileSuggestions.mockResolvedValue([])
  harness.logError.mockClear()
  harness.openFileInExternalEditor.mockReset()
  harness.openFileInExternalEditor.mockReturnValue(true)
  harness.readFileInRange.mockReset()
  harness.readFileInRange.mockResolvedValue({ content: '' })
}

function pickerProps(): CapturedPickerProps {
  const props = harness.pickerProps
  if (!props) throw new Error('Quick open picker props were not captured')
  return props
}

function emptyMessage(props: CapturedPickerProps, query: string): string {
  const message = props.emptyMessage
  return typeof message === 'function' ? message(query) : message ?? ''
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

  root.render(<QuickOpenDialog onDone={onDone} onInsert={onInsert} />)
  await waitFor(() => harness.pickerProps !== undefined, 'QuickOpenDialog did not render')

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

async function searchFor(
  query: string,
  suggestions: readonly Suggestion[],
  expectedItems: readonly string[],
) {
  harness.generateFileSuggestions.mockResolvedValueOnce(suggestions)

  pickerProps().onQueryChange(query)

  await waitFor(
    () => harness.generateFileSuggestions.mock.calls.length > 0,
    'Quick open did not request file suggestions',
  )
  expect(harness.generateFileSuggestions).toHaveBeenLastCalledWith(query, true)
  await waitFor(
    () => pickerProps().items.join('\0') === expectedItems.join('\0'),
    'Quick open results did not render',
  )
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('QuickOpenDialog render and interactions', () => {
  beforeEach(() => {
    resetHarness()
  })

  it('renders the initial picker state, empty-query state, cancel wiring, and bottom preview layout', async () => {
    const rendered = await renderDialog()

    try {
      const props = pickerProps()

      expect(harness.registerOverlay).toHaveBeenCalledWith('quick-open')
      expect(props.title).toBe('Quick Open')
      expect(props.placeholder).toBe('Type to search files...')
      expect(props.items).toEqual([])
      expect(props.visibleCount).toBe(8)
      expect(props.previewPosition).toBe('bottom')
      expect(props.selectAction).toBe('open in editor')
      expect(props.onTab?.action).toBe('mention')
      expect(props.onShiftTab?.action).toBe('insert path')
      expect(emptyMessage(props, '')).toBe('Start typing to search...')
      expect(emptyMessage(props, 'app')).toBe('No matching files')

      props.onQueryChange('   ')
      await waitFor(
        () => pickerProps().items.length === 0,
        'Quick open did not clear results for an empty query',
      )
      expect(harness.generateFileSuggestions).not.toHaveBeenCalled()

      props.onCancel()
      expect(rendered.onDone).toHaveBeenCalledTimes(1)
    } finally {
      await rendered.dispose()
    }
  })

  it('filters file suggestions, normalizes path separators, and renders focused items', async () => {
    const rendered = await renderDialog()

    try {
      const nestedPath = path.join('src', 'nested', 'index.ts')
      const normalizedNestedPath = nestedPath.split(path.sep).join('/')

      await searchFor(
        'src',
        [
          { id: 'file-src-app', displayText: 'src/app.tsx' },
          { id: 'command-help', displayText: 'help' },
          { id: 'file-src-directory', displayText: `src${path.sep}` },
          { id: 'file-src-nested', displayText: nestedPath },
        ],
        ['src/app.tsx', normalizedNestedPath],
      )

      const props = pickerProps()
      expect(props.items).toEqual(['src/app.tsx', 'src/nested/index.ts'])

      const itemOutput = await renderToString(props.renderItem('src/app.tsx', true), 120)
      expect(itemOutput).toContain('src/app.tsx')

      props.onQueryChange('')
      await waitFor(
        () => pickerProps().items.length === 0,
        'Quick open did not clear normalized results for an empty query',
      )
      expect(harness.generateFileSuggestions).toHaveBeenCalledTimes(1)
    } finally {
      await rendered.dispose()
    }
  })

  it('logs rejected file searches and clears stale results for the current query', async () => {
    const rendered = await renderDialog()

    try {
      await searchFor(
        'ready',
        [{ id: 'file-ready', displayText: 'src/ready.ts' }],
        ['src/ready.ts'],
      )
      expect(pickerProps().items).toEqual(['src/ready.ts'])

      const error = new Error('file suggestions failed')
      harness.generateFileSuggestions.mockRejectedValueOnce(error)
      pickerProps().onQueryChange('broken')

      await waitFor(
        () => harness.generateFileSuggestions.mock.calls.length === 2,
        'Quick open did not request the rejected search',
      )
      await waitFor(
        () => harness.logError.mock.calls.length === 1,
        'Quick open did not log the rejected search',
      )

      expect(harness.logError).toHaveBeenCalledWith(error)
      expect(pickerProps().items).toEqual([])
      expect(emptyMessage(pickerProps(), 'broken')).toBe('No matching files')
    } finally {
      await rendered.dispose()
    }
  })

  it('ignores rejected stale file searches after newer results render', async () => {
    const rendered = await renderDialog()
    const staleSearch = deferred<Suggestion[]>()
    const freshSearch = deferred<Suggestion[]>()

    try {
      harness.generateFileSuggestions
        .mockReturnValueOnce(staleSearch.promise)
        .mockReturnValueOnce(freshSearch.promise)

      pickerProps().onQueryChange('old')
      await waitFor(
        () => harness.generateFileSuggestions.mock.calls.length === 1,
        'Quick open did not request the stale search',
      )

      pickerProps().onQueryChange('new')
      await waitFor(
        () => harness.generateFileSuggestions.mock.calls.length === 2,
        'Quick open did not request the fresh search',
      )

      freshSearch.resolve([{ id: 'file-new', displayText: 'src/new.ts' }])
      await waitFor(
        () => pickerProps().items.join('\0') === 'src/new.ts',
        'Quick open did not render fresh search results',
      )

      staleSearch.reject(new Error('stale search failed'))
      await sleep(20)

      expect(pickerProps().items).toEqual(['src/new.ts'])
      expect(harness.logError).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  it('loads preview content without showing stale content under a new focused path', async () => {
    const rendered = await renderDialog()

    try {
      const secondPreview = deferred<{ content: string }>()
      harness.readFileInRange
        .mockResolvedValueOnce({
          content: 'export const alpha = 1\nneedle alpha',
        })
        .mockReturnValueOnce(secondPreview.promise)

      await searchFor(
        'alpha',
        [
          { id: 'file-alpha', displayText: 'src/alpha.ts' },
          { id: 'file-beta', displayText: 'src/beta.ts' },
        ],
        ['src/alpha.ts', 'src/beta.ts'],
      )

      pickerProps().onFocus?.('src/alpha.ts')
      const loadingOutput = await renderToString(
        pickerProps().renderPreview?.('src/alpha.ts'),
        120,
      )
      expect(loadingOutput).toContain('Loading preview...')

      await waitFor(
        () => harness.readFileInRange.mock.calls.length === 1,
        'Quick open did not request preview content',
      )
      expect(harness.readFileInRange).toHaveBeenCalledWith(
        '/workspace/project/src/alpha.ts',
        0,
        12,
        undefined,
        expect.any(AbortSignal),
      )

      const previewOutput = await waitForRenderedText(
        () => pickerProps().renderPreview?.('src/alpha.ts'),
        output => output.includes('needle alpha'),
        'Quick open preview content did not render',
      )
      expect(previewOutput).toContain('src/alpha.ts')
      expect(previewOutput).toContain('export const alpha = 1')

      pickerProps().onFocus?.('src/beta.ts')
      await waitFor(
        () => harness.readFileInRange.mock.calls.length === 2,
        'Quick open did not request preview content for the new focus',
      )

      const staleOutput = await renderToString(
        pickerProps().renderPreview?.('src/beta.ts'),
        120,
      )
      expect(staleOutput).toContain('src/beta.ts - loading...')
      expect(staleOutput).toContain('Loading preview...')
      expect(staleOutput).not.toContain('needle alpha')

      secondPreview.resolve({ content: 'beta ready' })
      const refreshedOutput = await waitForRenderedText(
        () => pickerProps().renderPreview?.('src/beta.ts'),
        output => output.includes('beta ready'),
        'Quick open did not replace the stale preview content',
      )
      expect(refreshedOutput).toContain('src/beta.ts')
      expect(refreshedOutput).not.toContain('loading...')
    } finally {
      await rendered.dispose()
    }
  })

  it('shows preview failures without weakening the selected path display', async () => {
    const rendered = await renderDialog()

    try {
      const previewError = new Error('cannot preview')
      harness.readFileInRange.mockRejectedValueOnce(previewError)

      await searchFor(
        'broken',
        [{ id: 'file-broken', displayText: 'src/broken.ts' }],
        ['src/broken.ts'],
      )

      pickerProps().onFocus?.('src/broken.ts')
      await waitFor(
        () => harness.readFileInRange.mock.calls.length === 1,
        'Quick open did not request failing preview content',
      )

      const previewOutput = await waitForRenderedText(
        () => pickerProps().renderPreview?.('src/broken.ts'),
        output => output.includes('(preview unavailable)'),
        'Quick open did not render preview failure content',
      )
      expect(previewOutput).toContain('src/broken.ts')
      expect(previewOutput).toContain('(preview unavailable)')
      expect(harness.logError).toHaveBeenCalledWith(previewError)
    } finally {
      await rendered.dispose()
    }
  })

  it('opens files and inserts file references through picker actions', async () => {
    const rendered = await renderDialog()

    try {
      await searchFor(
        'app',
        [{ id: 'file-app', displayText: 'src/app.tsx' }],
        ['src/app.tsx'],
      )

      pickerProps().onSelect('src/app.tsx')
      expect(harness.openFileInExternalEditor).toHaveBeenCalledWith(
        '/workspace/project/src/app.tsx',
      )

      pickerProps().onTab?.handler('src/app.tsx')
      expect(rendered.onInsert).toHaveBeenCalledWith('@src/app.tsx ')

      pickerProps().onShiftTab?.handler('src/app.tsx')
      expect(rendered.onInsert).toHaveBeenCalledWith('src/app.tsx ')
      expect(rendered.onDone).toHaveBeenCalledTimes(3)
    } finally {
      await rendered.dispose()
    }
  })

  it('uses a right-side preview and reduced preview line count on wide terminals', async () => {
    harness.terminal.columns = 160
    harness.terminal.rows = 30
    const rendered = await renderDialog()

    try {
      expect(pickerProps().previewPosition).toBe('right')

      await searchFor(
        'wide',
        [{ id: 'file-wide', displayText: 'src/wide.ts' }],
        ['src/wide.ts'],
      )

      pickerProps().onFocus?.('src/wide.ts')
      await waitFor(
        () => harness.readFileInRange.mock.calls.length === 1,
        'Quick open did not request wide-layout preview content',
      )
      expect(harness.readFileInRange).toHaveBeenCalledWith(
        '/workspace/project/src/wide.ts',
        0,
        7,
        undefined,
        expect.any(AbortSignal),
      )
    } finally {
      await rendered.dispose()
    }
  })
})
