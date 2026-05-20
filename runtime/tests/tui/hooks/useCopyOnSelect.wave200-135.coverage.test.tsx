import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  config: {} as { copyOnSelect?: boolean },
  copySelectionNoClear: vi.fn(() => 'selected text'),
  getState: vi.fn(() => null as { isDragging?: boolean } | null),
  hasSelection: vi.fn(() => false),
  latestSubscriber: null as (() => void) | null,
  selectionBgColors: [] as string[],
  themeName: 'dark',
  unsubscribe: vi.fn(),
  reset() {
    this.config = {}
    this.copySelectionNoClear.mockReset()
    this.copySelectionNoClear.mockReturnValue('selected text')
    this.getState.mockReset()
    this.getState.mockReturnValue(null)
    this.hasSelection.mockReset()
    this.hasSelection.mockReturnValue(false)
    this.latestSubscriber = null
    this.selectionBgColors = []
    this.themeName = 'dark'
    this.unsubscribe.mockReset()
  },
}))

vi.mock('../components/design-system/ThemeProvider', () => ({
  useTheme: () => [harness.themeName, vi.fn()],
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => harness.config,
}))

vi.mock('../../utils/theme.js', () => ({
  getTheme: (name: string) => ({ selectionBg: `${name}-selection` }),
}))

import { createRoot } from '../ink/root.js'
import { useCopyOnSelect, useSelectionBgColor } from './useCopyOnSelect.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

function createStreams(): {
  readonly stdin: TestStdin
  readonly stdout: PassThrough
} {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough()

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function notifySelectionChanged(): void {
  if (harness.latestSubscriber === null) {
    throw new Error('selection subscriber was not registered')
  }
  harness.latestSubscriber()
}

function createSelection() {
  return {
    copySelectionNoClear: harness.copySelectionNoClear,
    getState: harness.getState,
    hasSelection: harness.hasSelection,
    setSelectionBgColor: (color: string) => {
      harness.selectionBgColors.push(color)
    },
    subscribe: vi.fn((subscriber: () => void) => {
      harness.latestSubscriber = subscriber
      return harness.unsubscribe
    }),
  }
}

describe('useCopyOnSelect wave200 coverage', () => {
  beforeEach(() => {
    harness.reset()
  })

  test('copies settled selections once, respects disabled and blank selections, and refreshes theme color', async () => {
    const selection = createSelection()
    const firstCopied = vi.fn()
    const secondCopied = vi.fn()
    let isActive = false
    let onCopied: ((text: string) => void) | undefined = firstCopied
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    function Harness(): null {
      useCopyOnSelect(selection as never, isActive, onCopied)
      useSelectionBgColor(selection as never)
      return null
    }

    async function render(): Promise<void> {
      root.render(<Harness />)
      await sleep()
    }

    try {
      await render()

      expect(selection.subscribe).not.toHaveBeenCalled()
      expect(harness.selectionBgColors).toEqual(['dark-selection'])

      isActive = true
      harness.themeName = 'light'
      await render()

      expect(selection.subscribe).toHaveBeenCalledTimes(1)
      expect(harness.selectionBgColors).toEqual([
        'dark-selection',
        'light-selection',
      ])

      harness.getState.mockReturnValue({ isDragging: true })
      harness.hasSelection.mockReturnValue(true)
      notifySelectionChanged()
      expect(harness.copySelectionNoClear).not.toHaveBeenCalled()

      harness.getState.mockReturnValue({ isDragging: false })
      notifySelectionChanged()
      expect(harness.copySelectionNoClear).toHaveBeenCalledTimes(1)
      expect(firstCopied).toHaveBeenCalledWith('selected text')

      notifySelectionChanged()
      expect(harness.copySelectionNoClear).toHaveBeenCalledTimes(1)

      harness.hasSelection.mockReturnValue(false)
      notifySelectionChanged()

      harness.config = { copyOnSelect: false }
      harness.hasSelection.mockReturnValue(true)
      harness.copySelectionNoClear.mockClear()
      notifySelectionChanged()
      expect(harness.copySelectionNoClear).not.toHaveBeenCalled()

      harness.config = { copyOnSelect: true }
      onCopied = secondCopied
      await render()

      notifySelectionChanged()
      expect(harness.copySelectionNoClear).toHaveBeenCalledTimes(1)
      expect(secondCopied).toHaveBeenCalledWith('selected text')
      expect(firstCopied).toHaveBeenCalledTimes(1)

      harness.hasSelection.mockReturnValue(false)
      notifySelectionChanged()
      harness.hasSelection.mockReturnValue(true)
      harness.copySelectionNoClear.mockReturnValue('   ')
      notifySelectionChanged()

      expect(secondCopied).toHaveBeenCalledTimes(1)

      harness.copySelectionNoClear.mockReturnValue('retry should be blocked')
      notifySelectionChanged()
      expect(secondCopied).toHaveBeenCalledTimes(1)
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }

    expect(harness.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
