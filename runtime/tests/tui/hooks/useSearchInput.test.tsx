import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import Text from '../ink/components/Text.js'
import { createRoot } from '../ink/root.js'
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
  isActive = true,
  onExit = () => {},
  onCancel,
  onExitUp,
  passthroughCtrlKeys,
  initialQuery = '',
  backspaceExitsOnEmpty,
}: {
  controlsRef: { current: SearchInputState | null }
  snapshots: Snapshot[]
  isActive?: boolean
  onExit?: () => void
  onCancel?: () => void
  onExitUp?: () => void
  passthroughCtrlKeys?: string[]
  initialQuery?: string
  backspaceExitsOnEmpty?: boolean
}): React.ReactNode {
  const state = useSearchInput({
    isActive,
    onExit,
    onCancel,
    onExitUp,
    passthroughCtrlKeys,
    initialQuery,
    backspaceExitsOnEmpty,
    columns: 80,
  })

  controlsRef.current = state

  React.useEffect(() => {
    snapshots.push({
      query: state.query,
      cursorOffset: state.cursorOffset,
    })
  }, [snapshots, state])

  return <Text>{state.query}</Text>
}

describe('useSearchInput', () => {
  test('edits printable input with cursor movement, delete, and backspace', async () => {
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
        <Harness
          controlsRef={controlsRef}
          snapshots={snapshots}
          initialQuery="abc"
        />,
      )
      await expectSnapshot(snapshots, { query: 'abc', cursorOffset: 3 })

      controlsRef.current?.handleKeyDown(keyboard('home'))
      await expectSnapshot(snapshots, { query: 'abc', cursorOffset: 0 })

      controlsRef.current?.handleKeyDown(keyboard('x'))
      await expectSnapshot(snapshots, { query: 'xabc', cursorOffset: 1 })

      controlsRef.current?.handleKeyDown(keyboard('right'))
      await expectSnapshot(snapshots, { query: 'xabc', cursorOffset: 2 })

      controlsRef.current?.handleKeyDown(keyboard('delete'))
      await expectSnapshot(snapshots, { query: 'xac', cursorOffset: 2 })

      controlsRef.current?.handleKeyDown(keyboard('backspace'))
      await expectSnapshot(snapshots, { query: 'xc', cursorOffset: 1 })

      controlsRef.current?.handleKeyDown(keyboard('end'))
      await expectSnapshot(snapshots, { query: 'xc', cursorOffset: 2 })
    } finally {
      root.unmount()
      stdin.end()
    }
  })

  test('handles exit, cancel, and inactive states', async () => {
    const snapshots: Snapshot[] = []
    const controlsRef = { current: null as SearchInputState | null }
    const onExit = vi.fn()
    const onCancel = vi.fn()
    const onExitUp = vi.fn()
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
          snapshots={snapshots}
          initialQuery="query"
          onExit={onExit}
          onCancel={onCancel}
          onExitUp={onExitUp}
        />,
      )
      await expectSnapshot(snapshots, { query: 'query' })

      controlsRef.current?.handleKeyDown(keyboard('return'))
      expect(onExit).toHaveBeenCalledTimes(1)

      controlsRef.current?.handleKeyDown(keyboard('up'))
      expect(onExitUp).toHaveBeenCalledTimes(1)

      controlsRef.current?.handleKeyDown(keyboard('escape'))
      expect(onCancel).toHaveBeenCalledTimes(1)

      root.render(
        <Harness
          controlsRef={controlsRef}
          snapshots={snapshots}
          initialQuery="ignored"
          isActive={false}
          onExit={onExit}
        />,
      )
      controlsRef.current?.handleKeyDown(keyboard('z'))
      await expectSnapshot(snapshots, { query: 'query' })
    } finally {
      root.unmount()
      stdin.end()
    }
  })

  test('clears on escape without cancel and exits from an empty query', async () => {
    const snapshots: Snapshot[] = []
    const controlsRef = { current: null as SearchInputState | null }
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
          snapshots={snapshots}
          initialQuery="query"
          onExit={onExit}
        />,
      )
      await expectSnapshot(snapshots, { query: 'query' })

      controlsRef.current?.handleKeyDown(keyboard('escape'))
      await expectSnapshot(snapshots, { query: '', cursorOffset: 0 })

      controlsRef.current?.handleKeyDown(keyboard('escape'))
      expect(onExit).toHaveBeenCalledTimes(1)
    } finally {
      root.unmount()
      stdin.end()
    }
  })

  test('supports ctrl/meta editing, kill-ring yank, and passthrough ctrl keys', async () => {
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
        <Harness
          controlsRef={controlsRef}
          snapshots={snapshots}
          initialQuery="alpha beta gamma"
          passthroughCtrlKeys={['n']}
        />,
      )
      await expectSnapshot(snapshots, {
        query: 'alpha beta gamma',
        cursorOffset: 'alpha beta gamma'.length,
      })

      controlsRef.current?.handleKeyDown(keyboard('w', { ctrl: true }))
      await expectSnapshot(snapshots, {
        query: 'alpha beta ',
        cursorOffset: 'alpha beta '.length,
      })

      controlsRef.current?.handleKeyDown(keyboard('y', { ctrl: true }))
      await expectSnapshot(snapshots, {
        query: 'alpha beta gamma',
        cursorOffset: 'alpha beta gamma'.length,
      })

      controlsRef.current?.handleKeyDown(keyboard('a', { ctrl: true }))
      await expectSnapshot(snapshots, { cursorOffset: 0 })

      controlsRef.current?.handleKeyDown(keyboard('f', { meta: true }))
      await expectSnapshot(snapshots, { cursorOffset: 'alpha '.length })

      controlsRef.current?.handleKeyDown(keyboard('d', { meta: true }))
      await expectSnapshot(snapshots, {
        query: 'alpha gamma',
        cursorOffset: 'alpha '.length,
      })

      const passthrough = keyboard('n', { ctrl: true })
      controlsRef.current?.handleKeyDown(passthrough)
      expect(passthrough.preventDefault).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
    }
  })
})
