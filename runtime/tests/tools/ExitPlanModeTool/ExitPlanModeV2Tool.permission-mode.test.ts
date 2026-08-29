import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createEmptyToolPermissionContext } from '../../../src/permissions/types.js'
import { ExitPlanModeV2Tool } from '../../../src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import type { ToolUseContext } from '../../../src/tools/Tool.js'

const attachmentState = vi.hoisted(() => ({
  setHasExitedPlanMode: vi.fn(),
  setNeedsAutoModeExitAttachment: vi.fn(),
  setNeedsPlanModeExitAttachment: vi.fn(),
}))

vi.mock('../../../src/bootstrap/state.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/bootstrap/state.js')>()
  return {
    ...actual,
    getAllowedChannels: () => [],
    setHasExitedPlanMode: attachmentState.setHasExitedPlanMode,
    setNeedsAutoModeExitAttachment:
      attachmentState.setNeedsAutoModeExitAttachment,
    setNeedsPlanModeExitAttachment:
      attachmentState.setNeedsPlanModeExitAttachment,
  }
})

vi.mock('../../../src/utils/plans.js', () => ({
  getPlan: () => '# Plan\n\nMake the change.',
  getPlanFilePath: () => '/tmp/agenc-plan.md',
  persistFileSnapshotIfRemote: vi.fn(),
}))

describe('ExitPlanModeV2Tool permission restore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('refuses an unbound bypass restore and keeps plan mode active', async () => {
    const harness = createHarness({
      acceptedIn: [],
      prePlanMode: 'bypassPermissions',
    })

    await expect(callExitPlanMode(harness.context)).rejects.toThrow(
      /exact cwd consent/u,
    )

    expect(harness.state().toolPermissionContext.mode).toBe('plan')
    expect(harness.notifications).toEqual([
      expect.objectContaining({
        key: 'bypass-consent-required-plan-restore',
        color: 'warning',
      }),
    ])
    expect(attachmentState.setHasExitedPlanMode).not.toHaveBeenCalled()
    expect(
      attachmentState.setNeedsPlanModeExitAttachment,
    ).not.toHaveBeenCalled()
  })

  test('surfaces refusal before a deferred state updater can run', async () => {
    const harness = createHarness({
      acceptedIn: [],
      prePlanMode: 'bypassPermissions',
    })
    const queuedSetAppState = vi.fn()
    harness.context.setAppState = queuedSetAppState

    await expect(callExitPlanMode(harness.context)).rejects.toThrow(
      /exact cwd consent/u,
    )

    expect(queuedSetAppState).not.toHaveBeenCalled()
    expect(harness.state().toolPermissionContext.mode).toBe('plan')
    expect(harness.notifications).toHaveLength(1)
  })

  test('restores a bypass mode already bound to the exact cwd', async () => {
    const harness = createHarness({
      acceptedIn: [process.cwd()],
      prePlanMode: 'bypassPermissions',
    })

    await expect(callExitPlanMode(harness.context)).resolves.toMatchObject({
      data: {
        plan: '# Plan\n\nMake the change.',
      },
    })

    expect(harness.state().toolPermissionContext).toMatchObject({
      mode: 'bypassPermissions',
      bypassPermissionsAcceptedIn: [process.cwd()],
    })
    expect(harness.state().toolPermissionContext.prePlanMode).toBeUndefined()
    expect(attachmentState.setHasExitedPlanMode).toHaveBeenCalledWith(true)
    expect(
      attachmentState.setNeedsPlanModeExitAttachment,
    ).toHaveBeenCalledWith(true)
  })

  test('awaits a deferred state updater before reporting plan exit success', async () => {
    const harness = createHarness({
      acceptedIn: [process.cwd()],
      prePlanMode: 'bypassPermissions',
    })
    const applyState = harness.context.setAppState
    const queuedUpdates: Array<Parameters<typeof applyState>[0]> = []
    harness.context.setAppState = update => {
      queuedUpdates.push(update)
    }

    const result = callExitPlanMode(harness.context)
    await vi.waitFor(() => expect(queuedUpdates).toHaveLength(1))
    expect(attachmentState.setHasExitedPlanMode).not.toHaveBeenCalled()
    applyState(queuedUpdates.shift()!)

    await expect(result).resolves.toMatchObject({
      data: {
        plan: '# Plan\n\nMake the change.',
      },
    })
    expect(harness.state().toolPermissionContext.mode).toBe(
      'bypassPermissions',
    )
    expect(attachmentState.setHasExitedPlanMode).toHaveBeenCalledOnce()
  })

  test('retries when a concurrent permission context defeats the first CAS', async () => {
    const harness = createHarness({
      acceptedIn: [process.cwd()],
      prePlanMode: 'bypassPermissions',
    })
    const applyState = harness.context.setAppState
    let casAttempts = 0
    harness.context.setAppState = update => {
      casAttempts += 1
      if (casAttempts === 1) {
        applyState(prev => ({
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
          },
        }))
      }
      applyState(update)
    }

    await expect(callExitPlanMode(harness.context)).resolves.toMatchObject({
      data: {
        plan: '# Plan\n\nMake the change.',
      },
    })

    expect(casAttempts).toBe(2)
    expect(harness.state().toolPermissionContext.mode).toBe(
      'bypassPermissions',
    )
    expect(attachmentState.setHasExitedPlanMode).toHaveBeenCalledOnce()
  })

  test('refuses after repeated CAS conflicts leave plan mode active', async () => {
    const harness = createHarness({
      acceptedIn: [process.cwd()],
      prePlanMode: 'bypassPermissions',
    })
    const applyState = harness.context.setAppState
    let casAttempts = 0
    harness.context.setAppState = update => {
      casAttempts += 1
      applyState(prev => ({
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
        },
      }))
      applyState(update)
    }

    await expect(callExitPlanMode(harness.context)).rejects.toThrow(
      /permission state changed concurrently/u,
    )

    expect(casAttempts).toBe(3)
    expect(harness.state().toolPermissionContext.mode).toBe('plan')
    expect(harness.notifications).toEqual([
      expect.objectContaining({
        key: 'plan-exit-permission-state-conflict',
        color: 'warning',
      }),
    ])
    expect(attachmentState.setHasExitedPlanMode).not.toHaveBeenCalled()
    expect(
      attachmentState.setNeedsPlanModeExitAttachment,
    ).not.toHaveBeenCalled()
  })
})

function createHarness(args: {
  readonly acceptedIn: readonly string[]
  readonly prePlanMode: 'bypassPermissions'
}): {
  readonly context: ToolUseContext
  readonly notifications: Array<Record<string, unknown>>
  readonly state: () => {
    readonly toolPermissionContext: ReturnType<
      typeof createEmptyToolPermissionContext
    >
  }
} {
  let appState = {
    toolPermissionContext: createEmptyToolPermissionContext({
      mode: 'plan',
      prePlanMode: args.prePlanMode,
      isBypassPermissionsModeAvailable: true,
      bypassPermissionsAcceptedIn: [...args.acceptedIn],
    }),
  }
  const notifications: Array<Record<string, unknown>> = []
  const context = {
    options: { tools: [] },
    getAppState: () => appState,
    setAppState: (
      update: (prev: typeof appState) => typeof appState,
    ) => {
      appState = update(appState)
    },
    addNotification: (notification: Record<string, unknown>) => {
      notifications.push(notification)
    },
  } as unknown as ToolUseContext
  return {
    context,
    notifications,
    state: () => appState,
  }
}

async function callExitPlanMode(context: ToolUseContext): Promise<unknown> {
  return ExitPlanModeV2Tool.call(
    {},
    context,
    async () => ({ behavior: 'allow' }),
    {} as never,
  )
}
