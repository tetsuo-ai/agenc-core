import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { AgentsList } from './AgentsList.js'

vi.mock('../../keybindings/useKeybinding.js', () => ({
  useKeybinding: () => undefined,
}))

vi.mock('src/tui/hooks/useExitOnCtrlCDWithKeybindings.js', () => ({
  useExitOnCtrlCDWithKeybindings: () => ({
    keyName: 'ctrl+c',
    pending: false,
  }),
}))

describe('AgentsList empty state', () => {
  test('does not repeat the no-agents headline in the body copy', async () => {
    const output = await renderToString(
      <AgentsList
        source="projectSettings"
        agents={[]}
        onBack={() => {}}
        onSelect={() => {}}
        onCreateNew={() => {}}
      />,
      100,
    )

    expect(output).toContain('No agents found')
    expect(output).toContain('Create specialized agents')
    expect(output).not.toContain('No agents found. Create specialized agents')
  })
})
