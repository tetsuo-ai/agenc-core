import figures from 'figures'
import { describe, expect, it } from 'vitest'

import {
  describeTeammateActivity,
  getTaskStatusColor,
  getTaskStatusIcon,
  isTerminalStatus,
  shouldHideTasksFooter,
} from './taskStatusUtils.js'

type TaskStatus = Parameters<typeof isTerminalStatus>[0]
type TeammateTask = Parameters<typeof describeTeammateActivity>[0]

function teammate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'teammate-1',
    type: 'in_process_teammate',
    status: 'running',
    description: 'teammate',
    startTime: 1,
    outputFile: 'urn:agenc:task:teammate-1:output',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: 'teammate-1',
      agentName: 'worker',
      teamName: 'coverage',
      planModeRequired: false,
      parentSessionId: 'leader',
    },
    prompt: 'cover task status utils',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    isIdle: false,
    shutdownRequested: false,
    pendingUserMessages: [],
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    ...overrides,
  } as TeammateTask
}

describe('taskStatusUtils wave 200 item 050 coverage', () => {
  it('derives task status presentation, teammate activity, and hidden-footer state', () => {
    expect(['completed', 'failed', 'killed'].map(status =>
      isTerminalStatus(status as TaskStatus),
    )).toEqual([true, true, true])
    expect(['pending', 'running'].map(status =>
      isTerminalStatus(status as TaskStatus),
    )).toEqual([false, false])

    expect(getTaskStatusIcon('running', { hasError: true })).toBe(figures.cross)
    expect(getTaskStatusIcon('running', { awaitingApproval: true })).toBe(
      figures.questionMarkPrefix,
    )
    expect(getTaskStatusIcon('running', { shutdownRequested: true })).toBe(
      figures.warning,
    )
    expect(getTaskStatusIcon('running', { isIdle: true })).toBe(figures.ellipsis)
    expect(getTaskStatusIcon('running')).toBe(figures.play)
    expect(getTaskStatusIcon('completed')).toBe(figures.tick)
    expect(getTaskStatusIcon('failed')).toBe(figures.cross)
    expect(getTaskStatusIcon('killed')).toBe(figures.cross)
    expect(getTaskStatusIcon('pending')).toBe(figures.bullet)

    expect(getTaskStatusColor('running', { hasError: true })).toBe('error')
    expect(getTaskStatusColor('running', { awaitingApproval: true })).toBe(
      'warning',
    )
    expect(getTaskStatusColor('running', { shutdownRequested: true })).toBe(
      'warning',
    )
    expect(getTaskStatusColor('running', { isIdle: true })).toBe('background')
    expect(getTaskStatusColor('completed')).toBe('success')
    expect(getTaskStatusColor('failed')).toBe('error')
    expect(getTaskStatusColor('killed')).toBe('warning')
    expect(getTaskStatusColor('pending')).toBe('background')

    expect(describeTeammateActivity(teammate({ shutdownRequested: true }))).toBe(
      'stopping',
    )
    expect(describeTeammateActivity(teammate({ awaitingPlanApproval: true }))).toBe(
      'awaiting approval',
    )
    expect(describeTeammateActivity(teammate({ isIdle: true }))).toBe('idle')
    expect(describeTeammateActivity(teammate({
      progress: {
        recentActivities: [
          { activityDescription: 'editing src/app.ts' },
          { isSearch: true },
          { isRead: true },
        ],
      },
    }))).toMatch(/^Searching for 1 pattern, reading 1 file/)
    expect(describeTeammateActivity(teammate({
      progress: {
        lastActivity: { activityDescription: 'running checks' },
      },
    }))).toBe('running checks')
    expect(describeTeammateActivity(teammate())).toBe('working')

    expect(shouldHideTasksFooter({}, true)).toBe(false)
    expect(shouldHideTasksFooter({ teammate: teammate() }, false)).toBe(false)
    expect(shouldHideTasksFooter({ teammate: teammate() }, true)).toBe(true)
    expect(shouldHideTasksFooter({
      foreground: teammate({ status: 'completed' }),
      teammate: teammate(),
    }, true)).toBe(true)
    expect(shouldHideTasksFooter({
      teammate: teammate(),
      bash: {
        id: 'bash-1',
        type: 'local_bash',
        status: 'running',
        isBackgrounded: false,
      },
    }, true)).toBe(true)
    expect(shouldHideTasksFooter({
      teammate: teammate(),
      bash: {
        id: 'bash-1',
        type: 'local_bash',
        status: 'running',
      },
    }, true)).toBe(false)
  })
})
