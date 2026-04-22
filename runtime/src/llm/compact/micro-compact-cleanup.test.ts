import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { Message } from '../../types/message.js'

const mocks = vi.hoisted(() => ({
  runPostCompactCleanup: vi.fn(),
}))

// `feature('CACHED_MICROCOMPACT')` must be true so the router enters the
// cached-MC branch (openclaude parity). Other feature flags default to false.
vi.mock('bun:bundle', () => ({
  feature: (name: string) => name === 'CACHED_MICROCOMPACT',
}))

vi.mock('./post-compact-cleanup.js', () => ({
  runPostCompactCleanup: mocks.runPostCompactCleanup,
}))

function assistantToolUse(
  id: string,
  name: string,
  timestamp: string,
): Message {
  return {
    type: 'assistant',
    timestamp,
    uuid: `assistant-${id}`,
    message: {
      id: `resp-${id}`,
      role: 'assistant',
      model: 'claude-sonnet-4',
      content: [{ type: 'tool_use', id, name, input: {} }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    costUSD: 0,
    durationMs: 0,
    requestId: `req-${id}`,
  } as Message
}

function userToolResult(id: string, content: string): Message {
  return {
    type: 'user',
    uuid: `user-${id}`,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
  } as Message
}

describe('microcompact cleanup wiring', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  test('time-based microcompact runs post-compact cleanup before returning', async () => {
    vi.doMock('../../services/analytics/growthbook.js', () => ({
      getFeatureValue_CACHED_MAY_BE_STALE: () => ({
        enabled: true,
        gapThresholdMinutes: 1,
        keepRecent: 1,
      }),
    }))

    const { microcompactMessages, TIME_BASED_MC_CLEARED_MESSAGE } =
      await import('./micro-compact.js')

    const old = new Date(Date.now() - 5 * 60_000).toISOString()
    const context = {
      clearProviderResponseId: vi.fn(),
    }
    const messages: Message[] = [
      assistantToolUse('tool-1', 'Read', old),
      userToolResult('tool-1', 'old tool output'),
      assistantToolUse('tool-2', 'Read', old),
      userToolResult('tool-2', 'recent tool output'),
    ]

    const result = await microcompactMessages(
      messages,
      context as never,
      'repl_main_thread',
    )

    expect(mocks.runPostCompactCleanup).toHaveBeenCalledWith(
      'repl_main_thread',
      context,
      undefined,
    )
    expect(
      ((result.messages[1] as any).message.content[0] as any).content,
    ).toBe(TIME_BASED_MC_CLEARED_MESSAGE)
    expect(
      ((result.messages[3] as any).message.content[0] as any).content,
    ).toBe('recent tool output')
  })

  test('cached microcompact preserves pending cache edits while still running cleanup', async () => {
    vi.doMock('../../services/analytics/growthbook.js', () => ({
      getFeatureValue_CACHED_MAY_BE_STALE: () => ({
        enabled: false,
        gapThresholdMinutes: 60,
        keepRecent: 5,
      }),
    }))
    vi.doMock('./cached-micro-compact.js', () => ({
      isCachedMicrocompactEnabled: () => true,
      isModelSupportedForCacheEditing: () => true,
      getCachedMCConfig: () => ({
        enabled: true,
        triggerThreshold: 0,
        keepRecent: 1,
        supportedModels: ['claude-sonnet-4'],
        systemPromptSuggestSummaries: false,
      }),
      createCachedMCState: () => ({
        triggerThreshold: 0,
        keepRecent: 1,
        registeredTools: new Set<string>(),
        toolOrder: [],
        deletedRefs: new Set<string>(),
        pinnedEdits: [],
      }),
      resetCachedMCState: vi.fn(),
      registerToolResult: (state: any, toolUseId: string) => {
        state.registeredTools.add(toolUseId)
        state.toolOrder.push(toolUseId)
      },
      registerToolMessage: vi.fn(),
      getToolResultsToDelete: () => ['tool-1'],
      createCacheEditsBlock: () => ({
        type: 'cache_edits',
        edits: [{ type: 'delete', cache_reference: 'tool-1' }],
      }),
      markToolsSentToAPI: vi.fn(),
    }))

    const { microcompactMessages } = await import('./micro-compact.js')

    const context = {
      options: { mainLoopModel: 'claude-sonnet-4' },
      clearProviderResponseId: vi.fn(),
    }
    const messages: Message[] = [
      assistantToolUse('tool-1', 'Read', new Date().toISOString()),
      userToolResult('tool-1', 'tool output'),
    ]

    const result = await microcompactMessages(
      messages,
      context as never,
      'repl_main_thread',
    )

    expect(mocks.runPostCompactCleanup).toHaveBeenCalledWith(
      'repl_main_thread',
      context,
      { preserveMicrocompactState: true },
    )
    expect(result.compactionInfo?.pendingCacheEdits).toEqual({
      trigger: 'auto',
      deletedToolIds: ['tool-1'],
      baselineCacheDeletedTokens: 0,
    })
  })
})
