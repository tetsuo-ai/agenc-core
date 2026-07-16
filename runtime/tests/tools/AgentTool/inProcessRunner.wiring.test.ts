import { describe, expect, it, vi } from 'vitest'

const capture = vi.hoisted(() => ({
  definitions: [] as Array<Record<string, unknown>>,
  abort: undefined as (() => void) | undefined,
}))

vi.mock('../../../src/tools/AgentTool/runAgent.js', () => ({
  runAgent: (params: { agentDefinition: Record<string, unknown> }) =>
    (async function* () {
      capture.definitions.push(params.agentDefinition)
      capture.abort?.()
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

describe('in-process teammate production runner policy wiring', () => {
  it('passes the selected restrictive definition into runAgent', async () => {
    const abortController = new AbortController()
    capture.definitions.length = 0
    capture.abort = () => abortController.abort('captured')
    const taskId = 'task-restrictive-runner'
    let appState = {
      tasks: {
        [taskId]: {
          type: 'in_process_teammate',
          status: 'running',
          permissionMode: 'plan',
          messages: [],
          pendingUserMessages: [],
          isIdle: false,
          shutdownRequested: false,
          lastReportedToolCount: 0,
          lastReportedTokenCount: 0,
        },
      },
    }
    const setAppState = (updater: (state: typeof appState) => typeof appState) => {
      appState = updater(appState)
    }
    const { runInProcessTeammate } = await import(
      '../../../src/utils/swarm/inProcessRunner.js'
    )

    const result = await runInProcessTeammate({
      identity: {
        agentId: 'scanner@team',
        agentName: 'scanner',
        teamName: 'team',
        planModeRequired: false,
        parentSessionId: 'parent-session',
      },
      taskId,
      prompt: 'Inspect only.',
      agentDefinition: {
        agentType: 'readonly-scanner',
        whenToUse: 'Read-only scanner',
        source: 'built-in',
        baseDir: 'built-in',
        tools: ['Read'],
        disallowedTools: ['Write'],
        permissionMode: 'plan',
        getSystemPrompt: () => 'Never mutate files.',
      },
      teammateContext: {
        agentId: 'scanner@team',
        agentName: 'scanner',
        teamName: 'team',
        planModeRequired: false,
        parentSessionId: 'parent-session',
        isInProcess: true,
        abortController,
      },
      toolUseContext: {
        abortController,
        options: {
          tools: [],
          mainLoopModel: 'test-model',
          mcpClients: [],
        },
        getAppState: () => appState,
        setAppState,
      } as never,
      abortController,
      systemPrompt: 'Teammate system prompt.',
      systemPromptMode: 'replace',
    })

    expect(result.success).toBe(true)
    expect(capture.definitions).toHaveLength(1)
    expect(capture.definitions[0]).toMatchObject({
      agentType: 'readonly-scanner',
      source: 'built-in',
      tools: expect.arrayContaining(['Read']),
      disallowedTools: ['Write'],
      permissionMode: 'plan',
    })
    expect(capture.definitions[0]?.tools).not.toContain('*')
  })
})
