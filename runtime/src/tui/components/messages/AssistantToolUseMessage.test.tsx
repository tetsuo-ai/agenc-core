import type { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Tool } from '../../../tools/Tool.js'
import { renderToString } from '../../../utils/staticRender.js'
import { AssistantToolUseMessage } from './AssistantToolUseMessage.js'

const classifierMock = vi.hoisted(() => ({
  checking: false,
}))

const appStateMock = vi.hoisted(() => ({
  pendingWorkerRequest: undefined as undefined | { toolUseId: string },
  toolPermissionContext: {
    mode: 'default',
    strippedDangerousRules: undefined as undefined | Record<string, unknown>,
  },
}))

vi.mock('../../../utils/classifierApprovalsHook.js', () => ({
  useIsClassifierChecking: () => classifierMock.checking,
}))

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}))

vi.mock('../../state/AppState.js', () => ({
  useAppStateMaybeOutsideOfProvider: (
    selector: (state: typeof appStateMock) => unknown,
  ) => selector(appStateMock),
}))

vi.mock('../../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../../ink.js')>(
    '../../ink.js',
  )
  return {
    ...actual,
    useTheme: () => ['dark'],
  }
})

const param: ToolUseBlockParam = {
  type: 'tool_use',
  id: 'toolu_classifier',
  name: 'Bash',
  input: { command: 'echo hi' },
}

const tool = {
  name: 'Bash',
  inputSchema: {
    safeParse: (input: unknown) => ({ success: true, data: input }),
  },
  userFacingName: () => 'Bash',
  renderToolUseMessage: () => 'echo hi',
  renderToolUseProgressMessage: () => null,
} as unknown as Tool

const lookups = {
  resolvedToolUseIDs: new Set<string>(),
  erroredToolUseIDs: new Set<string>(),
} as never

async function renderClassifierToolUse(): Promise<string> {
  return renderToString(
    <AssistantToolUseMessage
      param={param}
      addMargin={false}
      tools={[tool]}
      commands={[]}
      verbose={false}
      inProgressToolUseIDs={new Set([param.id])}
      progressMessagesForMessage={[]}
      shouldAnimate={false}
      shouldShowDot={false}
      lookups={lookups}
    />,
    80,
  )
}

describe('AssistantToolUseMessage classifier progress', () => {
  beforeEach(() => {
    classifierMock.checking = true
    appStateMock.pendingWorkerRequest = undefined
    appStateMock.toolPermissionContext.mode = 'default'
    appStateMock.toolPermissionContext.strippedDangerousRules = undefined
  })

  it('shows bash classifier progress while checking', async () => {
    const output = await renderClassifierToolUse()

    expect(output).toContain('Bash classifier checking')
  })

  it('shows auto classifier progress while plan-mode stripped rules are checking', async () => {
    appStateMock.toolPermissionContext.mode = 'plan'
    appStateMock.toolPermissionContext.strippedDangerousRules = {}

    const output = await renderClassifierToolUse()

    expect(output).toContain('Auto classifier checking')
  })

  it('lets the permission wait row take precedence over classifier progress', async () => {
    appStateMock.pendingWorkerRequest = { toolUseId: param.id }

    const output = await renderClassifierToolUse()

    expect(output).toContain('Waiting for permission')
    expect(output).not.toContain('classifier checking')
  })
})
