import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../src/utils/staticRender.js'

type CapturedContext = {
  readonly agentDefinitions?: unknown
  readonly config: unknown
  readonly daemonStatus: {
    readonly autostartDisabled: boolean
  }
  readonly memoryDiagnostics: readonly string[]
}

type Notice = {
  readonly id: string
  readonly render: (context: CapturedContext) => React.ReactNode
  readonly type: 'info' | 'warning'
}

const harness = vi.hoisted(() => ({
  buildMemoryDiagnostics: vi.fn<() => Promise<unknown[]>>(async () => []),
  contexts: [] as CapturedContext[],
  getActiveNotices: vi.fn((context: CapturedContext): Notice[] => {
    harness.contexts.push(context)
    return [
      {
        id: 'probe',
        render: renderedContext =>
          React.createElement(
            'ink-text',
            null,
            [
              `disabled:${renderedContext.daemonStatus.autostartDisabled}`,
              `memory:${renderedContext.memoryDiagnostics.join('|')}`,
            ].join(' '),
          ),
        type: 'info',
      },
    ]
  }),
  globalConfig: {
    autoInstallIdeExtension: true,
    source: 'swarm-197',
  },
}))

vi.mock('../../../src/utils/config.js', () => ({
  getGlobalConfig: () => harness.globalConfig,
}))

vi.mock('../../../src/utils/status.js', () => ({
  buildMemoryDiagnostics: harness.buildMemoryDiagnostics,
}))

vi.mock('../../../src/tui/startup/statusNoticeDefinitions.js', () => ({
  getActiveNotices: harness.getActiveNotices,
}))

const previousDaemonAutostart = process.env.AGENC_DAEMON_AUTOSTART

function restoreDaemonAutostart(): void {
  if (previousDaemonAutostart === undefined) {
    delete process.env.AGENC_DAEMON_AUTOSTART
  } else {
    process.env.AGENC_DAEMON_AUTOSTART = previousDaemonAutostart
  }
}

async function renderStatusNotices(
  props: Record<string, unknown> = {},
): Promise<string> {
  const { StatusNotices } = await import(
    '../../../src/tui/startup/StatusNotices.js'
  )

  return renderToString(
    React.createElement(StatusNotices, props),
    { columns: 120 },
  )
}

describe('StatusNotices coverage swarm row 197', () => {
  beforeEach(() => {
    vi.resetModules()
    harness.buildMemoryDiagnostics.mockReset()
    harness.buildMemoryDiagnostics.mockResolvedValue([])
    harness.contexts = []
    harness.getActiveNotices.mockClear()
    harness.getActiveNotices.mockImplementation((context: CapturedContext) => {
      harness.contexts.push(context)
      return [
        {
          id: 'probe',
          render: renderedContext =>
            React.createElement(
              'ink-text',
              null,
              [
                `disabled:${renderedContext.daemonStatus.autostartDisabled}`,
                `memory:${renderedContext.memoryDiagnostics.join('|')}`,
              ].join(' '),
            ),
          type: 'info',
        },
      ]
    })
    restoreDaemonAutostart()
  })

  afterEach(() => {
    restoreDaemonAutostart()
  })

  test.each([
    ['0'],
    [' false '],
    ['OFF'],
  ])('marks daemon autostart disabled for %s', async value => {
    process.env.AGENC_DAEMON_AUTOSTART = value

    const output = await renderStatusNotices()

    expect(output).toContain('disabled:true')
    expect(harness.contexts.at(-1)?.daemonStatus.autostartDisabled).toBe(true)
  })

  test('returns no rendered output when no notices are active', async () => {
    harness.getActiveNotices.mockImplementation((context: CapturedContext) => {
      harness.contexts.push(context)
      return []
    })

    const output = await renderStatusNotices({
      agentDefinitions: { agents: ['reviewer'] },
    })

    expect(output.trim()).toBe('')
    expect(harness.contexts.at(-1)).toMatchObject({
      agentDefinitions: { agents: ['reviewer'] },
      config: harness.globalConfig,
      daemonStatus: { autostartDisabled: false },
      memoryDiagnostics: [],
    })
  })

  test('shares a pending memory diagnostics request and reuses the cached result', async () => {
    let resolveDiagnostics: (value: unknown[]) => void = () => {}
    harness.buildMemoryDiagnostics.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveDiagnostics = resolve
        }),
    )

    const { StatusNotices } = await import(
      '../../../src/tui/startup/StatusNotices.js'
    )

    await renderToString(
      <>
        <StatusNotices />
        <StatusNotices />
      </>,
      { columns: 120 },
    )

    await vi.waitFor(() => {
      expect(harness.buildMemoryDiagnostics).toHaveBeenCalledTimes(1)
    })

    resolveDiagnostics([404, 'Large memory file'])
    await Promise.resolve()

    const cachedOutput = await renderStatusNotices()

    expect(harness.buildMemoryDiagnostics).toHaveBeenCalledTimes(1)
    expect(cachedOutput).toContain('memory:404|Large memory file')
  })
})
