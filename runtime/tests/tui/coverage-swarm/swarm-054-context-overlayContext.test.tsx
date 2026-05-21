import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { createRoot, Text } from '../../../src/tui/ink.js'
import {
  useIsModalOverlayActive,
  useIsOverlayActive,
  useRegisterOverlay,
} from '../../../src/tui/context/overlayContext.js'
import { AppStoreContext } from '../../../src/tui/state/AppState.js'

type OverlayState = {
  activeOverlays: ReadonlySet<string>
}

type OverlayStore = {
  getState: () => OverlayState
  setState: (updater: (prev: OverlayState) => OverlayState) => void
  subscribe: (listener: () => void) => () => void
}

const appStateHarness = vi.hoisted(() => ({
  state: {
    activeOverlays: new Set<string>(),
  },
}))

const inkInstanceHarness = vi.hoisted(() => ({
  invalidatePrevFrame: vi.fn(),
  get: vi.fn(() => ({
    invalidatePrevFrame: inkInstanceHarness.invalidatePrevFrame,
  })),
}))

vi.mock('../../../src/tui/state/AppState.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')

  return {
    AppStoreContext: ReactActual.createContext<OverlayStore | null>(null),
    useAppState: (
      selector: (state: { activeOverlays: ReadonlySet<string> }) => unknown,
    ) => selector(appStateHarness.state),
  }
})

vi.mock('../../../src/tui/ink/instances.js', () => ({
  default: {
    get: inkInstanceHarness.get,
  },
  deleteInkInstance: vi.fn(() => true),
  getInkInstance: vi.fn(() => undefined),
  setInkInstance: vi.fn(),
}))

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  rows: number
  isTTY: boolean
}

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

  stdout.columns = 100
  stdout.rows = 24
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 1_000) {
    if (predicate()) return
    await sleep(10)
  }

  throw new Error(message)
}

function createOverlayStore(initialIds: readonly string[] = []): {
  readonly store: OverlayStore
  readonly writes: Array<{ readonly ids: string[]; readonly same: boolean }>
  readonly ids: () => string[]
} {
  let state: OverlayState = {
    activeOverlays: new Set(initialIds),
  }
  const listeners = new Set<() => void>()
  const writes: Array<{ ids: string[]; same: boolean }> = []

  const store: OverlayStore = {
    getState: () => state,
    setState: updater => {
      const prev = state
      const next = updater(prev)

      writes.push({
        ids: [...next.activeOverlays].sort(),
        same: Object.is(prev, next),
      })

      if (Object.is(prev, next)) return

      state = next
      for (const listener of listeners) listener()
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return {
    store,
    writes,
    ids: () => [...state.activeOverlays].sort(),
  }
}

async function renderRegisterHarness(
  node: React.ReactNode,
): Promise<{
  readonly root: Awaited<ReturnType<typeof createRoot>>
  readonly stdin: TestStdin
  readonly stdout: TestStdout
}> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  root.render(node)

  return { root, stdin, stdout }
}

function cleanupHarness({
  stdin,
  stdout,
}: {
  readonly stdin: TestStdin
  readonly stdout: TestStdout
}) {
  stdin.end()
  stdout.end()
}

function RegisterOverlay({
  enabled,
  id,
}: {
  readonly enabled?: boolean
  readonly id: string
}) {
  useRegisterOverlay(id, enabled)
  return null
}

function OverlayStatus() {
  const isActive = useIsOverlayActive()
  const isModalActive = useIsModalOverlayActive()

  return (
    <Text>
      {isActive ? 'active' : 'idle'}:{isModalActive ? 'modal' : 'nonmodal'}
    </Text>
  )
}

describe('overlayContext coverage swarm 054', () => {
  test('registers duplicate overlays once and unregisters idempotently', async () => {
    const overlayStore = createOverlayStore()
    const harness = await renderRegisterHarness(
      <AppStoreContext.Provider value={overlayStore.store as never}>
        <RegisterOverlay id="select" />
        <RegisterOverlay id="select" />
      </AppStoreContext.Provider>,
    )

    try {
      await waitForCondition(
        () =>
          overlayStore.ids().join(',') === 'select' &&
          overlayStore.writes.length >= 2,
        'timed out waiting for overlay registration',
      )

      expect(overlayStore.ids()).toEqual(['select'])
      expect(overlayStore.writes).toContainEqual({
        ids: ['select'],
        same: true,
      })

      harness.root.unmount()

      await waitForCondition(
        () => overlayStore.ids().length === 0,
        'timed out waiting for overlay cleanup',
      )

      expect(overlayStore.writes).toContainEqual({
        ids: [],
        same: true,
      })
      expect(inkInstanceHarness.invalidatePrevFrame).toHaveBeenCalled()
    } finally {
      harness.root.unmount()
      cleanupHarness(harness)
    }
  })

  test('skips registration when disabled or outside the app store provider', async () => {
    const overlayStore = createOverlayStore()
    const disabledHarness = await renderRegisterHarness(
      <AppStoreContext.Provider value={overlayStore.store as never}>
        <RegisterOverlay enabled={false} id="select" />
      </AppStoreContext.Provider>,
    )

    try {
      await sleep()
      expect(overlayStore.ids()).toEqual([])
      expect(overlayStore.writes).toEqual([])
    } finally {
      disabledHarness.root.unmount()
      cleanupHarness(disabledHarness)
    }

    const missingProviderHarness = await renderRegisterHarness(
      <RegisterOverlay id="select" />,
    )

    try {
      await sleep()
    } finally {
      missingProviderHarness.root.unmount()
      cleanupHarness(missingProviderHarness)
    }
  })

  test('distinguishes any overlay from modal overlays', async () => {
    appStateHarness.state = {
      activeOverlays: new Set(),
    }
    await expect(renderToString(<OverlayStatus />, 40)).resolves.toContain(
      'idle:nonmodal',
    )

    appStateHarness.state = {
      activeOverlays: new Set(['autocomplete']),
    }
    await expect(renderToString(<OverlayStatus />, 40)).resolves.toContain(
      'active:nonmodal',
    )

    appStateHarness.state = {
      activeOverlays: new Set(['autocomplete', 'select']),
    }
    await expect(renderToString(<OverlayStatus />, 40)).resolves.toContain(
      'active:modal',
    )
  })
})
