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
  logPermissionDecision: vi.fn(),
  persistPermissionUpdates: vi.fn(),
  supportsPersistence: vi.fn((destination: string) => destination === 'project'),
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => harness.features.has(name),
}))

vi.mock('../../../tools/BashTool/bashPermissions.js', () => ({
  awaitClassifierAutoApproval: harness.awaitClassifierAutoApproval,
}))

vi.mock('../../../tools/BashTool/toolName.js', () => ({
  BASH_TOOL_NAME: 'Bash',
}))

vi.mock('../../../utils/classifierApprovals.js', () => ({
  setClassifierApproval: (toolUseID: string, rule: string) => {
    harness.classifierApprovals.push([toolUseID, rule])
  },
}))

vi.mock('src/utils/debug.js', () => ({
  logForDebugging: harness.debug,
}))

vi.mock('../../../utils/hooks.js', () => ({
  executePermissionRequestHooks: async function* () {
    for (const result of harness.hookResults) {
      yield result
    }
  },
}))

vi.mock('../../../utils/messages.js', () => ({
  REJECT_MESSAGE: 'Rejected',
  REJECT_MESSAGE_WITH_REASON_PREFIX: 'Rejected: ',
  SUBAGENT_REJECT_MESSAGE: 'Subagent rejected',
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX: 'Subagent rejected: ',
  withMemoryCorrectionHint: (message: string) => `${message} [memory hint]`,
}))

vi.mock('../../../utils/permissions/PermissionUpdate.js', () => ({
  applyPermissionUpdates: harness.applyPermissionUpdates,
  persistPermissionUpdates: harness.persistPermissionUpdates,
  supportsPersistence: harness.supportsPersistence,
}))

vi.mock('./permissionLogging.js', () => ({
  logPermissionDecision: harness.logPermissionDecision,
}))

import {
  createPermissionContext,
  createPermissionQueueOps,
  createResolveOnce,
} from './PermissionContext.js'

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

function assistantMessage(id = 'message-1') {
  return {
    message: { id },
  }
}

function toolUseContext(
  overrides: Partial<{
    agentId: string
    abortController: AbortController
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
    assistantMessage() as never,
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
  harness.logPermissionDecision.mockReset()
  harness.persistPermissionUpdates.mockReset()
  harness.supportsPersistence.mockClear()
})

describe('PermissionContext primitives', () => {
  test('resolve-once resolves or claims at most one winner', () => {
    const resolve = vi.fn()
    const once = createResolveOnce(resolve)

    expect(once.isResolved()).toBe(false)
    expect(once.claim()).toBe(true)
    expect(once.claim()).toBe(false)
    expect(once.isResolved()).toBe(true)

    once.resolve('late')
    once.resolve('later')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith('late')

    const resolveFirst = vi.fn()
    const alreadyResolved = createResolveOnce(resolveFirst)
    alreadyResolved.resolve('first')
    expect(alreadyResolved.claim()).toBe(false)
    alreadyResolved.resolve('second')
    expect(resolveFirst).toHaveBeenCalledTimes(1)
    expect(resolveFirst).toHaveBeenCalledWith('first')
  })

  test('queue ops push, remove, and patch matching permission items', () => {
    let queue: Array<Record<string, unknown>> = []
    const setQueue = vi.fn(updater => {
      queue = typeof updater === 'function' ? updater(queue) : updater
    })
    const ops = createPermissionQueueOps(setQueue as never)

    ops.push({ toolUseID: 'a', title: 'A' } as never)
    ops.push({ toolUseID: 'b', title: 'B' } as never)
    ops.update('a', { title: 'A2' } as never)
    ops.remove('b')

    expect(queue).toEqual([{ toolUseID: 'a', title: 'A2' }])
    expect(setQueue).toHaveBeenCalledTimes(4)
  })

  test('persists permission updates and logs user allows with modified input', async () => {
    const setToolPermissionContext = vi.fn()
    const ctx = context({ setToolPermissionContext })

    await expect(ctx.persistPermissions([])).resolves.toBe(false)
    expect(harness.persistPermissionUpdates).not.toHaveBeenCalled()

    const decision = await ctx.handleUserAllow(
      { path: 'b.ts' },
      [{ destination: 'project' }],
      '  looks good  ',
      123,
      [{ type: 'text', text: 'extra block' }] as never,
      { type: 'user' } as never,
    )

    expect(harness.persistPermissionUpdates).toHaveBeenCalledWith([
      { destination: 'project' },
    ])
    expect(setToolPermissionContext).toHaveBeenCalledWith({
      mode: 'default',
      updates: [{ destination: 'project' }],
    })
    expect(harness.logPermissionDecision).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'message-1', toolUseID: 'tool-use-1' }),
      { decision: 'accept', source: { type: 'user', permanent: true } },
      123,
    )
    expect(decision).toMatchObject({
      behavior: 'allow',
      updatedInput: { path: 'b.ts' },
      userModified: true,
      acceptFeedback: 'looks good',
      contentBlocks: [{ type: 'text', text: 'extra block' }],
      decisionReason: { type: 'user' },
    })
  })

  test('cancels main-agent and subagent requests with the expected rejection messages', () => {
    const mainContext = toolUseContext()
    const main = context({ toolUseContext: mainContext })

    expect(main.cancelAndAbort()).toEqual({
      behavior: 'ask',
      message: 'Rejected [memory hint]',
      contentBlocks: undefined,
    })
    expect(mainContext.abortController.signal.aborted).toBe(true)
    expect(harness.debug).toHaveBeenCalledWith(
      expect.stringContaining('Aborting: tool=Read'),
    )

    const subagentContext = toolUseContext({ agentId: 'agent-1' })
    const subagent = context({ toolUseContext: subagentContext })
    expect(subagent.cancelAndAbort('needs changes')).toEqual({
      behavior: 'ask',
      message: 'Subagent rejected: needs changes',
      contentBlocks: undefined,
    })
    expect(subagentContext.abortController.signal.aborted).toBe(false)
  })

  test('resolves aborted requests with the abort decision and leaves active requests pending', () => {
    const abortController = new AbortController()
    abortController.abort()
    const ctx = context({ toolUseContext: toolUseContext({ abortController }) })
    const resolve = vi.fn()

    expect(ctx.resolveIfAborted(resolve)).toBe(true)

    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: 'ask',
        message: 'Rejected [memory hint]',
      }),
    )

    const active = context()
    expect(active.resolveIfAborted(vi.fn())).toBe(false)
  })

  test('runs permission hooks for allow, deny, interrupt, and empty results', async () => {
    const allow = context()
    harness.hookResults = [
      {
        permissionRequestResult: {
          behavior: 'allow',
          updatedInput: { path: 'hook.ts' },
          updatedPermissions: [{ destination: 'session' }],
        },
      },
    ]

    await expect(
      allow.runHooks('default', [{ destination: 'suggestion' }], undefined, 50),
    ).resolves.toMatchObject({
      behavior: 'allow',
      decisionReason: { type: 'hook', hookName: 'PermissionRequest' },
      updatedInput: { path: 'hook.ts' },
      userModified: false,
    })
    expect(harness.logPermissionDecision).toHaveBeenCalledWith(
      expect.anything(),
      { decision: 'accept', source: { type: 'hook', permanent: false } },
      50,
    )

    const abortController = new AbortController()
    const deny = context({ toolUseContext: toolUseContext({ abortController }) })
    harness.hookResults = [
      {
        permissionRequestResult: {
          behavior: 'deny',
          interrupt: true,
          message: 'blocked by hook',
        },
      },
    ]

    await expect(deny.runHooks('default', undefined)).resolves.toEqual({
      behavior: 'deny',
      message: 'blocked by hook',
      decisionReason: {
        type: 'hook',
        hookName: 'PermissionRequest',
        reason: 'blocked by hook',
      },
    })
    expect(abortController.signal.aborted).toBe(true)
    expect(harness.debug).toHaveBeenCalledWith(
      expect.stringContaining('Hook interrupt: tool=Read'),
    )

    harness.hookResults = [{}]
    await expect(context().runHooks(undefined, undefined)).resolves.toBeNull()
  })

  test('auto-approves bash commands through classifier decisions', async () => {
    harness.features.add('BASH_CLASSIFIER')
    harness.features.add('TRANSCRIPT_CLASSIFIER')
    harness.awaitClassifierAutoApproval.mockResolvedValue({
      type: 'classifier',
      reason: 'Allowed by prompt rule: "npm test"',
    })
    const ctx = context({
      tool: tool({ name: 'Bash' }),
      input: { command: 'npm test' },
      toolUseContext: toolUseContext({ isNonInteractiveSession: true }),
      toolUseID: 'tool-use-classifier',
    })

    await expect(
      ctx.tryClassifier?.({ id: 'pending' } as never, { command: 'npm test -- --run' }),
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm test -- --run' },
      userModified: false,
      decisionReason: {
        type: 'classifier',
        reason: 'Allowed by prompt rule: "npm test"',
      },
    })
    expect(harness.awaitClassifierAutoApproval).toHaveBeenCalledWith(
      { id: 'pending' },
      expect.any(AbortSignal),
      true,
    )
    expect(harness.classifierApprovals).toEqual([
      ['tool-use-classifier', 'npm test'],
    ])
    expect(harness.logPermissionDecision).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseID: 'tool-use-classifier' }),
      { decision: 'accept', source: { type: 'classifier' } },
      undefined,
    )

    await expect(
      context({ tool: tool({ name: 'Read' }) }).tryClassifier?.(
        { id: 'pending' } as never,
        undefined,
      ),
    ).resolves.toBeNull()
  })
})
