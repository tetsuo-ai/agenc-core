import { afterEach, describe, expect, it, vi } from 'vitest'

const capture = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  closeIds: [] as string[],
  rolloutStores: [] as Array<{ sessionId: string; [key: string]: unknown }>,
  failNextRun: false,
  lifecycleAbort: undefined as AbortController | undefined,
}))

vi.mock('../../../src/session/rollout-store.js', async importOriginal => {
  const actual = await importOriginal<
    typeof import('../../../src/session/rollout-store.js')
  >()
  class TrackingRolloutStore extends actual.RolloutStore {
    constructor(options: ConstructorParameters<typeof actual.RolloutStore>[0]) {
      super(options)
      capture.rolloutStores.push(this as never)
    }

    override close(): void {
      capture.closeIds.push(this.sessionId)
      super.close()
    }
  }
  return { ...actual, RolloutStore: TrackingRolloutStore }
})

vi.mock('../../../src/tools/AgentTool/runAgent.js', () => ({
  runAgent: (params: Record<string, unknown>) =>
    (async function* () {
      capture.calls.push(params)
      if (capture.failNextRun) {
        capture.failNextRun = false
        throw new Error('teammate provider failed')
      }

      if (capture.calls.length === 1) {
        yield {
          type: 'assistant',
          message: {
            id: 'teammate-response-1',
            role: 'assistant',
            model: 'grok-4.5',
            content: [
              {
                type: 'tool_use',
                id: 'teammate-tool-1',
                name: 'FileRead',
                input: { file_path: 'large.txt' },
              },
            ],
            usage: { input_tokens: 8, output_tokens: 8 },
          },
        }
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'teammate-tool-1',
                content: 'tool-output-'.repeat(2_000),
              },
            ],
          },
        }
        return
      }

      yield {
        type: 'assistant',
        message: {
          id: 'teammate-response-2',
          role: 'assistant',
          model: 'grok-4.5',
          content: [{ type: 'text', text: 'continued after compaction' }],
          usage: { input_tokens: 8, output_tokens: 8 },
        },
      }
      await Promise.resolve()
      capture.lifecycleAbort?.abort('test complete')
    })(),
}))

vi.mock('../../../src/utils/tasks.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/utils/tasks.js')>()),
  listTasks: vi.fn(async () => []),
  claimTask: vi.fn(async () => ({ success: false })),
  updateTask: vi.fn(async () => undefined),
}))

vi.mock('../../../src/utils/task/diskOutput.js', () => ({
  evictTaskOutput: vi.fn(async () => undefined),
}))

vi.mock('../../../src/utils/task/framework.js', () => ({
  evictTerminalTask: vi.fn(),
}))

vi.mock('../../../src/utils/sdkEventQueue.js', () => ({
  emitTaskTerminatedSdk: vi.fn(),
}))

vi.mock('../../../src/utils/teammateMailbox.js', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../../src/utils/teammateMailbox.js')
  >()),
  readMailbox: vi.fn(async () => []),
  writeToMailbox: vi.fn(async () => undefined),
  markMessageAsReadByIndex: vi.fn(async () => undefined),
}))

afterEach(() => {
  capture.calls.length = 0
  capture.closeIds.length = 0
  capture.rolloutStores.length = 0
  capture.failNextRun = false
  capture.lifecycleAbort = undefined
  delete process.env.AGENC_AUTO_COMPACT_WINDOW
})

function createAppState(taskId: string, pendingUserMessages: string[]) {
  return {
    tasks: {
      [taskId]: {
        type: 'in_process_teammate' as const,
        status: 'running' as const,
        permissionMode: 'default' as const,
        messages: [],
        pendingUserMessages,
        isIdle: false,
        shutdownRequested: false,
        lastReportedToolCount: 0,
        lastReportedTokenCount: 0,
      },
    },
  }
}

function teammateIdentity() {
  return {
    agentId: 'compactor@team',
    agentName: 'compactor',
    teamName: 'team',
    planModeRequired: false,
    parentSessionId: 'parent-session',
  }
}

describe('in-process teammate canonical rollout ownership', () => {
  it('compacts its isolated rollout, continues, and reopens without parent history leakage', async () => {
    process.env.AGENC_AUTO_COMPACT_WINDOW = '32'
    const { createCompactionTransactionHarness } = await import(
      '../../helpers/compaction-transaction-harness.js'
    )
    const { runWithCurrentRuntimeSession } = await import(
      '../../../src/session/current-session.js'
    )
    const { RolloutStore } = await import(
      '../../../src/session/rollout-store.js'
    )
    const { runInProcessTeammate } = await import(
      '../../../src/utils/swarm/inProcessRunner.js'
    )
    const harness = createCompactionTransactionHarness([
      {
        role: 'user',
        originalRole: 'user',
        content: 'parent-only-history',
        message: { role: 'user', content: 'parent-only-history' },
      },
    ])
    const parent = harness.session
    const parentCwd = harness.store.store.cwd
    const rootAdmission = parent.services.executionAdmission
    if (rootAdmission === undefined) {
      throw new Error('missing parent execution admission')
    }
    const parentAdmission = rootAdmission.forSession({
      runId: 'parent-run-distinct-from-session',
      sessionId: parent.conversationId,
      parentRunId: rootAdmission.scope.runId,
      parentScopeId: rootAdmission.scope.sessionId,
    })
    Object.assign(parent.services, { executionAdmission: parentAdmission })
    Object.assign(parent, {
      sessionConfiguration: { cwd: parentCwd },
      config: { cwd: parentCwd },
    })
    const parentJournalBefore = structuredClone(harness.store.readAll())

    const abortController = new AbortController()
    capture.lifecycleAbort = abortController
    const taskId = 'teammate-compaction'
    let appState = createAppState(taskId, ['continue with the next prompt'])
    const setAppState = (updater: (state: typeof appState) => typeof appState) => {
      appState = updater(appState)
    }

    let reopened: InstanceType<typeof RolloutStore> | undefined
    try {
      const result = await runWithCurrentRuntimeSession(parent, () =>
        runInProcessTeammate({
          identity: teammateIdentity(),
          taskId,
          prompt: 'Read the large file.',
          teammateContext: {
            ...teammateIdentity(),
            isInProcess: true,
            abortController,
          },
          toolUseContext: {
            abortController,
            options: {
              tools: [],
              mainLoopModel: 'grok-4.5',
              mcpClients: [],
            },
            getAppState: () => appState,
            setAppState,
          } as never,
          abortController,
          model: 'grok-4.5',
          systemPrompt: 'Use tools carefully.',
          systemPromptMode: 'replace',
        }),
      )

      expect(result).toEqual(expect.objectContaining({ success: true }))
      expect(capture.calls).toHaveLength(2)
      expect(capture.calls[1]?.forkContextMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ isCompactSummary: true }),
        ]),
      )
      expect(result.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({ text: 'continued after compaction' }),
              ]),
            }),
          }),
        ]),
      )

      const teammateStore = capture.rolloutStores.find(store =>
        store.sessionId.startsWith('teammate-compactor-'),
      ) as InstanceType<typeof RolloutStore> | undefined
      expect(teammateStore).toBeDefined()
      if (teammateStore === undefined) throw new Error('missing teammate store')
      expect(capture.closeIds).toContain(teammateStore.sessionId)

      const committed = teammateStore.readAll().find(
        item => item.type === 'compaction_committed',
      )
      expect(committed).toBeDefined()
      if (committed?.type !== 'compaction_committed') {
        throw new Error('missing compaction commit')
      }
      expect(committed.payload.summary.body.tool_pairs).toContainEqual(
        expect.objectContaining({ tool_call_id: 'teammate-tool-1' }),
      )

      reopened = new RolloutStore({
        cwd: parentCwd,
        sessionId: teammateStore.sessionId,
        agencVersion: '0.13.0',
        resume: true,
        autoStartScheduler: false,
      })
      expect(() =>
        reopened!.open({
          sessionId: teammateStore.sessionId,
          timestamp: new Date().toISOString(),
          cwd: parentCwd,
          originator: 'agenc-in-process-teammate',
          agencVersion: '0.13.0',
          model: 'grok-4.5',
          modelProvider: 'in-process-teammate',
        }),
      ).not.toThrow()
      expect(
        reopened.readAll().filter(item => item.type === 'compaction_committed'),
      ).toHaveLength(1)

      const parentJournalAfter = harness.store.readAll()
      expect(parentJournalAfter).toEqual(parentJournalBefore)
      expect(JSON.stringify(parentJournalAfter)).not.toContain(
        'teammate-tool-1',
      )
    } finally {
      reopened?.close()
      harness.close()
    }
  })

  it('closes the isolated rollout when teammate execution fails', async () => {
    const { createCompactionTransactionHarness } = await import(
      '../../helpers/compaction-transaction-harness.js'
    )
    const { runWithCurrentRuntimeSession } = await import(
      '../../../src/session/current-session.js'
    )
    const { runInProcessTeammate } = await import(
      '../../../src/utils/swarm/inProcessRunner.js'
    )
    const harness = createCompactionTransactionHarness([])
    const parent = harness.session
    const parentCwd = harness.store.store.cwd
    Object.assign(parent, {
      sessionConfiguration: { cwd: parentCwd },
      config: { cwd: parentCwd },
    })
    const abortController = new AbortController()
    const taskId = 'teammate-failure'
    let appState = createAppState(taskId, [])
    const setAppState = (updater: (state: typeof appState) => typeof appState) => {
      appState = updater(appState)
    }
    capture.failNextRun = true

    try {
      const result = await runWithCurrentRuntimeSession(parent, () =>
        runInProcessTeammate({
          identity: teammateIdentity(),
          taskId,
          prompt: 'Fail this run.',
          teammateContext: {
            ...teammateIdentity(),
            isInProcess: true,
            abortController,
          },
          toolUseContext: {
            abortController,
            options: {
              tools: [],
              mainLoopModel: 'grok-4.5',
              mcpClients: [],
            },
            getAppState: () => appState,
            setAppState,
          } as never,
          abortController,
          model: 'grok-4.5',
          systemPrompt: 'Fail deterministically.',
          systemPromptMode: 'replace',
        }),
      )

      expect(result).toMatchObject({
        success: false,
        error: 'teammate provider failed',
      })
      const teammateStore = capture.rolloutStores.find(store =>
        store.sessionId.startsWith('teammate-compactor-'),
      )
      expect(teammateStore).toBeDefined()
      expect(capture.closeIds).toContain(teammateStore?.sessionId)
    } finally {
      harness.close()
    }
  })
})
