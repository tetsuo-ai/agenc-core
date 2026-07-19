import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Command } from '../../commands.js'
import type { Tools } from '../../tools/Tool.js'
import { renderToString } from '../../utils/staticRender.js'
import {
  getDefaultMainLoopModelSetting,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import { ContentWidthProvider } from '../context/contentWidthContext.js'
import { stringWidth } from '../ink/stringWidth.js'
import { Messages } from './Messages.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../startup/StatusNotices.js', () => ({
  StatusNotices: () => null,
}))

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
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
    expect(output).toContain(
      parseUserSpecifiedModel(getDefaultMainLoopModelSetting()),
    )
    expect(output).not.toContain('default model')
    expect(output).toContain('workspace')
    // The recent card renders only with real session data (see the
    // WelcomeColdPanel comment: a fabricated resume list is worse than no
    // card at all); an empty transcript passes no recentSessions, so the
    // "recent" section must not appear.
    expect(output).not.toContain('recent')
    expect(output).not.toContain('18.40')
    expect(output).not.toContain('/claim')
  })

  it('does not render the welcome panel when hidden by the caller', async () => {
    const output = await renderToString(<Messages {...baseProps} hideLogo={true} />, 120)

    expect(output).not.toContain('a netrunner with hands on every file')
    expect(output).not.toContain('/claim')
  })

  it('keeps streaming markdown inside the inherited message content width', async () => {
    const output = await renderToString(
      <ContentWidthProvider width={50}>
        <Messages
          {...baseProps}
          hideLogo={true}
          streamingText={[
            '| Contract Row | Status | Evidence |',
            '| --- | --- | --- |',
            '| Row 1 - provider-boundary | Implemented | types.ts defines full BufferEditorProvider plus seven capability flags and provider selection wiring. |',
            '| Row 2 - neovim-discovery | Scaffolding present | NeovimDiscovery implements binary detection, version checks, fallback reason codes, and runtime module discovery. |',
          ].join('\n')}
        />
      </ContentWidthProvider>,
      { columns: 120, rows: 24 },
    )

    expect(output).toContain('Contract Row:')
    for (const line of output.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(50)
    }
  })
})
