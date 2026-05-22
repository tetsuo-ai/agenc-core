import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Command } from '../../commands.js'
import type { Tools } from '../../tools/Tool.js'
import { renderToString } from '../../utils/staticRender.js'
import { Messages } from './Messages.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../startup/StatusNotices.js', () => ({
  StatusNotices: () => null,
}))

const baseProps = {
  messages: [],
  tools: [] as unknown as Tools,
  commands: [] as Command[],
  verbose: false,
  toolJSX: null,
  toolUseConfirmQueue: [],
  inProgressToolUseIDs: new Set<string>(),
  isMessageSelectorVisible: false,
  conversationId: 'welcome-smoke',
  screen: 'main' as const,
  streamingToolUses: [],
}

describe('Messages welcome state', () => {
  it('renders the v2 cold-start welcome panel for an empty transcript', async () => {
    const output = await renderToString(<Messages {...baseProps} />, 120)

    expect(output).toContain('agenc.')
    expect(output).toContain('a netrunner with hands on every file')
    expect(output).toContain('workspace')
    expect(output).toContain('recent')
    expect(output).not.toContain('18.40')
    expect(output).not.toContain('/claim')
  })

  it('does not render the welcome panel when hidden by the caller', async () => {
    const output = await renderToString(<Messages {...baseProps} hideLogo={true} />, 120)

    expect(output).not.toContain('a netrunner with hands on every file')
    expect(output).not.toContain('/claim')
  })
})
