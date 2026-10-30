import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, it, vi } from 'vitest'

const appStateMock = vi.hoisted(() => ({
  pendingWorkerRequest: undefined as undefined | { toolUseId: string },
  toolPermissionContext: { mode: 'default', strippedDangerousRules: undefined },
}))

vi.mock('../../utils/classifierApprovalsHook.js', () => ({
  useIsClassifierChecking: () => false,
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 160, rows: 24 }),
}))

vi.mock('../state/AppState.js', () => ({
  useAppStateMaybeOutsideOfProvider: (
    selector: (state: typeof appStateMock) => unknown,
  ) => selector(appStateMock),
}))

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({ syntaxHighlightingDisabled: true }),
}))

vi.mock('../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../ink.js')>('../ink.js')
  return { ...actual, useTheme: () => ['dark'] }
})

import type { Tool } from '../../tools/Tool.js'
import type { AgenCToolUseBlockParam } from '../../types/message.js'
import { renderToString } from '../../utils/staticRender.js'
import { createTuiTool } from '../tool-rendering.js'
import { AssistantToolUseMessage } from './AssistantToolUseMessage.js'
import { UserToolErrorMessage } from './UserToolResultMessage/UserToolErrorMessage.js'

const param: AgenCToolUseBlockParam = {
  type: 'tool_use',
  id: 'toolu_web_fetch',
  name: 'web_fetch',
  input: { url: 'https://example.com/busy' },
}

// What web_fetch returns when DeepSeek's fetch timed out and the local fetch
// then got an HTTP 503: an error result with the fallback reason.
const failedBoth = JSON.stringify({
  deepseek_fetch_fallback: 'timed out after 30s',
  status: 503,
  ok: false,
  url: 'https://example.com/busy',
  final_url: 'https://example.com/busy',
  content_type: 'text/plain',
  preapproved: false,
  rendered_as: 'passthrough',
  truncated: false,
  content: 'busy, try later',
})

const failedLookups = (content: string) => ({
  resolvedToolUseIDs: new Set([param.id]),
  erroredToolUseIDs: new Set([param.id]),
  toolResultByToolUseID: new Map([[param.id, { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: param.id, is_error: true, content },
  ] } }]]),
}) as never

describe('a failed web_fetch after a DeepSeek fallback', () => {
  it('names both fetches on the collapsed failed row', async () => {
    const tool = createTuiTool('web_fetch') as Tool
    const output = stripAnsi(await renderToString(<AssistantToolUseMessage
      param={param} addMargin={false} tools={[tool]} commands={[]} verbose={false}
      inProgressToolUseIDs={new Set()} progressMessagesForMessage={[]}
      shouldAnimate={false} shouldShowDot={false}
      lookups={failedLookups(failedBoth)}
    />, 160))
    expect(output).toContain('HTTP 503 via local fetch (DeepSeek fetch: timed out after 30s)')
    expect(output).not.toContain('deepseek_fetch_fallback')
  })

  it('shows the same line in the detached error result (verbose)', async () => {
    const tool = createTuiTool('web_fetch') as Tool
    const output = stripAnsi(await renderToString(<UserToolErrorMessage
      progressMessagesForMessage={[]}
      tool={tool}
      tools={[tool]}
      param={{ type: 'tool_result', tool_use_id: param.id, is_error: true, content: failedBoth }}
      verbose={false}
    />, 160))
    expect(output).toContain('HTTP 503 via local fetch (DeepSeek fetch: timed out after 30s)')

    const unreachable = JSON.stringify({
      deepseek_fetch_fallback: 'HTTP 402: Insufficient Balance',
      error: 'fetch failed: getaddrinfo ENOTFOUND example.com',
    })
    const both = stripAnsi(await renderToString(<UserToolErrorMessage
      progressMessagesForMessage={[]}
      tool={tool}
      tools={[tool]}
      param={{ type: 'tool_result', tool_use_id: param.id, is_error: true, content: unreachable }}
      verbose={false}
    />, 160))
    expect(both).toContain(
      'fetch failed: getaddrinfo ENOTFOUND example.com (DeepSeek fetch: HTTP 402: Insufficient Balance)',
    )
  })

  it('keeps the generic failure line when DeepSeek was not involved', async () => {
    const tool = createTuiTool('web_fetch') as Tool
    const output = stripAnsi(await renderToString(<AssistantToolUseMessage
      param={param} addMargin={false} tools={[tool]} commands={[]} verbose={false}
      inProgressToolUseIDs={new Set()} progressMessagesForMessage={[]}
      shouldAnimate={false} shouldShowDot={false}
      lookups={failedLookups(JSON.stringify({ error: 'fetch failed: getaddrinfo ENOTFOUND example.com' }))}
    />, 160))
    expect(output).toContain('getaddrinfo ENOTFOUND example.com')
    expect(output).not.toContain('via local fetch')
  })
})
