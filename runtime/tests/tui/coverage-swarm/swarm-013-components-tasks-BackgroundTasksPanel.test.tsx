import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createRoot } from '../ink.js'
import { getInkInstance } from '../ink/instances.js'
import { cellAt } from '../ink/screen.js'
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

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

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

  it('filters dialog tasks and renders terminal task rows', async () => {
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
        pendingShell: makeShellTask({
          id: 'pending-shell',
          status: 'pending',
          command: 'pnpm build',
          startTime: Date.now() - 2_000,
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

    expect(output).toContain('1 RUNNING')
    expect(output).toContain('3 FINISHED')
    expect(output).toContain('pnpm build')
    expect(output).toContain('queued')
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

  it('keeps the last shell detail tail visible when a later poll fails', async () => {
    tailFileMock
      .mockResolvedValueOnce({
        content: 'tail line from shell',
        bytesTotal: 1536,
      })
      .mockRejectedValueOnce(new Error('tail failed'))
    appStateMock.state = {
      tasks: {
        shell: makeShellTask({
          id: 'shell-with-result',
          command: 'node scripts/check.js',
          kind: 'monitor',
        }),
      },
    }
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      const { BackgroundTasksPanel } = await import(
        '../components/tasks/BackgroundTasksPanel.js'
      )

      root.render(<BackgroundTasksPanel initialDetailTaskId="shell-with-result" />)
      await sleep()

      expect(compact(screenText(stdout))).toContain('taillinefromshell')

      await sleep(1_200)

      expect(compact(screenText(stdout))).toContain('taillinefromshell')
      expect(compact(screenText(stdout))).not.toContain('(nooutput)')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  it('ignores stop input for finished tasks', async () => {
    appStateMock.state = {
      tasks: {
        finished: makeLocalAgentTask({
          id: 'local-review',
          status: 'completed',
          prompt: '',
          description: 'Local description fallback',
        }),
      },
    }

    const { BackgroundTasksPanel } = await import(
      '../components/tasks/BackgroundTasksPanel.js'
    )

    const output = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="local-review" />,
      132,
    )

    expect(output).toContain('TASK DETAIL')
    expect(output).toContain('Local description fallback')

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

function createStreams(): {
  readonly stdin: TestStdin
  readonly stdout: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 132
  ;(stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 36
  ;(stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true
  stdout.resume()

  return {
    stdin,
    stdout,
  }
}

function sleep(ms = 200): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function compact(value: string): string {
  return value.replace(/\s+/gu, '')
}

function screenText(stdout: PassThrough): string {
  const instance = getInkInstance(stdout as unknown as NodeJS.WriteStream) as
    | { readonly frontFrame?: { readonly screen?: { readonly width: number; readonly height: number } } }
    | undefined
  const screen = instance?.frontFrame?.screen
  if (!screen) return ''
  const rows: string[] = []
  for (let row = 0; row < screen.height; row += 1) {
    const chars: string[] = []
    for (let column = 0; column < screen.width; column += 1) {
      chars.push(cellAt(screen, column, row)?.char ?? ' ')
    }
    rows.push(chars.join('').trimEnd())
  }
  return rows.join('\n')
}
