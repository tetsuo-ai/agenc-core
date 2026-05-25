import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'

const appStateMock = vi.hoisted(() => ({
  state: {
    expandedView: undefined as string | undefined,
    tasks: {} as Record<string, unknown>,
    viewingAgentTaskId: undefined as string | undefined,
  },
  setAppState: vi.fn(),
}))

const terminalSizeMock = vi.hoisted(() => ({
  size: { columns: 80, rows: 24 },
}))

vi.mock('../../state/AppState.js', () => ({
  useAppState: (selector: (state: typeof appStateMock.state) => unknown) =>
    selector(appStateMock.state),
  useSetAppState: () => appStateMock.setAppState,
}))

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => terminalSizeMock.size,
}))

function teammateTask(id: string, agentName: string, isIdle = false) {
  return {
    id,
    type: 'in_process_teammate',
    status: 'running',
    description: agentName,
    startTime: 10,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: id,
      agentName,
      teamName: 'team',
      color: 'cyan',
      planModeRequired: false,
      parentSessionId: 'parent',
    },
    prompt: 'help',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

function localAgentTask(id: string) {
  return {
    id,
    type: 'local_agent',
    status: 'running',
    description: id,
    startTime: 10,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
    agentId: id,
    agentType: 'worker',
    prompt: 'help',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  }
}

describe('BackgroundTaskStatus coverage', () => {
  const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

  beforeEach(() => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'
    appStateMock.state = {
      expandedView: undefined,
      tasks: {},
      viewingAgentTaskId: undefined,
    }
    appStateMock.setAppState.mockClear()
    terminalSizeMock.size = { columns: 18, rows: 24 }
  })

  afterEach(() => {
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode
    }
  })

  it('keeps the selected teammate visible in a narrow scrollable footer', async () => {
    appStateMock.state = {
      ...appStateMock.state,
      viewingAgentTaskId: 'charlie',
      tasks: {
        alpha: teammateTask('alpha', 'alpha-agent'),
        bravo: teammateTask('bravo', 'bravo-agent'),
        charlie: teammateTask('charlie', 'charlie-agent'),
        delta: teammateTask('delta', 'delta-agent', true),
      },
    }

    const { BackgroundTaskStatus } = await import('./BackgroundTaskStatus.js')
    const output = await renderToString(
      <BackgroundTaskStatus tasksSelected teammateFooterIndex={3} />,
      18,
    )

    expect(output).toContain('<')
    expect(output).toContain('>')
    expect(output).toContain('@charlie')
    expect(output).not.toContain('@alpha-agent')
    expect(output).not.toContain('shift + down to expand')
  })

  it('keeps teammate pills visible when coordinator agents are also running', async () => {
    terminalSizeMock.size = { columns: 80, rows: 24 }
    appStateMock.state = {
      ...appStateMock.state,
      tasks: {
        local: localAgentTask('local'),
        alpha: teammateTask('alpha', 'alpha-agent'),
      },
    }

    const { BackgroundTaskStatus } = await import('./BackgroundTaskStatus.js')
    const output = await renderToString(
      <BackgroundTaskStatus tasksSelected={false} />,
      80,
    )

    expect(output).toContain('@main')
    expect(output).toContain('@alpha-agent')
    expect(output).not.toContain('2 background tasks')
    expect(output).not.toContain('local agent')
  })

  it('keeps active teammates before idle teammates when the footer is not selected', async () => {
    terminalSizeMock.size = { columns: 80, rows: 24 }
    appStateMock.state = {
      ...appStateMock.state,
      tasks: {
        idle: teammateTask('idle', 'aaa-idle', true),
        active: teammateTask('active', 'zzz-active'),
      },
    }

    const { BackgroundTaskStatus } = await import('./BackgroundTaskStatus.js')
    const output = await renderToString(
      <BackgroundTaskStatus tasksSelected={false} />,
      80,
    )

    expect(output.indexOf('@zzz-active')).toBeLessThan(output.indexOf('@aaa-idle'))
  })

  it('falls back to the main pill while viewing a stale teammate id', async () => {
    terminalSizeMock.size = { columns: 18, rows: 24 }
    appStateMock.state = {
      ...appStateMock.state,
      viewingAgentTaskId: 'missing-teammate',
      tasks: {},
    }

    const { BackgroundTaskStatus } = await import('./BackgroundTaskStatus.js')
    const output = await renderToString(
      <BackgroundTaskStatus tasksSelected={false} isViewingTeammate={true} />,
      18,
    )

    expect(output).toContain('@main')
  })
})
