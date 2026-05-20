import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { InProcessTeammateTaskState } from '../../../tasks/InProcessTeammateTask/types.js'
import { renderToString } from '../../../utils/staticRender.js'
import {
  getMessagePreview,
  TeammateSpinnerLine,
} from './TeammateSpinnerLine.js'

const NOW = new Date('2026-05-20T12:00:00.000Z').getTime()

const terminalSizeMock = vi.hoisted(() => ({
  size: { columns: 120, rows: 24 },
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('lodash-es/sample.js', () => ({
  default: <T,>(items: readonly T[]) => items[0],
}))

vi.mock('../../../constants/spinnerVerbs.js', () => ({
  getSpinnerVerbs: () => ['Reviewing'],
}))

vi.mock('../../../constants/turnCompletionVerbs.js', () => ({
  TURN_COMPLETION_VERBS: ['finished'],
}))

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => terminalSizeMock.size,
}))

function teammate(
  overrides: Partial<InProcessTeammateTaskState> = {},
): InProcessTeammateTaskState {
  return {
    awaitingPlanApproval: false,
    description: 'Review teammate work',
    id: 'tm-coverage',
    identity: {
      agentId: 'reviewer@coverage',
      agentName: 'reviewer',
      color: 'blue',
      parentSessionId: 'leader-session',
      planModeRequired: false,
      teamName: 'coverage',
    },
    isIdle: false,
    lastReportedTokenCount: 0,
    lastReportedToolCount: 0,
    messages: [],
    outputFile: '/tmp/tm-coverage.out',
    outputOffset: 0,
    pendingUserMessages: [],
    permissionMode: 'default',
    progress: {
      lastActivity: {
        activityDescription: 'Reading source files',
      },
      tokenCount: 1500,
      toolUseCount: 1,
    },
    prompt: 'Review this work',
    shutdownRequested: false,
    spinnerVerb: 'Reviewing',
    startTime: NOW - 73_000,
    status: 'running',
    totalPausedMs: 0,
    type: 'in_process_teammate',
    notified: false,
    ...overrides,
  }
}

async function renderLine(
  task: InProcessTeammateTaskState,
  props: Partial<React.ComponentProps<typeof TeammateSpinnerLine>> = {},
): Promise<string> {
  return renderToString(
    <TeammateSpinnerLine
      teammate={task}
      isLast={false}
      {...props}
    />,
    terminalSizeMock.size.columns,
  )
}

describe('TeammateSpinnerLine wave 086 coverage', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    terminalSizeMock.size = { columns: 120, rows: 24 }
    process.env.AGENC_TUI_GLYPHS = 'ascii'
  })

  it('renders teammate line statuses, hints, previews, and compact fallbacks', async () => {
    expect(getMessagePreview([], 80)).toEqual([])
    expect(
      getMessagePreview(
        [
          {
            type: 'assistant',
            message: {
              content: [
                null,
                {
                  type: 'tool_use',
                  name: 'Bash',
                  input: { command: 'npm test\nignored' },
                },
                {
                  type: 'text',
                  text: 'old note\n\nnewer note\nnewest note',
                },
                { type: 'text', text: 'not reached' },
              ],
            },
          },
          { type: 'system', message: { content: [] } },
        ] as never,
        12,
      ),
    ).toEqual(['newer note', 'newest note', 'npm test'])

    const activityOutput = await renderLine(
      teammate({
        messages: [
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  name: 'Read',
                  input: { description: 'Inspect source file' },
                },
              ],
            },
          },
        ] as never,
        progress: {
          recentActivities: [
            { isRead: true },
            { isSearch: true },
          ],
          tokenCount: 1500,
          toolUseCount: 1,
        },
      }),
      { isLast: true, showPreview: true },
    )
    expect(activityOutput).toContain('@reviewer')
    expect(activityOutput).toContain('Searching for 1 pattern')
    expect(activityOutput).toContain('reading 1 file')
    expect(activityOutput).toContain('1 tool use')
    expect(activityOutput).toContain('1.5k tokens')
    expect(activityOutput).toContain('Inspect source file')

    const selectedOutput = await renderLine(teammate(), {
      isForegrounded: false,
      isSelected: true,
    })
    expect(selectedOutput).toContain('@reviewer')
    expect(selectedOutput).toContain('shift +')
    expect(selectedOutput).toContain('enter to view')
    expect(selectedOutput).not.toContain('Reading source files')

    const stoppingOutput = await renderLine(
      teammate({ shutdownRequested: true }),
    )
    expect(stoppingOutput).toContain('[stopping]')

    const approvalOutput = await renderLine(
      teammate({ awaitingPlanApproval: true }),
    )
    expect(approvalOutput).toContain('[awaiting approval]')

    const idleOutput = await renderLine(teammate({ isIdle: true }))
    expect(idleOutput).toContain('Idle for 0s')

    const allIdleOutput = await renderLine(
      teammate({
        isIdle: true,
        pastTenseVerb: 'worked',
        totalPausedMs: 10_000,
      }),
      { allIdle: true, isLast: true },
    )
    expect(allIdleOutput).toContain('worked for 1m 3s')

    terminalSizeMock.size = { columns: 30, rows: 24 }
    const compactOutput = await renderLine(
      teammate({
        progress: undefined,
        spinnerVerb: undefined,
      }),
    )
    expect(compactOutput).toContain('Reviewing')
    expect(compactOutput).not.toContain('@reviewer')
    expect(compactOutput).not.toContain('tokens')
  })
})
