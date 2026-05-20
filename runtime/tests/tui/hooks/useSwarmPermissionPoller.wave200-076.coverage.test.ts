import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  logForDebugging: vi.fn(),
}))

vi.mock('src/utils/debug.js', () => ({
  logForDebugging: harness.logForDebugging,
}))

import {
  clearAllPendingCallbacks,
  hasPermissionCallback,
  hasSandboxPermissionCallback,
  processMailboxPermissionResponse,
  processSandboxPermissionResponse,
  registerPermissionCallback,
  registerSandboxPermissionCallback,
  unregisterPermissionCallback,
} from './useSwarmPermissionPoller.js'

describe('useSwarmPermissionPoller callback registries', () => {
  beforeEach(() => {
    clearAllPendingCallbacks()
    harness.logForDebugging.mockClear()
  })

  test('routes mailbox and sandbox responses through registered callbacks', () => {
    const validPermissionUpdate = {
      type: 'addDirectories',
      directories: ['/repo/src'],
      destination: 'session',
    }
    const malformedPermissionUpdate = {
      type: 'addDirectories',
      directories: [42],
      destination: 'session',
    }

    expect(
      processMailboxPermissionResponse({
        requestId: 'missing',
        decision: 'approved',
      }),
    ).toBe(false)
    expect(harness.logForDebugging).toHaveBeenCalledWith(
      '[SwarmPermissionPoller] No callback registered for mailbox response missing',
    )

    const onAllow = vi.fn()
    const onReject = vi.fn()
    registerPermissionCallback({
      requestId: 'approve-request',
      toolUseId: 'tool-use-1',
      onAllow,
      onReject,
    })

    expect(hasPermissionCallback('approve-request')).toBe(true)
    expect(
      processMailboxPermissionResponse({
        requestId: 'approve-request',
        decision: 'approved',
        updatedInput: { command: 'npm test' },
        permissionUpdates: [
          validPermissionUpdate,
          malformedPermissionUpdate,
        ],
      }),
    ).toBe(true)
    expect(hasPermissionCallback('approve-request')).toBe(false)
    expect(onAllow).toHaveBeenCalledWith(
      { command: 'npm test' },
      [validPermissionUpdate],
    )
    expect(onReject).not.toHaveBeenCalled()
    expect(harness.logForDebugging).toHaveBeenCalledWith(
      expect.stringContaining('Dropping malformed permissionUpdate entry:'),
      { level: 'warn' },
    )
    expect(
      processMailboxPermissionResponse({
        requestId: 'approve-request',
        decision: 'approved',
      }),
    ).toBe(false)

    const unregisteredAllow = vi.fn()
    registerPermissionCallback({
      requestId: 'unregistered-request',
      toolUseId: 'tool-use-2',
      onAllow: unregisteredAllow,
      onReject: vi.fn(),
    })
    unregisterPermissionCallback('unregistered-request')
    expect(hasPermissionCallback('unregistered-request')).toBe(false)
    expect(
      processMailboxPermissionResponse({
        requestId: 'unregistered-request',
        decision: 'approved',
      }),
    ).toBe(false)
    expect(unregisteredAllow).not.toHaveBeenCalled()

    const rejectedAllow = vi.fn()
    const rejectedReject = vi.fn()
    registerPermissionCallback({
      requestId: 'reject-request',
      toolUseId: 'tool-use-3',
      onAllow: rejectedAllow,
      onReject: rejectedReject,
    })

    expect(
      processMailboxPermissionResponse({
        requestId: 'reject-request',
        decision: 'rejected',
        feedback: 'needs narrower access',
      }),
    ).toBe(true)
    expect(rejectedAllow).not.toHaveBeenCalled()
    expect(rejectedReject).toHaveBeenCalledWith('needs narrower access')
    expect(hasPermissionCallback('reject-request')).toBe(false)

    const emptyUpdatesAllow = vi.fn()
    registerPermissionCallback({
      requestId: 'empty-updates-request',
      toolUseId: 'tool-use-4',
      onAllow: emptyUpdatesAllow,
      onReject: vi.fn(),
    })
    expect(
      processMailboxPermissionResponse({
        requestId: 'empty-updates-request',
        decision: 'approved',
        permissionUpdates: 'not-an-array',
      }),
    ).toBe(true)
    expect(emptyUpdatesAllow).toHaveBeenCalledWith(undefined, [])

    expect(
      processSandboxPermissionResponse({
        requestId: 'missing-sandbox',
        host: 'example.test',
        allow: true,
      }),
    ).toBe(false)

    const resolveSandbox = vi.fn()
    registerSandboxPermissionCallback({
      requestId: 'sandbox-request',
      host: 'example.test',
      resolve: resolveSandbox,
    })
    expect(hasSandboxPermissionCallback('sandbox-request')).toBe(true)
    expect(
      processSandboxPermissionResponse({
        requestId: 'sandbox-request',
        host: 'example.test',
        allow: false,
      }),
    ).toBe(true)
    expect(resolveSandbox).toHaveBeenCalledWith(false)
    expect(hasSandboxPermissionCallback('sandbox-request')).toBe(false)
    expect(
      processSandboxPermissionResponse({
        requestId: 'sandbox-request',
        host: 'example.test',
        allow: true,
      }),
    ).toBe(false)

    registerPermissionCallback({
      requestId: 'clear-permission',
      toolUseId: 'tool-use-5',
      onAllow: vi.fn(),
      onReject: vi.fn(),
    })
    registerSandboxPermissionCallback({
      requestId: 'clear-sandbox',
      host: 'example.test',
      resolve: vi.fn(),
    })
    clearAllPendingCallbacks()
    expect(hasPermissionCallback('clear-permission')).toBe(false)
    expect(hasSandboxPermissionCallback('clear-sandbox')).toBe(false)
  })
})
