import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  activity: {
    endCLIActivity: vi.fn(),
    startCLIActivity: vi.fn(),
  },
  appState: {
    effortValue: 'medium',
    expandedView: undefined as undefined | 'tasks' | 'teammates',
    isBriefOnly: false,
    remoteBackgroundTaskCount: 0,
    remoteConnectionStatus: 'connected',
    selectedIPAgentIndex: 0,
    tasks: {} as Record<string, unknown>,
    viewingAgentTaskId: undefined as string | undefined,
    viewSelectionMode: 'idle',
  },
  features: new Set<string>(),
  settings: {
    prefersReducedMotion: false,
    spinnerTipsEnabled: true,
  } as { prefersReducedMotion?: boolean; spinnerTipsEnabled?: boolean } | undefined,
  tasksV2: undefined as undefined | Array<{
    activeForm?: string
    blockedBy: string[]
    id: string
    status: string
    subject: string
  }>,
  teammateTasks: [] as Array<Record<string, unknown>>,
  turnOutputTokens: 0,
  turnTokenBudget: null as number | null,
  viewedTeammate: undefined as undefined | Record<string, unknown>,
  reset() {
    harness.activity.endCLIActivity.mockClear()
    harness.activity.startCLIActivity.mockClear()
    harness.appState = {
      effortValue: 'medium',
      expandedView: undefined,
      isBriefOnly: false,
      remoteBackgroundTaskCount: 0,
      remoteConnectionStatus: 'connected',
      selectedIPAgentIndex: 0,
      tasks: {},
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'idle',
    }
    harness.features = new Set()
    harness.settings = {
      prefersReducedMotion: false,
      spinnerTipsEnabled: true,
    }
    harness.tasksV2 = undefined
    harness.teammateTasks = []
    harness.turnOutputTokens = 0
    harness.turnTokenBudget = null
    harness.viewedTeammate = undefined
  },
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => harness.features.has(name),
}))

vi.mock('../../../bootstrap/state.js', () => ({
  flushInteractionTime: vi.fn(),
  getCurrentTurnTokenBudget: () => harness.turnTokenBudget,
  getKairosActive: () => false,
  getTurnOutputTokens: () => harness.turnOutputTokens,
  getUserMsgOptIn: () => false,
}))

vi.mock('../../../utils/envUtils.js', () => ({
  isEnvTruthy: (value: string | undefined) => value === '1' || value === 'true',
}))

vi.mock('lodash-es/sample.js', () => ({
  default: (items: readonly string[]) => items[0],
}))

vi.mock('../../../utils/activityManager.js', () => ({
  activityManager: harness.activity,
}))

vi.mock('../../../constants/spinnerVerbs.js', () => ({
  getSpinnerVerbs: () => ['Working'],
}))

vi.mock('../MessageResponse.js', async () => {
  const ReactModule = await import('react')
  return {
    MessageResponse: ({ children }: { readonly children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  }
})

vi.mock('../TaskListV2.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')
  return {
    TaskListV2: ({ tasks }: { readonly tasks: readonly { subject: string }[] }) =>
      ReactModule.createElement(Text, null, `TaskList:${tasks.map(task => task.subject).join(',')}`),
  }
})

vi.mock('../../hooks/useTasksV2.js', () => ({
  useTasksV2: () => harness.tasksV2,
}))

vi.mock('../../state/AppState.js', () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
}))

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}))

vi.mock('../../hooks/useSettings.js', () => ({
  useSettings: () => harness.settings,
}))

vi.mock('../../../tasks/InProcessTeammateTask/types.js', () => ({
  isInProcessTeammateTask: (task: { readonly type?: string }) =>
    task.type === 'in_process_teammate',
}))

vi.mock('../../../tasks/types.js', () => ({
  isBackgroundTask: (task: { readonly type?: string }) => task.type === 'background',
}))

vi.mock('../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js', () => ({
  getAllInProcessTeammateTasks: () => harness.teammateTasks,
}))

vi.mock('../../../utils/effort.js', () => ({
  getEffortSuffix: () => ' - effort',
}))

vi.mock('../../../utils/model/model.js', () => ({
  getMainLoopModel: () => 'grok-4.3',
}))

vi.mock('../../state/selectors.js', () => ({
  getViewedTeammateTask: () => harness.viewedTeammate,
}))

vi.mock('./SpinnerAnimationRow.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')
  return {
    SpinnerAnimationRow: (props: Record<string, unknown>) =>
      ReactModule.createElement(
        Text,
        null,
        [
          'Animation',
          String(props.message),
          String(props.mode),
          `thinking=${String(props.thinkingStatus)}`,
          `teammateTokens=${String(props.teammateTokens)}`,
          `hasRunningTeammates=${String(props.hasRunningTeammates)}`,
        ].join('|'),
      ),
  }
})

vi.mock('./TeammateSpinnerTree.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')
  return {
    TeammateSpinnerTree: (props: Record<string, unknown>) =>
      ReactModule.createElement(Text, null, `Tree:${String(props.leaderVerb ?? 'none')}`),
  }
})

vi.mock('./agentActivity.js', () => ({
  formatRunningAgentSummary: (agents: readonly { readonly name: string }[]) =>
    agents.map(agent => agent.name).join(', '),
  getActiveLocalAgentTasks: () => [],
}))

import { createRoot } from '../../ink/root.js'
import { SpinnerWithVerb } from './Spinner.js'

function createStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  return { stdin, stdout }
}

async function flushRender(ms = 25): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await Promise.resolve()
}

async function renderToText(node: React.ReactNode): Promise<{
  dispose: () => Promise<void>
  output: () => string
  rerender: (nextNode: React.ReactNode) => Promise<void>
}> {
  let output = ''
  const { stdin, stdout } = createStreams()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  root.render(node)
  await flushRender()
  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushRender()
    },
    output: () => stripAnsi(output),
    rerender: async (nextNode: React.ReactNode) => {
      root.render(nextNode)
      await flushRender()
    },
  }
}

function spinnerProps(overrides: Partial<React.ComponentProps<typeof SpinnerWithVerb>> = {}) {
  return {
    loadingStartTimeRef: { current: Date.now() - 10_000 },
    mode: 'processing' as const,
    pauseStartTimeRef: { current: null },
    responseLengthRef: { current: 4000 },
    totalPausedMsRef: { current: 0 },
    verbose: false,
    ...overrides,
  }
}

describe('Spinner wave 200 coverage', () => {
  beforeEach(() => {
    harness.reset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'))

    harness.features.add('TOKEN_BUDGET')
    harness.turnTokenBudget = 4000
    harness.turnOutputTokens = 2500
    harness.tasksV2 = [
      {
        activeForm: 'Planning',
        blockedBy: [],
        id: 'active',
        status: 'running',
        subject: 'Active task',
      },
    ]
    harness.appState.tasks = {
      teammate: {
        progress: { tokenCount: 777 },
        status: 'running',
        type: 'in_process_teammate',
      },
    }
    harness.teammateTasks = [
      {
        isIdle: false,
        status: 'running',
        type: 'in_process_teammate',
      },
    ]
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('carries thinking duration, budget progress, and teammate tokens into the normal spinner row', async () => {
    const rendered = await renderToText(
      <SpinnerWithVerb {...spinnerProps({ mode: 'thinking' })} />,
    )

    try {
      expect(rendered.output()).toContain('Animation|Planning')
      expect(rendered.output()).toContain('|thinking|thinking=thinking|')

      await vi.advanceTimersByTimeAsync(2500)
      await rendered.rerender(<SpinnerWithVerb {...spinnerProps({ mode: 'processing' })} />)

      const output = rendered.output()
      const compactOutput = output.replace(/\s+/g, '')
      expect(output).toContain('|processing|thinking=2525|')
      expect(output).toContain('teammateTokens=777')
      expect(compactOutput).toContain('hasRunningTeammates=true')
      // Auto-show: the open task surfaces the todo board, winning over the
      // budget text line that used to render in its place.
      expect(output).toContain('TaskList:Active task')
      expect(harness.activity.endCLIActivity).toHaveBeenCalledWith('spinner-thinking')
      expect(harness.activity.startCLIActivity).toHaveBeenCalledWith('spinner-processing')
    } finally {
      await rendered.dispose()
    }
  })
})
