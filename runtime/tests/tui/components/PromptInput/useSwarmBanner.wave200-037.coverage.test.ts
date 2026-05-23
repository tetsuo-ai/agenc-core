import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => {
  function makeState() {
    return {
      agent: undefined as string | undefined,
      agentDefinitions: {
        activeAgents: [] as Array<{ agentType: string; color?: string }>,
      },
      agentNameRegistry: new Map<string, string>(),
      standaloneAgentContext: undefined as
        | undefined
        | { name?: string; color?: string },
      tasks: {} as Record<string, unknown>,
      teamContext: undefined as
        | undefined
        | {
            selfAgentColor?: string
            teamName?: string
            teammates?: Record<string, unknown>
          },
      viewingAgentTaskId: undefined as string | undefined,
    }
  }

  const state = {
    activeAgent: { type: 'leader' } as
      | { type: 'leader' }
      | {
          type: 'named_agent'
          task: { id: string; description: string; agentType: string }
        },
    agentColors: new Map<string, string>(),
    appState: makeState(),
    cachedDetection: undefined as undefined | { isNative?: boolean },
    inProcessEnabled: false,
    inProcessTeammate: false,
    insideTmuxError: undefined as undefined | Error,
    insideTmux: null as boolean | null,
    teammate: {
      active: false,
      agentName: undefined as string | undefined,
      color: undefined as string | undefined,
      teamName: undefined as string | undefined,
    },
    viewedTeammate: undefined as
      | undefined
      | { identity: { agentName: string; color?: string } },
    reset() {
      state.activeAgent = { type: 'leader' }
      state.agentColors.clear()
      state.appState = makeState()
      state.cachedDetection = undefined
      state.inProcessEnabled = false
      state.inProcessTeammate = false
      state.insideTmuxError = undefined
      state.insideTmux = null
      state.teammate = {
        active: false,
        agentName: undefined,
        color: undefined,
        teamName: undefined,
      }
      state.viewedTeammate = undefined
    },
  }

  return state
})

vi.mock('../../state/AppState.js', () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
  useAppStateStore: () => ({
    getState: () => harness.appState,
  }),
}))

vi.mock('../../state/selectors.js', () => ({
  getActiveAgentForInput: () => harness.activeAgent,
  getViewedTeammateTask: () => harness.viewedTeammate,
}))

vi.mock('../../../tools/AgentTool/agentColorManager.js', () => ({
  AGENT_COLOR_TO_THEME_COLOR: {
    blue: 'blue_FOR_SUBAGENTS_ONLY',
    cyan: 'cyan_FOR_SUBAGENTS_ONLY',
    green: 'green_FOR_SUBAGENTS_ONLY',
    orange: 'orange_FOR_SUBAGENTS_ONLY',
    pink: 'pink_FOR_SUBAGENTS_ONLY',
    purple: 'purple_FOR_SUBAGENTS_ONLY',
    red: 'red_FOR_SUBAGENTS_ONLY',
    yellow: 'yellow_FOR_SUBAGENTS_ONLY',
  },
  AGENT_COLORS: [
    'red',
    'blue',
    'green',
    'yellow',
    'purple',
    'orange',
    'pink',
    'cyan',
  ],
  getAgentColor: (agentType: string) => harness.agentColors.get(agentType),
}))

vi.mock('../../../utils/standaloneAgent.js', () => ({
  getStandaloneAgentName: (state: typeof harness.appState) =>
    state.standaloneAgentContext?.name,
}))

vi.mock('../../../utils/swarm/backends/detection.js', () => ({
  isInsideTmux: () =>
    harness.insideTmuxError
      ? Promise.reject(harness.insideTmuxError)
      : Promise.resolve(harness.insideTmux),
}))

vi.mock('../../../utils/log.js', () => ({
  logError: vi.fn(),
}))

vi.mock('../../../utils/swarm/backends/registry.js', () => ({
  getCachedDetectionResult: () => harness.cachedDetection,
  isInProcessEnabled: () => harness.inProcessEnabled,
}))

vi.mock('../../../utils/swarm/constants.js', () => ({
  getSwarmSocketName: () => 'agenc-swarm-test',
}))

vi.mock('../../../utils/teammate.js', () => ({
  getAgentName: () => harness.teammate.agentName,
  getTeammateColor: () => harness.teammate.color,
  getTeamName: () => harness.teammate.teamName,
  isTeammate: () => harness.teammate.active,
}))

vi.mock('../../../utils/teammateContext.js', () => ({
  isInProcessTeammate: () => harness.inProcessTeammate,
}))

import { createRoot } from '../../ink/root.js'
import { useSwarmBanner } from './useSwarmBanner.js'
import { logError } from '../../../utils/log.js'

type Banner = ReturnType<typeof useSwarmBanner>

function createStreams(): {
  readonly stdout: PassThrough
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
  stdout.resume()
  ;(stdout as unknown as { columns: number }).columns = 120
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
  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function renderBanner(): Promise<Banner> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  let latest: Banner | undefined

  function Harness(): null {
    latest = useSwarmBanner()
    return null
  }

  try {
    root.render(React.createElement(Harness))
    await sleep()
    await sleep()
    if (latest === undefined) throw new Error('hook did not render')
    return latest
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await sleep(0)
  }
}

async function expectBanner(
  setup: () => void,
  expected: Banner,
): Promise<void> {
  harness.reset()
  setup()
  expect(await renderBanner()).toEqual(expected)
}

describe('useSwarmBanner coverage', () => {
  afterEach(() => {
    harness.reset()
    vi.clearAllMocks()
  })

  test('resolves banner identity priority across team and agent contexts', async () => {
    await expectBanner(() => {
      harness.teammate = {
        active: true,
        agentName: 'builder',
        color: 'orange',
        teamName: 'core',
      }
      harness.appState.teamContext = { selfAgentColor: 'purple' }
    }, {
      bgColor: 'purple_FOR_SUBAGENTS_ONLY',
      text: '@builder',
    })

    await expectBanner(() => {
      harness.insideTmux = false
      harness.appState.teamContext = {
        teamName: 'launch',
        teammates: { analyst: {} },
      }
      harness.viewedTeammate = {
        identity: { agentName: 'analyst', color: 'blue' },
      }
    }, {
      bgColor: 'blue_FOR_SUBAGENTS_ONLY',
      text: 'View teammates: `tmux -L agenc-swarm-test a`',
    })

    await expectBanner(() => {
      harness.insideTmux = false
      harness.cachedDetection = { isNative: true }
      harness.appState.teamContext = {
        teamName: 'launch',
        teammates: { reviewer: {} },
      }
      harness.viewedTeammate = {
        identity: { agentName: 'reviewer', color: 'green' },
      }
    }, {
      bgColor: 'green_FOR_SUBAGENTS_ONLY',
      text: '@reviewer',
    })

    await expectBanner(() => {
      harness.appState.teamContext = {
        teamName: 'launch',
        teammates: { helper: {} },
      }
      harness.appState.standaloneAgentContext = {
        color: 'red',
        name: 'solo',
      }
    }, {
      bgColor: 'red_FOR_SUBAGENTS_ONLY',
      text: 'solo',
    })

    await expectBanner(() => {
      harness.activeAgent = {
        type: 'named_agent',
        task: {
          agentType: 'scout',
          description: 'Coordinate rollout',
          id: 'task-1',
        },
      }
      harness.agentColors.set('scout', 'pink_FOR_SUBAGENTS_ONLY')
      harness.appState.agentNameRegistry.set('scout-one', 'task-1')
    }, {
      bgColor: 'pink_FOR_SUBAGENTS_ONLY',
      text: '@scout-one',
    })

    await expectBanner(() => {
      harness.activeAgent = {
        type: 'named_agent',
        task: {
          agentType: 'general-purpose',
          description: 'Summarize notes',
          id: 'task-2',
        },
      }
    }, {
      bgColor: 'cyan_FOR_SUBAGENTS_ONLY',
      text: 'Summarize notes',
    })

    await expectBanner(() => {
      harness.appState.standaloneAgentContext = { color: 'orange' }
    }, {
      bgColor: 'orange_FOR_SUBAGENTS_ONLY',
      text: '',
    })

    await expectBanner(() => {
      harness.appState.agent = 'planner'
      harness.appState.agentDefinitions.activeAgents = [
        { agentType: 'planner', color: 'not-a-theme-color' },
      ]
    }, {
      bgColor: 'promptBorder',
      text: 'planner',
    })

    await expectBanner(() => {}, null)
  })

  test('logs rejected tmux detection and falls back to attach hint', async () => {
    const error = new Error('tmux detection failed')

    await expectBanner(() => {
      harness.insideTmuxError = error
      harness.appState.teamContext = {
        teamName: 'launch',
        teammates: { analyst: {} },
      }
      harness.viewedTeammate = {
        identity: { agentName: 'analyst', color: 'blue' },
      }
    }, {
      bgColor: 'blue_FOR_SUBAGENTS_ONLY',
      text: 'View teammates: `tmux -L agenc-swarm-test a`',
    })

    expect(logError).toHaveBeenCalledWith(error)
  })
})
