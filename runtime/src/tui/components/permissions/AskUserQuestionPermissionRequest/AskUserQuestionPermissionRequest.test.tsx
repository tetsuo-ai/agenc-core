import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../../utils/staticRender.js'

vi.mock('../../../hooks/useSettings', () => ({
  useSettings: () => ({ syntaxHighlightingDisabled: true }),
}))

vi.mock('../../../hooks/useTerminalSize', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}))

vi.mock('../../../state/AppState.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../state/AppState.js')>()
  return {
    ...actual,
    useAppState: (selector: (state: unknown) => unknown) =>
      selector({ toolPermissionContext: { mode: 'default' } }),
    useSetAppState: () => vi.fn(),
  }
})

vi.mock('../../../keybindings/useKeybinding.js', () => ({
  useKeybindings: vi.fn(),
}))

vi.mock('../../../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../../../ink.js')>(
    '../../../ink.js',
  )
  return {
    ...actual,
    useTheme: () => ['dark'],
  }
})

vi.mock('../PermissionPrompt', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  const { Text } = await vi.importActual<typeof import('../../../ink.js')>(
    '../../../ink.js',
  )
  return {
    PermissionPrompt: () => ReactActual.createElement(Text, null, 'Reject'),
  }
})

vi.mock('../PermissionPrompt.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  const { Text } = await vi.importActual<typeof import('../../../ink.js')>(
    '../../../ink.js',
  )
  return {
    PermissionPrompt: () => ReactActual.createElement(Text, null, 'Reject'),
  }
})

function makeProps(input: Record<string, unknown>) {
  return {
    toolUseConfirm: {
      input,
      tool: {
        name: 'AskUserQuestion',
        isMcp: false,
        userFacingName: () => 'AskUserQuestion',
      },
      assistantMessage: {
        message: { id: 'msg_1' },
      },
      description: '',
      toolUseContext: {},
      toolUseID: 'toolu_1',
      permissionResult: { behavior: 'ask' },
      permissionPromptStartTimeMs: 0,
      onUserInteraction: vi.fn(),
      onAbort: vi.fn(),
      onAllow: vi.fn(),
      onReject: vi.fn(),
      recheckPermission: vi.fn(),
    },
    toolUseContext: {},
    onDone: vi.fn(),
    onReject: vi.fn(),
    verbose: false,
    workerBadge: undefined,
  } as never
}

describe('AskUserQuestionPermissionRequest', () => {
  it('renders a visible rejection dialog for malformed input', async () => {
    const { AskUserQuestionPermissionRequest } = await import(
      './AskUserQuestionPermissionRequest.js'
    )

    const output = await renderToString(
      <AskUserQuestionPermissionRequest {...makeProps({ bad: true })} />,
      80,
    )

    expect(output).toContain('Invalid AskUserQuestion input')
    expect(output).toContain('Reject')
  })
})
