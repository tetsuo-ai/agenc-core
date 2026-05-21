import type { ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { MCPServerConnection } from '../../../src/services/mcp/types.js'

const harness = vi.hoisted(() => ({
  addNotification: vi.fn(),
  agencAiConnected: false,
  logError: vi.fn(),
  remoteMode: false,
}))

vi.mock('react-compiler-runtime', () => ({
  c: (size: number) => new Array(size),
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    },
  }
})

vi.mock('../../../src/tui/context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: harness.addNotification,
  }),
}))

vi.mock('../../../src/bootstrap/state.js', () => ({
  getIsRemoteMode: () => harness.remoteMode,
}))

vi.mock('../../../src/services/mcp/agencai.js', () => ({
  hasAgenCAiMcpEverConnected: () => harness.agencAiConnected,
}))

vi.mock('../../../src/tui/ink.js', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react')
  return {
    Text: ({ children }: { readonly children?: ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  }
})

vi.mock('../../../src/utils/log.js', () => ({
  logError: harness.logError,
}))

import { useMcpConnectivityStatus } from '../../../src/tui/hooks/notifs/useMcpConnectivityStatus.js'

function scopedConfig(type: string): MCPServerConnection['config'] {
  if (type === 'stdio') {
    return {
      type: 'stdio',
      command: 'node',
      args: [],
      scope: 'user',
    }
  }

  return {
    type,
    url: `https://${type}.example.test`,
    scope: 'user',
  } as MCPServerConnection['config']
}

function failedClient(
  name: string,
  configType: string = 'stdio',
): MCPServerConnection {
  return {
    type: 'failed',
    name,
    config: scopedConfig(configType),
    error: 'connection failed',
  }
}

function needsAuthClient(
  name: string,
  configType: string = 'http',
): MCPServerConnection {
  return {
    type: 'needs-auth',
    name,
    config: scopedConfig(configType),
  }
}

function connectedClient(name: string): MCPServerConnection {
  return {
    type: 'connected',
    name,
    config: scopedConfig('stdio'),
    capabilities: {},
    client: {} as MCPServerConnection['client'],
    cleanup: vi.fn(),
  } as MCPServerConnection
}

function runHook(mcpClients?: readonly MCPServerConnection[]): void {
  useMcpConnectivityStatus({
    mcpClients: mcpClients as MCPServerConnection[] | undefined,
  })
}

describe('useMcpConnectivityStatus swarm coverage 082', () => {
  beforeEach(() => {
    harness.addNotification.mockReset()
    harness.agencAiConnected = false
    harness.logError.mockReset()
    harness.remoteMode = false
  })

  test('does not notify for default, remote, or non-actionable client lists', () => {
    runHook()
    expect(harness.addNotification).not.toHaveBeenCalled()

    harness.remoteMode = true
    runHook([failedClient('files')])
    expect(harness.addNotification).not.toHaveBeenCalled()

    harness.remoteMode = false
    runHook([
      connectedClient('connected'),
      {
        type: 'pending',
        name: 'pending',
        config: scopedConfig('stdio'),
      },
      {
        type: 'disabled',
        name: 'disabled',
        config: scopedConfig('stdio'),
      },
      failedClient('ide-sse', 'sse-ide'),
      failedClient('ide-ws', 'ws-ide'),
    ])

    expect(harness.addNotification).not.toHaveBeenCalled()
    expect(harness.logError).not.toHaveBeenCalled()
  })

  test('adds separate local failure and local auth notifications', () => {
    runHook([failedClient('files'), needsAuthClient('calendar')])

    expect(harness.addNotification).toHaveBeenCalledTimes(2)
    expect(harness.addNotification).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        key: 'mcp-failed',
        priority: 'medium',
      }),
    )
    expect(harness.addNotification).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        key: 'mcp-needs-auth',
        priority: 'medium',
      }),
    )
    expect(harness.logError).not.toHaveBeenCalled()
  })

  test('adds agenc.tech connector notifications only after a connector has connected before', () => {
    runHook([failedClient('remote-files', 'agencai-proxy')])
    expect(harness.addNotification).not.toHaveBeenCalled()

    harness.agencAiConnected = true
    runHook([
      failedClient('remote-files', 'agencai-proxy'),
      needsAuthClient('remote-calendar', 'agencai-proxy'),
    ])

    expect(harness.addNotification).toHaveBeenCalledTimes(2)
    expect(harness.addNotification).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        key: 'mcp-agencai-failed',
      }),
    )
    expect(harness.addNotification).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        key: 'mcp-agencai-needs-auth',
      }),
    )
  })

  test('uses plural notification branches for multiple local failures and auth prompts', () => {
    runHook([
      failedClient('files'),
      failedClient('search'),
      needsAuthClient('calendar'),
      needsAuthClient('docs'),
    ])

    expect(harness.addNotification).toHaveBeenCalledTimes(2)
    expect(harness.addNotification).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        key: 'mcp-failed',
      }),
    )
    expect(harness.addNotification).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        key: 'mcp-needs-auth',
      }),
    )
  })

  test('logs notification errors thrown during status processing', () => {
    const error = new Error('notification failed')
    harness.addNotification.mockImplementationOnce(() => {
      throw error
    })

    runHook([failedClient('files')])

    expect(harness.logError).toHaveBeenCalledWith(error)
  })
})
