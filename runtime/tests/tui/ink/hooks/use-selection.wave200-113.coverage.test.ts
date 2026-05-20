import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../root.js'
import {
  deleteInkInstance,
  getInkInstance,
  setInkInstance,
} from '../instances.js'
import { createSelectionState } from '../selection.js'
import { useHasSelection, useSelection } from './use-selection.js'

type SelectionControls = ReturnType<typeof useSelection>

type HarnessState = {
  has: boolean
  selection: SelectionControls
}

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough
}

const originalInk = getInkInstance(process.stdout)

function createStreams(): TestStreams {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStreams['stdin']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  ;(stdout as unknown as { columns: number; rows: number }).columns = 80
  ;(stdout as unknown as { rows: number }).rows = 24

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function renderSelectionHarness(): Promise<{
  readonly dispose: () => Promise<void>
  readonly latest: () => HarnessState
}> {
  let latest: HarnessState | undefined
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    latest = {
      has: useHasSelection(),
      selection: useSelection(),
    }
    return null
  }

  root.render(React.createElement(Harness))
  await sleep()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error('timed out waiting for hook update')
}

afterEach(() => {
  deleteInkInstance(process.stdout)
  if (originalInk !== undefined) {
    setInkInstance(process.stdout, originalInk)
  }
})

describe('useSelection wave200 coverage', () => {
  test('returns safe fallbacks and delegates selection operations to the active ink instance', async () => {
    deleteInkInstance(process.stdout)

    const fallback = await renderSelectionHarness()
    try {
      const selection = fallback.latest().selection

      expect(fallback.latest().has).toBe(false)
      expect(selection.copySelection()).toBe('')
      expect(selection.copySelectionNoClear()).toBe('')
      expect(selection.hasSelection()).toBe(false)
      expect(selection.getState()).toBeNull()
      expect(selection.subscribe(() => {})).toEqual(expect.any(Function))
      expect(() => {
        selection.clearSelection()
        selection.shiftAnchor(1, 0, 2)
        selection.shiftSelection(1, 0, 2)
        selection.moveFocus('right')
        selection.captureScrolledRows(0, 1, 'above')
        selection.setSelectionBgColor('#123456')
      }).not.toThrow()
    } finally {
      await fallback.dispose()
    }

    let selected = false
    const listeners = new Set<() => void>()
    const state = createSelectionState()
    state.anchor = { col: 2, row: 1 }
    state.focus = { col: 5, row: 1 }

    const fakeInk = {
      captureScrolledRows: vi.fn(),
      clearTextSelection: vi.fn(),
      copySelection: vi.fn(() => 'copied-and-cleared'),
      copySelectionNoClear: vi.fn(() => 'copied'),
      hasTextSelection: vi.fn(() => selected),
      moveSelectionFocus: vi.fn(),
      selection: state,
      setSelectionBgColor: vi.fn(),
      shiftSelectionForScroll: vi.fn(),
      subscribeToSelectionChange: vi.fn((cb: () => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }),
    }

    setInkInstance(
      process.stdout,
      fakeInk as unknown as Parameters<typeof setInkInstance>[1],
    )

    const active = await renderSelectionHarness()
    try {
      const selection = active.latest().selection
      expect(active.latest().has).toBe(false)
      expect(selection.getState()).toBe(state)
      expect(selection.copySelection()).toBe('copied-and-cleared')
      expect(selection.copySelectionNoClear()).toBe('copied')
      expect(selection.hasSelection()).toBe(false)

      selection.clearSelection()
      selection.shiftAnchor(3, 0, 2)
      selection.shiftSelection(-2, 0, 4)
      selection.moveFocus('home')
      selection.captureScrolledRows(4, 6, 'below')
      selection.setSelectionBgColor('#abcdef')

      expect(fakeInk.clearTextSelection).toHaveBeenCalledOnce()
      expect(state.anchor).toEqual({ col: 2, row: 2 })
      expect(state.virtualAnchorRow).toBe(4)
      expect(fakeInk.shiftSelectionForScroll).toHaveBeenCalledWith(-2, 0, 4)
      expect(fakeInk.moveSelectionFocus).toHaveBeenCalledWith('home')
      expect(fakeInk.captureScrolledRows).toHaveBeenCalledWith(4, 6, 'below')
      expect(fakeInk.setSelectionBgColor).toHaveBeenCalledWith('#abcdef')

      let unsubscribed = false
      const unsubscribe = selection.subscribe(() => {
        unsubscribed = true
      })
      expect(fakeInk.subscribeToSelectionChange).toHaveBeenCalled()
      unsubscribe()
      expect(unsubscribed).toBe(false)

      selected = true
      for (const listener of listeners) listener()
      await waitFor(() => active.latest().has)

      expect(active.latest().has).toBe(true)
    } finally {
      await active.dispose()
    }
  })
})
