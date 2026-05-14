import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../../utils/staticRender.js'

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
        name: 'Skill',
        isMcp: false,
        userFacingName: () => 'Skill',
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

describe('SkillPermissionRequest', () => {
  it('renders a visible rejection dialog when skill input is missing', async () => {
    const { SkillPermissionRequest } = await import('./SkillPermissionRequest.js')

    const output = await renderToString(
      <SkillPermissionRequest {...makeProps({})} />,
      80,
    )

    expect(output).toContain('Invalid Skill input')
    expect(output).toContain('Reject')
    expect(output).not.toContain('Use skill ""')
  })
})
