import { describe, expect, it, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

import { shouldRenderStatically } from './Messages.js'

function lookups(
  resolvedToolUseIDs: string[] = [],
  inProgressPostHooks: string[] = [],
) {
  return {
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(
      inProgressPostHooks.map(id => [id, new Map([['PostToolUse', 1]])]),
    ),
    resolvedHookCounts: new Map(),
    toolResultByToolUseID: new Map(),
    toolUseByToolUseID: new Map(),
    normalizedMessageCount: 0,
    resolvedToolUseIDs: new Set(resolvedToolUseIDs),
    erroredToolUseIDs: new Set(),
  } as Parameters<typeof shouldRenderStatically>[5]
}

const emptyIDs = new Set<string>()

describe('shouldRenderStatically', () => {
  it('keeps unresolved tool, hook, and grouped rows dynamic on the main screen', () => {
    const settledLookups = lookups([
      'server-done',
      'tool-done',
      'tool-sibling',
      'group-one',
      'group-two',
    ])
    const pendingHookLookups = lookups(['tool-hook'], ['tool-hook'])

    expect(
      shouldRenderStatically(
        { subtype: 'api_error', type: 'system', uuid: 'api-error' } as never,
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'transcript',
        settledLookups,
      ),
    ).toBe(true)

    expect(
      shouldRenderStatically(
        {
          message: { content: [{ id: 'server-done', type: 'server_tool_use' }] },
          type: 'assistant',
          uuid: 'server-done-message',
        } as never,
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'main',
        settledLookups,
      ),
    ).toBe(true)
    expect(
      shouldRenderStatically(
        {
          message: { content: [{ id: 'server-pending', type: 'server_tool_use' }] },
          type: 'assistant',
          uuid: 'server-pending-message',
        } as never,
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'main',
        settledLookups,
      ),
    ).toBe(false)

    expect(
      shouldRenderStatically(
        {
          message: { content: [{ id: 'tool-streaming', type: 'tool_use' }] },
          type: 'assistant',
          uuid: 'streaming-tool-message',
        } as never,
        new Set(['tool-streaming']),
        emptyIDs,
        emptyIDs,
        'main',
        settledLookups,
      ),
    ).toBe(false)
    expect(
      shouldRenderStatically(
        {
          message: { content: [{ id: 'tool-running', type: 'tool_use' }] },
          type: 'assistant',
          uuid: 'running-tool-message',
        } as never,
        emptyIDs,
        new Set(['tool-running']),
        emptyIDs,
        'main',
        settledLookups,
      ),
    ).toBe(false)

    expect(
      shouldRenderStatically(
        {
          message: {
            content: [{ tool_use_id: 'tool-hook', type: 'tool_result' }],
          },
          type: 'user',
          uuid: 'hooked-tool-result',
        } as never,
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'main',
        pendingHookLookups,
      ),
    ).toBe(false)
    expect(
      shouldRenderStatically(
        {
          message: {
            content: [{ tool_use_id: 'tool-done', type: 'tool_result' }],
          },
          type: 'user',
          uuid: 'settled-tool-result',
        } as never,
        emptyIDs,
        emptyIDs,
        new Set(['tool-done', 'tool-sibling']),
        'main',
        settledLookups,
      ),
    ).toBe(true)
    expect(
      shouldRenderStatically(
        {
          message: {
            content: [{ tool_use_id: 'tool-done', type: 'tool_result' }],
          },
          type: 'user',
          uuid: 'missing-sibling-result',
        } as never,
        emptyIDs,
        emptyIDs,
        new Set(['tool-done', 'missing-sibling']),
        'main',
        settledLookups,
      ),
    ).toBe(false)

    expect(
      shouldRenderStatically(
        { subtype: 'api_error', type: 'system', uuid: 'main-api-error' } as never,
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'main',
        settledLookups,
      ),
    ).toBe(false)
    expect(
      shouldRenderStatically(
        { subtype: 'notice', type: 'system', uuid: 'notice' } as never,
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'main',
        settledLookups,
      ),
    ).toBe(true)

    expect(
      shouldRenderStatically(
        {
          messages: [
            { message: { content: [{ id: 'group-one', type: 'tool_use' }] } },
            { message: { content: [{ id: 'group-two', type: 'tool_use' }] } },
          ],
          type: 'grouped_tool_use',
          uuid: 'settled-group',
        } as never,
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'main',
        settledLookups,
      ),
    ).toBe(true)
    expect(
      shouldRenderStatically(
        {
          messages: [
            { message: { content: [{ id: 'group-one', type: 'tool_use' }] } },
            { message: { content: [{ id: 'group-pending', type: 'tool_use' }] } },
          ],
          type: 'grouped_tool_use',
          uuid: 'pending-group',
        } as never,
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'main',
        settledLookups,
      ),
    ).toBe(false)

    expect(
      shouldRenderStatically(
        { messages: [], type: 'collapsed_read_search', uuid: 'collapsed' } as never,
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'main',
        settledLookups,
      ),
    ).toBe(false)
  })
})
