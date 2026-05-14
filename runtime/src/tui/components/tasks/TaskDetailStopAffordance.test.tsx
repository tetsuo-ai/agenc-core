import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { AsyncAgentDetailDialog } from './AsyncAgentDetailDialog.js'
import { InProcessTeammateDetailDialog } from './InProcessTeammateDetailDialog.js'
import { ShellDetailDialog } from './ShellDetailDialog.js'

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
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
      />,
      100,
    )

    expect(output).toContain('x to stop')
    expect(output).toContain('Pending')
  })
})
