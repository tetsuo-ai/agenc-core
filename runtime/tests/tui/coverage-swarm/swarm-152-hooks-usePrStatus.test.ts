import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  fetchPrStatus: vi.fn(),
  interactionTime: 1,
}))

vi.mock('../../../src/tui/bootstrap/state.js', () => ({
  getLastInteractionTime: () => fixture.interactionTime,
}))

vi.mock('../../../src/utils/ghPrStatus.js', () => ({
  fetchPrStatus: fixture.fetchPrStatus,
}))

import { createRoot } from '../../../src/tui/ink.js'
import {
  type PrStatusState,
  usePrStatus,
} from '../../../src/tui/hooks/usePrStatus.js'

type HookProps = {
  readonly enabled: boolean
  readonly isLoading: boolean
}

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough & {
    columns: number
    isTTY: boolean
    rows: number
  }
}

const POLL_INTERVAL_MS = 60_000
const IDLE_STOP_MS = 60 * 60_000
const realSetImmediate = setImmediate

function createStreams(): TestStreams {
  const stdin = new PassThrough() as TestStreams['stdin']
  const stdout = new PassThrough() as TestStreams['stdout']

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

async function flushEffects(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await Promise.resolve()
  })
  await new Promise<void>(resolve => realSetImmediate(resolve))
  await act(async () => {
    await Promise.resolve()
  })
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await flushEffects()
    }
  }
  throw lastError
}

async function renderHookHarness(
  initialProps: HookProps,
): Promise<{
  readonly dispose: () => Promise<void>
  readonly latest: () => PrStatusState
  readonly render: (next: Partial<HookProps>) => Promise<void>
}> {
  let latest: PrStatusState | undefined
  let props = initialProps
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    latest = usePrStatus(props.isLoading, props.enabled)
    return null
  }

  async function render(next: Partial<HookProps> = {}): Promise<void> {
    props = { ...props, ...next }
    await act(async () => {
      root.render(React.createElement(Harness))
    })
    await flushEffects()
  }

  await render()

  return {
    dispose: async () => {
      await act(async () => {
        root.unmount()
      })
      stdin.end()
      stdout.end()
      await flushEffects()
    },
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
    render,
  }
}

describe('usePrStatus coverage swarm row 152', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(120_000)
    fixture.fetchPrStatus.mockReset()
    fixture.interactionTime = 1
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('does not fetch or schedule polling when disabled', async () => {
    fixture.fetchPrStatus.mockResolvedValue({
      number: 152,
      reviewState: 'approved',
      url: 'https://example.test/pull/152',
    })
    const rendered = await renderHookHarness({
      enabled: false,
      isLoading: false,
    })

    try {
      expect(rendered.latest()).toEqual({
        number: null,
        reviewState: null,
        url: null,
        lastUpdated: 0,
      })

      await flushEffects(POLL_INTERVAL_MS * 2)
      await rendered.render({ isLoading: true })
      await flushEffects(POLL_INTERVAL_MS * 2)

      expect(fixture.fetchPrStatus).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('clears the previous PR status when a later poll finds no PR', async () => {
    fixture.fetchPrStatus
      .mockResolvedValueOnce({
        number: 152,
        reviewState: 'changes_requested',
        url: 'https://example.test/pull/152',
      })
      .mockResolvedValueOnce(null)
    const rendered = await renderHookHarness({
      enabled: true,
      isLoading: false,
    })

    try {
      await waitFor(() => {
        expect(rendered.latest()).toMatchObject({
          number: 152,
          reviewState: 'changes_requested',
          url: 'https://example.test/pull/152',
        })
      })
      const firstUpdated = rendered.latest().lastUpdated

      await flushEffects(POLL_INTERVAL_MS)
      await waitFor(() => {
        expect(fixture.fetchPrStatus).toHaveBeenCalledTimes(2)
      })

      expect(rendered.latest()).toEqual({
        number: null,
        reviewState: null,
        url: null,
        lastUpdated: expect.any(Number),
      })
      expect(rendered.latest().lastUpdated).toBeGreaterThan(firstUpdated)
    } finally {
      await rendered.dispose()
    }
  })

  test('treats a rejected PR status fetch as unavailable and keeps polling', async () => {
    fixture.fetchPrStatus
      .mockRejectedValueOnce(new Error('gh lookup failed'))
      .mockResolvedValueOnce({
        number: 153,
        reviewState: 'approved',
        url: 'https://example.test/pull/153',
      })
    const rendered = await renderHookHarness({
      enabled: true,
      isLoading: false,
    })

    try {
      await waitFor(() => {
        expect(fixture.fetchPrStatus).toHaveBeenCalledTimes(1)
      })
      expect(rendered.latest()).toEqual({
        number: null,
        reviewState: null,
        url: null,
        lastUpdated: 0,
      })

      await flushEffects(POLL_INTERVAL_MS)

      await waitFor(() => {
        expect(rendered.latest()).toMatchObject({
          number: 153,
          reviewState: 'approved',
          url: 'https://example.test/pull/153',
        })
      })
      expect(fixture.fetchPrStatus).toHaveBeenCalledTimes(2)
    } finally {
      await rendered.dispose()
    }
  })

  test('stops polling once the session has been idle for an hour', async () => {
    fixture.fetchPrStatus.mockResolvedValue({
      number: 152,
      reviewState: 'pending',
      url: 'https://example.test/pull/152',
    })
    const rendered = await renderHookHarness({
      enabled: true,
      isLoading: false,
    })

    try {
      await waitFor(() => {
        expect(fixture.fetchPrStatus).toHaveBeenCalledTimes(1)
      })

      vi.setSystemTime(Date.now() + IDLE_STOP_MS)
      await flushEffects(POLL_INTERVAL_MS)

      expect(fixture.fetchPrStatus).toHaveBeenCalledTimes(1)

      await flushEffects(POLL_INTERVAL_MS)

      expect(fixture.fetchPrStatus).toHaveBeenCalledTimes(1)
    } finally {
      await rendered.dispose()
    }
  })
})
