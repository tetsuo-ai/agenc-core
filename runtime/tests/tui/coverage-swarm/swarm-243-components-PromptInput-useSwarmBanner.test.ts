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
    appState: makeState(),
    cachedDetection: undefined as undefined | { isNative?: boolean },
    inProcessEnabled: false,
    inProcessTeammate: false,
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
      state.appState = makeState()
      state.cachedDetection = undefined
      state.inProcessEnabled = false
      state.inProcessTeammate = false
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

vi.mock('../../../src/tui/state/AppState.js', () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
  useAppStateStore: () => ({
    getState: () => harness.appState,
  }),
}))

vi.mock('../../../src/tui/state/selectors.js', () => ({
  getActiveAgentForInput: () => harness.activeAgent,
  getViewedTeammateTask: () => harness.viewedTeammate,
}))

vi.mock('../../../src/tools/AgentTool/agentColorManager.js', () => ({
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
  getAgentColor: (agentType: string) =>
    agentType === 'writer' ? 'yellow_FOR_SUBAGENTS_ONLY' : undefined,
}))

vi.mock('../../../src/utils/standaloneAgent.js', () => ({
  getStandaloneAgentName: (state: typeof harness.appState) =>
    state.standaloneAgentContext?.name,
}))

vi.mock('../../../src/utils/swarm/backends/detection.js', () => ({
  isInsideTmux: () => Promise.resolve(harness.insideTmux),
}))

vi.mock('../../../src/utils/swarm/backends/registry.js', () => ({
  getCachedDetectionResult: () => harness.cachedDetection,
  isInProcessEnabled: () => harness.inProcessEnabled,
}))

vi.mock('../../../src/utils/swarm/constants.js', () => ({
  getSwarmSocketName: () => 'row-243',
}))

vi.mock('../../../src/utils/teammate.js', () => ({
  getAgentName: () => harness.teammate.agentName,
  getTeammateColor: () => harness.teammate.color,
  getTeamName: () => harness.teammate.teamName,
  isTeammate: () => harness.teammate.active,
}))

vi.mock('../../../src/utils/teammateContext.js', () => ({
  isInProcessTeammate: () => harness.inProcessTeammate,
}))

import { createRoot } from '../../../src/tui/ink/root.js'
import { useSwarmBanner } from '../../../src/tui/components/PromptInput/useSwarmBanner.js'

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

describe('useSwarmBanner coverage swarm row 243', () => {
  afterEach(() => {
    harness.reset()
    vi.clearAllMocks()
  })

  test('skips teammate banner when the process is in-process or lacks a team name', async () => {
    await expectBanner(() => {
      harness.inProcessTeammate = true
      harness.teammate = {
        active: true,
        agentName: 'builder',
        color: 'orange',
        teamName: 'core',
      }
      harness.appState.agent = 'planner'
      harness.appState.agentDefinitions.activeAgents = [
        { agentType: 'planner', color: 'cyan' },
      ]
    }, {
      bgColor: 'cyan_FOR_SUBAGENTS_ONLY',
      text: 'planner',
    })

    await expectBanner(() => {
      harness.teammate = {
        active: true,
        agentName: 'builder',
        color: 'orange',
        teamName: undefined,
      }
      harness.appState.standaloneAgentContext = { name: 'solo' }
    }, {
      bgColor: 'cyan_FOR_SUBAGENTS_ONLY',
      text: 'solo',
    })
  })

  test('falls through when teammate identity is missing and no agent definition matches', async () => {
    await expectBanner(() => {
      harness.teammate = {
        active: true,
        agentName: undefined,
        color: 'orange',
        teamName: 'core',
      }
      harness.appState.agent = 'reviewer'
      harness.appState.agentDefinitions.activeAgents = [
        { agentType: 'planner', color: 'green' },
      ]
    }, {
      bgColor: 'promptBorder',
      text: 'reviewer',
    })
  })

  test('shows viewed teammate when the leader is inside tmux or in-process mode', async () => {
    await expectBanner(() => {
      harness.insideTmux = true
      harness.appState.teamContext = {
        teamName: 'launch',
        teammates: { analyst: {} },
      }
      harness.viewedTeammate = {
        identity: { agentName: 'analyst', color: 'blue' },
      }
    }, {
      bgColor: 'blue_FOR_SUBAGENTS_ONLY',
      text: '@analyst',
    })

    await expectBanner(() => {
      harness.inProcessEnabled = true
      harness.appState.teamContext = {
        teamName: 'launch',
        teammates: { writer: {} },
      }
      harness.viewedTeammate = {
        identity: { agentName: 'writer', color: undefined },
      }
    }, {
      bgColor: 'cyan_FOR_SUBAGENTS_ONLY',
      text: '@writer',
    })
  })

  test('uses background task colors and ignores empty teammate collections', async () => {
    await expectBanner(() => {
      harness.activeAgent = {
        type: 'named_agent',
        task: {
          agentType: 'writer',
          description: 'Draft notes',
          id: 'task-1',
        },
      }
      harness.appState.agentNameRegistry.set('scribe', 'task-1')
    }, {
      bgColor: 'yellow_FOR_SUBAGENTS_ONLY',
      text: '@scribe',
    })

    await expectBanner(() => {
      harness.appState.teamContext = {
        teamName: 'empty',
        teammates: {},
      }
      harness.appState.standaloneAgentContext = {
        color: 'red',
        name: 'solo',
      }
    }, {
      bgColor: 'red_FOR_SUBAGENTS_ONLY',
      text: 'solo',
    })
  })
})
