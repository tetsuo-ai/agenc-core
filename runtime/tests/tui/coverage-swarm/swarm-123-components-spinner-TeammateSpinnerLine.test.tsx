import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { InProcessTeammateTaskState } from '../../../src/tasks/InProcessTeammateTask/types.js'
import {
  computeTeammateActivityMaxWidth,
  computeTeammatePreviewTextWidth,
  getMessagePreview,
  TeammateSpinnerLine,
} from '../../../src/tui/components/spinner/TeammateSpinnerLine.js'
import { renderToString } from '../../../src/utils/staticRender.js'

const NOW = new Date('2026-05-20T12:00:00.000Z').getTime()
const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('lodash-es/sample.js', () => ({
  default: <T,>(items: readonly T[]) => items[0],
}))

vi.mock('../../../src/constants/spinnerVerbs.js', () => ({
  getSpinnerVerbs: () => ['Coordinating'],
}))

vi.mock('../../../src/constants/turnCompletionVerbs.js', () => ({
  TURN_COMPLETION_VERBS: ['finished'],
}))

function teammate(
  overrides: Partial<InProcessTeammateTaskState> = {},
): InProcessTeammateTaskState {
  return {
    awaitingPlanApproval: false,
    description: 'Review teammate progress',
    id: 'tm-row-123',
    identity: {
      agentId: 'reviewer@coverage',
      agentName: 'reviewer',
      color: 'green',
      parentSessionId: 'leader-session',
      planModeRequired: false,
      teamName: 'coverage',
    },
    isIdle: false,
    lastReportedTokenCount: 0,
    lastReportedToolCount: 0,
    messages: [],
    notified: false,
    outputFile: '/tmp/tm-row-123.log',
    outputOffset: 0,
    pendingUserMessages: [],
    permissionMode: 'default',
    progress: {
      lastActivity: {
        activityDescription: 'Reading project notes',
      },
      tokenCount: 2500,
      toolUseCount: 2,
    },
    prompt: 'Review the current work',
    shutdownRequested: false,
    spinnerVerb: 'Reviewing',
    startTime: NOW - 75_000,
    status: 'running',
    totalPausedMs: 0,
    type: 'in_process_teammate',
    ...overrides,
  }
}

async function renderLine(
  task: InProcessTeammateTaskState,
  props: Partial<React.ComponentProps<typeof TeammateSpinnerLine>> = {},
  columns = 120,
): Promise<string> {
  return renderToString(
    <TeammateSpinnerLine teammate={task} isLast={false} {...props} />,
    columns,
  )
}

describe('TeammateSpinnerLine coverage swarm row 123', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    process.env.AGENC_TUI_GLYPHS = 'ascii'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode
    }
  })

  test('clamps layout helpers and extracts previews from recent message content', () => {
    expect(computeTeammateActivityMaxWidth(40.9, 8, 10, 5)).toBe(16)
    expect(computeTeammateActivityMaxWidth(12, 8, 10, 5)).toBe(0)
    expect(computeTeammatePreviewTextWidth(12.9)).toBe(4)
    expect(computeTeammatePreviewTextWidth(7)).toBe(0)
    expect(getMessagePreview(undefined, 80)).toEqual([])

    expect(
      getMessagePreview(
        [
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'older line' }],
            },
          },
          {
            type: 'user',
            message: {
              content: [
                null,
                { type: 'tool_use', name: 'Grep', input: { pattern: 'needle' } },
                { type: 'text', text: 'first latest\n\nsecond latest' },
              ],
            },
          },
        ] as never,
        80,
      ),
    ).toEqual(['first latest', 'second latest', 'needle'])

    expect(
      getMessagePreview(
        [
          {
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', name: 'Notebook' }],
            },
          },
        ] as never,
        80,
      ),
    ).toEqual(['Using Notebook...'])
  })

  test('renders selected, foregrounded, and compact active teammate rows', async () => {
    const selected = await renderLine(teammate(), {
      isForegrounded: false,
      isSelected: true,
    })

    expect(selected).toContain('@reviewer')
    expect(selected).toContain('2 tool uses')
    expect(selected).toContain('2.5k tokens')
    expect(selected).toContain('shift +')
    expect(selected).toContain('enter to view')
    expect(selected).not.toContain('Reading project notes')

    const foregrounded = await renderLine(teammate(), {
      isForegrounded: true,
      isSelected: false,
    })

    expect(foregrounded).toContain('@reviewer')
    expect(foregrounded).toContain('shift +')
    expect(foregrounded).not.toContain('enter to view')
    expect(foregrounded).not.toContain('Reading project notes')

    const compact = await renderLine(
      teammate({ progress: undefined, spinnerVerb: undefined }),
      {},
      30,
    )

    expect(compact).toContain('Coordinating')
    expect(compact).not.toContain('@reviewer')
    expect(compact).not.toContain('tokens')
  })

  test('renders status precedence, idle durations, and preview continuation rows', async () => {
    const stopping = await renderLine(
      teammate({
        awaitingPlanApproval: true,
        isIdle: true,
        shutdownRequested: true,
      }),
    )

    expect(stopping).toContain('[stopping]')
    expect(stopping).not.toContain('[awaiting approval]')
    expect(stopping).not.toContain('Idle for')

    const awaitingApproval = await renderLine(
      teammate({ awaitingPlanApproval: true }),
    )
    expect(awaitingApproval).toContain('[awaiting approval]')

    const idle = await renderLine(teammate({ isIdle: true }))
    expect(idle).toContain('Idle for 0s')

    const allIdle = await renderLine(
      teammate({
        isIdle: true,
        pastTenseVerb: 'finished',
        startTime: NOW - 74_000,
        totalPausedMs: 10_000,
      }),
      { allIdle: true, isLast: true },
    )
    expect(allIdle).toContain('finished for 1m 4s')

    const preview = await renderLine(
      teammate({
        messages: [
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'opened file\nchecked branch' },
              ],
            },
          },
        ] as never,
      }),
      { showPreview: true },
    )

    expect(preview).toContain('Reading project notes')
    expect(preview).toContain('|   opened file')
    expect(preview).toContain('|   checked branch')
  })
})
