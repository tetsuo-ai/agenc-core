import React from 'react'
import { describe, it, vi } from 'vitest'

import type { Command } from '../../commands.js'
import type { Tools } from '../../tools/Tool.js'
import { renderToString } from '../../utils/staticRender.js'
import { Messages } from './Messages.js'
import { makeAssistantTextMessage } from '../../../src/tui/session-transcript.js'

vi.mock('bun:bundle', () => ({ feature: () => false }))
vi.mock('../startup/StatusNotices.js', () => ({ StatusNotices: () => null }))
vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({ syntaxHighlightingDisabled: true }),
}))

const baseProps = {
  tools: [] as unknown as Tools,
  commands: [] as Command[],
  verbose: false,
  toolJSX: null,
  toolUseConfirmQueue: [],
  inProgressToolUseIDs: new Set<string>(),
  isMessageSelectorVisible: false,
  conversationId: 'probe',
  screen: 'main' as const,
  streamingToolUses: [],
}

describe('consecutive assistant notes probe', () => {
  it('three progress notes render on separate lines', async () => {
    const msgs = [
      makeAssistantTextMessage('Entering plan mode to design the approach.', 'u1'),
      makeAssistantTextMessage('Clarifying the goal and checking the workspace.', 'u2'),
      makeAssistantTextMessage('Workspace search hit a sandbox issue.', 'u3'),
    ]
    const output = await renderToString(
      <Messages {...baseProps} messages={msgs as never} />,
      120,
    )
    console.log('---RENDER---')
    console.log(output)
    console.log('---glued:', output.includes('approach.Clarifying'), '| separate:', output.includes('approach.\n') || output.includes('approach. '))
    console.log('---END---')
  })
})
