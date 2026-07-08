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

function teammateTask(id: string, agentName: string) {
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
      planModeRequired: false,
      parentSessionId: 'parent',
    },
    prompt: 'help',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

describe('BackgroundTaskStatus glyph rendering', () => {
  const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

  beforeEach(() => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'
    appStateMock.state = {
      expandedView: undefined,
      tasks: {},
      viewingAgentTaskId: undefined,
    }
    appStateMock.setAppState.mockClear()
    terminalSizeMock.size = { columns: 80, rows: 24 }
  })

  afterEach(() => {
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode
    }
  })

  it('uses ASCII separator and shortcut text for teammate expand hints', async () => {
    appStateMock.state = {
      ...appStateMock.state,
      tasks: {
        alpha: teammateTask('alpha', 'alpha'),
      },
    }

    const { BackgroundTaskStatus } = await import('./BackgroundTaskStatus.js')
    const output = await renderToString(
      <BackgroundTaskStatus tasksSelected={false} />,
      80,
    )

    expect(output).toContain('- shift + down to expand')
    expect(output).not.toContain('·')
    expect(output).not.toContain('↓')
  })
})
