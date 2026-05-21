import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const oscHarness = vi.hoisted(() => {
  const state = { supported: true }

  return {
    state,
    supportsTabStatus: vi.fn(() => state.supported),
    tabStatus: vi.fn((fields: { readonly status?: string | null }) => {
      return `tab-status:${fields.status ?? 'clear'}`
    }),
    wrapForMultiplexer: vi.fn((sequence: string) => `wrapped:${sequence}`),
  }
})

vi.mock('../../../src/tui/ink/termio/osc.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../src/tui/ink/termio/osc.js')>()

  return {
    ...actual,
    supportsTabStatus: oscHarness.supportsTabStatus,
    tabStatus: oscHarness.tabStatus,
    wrapForMultiplexer: oscHarness.wrapForMultiplexer,
  }
})

import { createRoot } from '../../../src/tui/ink.js'
import {
  type TabStatusKind,
  useTabStatus,
} from '../../../src/tui/ink/hooks/use-tab-status.js'
import { CLEAR_TAB_STATUS } from '../../../src/tui/ink/termio/osc.js'
import { TerminalWriteProvider } from '../../../src/tui/ink/useTerminalNotification.js'

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

type WriteRaw = ((data: string) => void) | null

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
  stdout.isTTY = false
  stdout.resume()

  return { stdin, stdout }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
  await new Promise(resolve => realSetImmediate(resolve))
  await act(async () => {
    await Promise.resolve()
  })
}

function TabStatusProbe({
  kind,
}: {
  readonly kind: TabStatusKind | null
}): null {
  useTabStatus(kind)
  return null
}

async function renderHookHarness(
  initialKind: TabStatusKind | null,
  initialWriteRaw: WriteRaw,
): Promise<{
  readonly dispose: () => Promise<void>
  readonly render: (
    nextKind: TabStatusKind | null,
    nextWriteRaw?: WriteRaw,
  ) => Promise<void>
}> {
  let kind = initialKind
  let writeRaw = initialWriteRaw
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  async function render(
    nextKind: TabStatusKind | null,
    nextWriteRaw: WriteRaw = writeRaw,
  ): Promise<void> {
    kind = nextKind
    writeRaw = nextWriteRaw

    await act(async () => {
      root.render(
        React.createElement(
          TerminalWriteProvider,
          { value: writeRaw },
          React.createElement(TabStatusProbe, { kind }),
        ),
      )
    })
    await flushEffects()
  }

  await render(kind)

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushEffects()
    },
    render,
  }
}

describe('useTabStatus coverage swarm row 093', () => {
  beforeEach(() => {
    oscHarness.state.supported = true
    oscHarness.supportsTabStatus.mockClear()
    oscHarness.tabStatus.mockClear()
    oscHarness.wrapForMultiplexer.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('emits wrapped preset status sequences for each tab-status kind', async () => {
    const writeRaw = vi.fn()
    const rendered = await renderHookHarness('idle', writeRaw)

    try {
      await rendered.render('busy')
      await rendered.render('waiting')

      expect(oscHarness.tabStatus.mock.calls.map(([fields]) => fields)).toEqual([
        {
          indicator: { type: 'rgb', r: 0, g: 215, b: 95 },
          status: 'Idle',
          statusColor: { type: 'rgb', r: 136, g: 136, b: 136 },
        },
        {
          indicator: { type: 'rgb', r: 255, g: 149, b: 0 },
          status: 'Working…',
          statusColor: { type: 'rgb', r: 255, g: 149, b: 0 },
        },
        {
          indicator: { type: 'rgb', r: 95, g: 135, b: 255 },
          status: 'Waiting',
          statusColor: { type: 'rgb', r: 95, g: 135, b: 255 },
        },
      ])
      expect(oscHarness.wrapForMultiplexer.mock.calls).toEqual([
        ['tab-status:Idle'],
        ['tab-status:Working…'],
        ['tab-status:Waiting'],
      ])
      expect(writeRaw.mock.calls.map(([sequence]) => sequence)).toEqual([
        'wrapped:tab-status:Idle',
        'wrapped:tab-status:Working…',
        'wrapped:tab-status:Waiting',
      ])
    } finally {
      await rendered.dispose()
    }
  })

  test('skips initial null status and short-circuits when no terminal writer exists', async () => {
    const nullRendered = await renderHookHarness(null, vi.fn())

    try {
      expect(oscHarness.supportsTabStatus).not.toHaveBeenCalled()
      expect(oscHarness.tabStatus).not.toHaveBeenCalled()
    } finally {
      await nullRendered.dispose()
    }

    const noWriterRendered = await renderHookHarness('busy', null)

    try {
      await noWriterRendered.render(null)

      expect(oscHarness.supportsTabStatus).not.toHaveBeenCalled()
      expect(oscHarness.tabStatus).not.toHaveBeenCalled()
      expect(oscHarness.wrapForMultiplexer).not.toHaveBeenCalled()
    } finally {
      await noWriterRendered.dispose()
    }
  })

  test('gates unsupported terminals and clears stale status after support is available', async () => {
    const writeRaw = vi.fn()
    oscHarness.state.supported = false
    const rendered = await renderHookHarness('waiting', writeRaw)

    try {
      await rendered.render(null)

      expect(oscHarness.supportsTabStatus).toHaveBeenCalledTimes(2)
      expect(oscHarness.tabStatus).not.toHaveBeenCalled()
      expect(writeRaw).not.toHaveBeenCalled()

      oscHarness.state.supported = true
      await rendered.render('idle')
      await rendered.render(null)

      expect(oscHarness.tabStatus).toHaveBeenCalledTimes(1)
      expect(oscHarness.wrapForMultiplexer.mock.calls.slice(-2)).toEqual([
        ['tab-status:Idle'],
        [CLEAR_TAB_STATUS],
      ])
      expect(writeRaw.mock.calls.map(([sequence]) => sequence)).toEqual([
        'wrapped:tab-status:Idle',
        `wrapped:${CLEAR_TAB_STATUS}`,
      ])
    } finally {
      await rendered.dispose()
    }
  })
})
