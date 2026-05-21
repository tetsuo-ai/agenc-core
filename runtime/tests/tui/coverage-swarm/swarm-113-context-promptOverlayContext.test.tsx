import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { createRoot, Text } from '../../../src/tui/ink.js'
import {
  PromptOverlayProvider,
  type PromptOverlayData,
  usePromptOverlay,
  usePromptOverlayDialog,
  useSetPromptOverlay,
  useSetPromptOverlayDialog,
} from '../../../src/tui/context/promptOverlayContext.js'

vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: () => {},
}))

vi.mock('../../../src/bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  getActiveTimeCounter: () => 0,
  markScrollActivity: () => {},
  updateLastInteractionTime: () => {},
}))

vi.mock('../../../src/utils/earlyInput.js', () => ({
  stopCapturingEarlyInput: () => {},
}))

vi.mock('../../../src/utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
}))

vi.mock('../../../src/utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => true,
}))

vi.mock('../../../src/utils/log.js', () => ({
  logError: () => {},
}))

type Snapshot = {
  readonly dialog: string | null
  readonly overlay: string | null
}

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  isTTY: boolean
}

const overlayData: PromptOverlayData = {
  suggestions: [
    {
      id: 'command-status',
      displayText: '/status',
      description: 'show status',
    },
  ],
  selectedSuggestion: 0,
  maxColumnWidth: 24,
  suggestionType: 'command',
}

const dialogNode = <Text>stable dialog</Text>

function createStreams(): {
  readonly stdin: TestStdin
  readonly stdout: TestStdout
} {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 120
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error('Timed out waiting for prompt overlay coverage state')
}

function dialogLabel(node: React.ReactNode): string | null {
  if (node === null || node === undefined) return null
  if (!React.isValidElement(node)) return 'node'

  const props = node.props as { readonly children?: React.ReactNode }
  return typeof props.children === 'string' ? props.children : 'node'
}

function Observer({
  snapshots,
}: {
  readonly snapshots: Snapshot[]
}): React.ReactNode {
  const overlay = usePromptOverlay()
  const dialog = usePromptOverlayDialog()

  React.useEffect(() => {
    snapshots.push({
      dialog: dialogLabel(dialog),
      overlay: overlay?.suggestions[0]?.displayText ?? null,
    })
  }, [dialog, overlay, snapshots])

  return <Text>observer</Text>
}

function UnscopedWriter({
  snapshots,
}: {
  readonly snapshots: Snapshot[]
}): React.ReactNode {
  useSetPromptOverlay(overlayData)
  useSetPromptOverlayDialog(dialogNode)

  return <Observer snapshots={snapshots} />
}

function StableWriter({
  renders,
  revision,
}: {
  readonly renders: { count: number }
  readonly revision: number
}): React.ReactNode {
  renders.count += 1

  useSetPromptOverlay(overlayData)
  useSetPromptOverlayDialog(dialogNode)

  return <Text>{`writer-${revision}`}</Text>
}

function ProviderHarness({
  renders,
  revision,
  snapshots,
}: {
  readonly renders: { count: number }
  readonly revision: number
  readonly snapshots: Snapshot[]
}): React.ReactNode {
  return (
    <PromptOverlayProvider>
      <StableWriter renders={renders} revision={revision} />
      <Observer snapshots={snapshots} />
    </PromptOverlayProvider>
  )
}

describe('prompt overlay context coverage swarm 113', () => {
  test('setter hooks are no-ops outside the provider and keep default readers null', async () => {
    const snapshots: Snapshot[] = []
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      root.render(<UnscopedWriter snapshots={snapshots} />)
      await waitForCondition(() =>
        snapshots.some(
          snapshot => snapshot.overlay === null && snapshot.dialog === null,
        ),
      )

      const beforeRerender = snapshots.length
      root.render(<UnscopedWriter snapshots={snapshots} />)
      await sleep()

      expect(snapshots.slice(beforeRerender)).toEqual([])
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }

    expect(snapshots).toEqual([{ overlay: null, dialog: null }])
  })

  test('stable setter inputs survive rerenders without changing overlay state', async () => {
    const renders = { count: 0 }
    const snapshots: Snapshot[] = []
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      root.render(
        <ProviderHarness
          renders={renders}
          revision={1}
          snapshots={snapshots}
        />,
      )
      await waitForCondition(() =>
        snapshots.some(
          snapshot =>
            snapshot.overlay === '/status' &&
            snapshot.dialog === 'stable dialog',
        ),
      )

      const beforeRerender = snapshots.length
      root.render(
        <ProviderHarness
          renders={renders}
          revision={2}
          snapshots={snapshots}
        />,
      )
      await sleep()

      expect(renders.count).toBeGreaterThanOrEqual(2)
      expect(snapshots.slice(beforeRerender)).toEqual([])
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }

    expect(snapshots).toContainEqual({
      dialog: 'stable dialog',
      overlay: '/status',
    })
  })
})
