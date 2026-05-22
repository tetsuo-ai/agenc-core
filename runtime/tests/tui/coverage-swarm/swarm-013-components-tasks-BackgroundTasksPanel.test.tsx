import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'

const appStateMock = vi.hoisted(() => ({
  state: { tasks: {} as Record<string, unknown> },
  setAppState: vi.fn(),
}))

const inputHandler = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | ((input: string, key: Record<string, boolean>) => void),
}))

const terminalSizeMock = vi.hoisted(() => ({
  size: { columns: 132, rows: 36 },
}))

const killTaskMock = vi.hoisted(() => vi.fn())
const killAsyncAgentMock = vi.hoisted(() => vi.fn())
const requestTeammateShutdownMock = vi.hoisted(() => vi.fn())
const tailFileMock = vi.hoisted(() => vi.fn())
const getTaskOutputPathMock = vi.hoisted(() =>
  vi.fn((taskId: string) => `/tmp/${taskId}.log`),
)

vi.mock('../state/AppState.js', () => ({
  useAppState: (selector: (state: typeof appStateMock.state) => unknown) =>
    selector(appStateMock.state),
  useSetAppState: () => appStateMock.setAppState,
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => terminalSizeMock.size,
}))

vi.mock('../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../ink.js')>('../ink.js')
  return {
    ...actual,
    useInput: (
      handler: (input: string, key: Record<string, boolean>) => void,
    ) => {
      inputHandler.current = handler
    },
  }
})

vi.mock('../../tasks/LocalShellTask/killShellTasks.js', () => ({
  killTask: killTaskMock,
}))

vi.mock('../../tasks/LocalAgentTask/LocalAgentTask.js', () => ({
  killAsyncAgent: killAsyncAgentMock,
}))

vi.mock('../../tasks/InProcessTeammateTask/InProcessTeammateTask.js', () => ({
  requestTeammateShutdown: requestTeammateShutdownMock,
}))

vi.mock('../../utils/fsOperations.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/fsOperations.js')>()
  return {
    ...actual,
    tailFile: tailFileMock,
  }
})

vi.mock('../../utils/task/diskOutput.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/task/diskOutput.js')>()
  return {
    ...actual,
    getTaskOutputPath: getTaskOutputPathMock,
  }
})

function key(overrides: Record<string, boolean> = {}) {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    return: false,
    escape: false,
    ...overrides,
  }
}

function makeShellTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'shell-task',
    type: 'local_bash',
    status: 'running',
    description: 'Run shell task',
    startTime: Date.now() - 2_000,
    outputFile: 'urn:agenc:task:shell-task:output',
    outputOffset: 0,
    notified: false,
    command: 'npm run test:unit',
    kind: 'bash',
    isBackgrounded: true,
    ...overrides,
  }
}

function makeRemoteTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'remote-task',
    type: 'remote_agent',
    status: 'running',
    description: 'Remote task description',
    startTime: Date.now() - 1_000,
    outputFile: 'urn:agenc:task:remote-task:output',
    outputOffset: 0,
    notified: false,
    remoteTaskType: 'ultrareview',
    sessionId: 'session-remote',
    command: 'review the change',
    title: 'Remote review',
    todoList: [],
    log: [],
    pollStartedAt: Date.now() - 1_000,
    ...overrides,
  }
}

function makeLocalAgentTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'local-agent-task',
    type: 'local_agent',
    status: 'completed',
    description: 'Local agent description',
    startTime: Date.now() - 5_000,
    outputFile: 'urn:agenc:task:local-agent-task:output',
    outputOffset: 0,
    notified: false,
    agentId: 'agent-local',
    agentType: 'planner',
    prompt: 'Use this prompt as the title',
    retrieved: false,
    pendingMessages: [],
    messages: [],
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    retain: false,
    diskLoaded: false,
    ...overrides,
  }
}

function makeTeammateTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'teammate-task',
    type: 'in_process_teammate',
    status: 'completed',
    description: 'Teammate task description',
    startTime: Date.now() - 4_000,
    outputFile: 'urn:agenc:task:teammate-task:output',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: 'agent-teammate',
      agentName: 'Reviewer',
      teamName: 'runtime',
      planModeRequired: false,
      parentSessionId: 'parent-session',
    },
    prompt: 'Check the task panel',
    model: 'teammate-model',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    messages: [],
    isIdle: true,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    ...overrides,
  }
}

describe('BackgroundTasksPanel swarm row 013', () => {
  beforeEach(() => {
    appStateMock.state = { tasks: {} }
    appStateMock.setAppState.mockClear()
    inputHandler.current = undefined
    terminalSizeMock.size = { columns: 132, rows: 36 }
    killTaskMock.mockClear()
    killAsyncAgentMock.mockClear()
    requestTeammateShutdownMock.mockClear()
    tailFileMock.mockReset()
    getTaskOutputPathMock.mockClear()
  })

  it('filters dialog tasks, renders terminal task rows, and leaves remote stop unavailable', async () => {
    appStateMock.state = {
      tasks: {
        invalidPrimitive: null,
        invalidType: {
          id: 'invalid-type',
          type: 'generic',
          status: 'completed',
          description: 'should stay hidden',
        },
        foregroundFinished: makeShellTask({
          id: 'foreground-finished',
          status: 'completed',
          command: 'should not be listed',
          isBackgrounded: false,
        }),
        remoteRunning: makeRemoteTask({
          id: 'remote-running',
          title: 'Remote selected task',
          startTime: Date.now() - 1_000,
        }),
        pendingShell: makeShellTask({
          id: 'pending-shell',
          status: 'pending',
          command: 'pnpm build',
          startTime: Date.now() - 2_000,
        }),
        completedRemote: makeRemoteTask({
          id: 'remote-finished',
          status: 'completed',
          title: 'Finished remote task',
          startTime: Date.now() - 3_000,
        }),
        completedTeammate: makeTeammateTask({
          id: 'teammate-finished',
          status: 'completed',
          startTime: Date.now() - 4_000,
        }),
        completedLocal: makeLocalAgentTask({
          id: 'local-finished',
          status: 'completed',
          startTime: Date.now() - 5_000,
        }),
        completedShell: makeShellTask({
          id: 'shell-finished',
          status: 'completed',
          command: 'npm run done',
          isBackgrounded: undefined,
          startTime: Date.now() - 6_000,
        }),
      },
    }

    const { BackgroundTasksPanel } = await import(
      '../components/tasks/BackgroundTasksPanel.js'
    )

    const output = await renderToString(<BackgroundTasksPanel />, 132)

    expect(output).toContain('2 RUNNING')
    expect(output).toContain('4 FINISHED')
    expect(output).toContain('remote-running')
    expect(output).toContain('Remote selected task')
    expect(output).toContain('Remote task stop is not available')
    expect(output).toContain('pnpm build')
    expect(output).toContain('queued')
    expect(output).toContain('Finished remote')
    expect(output).toContain('npm run done')
    expect(output).not.toContain('foreground-finished')
    expect(output).not.toContain('invalid-type')
    expect(output).not.toContain('should stay hidden')

    if (!inputHandler.current) {
      throw new Error('BackgroundTasksPanel did not register input handling')
    }
    inputHandler.current('x', key())

    expect(killTaskMock).not.toHaveBeenCalled()
    expect(killAsyncAgentMock).not.toHaveBeenCalled()
    expect(requestTeammateShutdownMock).not.toHaveBeenCalled()
  })

  it('renders shell result details and requests the output tail for running tasks', async () => {
    tailFileMock.mockResolvedValue({
      content: 'tail line from shell',
      bytesTotal: 1536,
    })
    appStateMock.state = {
      tasks: {
        shell: makeShellTask({
          id: 'shell-with-result',
          command: 'node scripts/check.js',
          kind: 'monitor',
          result: { code: 7, interrupted: true },
        }),
      },
    }

    const { BackgroundTasksPanel } = await import(
      '../components/tasks/BackgroundTasksPanel.js'
    )

    const output = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="shell-with-result" />,
      132,
    )

    expect(output).toContain('TASK DETAIL')
    expect(output).toContain('node scripts/check.js')
    expect(output).toContain('monitor')
    expect(output).toContain('code 7')
    expect(output).toContain('interrupted')
    expect(output).toContain('yes')
    expect(output).toContain('tail line from shell')
    expect(getTaskOutputPathMock).toHaveBeenCalledWith('shell-with-result')
    expect(tailFileMock).toHaveBeenCalledWith('/tmp/shell-with-result.log', 8192)
  })

  it('renders remote review progress and ignores stop input for finished tasks', async () => {
    appStateMock.state = {
      tasks: {
        review: makeRemoteTask({
          id: 'remote-review',
          status: 'completed',
          title: '',
          command: '',
          description: 'Remote description fallback',
          reviewProgress: {
            bugsFound: 4,
            bugsVerified: 2,
            bugsRefuted: 1,
          },
          log: undefined,
        }),
      },
    }

    const { BackgroundTasksPanel } = await import(
      '../components/tasks/BackgroundTasksPanel.js'
    )

    const output = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="remote-review" />,
      132,
    )

    expect(output).toContain('TASK DETAIL')
    expect(output).toContain('Remote description fallback')
    expect(output).toContain('review')
    expect(output).toContain('4 found')
    expect(output).toContain('2 verified')
    expect(output).toContain('1 refuted')

    if (!inputHandler.current) {
      throw new Error('BackgroundTasksPanel did not register input handling')
    }
    inputHandler.current('x', key())

    expect(killTaskMock).not.toHaveBeenCalled()
    expect(killAsyncAgentMock).not.toHaveBeenCalled()
    expect(requestTeammateShutdownMock).not.toHaveBeenCalled()
  })

  it('stringifies sparse local agent detail values and activity fallbacks', async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    appStateMock.state = {
      tasks: {
        local: makeLocalAgentTask({
          id: 'local-agent-detail',
          status: 'failed',
          model: undefined,
          error: new Error('agent exploded'),
          result: 12n,
          messages: [null, true, circular],
          progress: {
            recentActivities: [
              {
                toolName: 'write',
                input: 'notes.txt',
              },
            ],
          },
        }),
      },
    }

    const { BackgroundTasksPanel } = await import(
      '../components/tasks/BackgroundTasksPanel.js'
    )

    const output = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="local-agent-detail" />,
      132,
    )

    expect(output).toContain('TASK DETAIL')
    expect(output).toContain('failed')
    expect(output).toContain('Use this prompt as the title')
    expect(output).toContain('agent exploded')
    expect(output).toContain('12')
    expect(output).toContain('null')
    expect(output).toContain('true')
    expect(output).toContain('[object Object]')
    expect(output).toContain('write notes.txt')
  })
})
