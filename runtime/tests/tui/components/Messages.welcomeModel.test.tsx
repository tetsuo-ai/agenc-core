import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Command } from '../../commands.js'
import type { Tools } from '../../tools/Tool.js'
import { renderToString } from '../../utils/staticRender.js'
import { AppStateProvider, getDefaultAppState } from '../state/AppState.js'
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
  conversationId: 'welcome-model-smoke',
  screen: 'main' as const,
  streamingToolUses: [],
}

// Regression for "welcome-model": LogoHeader used to render <WelcomeColdPanel />
// with no model prop, so the welcome/home box showed the literal placeholder
// "default model". The fix resolves the effective model (same source the
// footer uses, via useMainLoopModel) and threads it through. With an
// AppStateProvider whose session model is set, that concrete model must appear
// in the rendered welcome box -- and the placeholder must not.
describe('Messages welcome model wiring', () => {
  it('renders the configured session model in the welcome box', async () => {
    const initialState = {
      ...getDefaultAppState(),
      mainLoopModelForSession: 'grok-build-0.1',
    }

    const output = await renderToString(
      <AppStateProvider initialState={initialState}>
        <Messages {...baseProps} />
      </AppStateProvider>,
      120,
    )

    expect(output).toContain('a netrunner with hands on every file')
    expect(output).toContain('grok-build-0.1')
    expect(output).not.toContain('default model')
  })
})
