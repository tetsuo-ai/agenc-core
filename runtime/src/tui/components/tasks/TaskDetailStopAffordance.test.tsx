import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { AsyncAgentDetailDialog } from './AsyncAgentDetailDialog.js'
import { InProcessTeammateDetailDialog } from './InProcessTeammateDetailDialog.js'
import { ShellDetailDialog } from './ShellDetailDialog.js'

const terminalSizeMock = vi.hoisted(() => ({
  size: { columns: 80, rows: 24 },
}))

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => terminalSizeMock.size,
}))

vi.mock('../../../utils/fsOperations.js', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/fsOperations.js')>(
    '../../../utils/fsOperations.js',
  )
  return {
    ...actual,
    tailFile: async () => ({ content: '', bytesTotal: 0 }),
  }
})

vi.mock('../../../utils/task/diskOutput.js', () => ({
  getTaskOutputPath: () => '/tmp/agenc-task-output',
}))

vi.mock('../../keybindings/useKeybinding.js', () => ({
  useKeybinding: () => {},
  useKeybindings: () => {},
}))

vi.mock('../../../tools', () => ({
  getTools: () => [],
}))

vi.mock('../../../tools/index.js', () => ({
  getTools: () => [],
}))

vi.mock('../../../tools/Tool.js', async () => {
  const actual = await vi.importActual<typeof import('../../../tools/Tool.js')>(
    '../../../tools/Tool.js',
  )
  return {
    ...actual,
    getEmptyToolPermissionContext: () => ({}),
  }
})

vi.mock('../../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../../ink.js')>('../../ink.js')
  return {
    ...actual,
    useTheme: () => ['dark'],
  }
})

const taskBase = {
  status: 'pending',
  startTime: Date.now() - 1000,
  outputFile: 'urn:agenc:task:t1:output',
  outputOffset: 0,
  notified: false,
  isBackgrounded: true,
}

describe('task detail stop affordances', () => {
  beforeEach(() => {
    terminalSizeMock.size = { columns: 80, rows: 24 }
  })

  it('shows stop affordance for pending shell tasks', async () => {
    const output = await renderToString(
      <ShellDetailDialog
        shell={{
          ...taskBase,
          id: 'bash-1',
          type: 'local_bash',
          description: 'npm test',
          command: 'npm test',
        } as never}
        onDone={() => {}}
        onKillShell={() => {}}
      />,
      100,
    )

    expect(output).toContain('x to stop')
    expect(output).toContain('Status: pending')
  })

  it('shows stop affordance for pending async agent tasks', async () => {
    const output = await renderToString(
      <AsyncAgentDetailDialog
        agent={{
          ...taskBase,
          id: 'agent-1',
          type: 'local_agent',
          description: 'inspect repo',
          agentId: 'agent-1',
          prompt: 'inspect repo',
          agentType: 'default',
          retrieved: false,
          lastReportedToolCount: 0,
          lastReportedTokenCount: 0,
          pendingMessages: [],
          retain: false,
          diskLoaded: false,
        } as never}
        onDone={() => {}}
        onKillAgent={() => {}}
      />,
      100,
    )

    expect(output).toContain('x to stop')
    expect(output).toContain('Pending')
  })

  it('uses ASCII-safe async agent detail glyphs when requested', async () => {
    const previousGlyphMode = process.env.AGENC_TUI_GLYPHS
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    try {
      const output = stripAnsi(
        await renderToString(
          <AsyncAgentDetailDialog
            agent={{
              ...taskBase,
              status: 'running',
              id: 'agent-1',
              type: 'local_agent',
              description: 'inspect repo',
              agentId: 'agent-1',
              prompt: 'inspect repo '.repeat(80),
              agentType: 'default',
              retrieved: false,
              lastReportedToolCount: 0,
              lastReportedTokenCount: 0,
              pendingMessages: [],
              retain: false,
              diskLoaded: false,
              progress: {
                tokenCount: 1,
                toolUseCount: 1,
                recentActivities: [
                  {
                    toolName: 'VeryLongToolNameThatShouldTruncateInsideTheDialog',
                    input: {},
                  },
                ],
              },
            } as never}
            onDone={() => {}}
            onBack={() => {}}
            onKillAgent={() => {}}
          />,
          42,
        ),
      )

      expect(output).toContain('Left to go back')
      expect(output).toContain('> VeryLongToolName')
      expect(output).not.toContain('←')
      expect(output).not.toContain('›')
    } finally {
      if (previousGlyphMode === undefined) {
        delete process.env.AGENC_TUI_GLYPHS
      } else {
        process.env.AGENC_TUI_GLYPHS = previousGlyphMode
      }
    }
  })

  it('shows stop affordance for pending in-process teammate tasks', async () => {
    const output = await renderToString(
      <InProcessTeammateDetailDialog
        teammate={{
          ...taskBase,
          id: 'team-1',
          type: 'in_process_teammate',
          description: 'review code',
          prompt: 'review code',
          identity: {
            agentId: 'agent-1',
            agentName: 'reviewer',
            teamName: 'default',
            planModeRequired: false,
            parentSessionId: 'session-1',
          },
          awaitingPlanApproval: false,
          permissionMode: 'default',
          pendingUserMessages: [],
          isIdle: false,
          shutdownRequested: false,
          lastReportedToolCount: 0,
          lastReportedTokenCount: 0,
        } as never}
        onDone={() => {}}
        onKill={() => {}}
        onForeground={() => {}}
      />,
      100,
    )

    expect(output).toContain('x to stop')
    expect(output).toContain('f to foreground')
    expect(output).toContain('Pending')
  })

  it('uses ASCII-safe teammate detail glyphs and terminal-width prompt previews', async () => {
    const previousGlyphMode = process.env.AGENC_TUI_GLYPHS
    process.env.AGENC_TUI_GLYPHS = 'ascii'
    terminalSizeMock.size = { columns: 42, rows: 24 }
    const longPrompt = 'review this very long teammate prompt '.repeat(40)

    try {
      const output = stripAnsi(
        await renderToString(
          <InProcessTeammateDetailDialog
            teammate={{
              ...taskBase,
              status: 'running',
              id: 'team-1',
              type: 'in_process_teammate',
              description: 'review code',
              prompt: longPrompt,
              identity: {
                agentId: 'agent-1',
                agentName: 'reviewer',
                teamName: 'default',
                planModeRequired: false,
                parentSessionId: 'session-1',
              },
              awaitingPlanApproval: false,
              permissionMode: 'default',
              pendingUserMessages: [],
              isIdle: false,
              shutdownRequested: false,
              lastReportedToolCount: 0,
              lastReportedTokenCount: 0,
              progress: {
                tokenCount: 1,
                toolUseCount: 1,
                recentActivities: [
                  {
                    toolName: 'VeryLongToolNameThatShouldTruncateInsideTheDialog',
                    input: {},
                  },
                ],
              },
            } as never}
            onDone={() => {}}
            onBack={() => {}}
            onKill={() => {}}
            onForeground={() => {}}
          />,
          42,
        ),
      )

      expect(output).toContain('Left to go back')
      expect(output).toContain('> VeryLongToolName')
      expect(output).toContain('review this very long teammate prom...')
      expect(output).not.toContain('←')
      expect(output).not.toContain('›')
      expect(output).not.toContain(longPrompt)
    } finally {
      if (previousGlyphMode === undefined) {
        delete process.env.AGENC_TUI_GLYPHS
      } else {
        process.env.AGENC_TUI_GLYPHS = previousGlyphMode
      }
    }
  })
})
