import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./utils/attachments.js', () => ({
  createAttachmentMessage: vi.fn(),
  filterDuplicateMemoryAttachments: vi.fn((value: unknown) => value),
  getAttachmentMessages: vi.fn(async () => []),
  startRelevantMemoryPrefetch: vi.fn(() => undefined),
}))

vi.mock('./query/config.js', () => ({
  buildQueryConfig: vi.fn(() => ({
    sessionId: 'session-under-test',
    gates: {
      streamingToolExecution: false,
      emitToolUseSummaries: false,
      isAnt: false,
      fastModeEnabled: false,
    },
  })),
}))

vi.mock('./utils/sessionStorage.js', () => ({
  recordContentReplacement: vi.fn(),
}))

const ENV_KEYS = [
  'AGENC_TRANSPORT',
  'CLAUDE_CODE_USE_CCR_V2',
  'CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2',
] as const

const originalEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

function minimalToolUseContext() {
  return {
    abortController: new AbortController(),
    options: {
      thinkingConfig: {},
      tools: [],
      isNonInteractiveSession: false,
      agentDefinitions: {
        activeAgents: [],
        allowedAgentTypes: [],
      },
    },
  }
}

describe('query transport selection', () => {
  it('surfaces the selected ladder mode on the live stream_request_start event', async () => {
    process.env.AGENC_TRANSPORT = 'hybrid'
    const { query } = await import('./query.ts')

    const iter = query({
      messages: [],
      systemPrompt: '',
      userContext: {},
      systemContext: {},
      canUseTool: () => true,
      toolUseContext: minimalToolUseContext(),
      querySource: 'user',
    } as never)

    const first = await iter.next()
    expect(first.done).toBe(false)
    expect(first.value).toEqual({
      type: 'stream_request_start',
      transportMode: 'hybrid',
    })

    await iter.return({ reason: 'cancelled' })
  })

  it('keeps the start event unannotated when the default websocket path is in effect', async () => {
    delete process.env.AGENC_TRANSPORT
    delete process.env.CLAUDE_CODE_USE_CCR_V2
    delete process.env.CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2

    const { query } = await import('./query.ts')
    const iter = query({
      messages: [],
      systemPrompt: '',
      userContext: {},
      systemContext: {},
      canUseTool: () => true,
      toolUseContext: minimalToolUseContext(),
      querySource: 'user',
    } as never)

    const first = await iter.next()
    expect(first.done).toBe(false)
    expect(first.value).toEqual({
      type: 'stream_request_start',
    })

    await iter.return({ reason: 'cancelled' })
  })
})
