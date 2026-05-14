import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../../utils/staticRender.js'

const promptProps = vi.hoisted(() => ({
  current: undefined as undefined | {
    onSelect: (value: string, feedback?: string) => void
    onCancel: () => void
  },
}))

const logUnaryPermissionEventMock = vi.hoisted(() => vi.fn())

vi.mock('../utils', () => ({
  logUnaryPermissionEvent: logUnaryPermissionEventMock,
}))

vi.mock('../hooks', () => ({
  usePermissionRequestLogging: () => {},
}))

vi.mock('../PermissionDialog', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  return {
    PermissionDialog: ({ children }: { children: React.ReactNode }) =>
      ReactActual.createElement(ReactActual.Fragment, null, children),
  }
})

vi.mock('../PermissionRuleExplanation', () => ({
  PermissionRuleExplanation: () => null,
}))

vi.mock('../PermissionPrompt', () => ({
  PermissionPrompt: (props: {
    onSelect: (value: string, feedback?: string) => void
    onCancel: () => void
  }) => {
    promptProps.current = props
    return null
  },
}))

vi.mock('../../../../bootstrap/state', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../bootstrap/state')>()
  return {
    ...actual,
    getOriginalCwd: () => '/tmp/agenc-monitor-test',
  }
})

vi.mock('../../../../utils/permissions/permissionsLoader', () => ({
  shouldShowAlwaysAllowOptions: () => true,
}))

function makeProps() {
  const toolUseConfirm = {
    input: {
      command: 'tail -f app.log',
      description: 'watch log output',
    },
    tool: {
      name: 'Monitor',
      isMcp: false,
      userFacingName: () => 'Monitor',
    },
    assistantMessage: {
      message: { id: 'msg_monitor' },
    },
    description: '',
    toolUseContext: {},
    toolUseID: 'toolu_monitor',
    permissionResult: { behavior: 'ask' },
    permissionPromptStartTimeMs: 0,
    onUserInteraction: vi.fn(),
    onAbort: vi.fn(),
    onAllow: vi.fn(),
    onReject: vi.fn(),
    recheckPermission: vi.fn(),
  }

  return {
    toolUseConfirm,
    toolUseContext: {},
    onDone: vi.fn(),
    onReject: vi.fn(),
    verbose: false,
    workerBadge: undefined,
  } as never
}

async function renderMonitorPermission() {
  const { MonitorPermissionRequest } = await import(
    './MonitorPermissionRequest.js'
  )
  const props = makeProps()

  await renderToString(<MonitorPermissionRequest {...props} />, 80)

  if (!promptProps.current) {
    throw new Error('PermissionPrompt was not rendered')
  }

  return props as any
}

describe('MonitorPermissionRequest analytics logging', () => {
  beforeEach(() => {
    promptProps.current = undefined
    logUnaryPermissionEventMock.mockClear()
  })

  it('logs allow selections with the helper signature', async () => {
    const props = await renderMonitorPermission()

    expect(() => promptProps.current!.onSelect('yes', 'approved')).not.toThrow()

    expect(logUnaryPermissionEventMock).toHaveBeenCalledWith(
      'tool_use_single',
      props.toolUseConfirm,
      'accept',
      true,
    )
  })

  it('logs always-allow selections with the helper signature', async () => {
    const props = await renderMonitorPermission()

    expect(() =>
      promptProps.current!.onSelect('yes-dont-ask-again'),
    ).not.toThrow()

    expect(logUnaryPermissionEventMock).toHaveBeenCalledWith(
      'tool_use_single',
      props.toolUseConfirm,
      'accept',
      false,
    )
  })

  it('logs deny selections with the helper signature', async () => {
    const props = await renderMonitorPermission()

    expect(() => promptProps.current!.onSelect('no', 'nope')).not.toThrow()

    expect(logUnaryPermissionEventMock).toHaveBeenCalledWith(
      'tool_use_single',
      props.toolUseConfirm,
      'reject',
      true,
    )
  })

  it('logs cancel with the helper signature', async () => {
    const props = await renderMonitorPermission()

    expect(() => promptProps.current!.onCancel()).not.toThrow()

    expect(logUnaryPermissionEventMock).toHaveBeenCalledWith(
      'tool_use_single',
      props.toolUseConfirm,
      'reject',
      false,
    )
  })
})
