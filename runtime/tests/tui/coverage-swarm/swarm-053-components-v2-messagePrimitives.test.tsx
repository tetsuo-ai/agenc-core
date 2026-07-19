import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { AppStateProvider } from '../state/AppState.js'
import {
  PlanMessage,
  ShellInputMessage,
  ThinkingMessage,
  UserAgentNotificationMessage,
  UserChannelMessage,
  UserCommandMessage,
  UserImageMessage,
  UserMemoryInputMessage,
  UserResourceUpdateMessage,
} from '../components/v2/messagePrimitives.js'

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

afterEach(() => {
  if (originalGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = originalGlyphMode
  }
})

function textParam(text: string): { readonly type: 'text'; readonly text: string } {
  return { type: 'text', text }
}

function renderWithAppState(
  node: React.ReactNode,
  width = 100,
): Promise<string> {
  return renderToString(<AppStateProvider>{node}</AppStateProvider>, width)
}

describe('messagePrimitives coverage swarm 053', () => {
  it('returns null for text markers and thinking content that are absent', () => {
    expect(
      ShellInputMessage({
        addMargin: false,
        param: textParam('plain text'),
      }),
    ).toBeNull()
    expect(
      UserCommandMessage({
        addMargin: false,
        param: textParam('<command-args>ignored</command-args>'),
      }),
    ).toBeNull()
    expect(
      UserAgentNotificationMessage({
        addMargin: false,
        param: textParam('<status>completed</status>'),
      }),
    ).toBeNull()
    expect(
      UserResourceUpdateMessage({
        addMargin: false,
        param: textParam('<mcp-resource-update />'),
      }),
    ).toBeNull()
    expect(
      UserMemoryInputMessage({
        addMargin: false,
        text: '<memory>missing user-memory marker</memory>',
      }),
    ).toBeNull()
    expect(
      UserChannelMessage({
        addMargin: false,
        param: textParam('<channel>missing source</channel>'),
      }),
    ).toBeNull()
    expect(
      ThinkingMessage({
        param: { type: 'thinking', thinking: '' },
        addMargin: false,
        isTranscriptMode: false,
        verbose: false,
      }),
    ).toBeNull()
    expect(
      ThinkingMessage({
        param: { type: 'thinking', thinking: 'hidden by transcript option' },
        addMargin: false,
        isTranscriptMode: true,
        verbose: true,
        hideInTranscript: true,
      }),
    ).toBeNull()
  })

  it('renders command, shell, image, and notification variants', async () => {
    const output = await renderToString(
      <>
        <ShellInputMessage
          addMargin={true}
          param={textParam(
            '<bash-input>npm test -- --runInBand &lt;ci&gt; &amp;</bash-input>',
          )}
        />
        <UserCommandMessage
          addMargin={true}
          param={textParam(
            '<command-message>lint</command-message><skill-format>true</skill-format>',
          )}
        />
        <UserCommandMessage
          addMargin={false}
          param={textParam('<command-message>status</command-message>')}
        />
        <UserImageMessage imageId={53} addMargin={true} />
        <UserAgentNotificationMessage
          addMargin={true}
          param={textParam(
            '<status>failed</status><summary>worker failed checks</summary>',
          )}
        />
        <UserAgentNotificationMessage
          addMargin={false}
          param={textParam(
            '<status>killed</status><summary>worker was stopped</summary>',
          )}
        />
        <UserAgentNotificationMessage
          addMargin={false}
          param={textParam('<status>running</status><summary>worker queued</summary>')}
        />
      </>,
      120,
    )

    expect(output).toContain('SHELL')
    expect(output).toContain('! npm test -- --runInBand <ci> &')
    expect(output).toContain('SKILL')
    expect(output).toContain('$lint')
    expect(output).toContain('/status')
    expect(output).toContain('IMAGE')
    expect(output).toContain('#53')
    expect(output).toContain('worker failed checks')
    expect(output).toContain('worker was stopped')
    expect(output).toContain('worker queued')
  })

  it('renders resource and polling updates with target formatting branches', async () => {
    const longTarget = `https://example.test/${'segment-'.repeat(8)}tail`
    const fileOutput = await renderToString(
      <UserResourceUpdateMessage
        addMargin={true}
        param={textParam(
          '<mcp-resource-update server="files" uri="file:///tmp/"></mcp-resource-update>',
        )}
      />,
      140,
    )
    const shortOutput = await renderToString(
      <UserResourceUpdateMessage
        addMargin={false}
        param={textParam(
          '<mcp-resource-update server="cache" uri="urn:short"></mcp-resource-update>',
        )}
      />,
      140,
    )
    const longOutput = await renderToString(
      <UserResourceUpdateMessage
        addMargin={false}
        param={textParam(
          `<mcp-resource-update server="remote" uri="${longTarget}"><reason>refreshed</reason></mcp-resource-update>`,
        )}
      />,
      140,
    )
    const pollingOutput = await renderToString(
      <UserResourceUpdateMessage
        addMargin={false}
        param={textParam(
          '<mcp-polling-update type="tools" server="github" tool="list_issues"><reason>polling now</reason></mcp-polling-update>',
        )}
      />,
      140,
    )
    const adjacentOutput = await renderToString(
      <UserResourceUpdateMessage
        addMargin={false}
        param={textParam(
          '<mcp-resource-update server="one" uri="urn:one"><reason>first</reason></mcp-resource-update><mcp-resource-update server="two" uri="urn:two"><reason>second</reason></mcp-resource-update>',
        )}
      />,
      140,
    )
    const output = [
      fileOutput,
      shortOutput,
      longOutput,
      pollingOutput,
      adjacentOutput,
    ].join('\n')

    expect(output).toContain('MCP')
    expect(output).toContain('files:')
    expect(output).toContain('/tmp/')
    expect(output).toContain('cache:')
    expect(output).toContain('urn:short')
    expect(output).toContain('remote:')
    expect(output).toContain(longTarget.slice(0, 39))
    expect(output).not.toContain(longTarget)
    expect(output).toContain('refreshed')
    expect(output).toContain('github:')
    expect(output).toContain('list_issues')
    expect(output).toContain('polling now')
    expect(output).toContain('one:')
    expect(output).toContain('urn:one')
    expect(output).toContain('first')
    expect(output).toContain('two:')
    expect(output).toContain('urn:two')
    expect(output).toContain('second')
  })

  it('renders memory, channel, and standalone plan formatting branches', async () => {
    const output = await renderWithAppState(
      <>
        <UserMemoryInputMessage
          addMargin={true}
          text="<user-memory-input>keep the API token local</user-memory-input>"
        />
        <UserChannelMessage
          addMargin={true}
          param={textParam(
            '<channel source="irc">one\n   two   three</channel>',
          )}
        />
        <UserChannelMessage
          addMargin={false}
          param={textParam(
            `<channel source="plugin:chat:ops" user="sam">${'abcdef'.repeat(
              12,
            )}</channel>`,
          )}
        />
        <PlanMessage addMargin={true} planContent="1. Keep the test scoped" />
      </>,
      120,
    )

    expect(output).toContain('MEMORY')
    expect(output).toContain('keep the API token local')
    expect(output).toContain('Noted.')
    expect(output).toContain('CHANNEL')
    expect(output).toContain('irc:')
    expect(output).toContain('one two three')
    expect(output).toContain('ops · sam')
    expect(output).not.toContain('abcdef'.repeat(12))
    expect(output).toContain('PLAN TO IMPLEMENT')
    expect(output).toContain('Keep the test scoped')
  })

  it('renders collapsed and verbose thinking branches', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const collapsed = await renderWithAppState(
      <ThinkingMessage
        param={{ type: 'thinking', thinking: 'private chain of thought' }}
        addMargin={true}
        isTranscriptMode={false}
        verbose={false}
      />,
    )
    const verbose = await renderWithAppState(
      <ThinkingMessage
        param={{ type: 'thinking', thinking: 'visible reasoning summary' }}
        addMargin={false}
        isTranscriptMode={false}
        verbose={true}
      />,
    )

    // Collapsed streaming hint is just the expand affordance — the activity
    // spinner already says "thinking", so the row intentionally omits the
    // "Thinking" word and glyph (UX request; see ThinkingMessage).
    expect(collapsed).not.toContain('Thinking')
    expect(collapsed).toContain('ctrl+o')
    expect(collapsed).not.toContain('private chain of thought')
    expect(verbose).toContain('Thinking...')
    expect(verbose).toContain('visible reasoning summary')
  })
})
