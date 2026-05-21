import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  applyPermissionUpdates: vi.fn(),
  awaitClassifierAutoApproval: vi.fn(),
  classifierApprovals: [] as Array<[string, string]>,
  debug: vi.fn(),
  features: new Set<string>(),
  hookResults: [] as Array<{
    permissionRequestResult?: {
      behavior: 'allow' | 'deny'
      interrupt?: boolean
      message?: string
      updatedInput?: Record<string, unknown>
      updatedPermissions?: Array<{ destination: string }>
    }
  }>,
  logEvent: vi.fn(),
  logPermissionDecision: vi.fn(),
  persistPermissionUpdates: vi.fn(),
  sanitizeToolNameForAnalytics: vi.fn((toolName: string) => `safe:${toolName}`),
  supportsPersistence: vi.fn((destination: string) => destination === 'project'),
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => harness.features.has(name),
}))

vi.mock('../../../src/services/analytics/index.js', () => ({
  logEvent: harness.logEvent,
}))

vi.mock('../../../src/services/analytics/metadata.js', () => ({
  sanitizeToolNameForAnalytics: harness.sanitizeToolNameForAnalytics,
}))

vi.mock('../../../src/tools/BashTool/bashPermissions.js', () => ({
  awaitClassifierAutoApproval: harness.awaitClassifierAutoApproval,
}))

vi.mock('../../../src/tools/BashTool/toolName.js', () => ({
  BASH_TOOL_NAME: 'Bash',
}))

vi.mock('../../../src/utils/classifierApprovals.js', () => ({
  setClassifierApproval: (toolUseID: string, rule: string) => {
    harness.classifierApprovals.push([toolUseID, rule])
  },
}))

vi.mock('src/utils/debug.js', () => ({
  logForDebugging: harness.debug,
}))

vi.mock('../../../src/utils/hooks.js', () => ({
  executePermissionRequestHooks: async function* () {
    for (const result of harness.hookResults) {
      yield result
    }
  },
}))

vi.mock('../../../src/utils/messages.js', () => ({
  REJECT_MESSAGE: 'Rejected',
  REJECT_MESSAGE_WITH_REASON_PREFIX: 'Rejected: ',
  SUBAGENT_REJECT_MESSAGE: 'Subagent rejected',
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX: 'Subagent rejected: ',
  withMemoryCorrectionHint: (message: string) => `${message} [memory hint]`,
}))

vi.mock('../../../src/utils/permissions/PermissionUpdate.js', () => ({
  applyPermissionUpdates: harness.applyPermissionUpdates,
  persistPermissionUpdates: harness.persistPermissionUpdates,
  supportsPersistence: harness.supportsPersistence,
}))

vi.mock('../../../src/tui/hooks/toolPermission/permissionLogging.js', () => ({
  logPermissionDecision: harness.logPermissionDecision,
}))

import {
  createPermissionContext,
  createPermissionQueueOps,
} from '../../../src/tui/hooks/toolPermission/PermissionContext.js'

type TestTool = {
  name: string
  inputsEquivalent?: (
    previous: Record<string, unknown>,
    next: Record<string, unknown>,
  ) => boolean
}

function tool(overrides: Partial<TestTool> = {}): TestTool {
  return {
    name: 'Read',
    inputsEquivalent: (previous, next) => previous.path === next.path,
    ...overrides,
  }
}

function toolUseContext(
  overrides: Partial<{
    abortController: AbortController
    agentId: string
    isNonInteractiveSession: boolean
    toolPermissionContext: Record<string, unknown>
  }> = {},
) {
  const abortController = overrides.abortController ?? new AbortController()
  const toolPermissionContext =
    overrides.toolPermissionContext ?? ({ mode: 'default' } as const)

  return {
    abortController,
    agentId: overrides.agentId,
    getAppState: () => ({ toolPermissionContext }),
    options: {
      isNonInteractiveSession: overrides.isNonInteractiveSession ?? false,
    },
  }
}

function context(
  overrides: Partial<{
    input: Record<string, unknown>
    setToolPermissionContext: ReturnType<typeof vi.fn>
    tool: TestTool
    toolUseContext: ReturnType<typeof toolUseContext>
    toolUseID: string
  }> = {},
) {
  return createPermissionContext(
    (overrides.tool ?? tool()) as never,
    overrides.input ?? { path: 'a.ts' },
    (overrides.toolUseContext ?? toolUseContext()) as never,
    { message: { id: 'message-1' } } as never,
    overrides.toolUseID ?? 'tool-use-1',
    overrides.setToolPermissionContext ?? vi.fn(),
  )
}

beforeEach(() => {
  harness.applyPermissionUpdates.mockReset()
  harness.applyPermissionUpdates.mockImplementation((current, updates) => ({
    ...current,
    updates,
  }))
  harness.awaitClassifierAutoApproval.mockReset()
  harness.classifierApprovals = []
  harness.debug.mockReset()
  harness.features = new Set()
  harness.hookResults = []
  harness.logEvent.mockReset()
  harness.logPermissionDecision.mockReset()
  harness.persistPermissionUpdates.mockReset()
  harness.sanitizeToolNameForAnalytics.mockClear()
  harness.supportsPersistence.mockClear()
})

describe('PermissionContext coverage swarm row 129', () => {
  test('omits optional allow fields when feedback and content blocks are empty', async () => {
    const setToolPermissionContext = vi.fn()
    const ctx = context({
      setToolPermissionContext,
      tool: { name: 'Write' },
    })

    await expect(
      ctx.handleUserAllow({ path: 'a.ts' }, [], '   ', 25, []),
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { path: 'a.ts' },
      userModified: false,
    })

    expect(harness.persistPermissionUpdates).not.toHaveBeenCalled()
    expect(setToolPermissionContext).not.toHaveBeenCalled()
    expect(harness.logPermissionDecision).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseID: 'tool-use-1' }),
      { decision: 'accept', source: { type: 'user', permanent: false } },
      25,
    )
  })

  test('keeps rejection paths non-aborting unless the abort flag is explicit', () => {
    const activeContext = toolUseContext()
    const active = context({ toolUseContext: activeContext })
    const block = [{ type: 'text', text: 'diagnostic block' }]

    expect(active.cancelAndAbort('needs review')).toEqual({
      behavior: 'ask',
      message: 'Rejected: needs review [memory hint]',
      contentBlocks: undefined,
    })
    expect(activeContext.abortController.signal.aborted).toBe(false)

    expect(active.cancelAndAbort(undefined, false, block as never)).toEqual({
      behavior: 'ask',
      message: 'Rejected [memory hint]',
      contentBlocks: block,
    })
    expect(activeContext.abortController.signal.aborted).toBe(false)

    const forcedContext = toolUseContext()
    const forced = context({ toolUseContext: forcedContext })

    expect(forced.cancelAndAbort('stop now', true)).toEqual({
      behavior: 'ask',
      message: 'Rejected: stop now [memory hint]',
      contentBlocks: undefined,
    })
    expect(forcedContext.abortController.signal.aborted).toBe(true)
    expect(harness.debug).toHaveBeenCalledWith(
      expect.stringContaining('isAbort=true'),
    )
  })

  test('uses hook allow and deny fallback values', async () => {
    const setToolPermissionContext = vi.fn()
    harness.hookResults = [
      {
        permissionRequestResult: {
          behavior: 'allow',
          updatedPermissions: [{ destination: 'project' }],
        },
      },
    ]

    await expect(
      context({ setToolPermissionContext }).runHooks(
        'plan',
        undefined,
        { path: 'suggested.ts' },
        100,
      ),
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { path: 'suggested.ts' },
      userModified: false,
      decisionReason: { type: 'hook', hookName: 'PermissionRequest' },
    })
    expect(setToolPermissionContext).toHaveBeenCalledWith({
      mode: 'default',
      updates: [{ destination: 'project' }],
    })
    expect(harness.logPermissionDecision).toHaveBeenCalledWith(
      expect.anything(),
      { decision: 'accept', source: { type: 'hook', permanent: true } },
      100,
    )

    harness.hookResults = [
      {
        permissionRequestResult: {
          behavior: 'deny',
        },
      },
    ]

    await expect(context().runHooks(undefined, undefined)).resolves.toEqual({
      behavior: 'deny',
      message: 'Permission denied by hook',
      decisionReason: {
        type: 'hook',
        hookName: 'PermissionRequest',
        reason: undefined,
      },
    })
    expect(harness.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('Hook interrupt'),
    )
  })

  test('covers classifier fallback outcomes and queue misses', async () => {
    harness.features.add('BASH_CLASSIFIER')
    const classifier = context({
      input: { command: 'npm test' },
      tool: tool({ name: 'Bash' }),
      toolUseContext: toolUseContext({ isNonInteractiveSession: true }),
    })

    await expect(classifier.tryClassifier?.(undefined, undefined)).resolves.toBeNull()
    expect(harness.awaitClassifierAutoApproval).not.toHaveBeenCalled()

    harness.awaitClassifierAutoApproval.mockResolvedValueOnce(null)
    await expect(
      classifier.tryClassifier?.({ id: 'pending' } as never, undefined),
    ).resolves.toBeNull()

    harness.features.add('TRANSCRIPT_CLASSIFIER')
    harness.awaitClassifierAutoApproval.mockResolvedValueOnce({
      type: 'classifier',
      reason: 'Allowed without stored prompt rule',
    })
    await expect(
      classifier.tryClassifier?.({ id: 'pending-2' } as never, undefined),
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
      userModified: false,
      decisionReason: {
        type: 'classifier',
        reason: 'Allowed without stored prompt rule',
      },
    })
    expect(harness.classifierApprovals).toEqual([])

    let queue: Array<Record<string, unknown>> = [{ toolUseID: 'kept', title: 'Kept' }]
    const setQueue = vi.fn(updater => {
      queue = typeof updater === 'function' ? updater(queue) : updater
    })
    const ops = createPermissionQueueOps(setQueue as never)

    ops.update('missing', { title: 'Ignored' } as never)
    ops.remove('missing')

    expect(queue).toEqual([{ toolUseID: 'kept', title: 'Kept' }])
    expect(setQueue).toHaveBeenCalledTimes(2)
  })
})
