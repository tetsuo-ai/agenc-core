import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import Text from '../ink/components/Text.js'
import { createRoot } from '../ink/root.js'
import { clearKillRing } from '../../utils/TextCursor.js'
import { useSearchInput } from './useSearchInput.js'

vi.mock('../../utils/debug.js', () => ({
  logForDebugging: () => {},
}))
vi.mock('../../bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  getActiveTimeCounter: () => 0,
  markScrollActivity: () => {},
  updateLastInteractionTime: () => {},
}))
vi.mock('../../utils/earlyInput.js', () => ({
  stopCapturingEarlyInput: () => {},
}))
vi.mock('../../utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
}))
vi.mock('../../utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => true,
}))
vi.mock('../../utils/log.js', () => ({
  logError: () => {},
}))

type SearchInputState = ReturnType<typeof useSearchInput>
type SearchInputKey = Parameters<SearchInputState['handleKeyDown']>[0]

type Snapshot = {
  query: string
  cursorOffset: number
}

type TestStreams = {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
}

function createTestStreams(): TestStreams {
  const stdout = new PassThrough()
  stdout.resume()
  ;(stdout as unknown as { columns: number }).columns = 120

  const stdin = new PassThrough() as TestStreams['stdin']
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  return { stdin, stdout }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for search input state')
}

function expectSnapshot(
  snapshots: Snapshot[],
  expected: Partial<Snapshot>,
): Promise<void> {
  return waitForCondition(() =>
    Object.entries(expected).every(
      ([key, value]) => latestSnapshot(snapshots)[key as keyof Snapshot] === value,
    ),
  )
}

function latestSnapshot(snapshots: Snapshot[]): Snapshot {
  const snapshot = snapshots.at(-1)
  if (snapshot === undefined) throw new Error('No search input snapshot')
  return snapshot
}

function keyboard(
  key: string,
  modifiers: Partial<Pick<SearchInputKey, 'ctrl' | 'meta' | 'fn'>> = {},
): SearchInputKey & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    key,
    ctrl: modifiers.ctrl ?? false,
    meta: modifiers.meta ?? false,
    fn: modifiers.fn ?? false,
    preventDefault: vi.fn(),
  } as SearchInputKey & { preventDefault: ReturnType<typeof vi.fn> }
}

function Harness({
  backspaceExitsOnEmpty = true,
  controlsRef,
  initialQuery = '',
  onCancel,
  onExit,
  snapshots,
}: {
  backspaceExitsOnEmpty?: boolean
  controlsRef: { current: SearchInputState | null }
  initialQuery?: string
  onCancel?: () => void
  onExit: () => void
  snapshots: Snapshot[]
}): React.ReactNode {
  const state = useSearchInput({
    backspaceExitsOnEmpty,
    columns: 80,
    initialQuery,
    isActive: true,
    onCancel,
    onExit,
  })

  controlsRef.current = state

  React.useEffect(() => {
    snapshots.push({
      cursorOffset: state.cursorOffset,
      query: state.query,
    })
  }, [snapshots, state])

  return <Text>{state.query}</Text>
}

describe('useSearchInput wave200 coverage', () => {
  beforeEach(() => {
    clearKillRing()
  })

  afterEach(() => {
    clearKillRing()
  })

  test('handles shortcut edge cases without inserting ignored keys', async () => {
    const snapshots: Snapshot[] = []
    const controlsRef = { current: null as SearchInputState | null }
    const onCancel = vi.fn()
    const onExit = vi.fn()
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <Harness
          controlsRef={controlsRef}
          initialQuery="alpha beta"
          onCancel={onCancel}
          onExit={onExit}
          snapshots={snapshots}
        />,
      )
      await expectSnapshot(snapshots, {
        cursorOffset: 'alpha beta'.length,
        query: 'alpha beta',
      })

      controlsRef.current?.setQuery('left right')
      await expectSnapshot(snapshots, {
        cursorOffset: 'left right'.length,
        query: 'left right',
      })

      controlsRef.current?.handleKeyDown(keyboard('left', { ctrl: true }))
      await expectSnapshot(snapshots, { cursorOffset: 'left '.length })

      controlsRef.current?.handleKeyDown(keyboard('right', { fn: true }))
      await expectSnapshot(snapshots, { cursorOffset: 'left right'.length })

      controlsRef.current?.handleKeyDown(keyboard('left'))
      await expectSnapshot(snapshots, { cursorOffset: 'left righ'.length })

      controlsRef.current?.handleKeyDown(keyboard('d', { ctrl: true }))
      await expectSnapshot(snapshots, {
        cursorOffset: 'left righ'.length,
        query: 'left righ',
      })

      controlsRef.current?.handleKeyDown(keyboard('h', { ctrl: true }))
      await expectSnapshot(snapshots, {
        cursorOffset: 'left rig'.length,
        query: 'left rig',
      })

      controlsRef.current?.handleKeyDown(keyboard('e', { ctrl: true }))
      await expectSnapshot(snapshots, { cursorOffset: 'left rig'.length })

      controlsRef.current?.handleKeyDown(keyboard('b', { ctrl: true }))
      await expectSnapshot(snapshots, { cursorOffset: 'left ri'.length })

      controlsRef.current?.handleKeyDown(keyboard('f', { ctrl: true }))
      await expectSnapshot(snapshots, { cursorOffset: 'left rig'.length })

      controlsRef.current?.handleKeyDown(keyboard('b', { meta: true }))
      await expectSnapshot(snapshots, { cursorOffset: 'left '.length })

      controlsRef.current?.handleKeyDown(keyboard('k', { ctrl: true }))
      await expectSnapshot(snapshots, {
        cursorOffset: 'left '.length,
        query: 'left ',
      })

      controlsRef.current?.handleKeyDown(keyboard('y', { ctrl: true }))
      await expectSnapshot(snapshots, {
        cursorOffset: 'left rig'.length,
        query: 'left rig',
      })

      controlsRef.current?.handleKeyDown(keyboard('g', { ctrl: true }))
      expect(onCancel).toHaveBeenCalledTimes(1)

      const unknownMeta = keyboard('z', { meta: true })
      controlsRef.current?.handleKeyDown(unknownMeta)
      expect(unknownMeta.preventDefault).toHaveBeenCalledTimes(1)

      const tab = keyboard('tab')
      controlsRef.current?.handleKeyDown(tab)
      expect(tab.preventDefault).not.toHaveBeenCalled()

      const pageUp = keyboard('pageup')
      controlsRef.current?.handleKeyDown(pageUp)
      expect(pageUp.preventDefault).not.toHaveBeenCalled()
      expect(latestSnapshot(snapshots)).toMatchObject({
        cursorOffset: 'left rig'.length,
        query: 'left rig',
      })

      controlsRef.current?.setQuery('')
      await expectSnapshot(snapshots, { cursorOffset: 0, query: '' })

      controlsRef.current?.handleKeyDown(keyboard('d', { ctrl: true }))
      expect(onCancel).toHaveBeenCalledTimes(2)

      root.render(
        <Harness
          backspaceExitsOnEmpty={false}
          controlsRef={controlsRef}
          onCancel={onCancel}
          onExit={onExit}
          snapshots={snapshots}
        />,
      )
      await expectSnapshot(snapshots, { cursorOffset: 0, query: '' })

      controlsRef.current?.handleKeyDown(keyboard('backspace'))
      expect(onCancel).toHaveBeenCalledTimes(2)
      expect(onExit).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })
})
