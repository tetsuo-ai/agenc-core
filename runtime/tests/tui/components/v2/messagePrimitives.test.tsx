import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { AppStateProvider } from '../../state/AppState.js'
import {
  RedactedThinkingMessage,
  ThinkingMessage,
  UserAgentNotificationMessage,
  UserChannelMessage,
  UserCommandMessage,
  UserMemoryInputMessage,
  UserResourceUpdateMessage,
} from './messagePrimitives.js'

const previousGlyphMode = process.env.AGENC_TUI_GLYPHS

afterEach(() => {
  if (previousGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = previousGlyphMode
  }
})

describe('v2 message primitives', () => {
  it('renders migrated user command rows through v2 message chrome', async () => {
    const output = await renderToString(
      <UserCommandMessage
        addMargin={false}
        param={{
          type: 'text',
          text: '<command-message>model</command-message><command-args>gpt-5</command-args>',
        }}
      />,
      80,
    )

    expect(output).toContain('COMMAND')
    expect(output).toContain('/model gpt-5')
  })

  it('renders migrated task notification rows through v2 worker chrome', async () => {
    const output = await renderToString(
      <AppStateProvider>
        <UserAgentNotificationMessage
          addMargin={false}
          param={{
            type: 'text',
            text: '<status>completed</status><summary>worker finished proof</summary>',
          }}
        />
      </AppStateProvider>,
      80,
    )

    expect(output).toContain('AGENT')
    expect(output).toContain('worker finished proof')
  })

  it('renders migrated MCP resource updates through v2 system chrome', async () => {
    const output = await renderToString(
      <UserResourceUpdateMessage
        addMargin={false}
        param={{
          type: 'text',
          text: '<mcp-resource-update server="local" uri="file:///tmp/context.md"><reason>changed</reason></mcp-resource-update>',
        }}
      />,
      100,
    )

    expect(output).toContain('MCP')
    expect(output).toContain('context.md')
    expect(output).toContain('changed')
  })

  it('renders migrated memory input rows through v2 system chrome', async () => {
    const output = await renderToString(
      <UserMemoryInputMessage
        addMargin={false}
        text="<user-memory-input>remember the local API port</user-memory-input>"
      />,
      80,
    )

    expect(output).toContain('MEMORY')
    expect(output).toContain('remember the local API port')
    expect(output).toContain('Noted.')
  })

  it('renders migrated channel rows through v2 worker chrome', async () => {
    const output = await renderToString(
      <UserChannelMessage
        addMargin={false}
        param={{
          type: 'text',
          text: '<channel source="plugin:slack-channel:slack" user="tetsuo">new deployment is ready</channel>',
        }}
      />,
      100,
    )

    expect(output).toContain('CHANNEL')
    expect(output).toContain('slack · tetsuo')
    expect(output).toContain('new deployment is ready')
  })

  it('uses ASCII thinking labels when ASCII glyph mode is requested', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const output = await renderToString(
      <AppStateProvider>
        <ThinkingMessage
          param={{ type: 'thinking', thinking: 'working' }}
          addMargin={false}
          isTranscriptMode={true}
          verbose={false}
        />
      </AppStateProvider>,
      80,
    )

    expect(output).toContain('Thinking...')
    expect(output).toContain('working')
    expect(output).not.toContain('∴')
    expect(output).not.toContain('…')
  })

  it('uses ASCII redacted-thinking labels when ASCII glyph mode is requested', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const output = await renderToString(
      <RedactedThinkingMessage addMargin={false} />,
      80,
    )

    expect(output).toContain('* Thinking...')
    expect(output).not.toContain('✻')
    expect(output).not.toContain('…')
  })
})
