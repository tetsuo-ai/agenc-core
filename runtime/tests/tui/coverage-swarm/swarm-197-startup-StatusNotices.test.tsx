import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { ProviderAuthReadContext } from '../../../src/utils/auth.js'
import { renderToString } from '../../../src/utils/staticRender.js'
import {
  TEST_REMOTE_AUTH_ENVIRONMENT,
  TEST_REMOTE_AUTH_SESSION_CONTEXT,
  TEST_RUNTIME_STATE_REPOSITORY,
} from '../remoteAuthSessionContext.fixture.js'

function providerAuthContextWithEnvironment(
  overrides: Partial<ProviderAuthReadContext['environment']>,
): ProviderAuthReadContext {
  return Object.freeze({
    ...TEST_REMOTE_AUTH_SESSION_CONTEXT,
    environment: Object.freeze({
      ...TEST_REMOTE_AUTH_ENVIRONMENT,
      ...overrides,
    }),
  })
}

type CapturedContext = {
  readonly agentDefinitions?: unknown
  readonly config: unknown
  readonly homeContext: unknown
  readonly providerAuthContext: ProviderAuthReadContext
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
  buildMemoryDiagnostics: vi.fn<() => Promise<string[]>>(async () => []),
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
  logError: vi.fn(),
}))

vi.mock('../../../src/utils/config.js', () => ({
  getRuntimeState: () => harness.globalConfig,
}))

vi.mock('../../../src/tui/startup/memoryDiagnostics.js', () => ({
  buildMemoryDiagnostics: harness.buildMemoryDiagnostics,
}))

vi.mock('../../../src/utils/log.js', () => ({
  logError: harness.logError,
}))

vi.mock('../../../src/tui/startup/statusNoticeDefinitions.js', () => ({
  getActiveNotices: harness.getActiveNotices,
}))

async function renderStatusNotices(
  props: Record<string, unknown> = {},
): Promise<string> {
  const { StatusNotices } = await import(
    '../../../src/tui/startup/StatusNotices.js'
  )

  return renderToString(
    React.createElement(StatusNotices, {
      homeContext: TEST_REMOTE_AUTH_SESSION_CONTEXT.home,
      providerAuthContext: TEST_REMOTE_AUTH_SESSION_CONTEXT,
      stateRepository: TEST_RUNTIME_STATE_REPOSITORY,
      ...props,
    }),
    { columns: 120 },
  )
}

describe('StatusNotices coverage swarm row 197', () => {
  beforeEach(() => {
    vi.resetModules()
    harness.buildMemoryDiagnostics.mockReset()
    harness.buildMemoryDiagnostics.mockResolvedValue([])
    harness.contexts = []
    harness.logError.mockClear()
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
  })

  test.each([
    ['0'],
    [' false '],
    ['OFF'],
  ])('marks daemon autostart disabled for %s', async value => {
    const providerAuthContext = providerAuthContextWithEnvironment({
      AGENC_DAEMON_AUTOSTART: value,
    })

    const output = await renderStatusNotices({ providerAuthContext })

    expect(output).toContain('disabled:true')
    expect(harness.contexts.at(-1)?.daemonStatus.autostartDisabled).toBe(true)
    expect(harness.contexts.at(-1)?.providerAuthContext).toBe(
      providerAuthContext,
    )
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
      providerAuthContext: TEST_REMOTE_AUTH_SESSION_CONTEXT,
    })
  })

  test('shares a pending memory diagnostics request and reuses the cached result', async () => {
    let resolveDiagnostics: (value: string[]) => void = () => {}
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
        <StatusNotices
          homeContext={TEST_REMOTE_AUTH_SESSION_CONTEXT.home}
          providerAuthContext={TEST_REMOTE_AUTH_SESSION_CONTEXT}
          stateRepository={TEST_RUNTIME_STATE_REPOSITORY}
        />
        <StatusNotices
          homeContext={TEST_REMOTE_AUTH_SESSION_CONTEXT.home}
          providerAuthContext={TEST_REMOTE_AUTH_SESSION_CONTEXT}
          stateRepository={TEST_RUNTIME_STATE_REPOSITORY}
        />
      </>,
      { columns: 120 },
    )

    await vi.waitFor(() => {
      expect(harness.buildMemoryDiagnostics).toHaveBeenCalledTimes(1)
    })

    resolveDiagnostics(['404', 'Large memory file'])
    await Promise.resolve()

    const cachedOutput = await renderStatusNotices()

    expect(harness.buildMemoryDiagnostics).toHaveBeenCalledTimes(1)
    expect(cachedOutput).toContain('memory:404|Large memory file')
  })

  test('logs rejected memory diagnostics and retries on a later render', async () => {
    const error = new Error('memory diagnostics unavailable')
    harness.buildMemoryDiagnostics.mockRejectedValueOnce(error)

    const firstOutput = await renderStatusNotices()

    expect(firstOutput).toContain('memory:')
    await vi.waitFor(() => {
      expect(harness.buildMemoryDiagnostics).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(harness.logError).toHaveBeenCalledWith(error)
    })

    harness.buildMemoryDiagnostics.mockResolvedValueOnce(['Recovered memory'])
    await renderStatusNotices()

    await vi.waitFor(() => {
      expect(harness.buildMemoryDiagnostics).toHaveBeenCalledTimes(2)
    })

    const thirdOutput = await renderStatusNotices()

    expect(thirdOutput).toContain('memory:Recovered memory')
  })
})
