import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import Text from '../ink/components/Text.js'
import { createRoot } from '../ink/root.js'
import { clearKillRing } from '../../utils/TextCursor.js'
import type { KeyboardEvent } from './events/keyboard-event.js'
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

type Snapshot = {
  query: string
  cursorOffset: number
}

type TestStreams = {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
}

function createTestStreams(): TestStreams {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStreams['stdin']

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120

  return { stdout, stdin }
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
    snapshots.some(snapshot =>
      Object.entries(expected).every(
        ([key, value]) => snapshot[key as keyof Snapshot] === value,
      ),
    ),
  )
}

function keyboard(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'ctrl' | 'meta' | 'fn'>> = {},
): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    key,
    ctrl: modifiers.ctrl ?? false,
    meta: modifiers.meta ?? false,
    fn: modifiers.fn ?? false,
    preventDefault: vi.fn(),
  } as never
}

function Harness({
  controlsRef,
  snapshots,
  initialQuery,
}: {
  controlsRef: { current: SearchInputState | null }
  snapshots: Snapshot[]
  initialQuery: string
}): React.ReactNode {
  const state = useSearchInput({
    isActive: true,
    onExit: () => {},
    initialQuery,
    columns: 80,
  })

  controlsRef.current = state

  React.useEffect(() => {
    snapshots.push({
      query: state.query,
      cursorOffset: state.cursorOffset,
    })
  }, [snapshots, state])

  return React.createElement(Text, null, state.query)
}

describe('useSearchInput coverage', () => {
  beforeEach(() => {
    clearKillRing()
  })

  afterEach(() => {
    clearKillRing()
  })

  test('yank-pop replaces the latest yanked kill-ring entry with the previous one', async () => {
    const snapshots: Snapshot[] = []
    const controlsRef = { current: null as SearchInputState | null }
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        React.createElement(Harness, {
          controlsRef,
          snapshots,
          initialQuery: 'alpha beta gamma',
        }),
      )
      await expectSnapshot(snapshots, {
        query: 'alpha beta gamma',
        cursorOffset: 'alpha beta gamma'.length,
      })

      controlsRef.current?.handleKeyDown(keyboard('u', { ctrl: true }))
      await expectSnapshot(snapshots, { query: '', cursorOffset: 0 })

      controlsRef.current?.handleKeyDown(keyboard('delta epsilon'))
      await expectSnapshot(snapshots, {
        query: 'delta epsilon',
        cursorOffset: 'delta epsilon'.length,
      })

      controlsRef.current?.handleKeyDown(keyboard('backspace', { meta: true }))
      await expectSnapshot(snapshots, {
        query: 'delta ',
        cursorOffset: 'delta '.length,
      })

      controlsRef.current?.handleKeyDown(keyboard('y', { ctrl: true }))
      await expectSnapshot(snapshots, {
        query: 'delta epsilon',
        cursorOffset: 'delta epsilon'.length,
      })

      controlsRef.current?.handleKeyDown(keyboard('y', { meta: true }))
      await expectSnapshot(snapshots, {
        query: 'delta alpha beta gamma',
        cursorOffset: 'delta alpha beta gamma'.length,
      })
    } finally {
      root.unmount()
      stdin.end()
    }
  })
})
