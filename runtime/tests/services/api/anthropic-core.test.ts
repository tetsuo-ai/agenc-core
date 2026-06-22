import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resetStateForTests, setPromptCache1hAllowlist, setPromptCache1hEligible } from '../../../src/bootstrap/state.ts'
import {
  accumulateUsage,
  cleanupStream,
  getAPIMetadata,
  getCacheControl,
  getMaxOutputTokensForModel,
  queryHaiku,
  queryModelWithStreaming,
  queryWithModel,
  updateUsage,
  verifyApiKey,
} from '../../../src/services/api/anthropic.ts'
import { asSystemPrompt } from '../../../src/utils/systemPromptType.ts'

type AnyRecord = Record<string, any>

const harness = vi.hoisted(() => {
  class MockCannotRetryError extends Error {
    constructor(
      public readonly originalError: unknown,
      public readonly retryContext: AnyRecord,
    ) {
      super(
        originalError instanceof Error ? originalError.message : String(originalError),
      )
    }
  }

  class MockFallbackTriggeredError extends Error {}

  const usage = () => ({
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    output_tokens_details: {
      thinking_tokens: 0,
    },
    server_tool_use: {
      web_search_requests: 0,
      web_fetch_requests: 0,
    },
    service_tier: null,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: null,
    iterations: 0,
    speed: null,
  })

  const state: AnyRecord = {
    createCalls: [],
    getClientCalls: [],
    streamEvents: [],
    responseHeaders: {},
    requestId: 'req_stream_1',
    createError: undefined,
    nonStreamingResponse: undefined,
    logAPIError: vi.fn(),
    logAPISuccessAndDuration: vi.fn(),
    logAPIQuery: vi.fn(),
    logForDebugging: vi.fn(),
    captureAPIRequest: vi.fn(),
    recordUsageCacheStats: vi.fn(),
    addToTotalSessionCost: vi.fn(() => 0),
    calculateUSDCost: vi.fn(() => 0),
    enabledFeatures: new Set<string>(),
    cachedMicrocompactEnabled: false,
    cachedMicrocompactModelSupported: true,
    pendingCacheEdits: null,
    pinnedCacheEdits: [],
    pinCacheEdits: vi.fn(),
  }

  const makeStream = (events: AnyRecord[]) => ({
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event
      }
    },
  })

  state.client = {
    beta: {
      messages: {
        create: vi.fn((params: AnyRecord, options?: AnyRecord) => {
          state.createCalls.push({ params, options })
          if (state.createError) {
            throw state.createError
          }
          if (params.stream) {
            return {
              withResponse: async () => ({
                data: makeStream(state.streamEvents),
                request_id: state.requestId,
                response: new Response('', {
                  headers: state.responseHeaders,
                }),
              }),
            }
          }
          return Promise.resolve(
            state.nonStreamingResponse ?? {
              id: 'msg_nonstream',
              type: 'message',
              role: 'assistant',
              model: params.model,
              content: [{ type: 'text', text: 'nonstream ok' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: usage(),
            },
          )
        }),
      },
    },
  }

  state.getproviderClient = vi.fn(async (options: AnyRecord) => {
    state.getClientCalls.push(options)
    return state.client
  })

  state.withRetry = async function* (
    getClient: () => Promise<unknown>,
    operation: (
      client: unknown,
      attempt: number,
      context: AnyRecord,
    ) => Promise<unknown>,
    options: AnyRecord,
  ) {
    const client = await getClient()
    return await operation(client, 1, {
      model: options.model,
      thinkingConfig: options.thinkingConfig,
      fastMode: options.fastMode,
    })
  }

  state.CannotRetryError = MockCannotRetryError
  state.FallbackTriggeredError = MockFallbackTriggeredError
  state.usage = usage
  return state
})

vi.mock('bun:bundle', () => ({
  feature: (name: string) => harness.enabledFeatures.has(name),
}))

vi.mock('../../../src/constants/system.js', () => ({
  getAttributionHeader: (fingerprint: string) => `attr:${fingerprint}`,
  getCLISyspromptPrefix: () => 'system-prefix',
}))

vi.mock('../../../src/services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  getproviderClient: harness.getproviderClient,
}))

vi.mock('../../../src/services/api/withRetry.js', () => ({
  CannotRetryError: harness.CannotRetryError,
  FallbackTriggeredError: harness.FallbackTriggeredError,
  getDefaultMaxRetries: () => 10,
  is529Error: (error: AnyRecord) => error?.status === 529,
  withRetry: harness.withRetry,
}))

vi.mock('../../../src/services/vcr.js', () => ({
  withStreamingVCR: async function* (
    _messages: unknown[],
    run: () => AsyncGenerator<unknown, void>,
  ) {
    yield* run()
  },
  withVCR: async (_messages: unknown[], run: () => Promise<unknown[]>) => run(),
}))

vi.mock('../../../src/utils/model/providers.js', () => ({
  getAPIProvider: () => 'firstParty',
  isFirstPartyproviderBaseUrl: () => true,
  isGithubNativeproviderMode: () => false,
}))

vi.mock('../../../src/utils/auth.js', () => ({
  getOauthAccountInfo: () => null,
  isAgenCAISubscriber: () => false,
}))

vi.mock('../../../src/utils/config.js', () => ({
  getOrCreateUserID: () => 'user-test-id',
}))

vi.mock('../../../src/utils/context.js', () => ({
  CAPPED_DEFAULT_MAX_TOKENS: 8192,
  getMaxThinkingTokensForModel: () => 2048,
  getModelMaxOutputTokens: () => ({
    default: 4096,
    upperLimit: 128000,
  }),
  getSonnet1mExpTreatmentEnabled: () => false,
}))

vi.mock('../../../src/utils/model/model.js', () => ({
  getDefaultOpusModel: () => 'opus-default',
  getDefaultSonnetModel: () => 'sonnet-default',
  getSmallFastModel: () => 'small-fast-model',
  isNonCustomOpusModel: () => false,
  normalizeModelStringForAPI: (model: string) => `normalized-${model}`,
  parseUserSpecifiedModel: (model: string) => model,
}))

vi.mock('../../../src/utils/betas.js', () => ({
  getMergedBetas: () => ['base-beta'],
  getModelBetas: () => ['model-beta'],
  getToolSearchBetaHeader: () => 'tool-search-beta',
  modelSupportsStructuredOutputs: () => true,
  shouldIncludeFirstPartyOnlyBetas: () => true,
  shouldUseGlobalCacheScope: () => false,
}))

vi.mock('../../../src/utils/effort.js', () => ({
  modelSupportsEffort: () => true,
  resolveAppliedEffort: (_model: string, effort: unknown) => effort,
}))

vi.mock('../../../src/utils/fastMode.js', () => ({
  isFastModeAvailable: () => false,
  isFastModeCooldown: () => false,
  isFastModeEnabled: () => false,
  isFastModeSupportedByModel: () => true,
}))

vi.mock('../../../src/utils/advisor.js', () => ({
  ADVISOR_TOOL_INSTRUCTIONS: 'advisor instructions',
  getExperimentAdvisorModels: () => undefined,
  isAdvisorEnabled: () => false,
  isValidAdvisorModel: () => true,
  modelSupportsAdvisor: () => true,
}))

vi.mock('../../../src/utils/toolSearch.js', () => ({
  extractDiscoveredToolNames: () => new Set<string>(),
  isDeferredToolsDeltaEnabled: () => false,
  isToolSearchEnabled: async () => false,
}))

vi.mock('../../../src/tools/ToolSearchTool/prompt.js', () => ({
  TOOL_SEARCH_TOOL_NAME: 'ToolSearch',
  formatDeferredToolLine: (tool: AnyRecord) => tool.name,
  isDeferredTool: (tool: AnyRecord) => tool.defer_loading === true,
}))

vi.mock('../../../src/utils/api.js', () => ({
  logAPIPrefix: vi.fn(),
  splitSysPromptPrefix: (systemPrompt: readonly string[]) =>
    systemPrompt.map(text => ({ text, cacheScope: null })),
  toolToAPISchema: async (tool: AnyRecord) => ({
    name: tool.name,
    description: 'tool',
    input_schema: { type: 'object' },
  }),
}))

vi.mock('../../../src/utils/messages.js', () => ({
  createAssistantAPIErrorMessage: ({ content, apiError, error }: AnyRecord) => ({
    type: 'assistant',
    isApiErrorMessage: true,
    apiError,
    error,
    message: {
      role: 'assistant',
      model: 'error-model',
      content: [{ type: 'text', text: content }],
      stop_reason: null,
      usage: harness.usage(),
    },
  }),
  createUserMessage: ({ content, isMeta }: AnyRecord) => ({
    type: 'user',
    isMeta,
    message: { role: 'user', content },
  }),
  ensureToolResultPairing: (messages: unknown[]) => messages,
  normalizeContentFromAPI: (content: unknown[]) => content,
  normalizeMessagesForAPI: (messages: unknown[]) => messages,
  stripAdvisorBlocks: (messages: unknown[]) => messages,
  stripCallerFieldFromAssistantMessage: (message: unknown) => message,
  stripToolReferenceBlocksFromUserMessage: (message: unknown) => message,
}))

vi.mock('../../../src/services/api/errors.js', () => ({
  API_ERROR_MESSAGE_PREFIX: 'API Error',
  CUSTOM_OFF_SWITCH_MESSAGE: 'off switch',
  getAssistantMessageFromError: (error: unknown, model: string) => ({
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      model,
      content: [
        {
          type: 'text',
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      stop_reason: null,
      usage: harness.usage(),
    },
  }),
  getErrorMessageIfRefusal: () => null,
}))

vi.mock('../../../src/utils/fingerprint.js', () => ({
  computeFingerprintFromMessages: () => 'fingerprint',
}))

vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: harness.logForDebugging,
}))

vi.mock('../../../src/utils/log.js', () => ({
  captureAPIRequest: harness.captureAPIRequest,
  logError: vi.fn(),
}))

vi.mock('../../../src/services/api/logging.js', () => ({
  EMPTY_USAGE: harness.usage(),
  logAPIError: harness.logAPIError,
  logAPIQuery: harness.logAPIQuery,
  logAPISuccessAndDuration: harness.logAPISuccessAndDuration,
}))

vi.mock('../../../src/services/agencAiLimits.js', () => ({
  currentLimits: { isUsingOverage: false },
  extractQuotaStatusFromError: vi.fn(),
  extractQuotaStatusFromHeaders: vi.fn(),
}))

vi.mock('../../../src/services/compact/apiMicrocompact.js', () => ({
  getAPIContextManagement: () => null,
}))

vi.mock('../../../src/services/compact/cachedMicrocompact.js', () => ({
  getCachedMCConfig: () => ({ supportedModels: ['test-model'] }),
  isCachedMicrocompactEnabled: () => harness.cachedMicrocompactEnabled,
  isModelSupportedForCacheEditing: () => harness.cachedMicrocompactModelSupported,
}))

vi.mock('../../../src/services/compact/microCompact.js', () => ({
  consumePendingCacheEdits: () => harness.pendingCacheEdits,
  getPinnedCacheEdits: () => harness.pinnedCacheEdits,
  markToolsSentToAPIState: vi.fn(),
  pinCacheEdits: harness.pinCacheEdits,
}))

vi.mock('../../../src/services/lsp/manager.js', () => ({
  getInitializationStatus: () => ({ status: 'initialized' }),
}))

vi.mock('../../../src/services/mcp/utils.js', () => ({
  isToolFromMcpServer: () => false,
}))

vi.mock('../../../src/utils/agentContext.js', () => ({
  getAgentContext: () => null,
}))

vi.mock('../../../src/utils/headlessProfiler.js', () => ({
  headlessProfilerCheckpoint: vi.fn(),
}))

vi.mock('../../../src/utils/queryProfiler.js', () => ({
  endQueryProfile: vi.fn(),
  queryCheckpoint: vi.fn(),
}))

vi.mock('../../../src/utils/sessionActivity.js', () => ({
  startSessionActivity: vi.fn(),
  stopSessionActivity: vi.fn(),
}))

vi.mock('../../../src/utils/diagLogs.js', () => ({
  logForDiagnosticsNoPII: vi.fn(),
}))

vi.mock('../../../src/utils/mcpInstructionsDelta.js', () => ({
  isMcpInstructionsDeltaEnabled: () => false,
}))

vi.mock('../../../src/utils/modelCost.js', () => ({
  calculateUSDCost: harness.calculateUSDCost,
}))

vi.mock('../../../src/cost/tracker.js', () => ({
  addToTotalSessionCost: harness.addToTotalSessionCost,
}))

vi.mock('../../../src/services/api/cacheStatsTracker.js', () => ({
  recordUsageCacheStats: harness.recordUsageCacheStats,
}))

vi.mock('../../../src/utils/tokens.js', () => ({
  tokenCountFromLastAPIResponse: () => 123,
}))

function resetHarness(): void {
  harness.createCalls.length = 0
  harness.getClientCalls.length = 0
  harness.streamEvents = []
  harness.responseHeaders = {}
  harness.requestId = 'req_stream_1'
  harness.createError = undefined
  harness.nonStreamingResponse = undefined
  harness.getproviderClient.mockClear()
  harness.client.beta.messages.create.mockClear()
  harness.logAPIError.mockClear()
  harness.logAPISuccessAndDuration.mockClear()
  harness.logAPIQuery.mockClear()
  harness.logForDebugging.mockClear()
  harness.captureAPIRequest.mockClear()
  harness.recordUsageCacheStats.mockClear()
  harness.addToTotalSessionCost.mockClear()
  harness.calculateUSDCost.mockClear()
  harness.enabledFeatures.clear()
  harness.cachedMicrocompactEnabled = false
  harness.cachedMicrocompactModelSupported = true
  harness.pendingCacheEdits = null
  harness.pinnedCacheEdits = []
  harness.pinCacheEdits.mockClear()
}

function baseOptions(overrides: AnyRecord = {}): AnyRecord {
  return {
    getToolPermissionContext: async () => ({
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    }),
    model: 'test-model',
    isNonInteractiveSession: false,
    querySource: 'sdk',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    ...overrides,
  }
}

function userMessage(content = 'hello'): AnyRecord {
  return {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  }
}

function textStreamEvents(text = 'stream ok'): AnyRecord[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_stream',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          ...harness.usage(),
          input_tokens: 7,
          cache_read_input_tokens: 3,
        },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'text',
        text: 'ignored-prefix',
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text,
      },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    {
      type: 'message_delta',
      delta: {
        stop_reason: 'end_turn',
      },
      usage: {
        output_tokens: 5,
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: {
          web_search_requests: 2,
        },
        cache_creation: {
          ephemeral_1h_input_tokens: 11,
        },
        iterations: 2,
        speed: 'standard',
      },
    },
    {
      type: 'message_stop',
    },
  ]
}

beforeEach(() => {
  resetHarness()
  resetStateForTests()
  ;(globalThis as AnyRecord).MACRO = { VERSION: 'test-version' }
  delete process.env.AGENC_MAX_OUTPUT_TOKENS
  delete process.env.AGENC_EXTRA_METADATA
  delete process.env.AGENC_EXTRA_BODY
  delete process.env.AGENC_DISABLE_THINKING
  delete process.env.AGENC_DISABLE_PROMPT_CACHING
  delete process.env.AGENC_DISABLE_NONSTREAMING_FALLBACK
  delete process.env.API_TIMEOUT_MS
  delete process.env.USER_TYPE
})

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.AGENC_MAX_OUTPUT_TOKENS
  delete process.env.AGENC_EXTRA_METADATA
  delete process.env.AGENC_EXTRA_BODY
  delete process.env.AGENC_DISABLE_THINKING
  delete process.env.AGENC_DISABLE_PROMPT_CACHING
  delete process.env.AGENC_DISABLE_NONSTREAMING_FALLBACK
  delete process.env.API_TIMEOUT_MS
  delete process.env.USER_TYPE
})

describe('provider API core helpers', () => {
  test('getCacheControl adds one-hour TTL and global scope when the latched allowlist matches', () => {
    setPromptCache1hEligible(true)
    setPromptCache1hAllowlist(['sdk', 'agent:*'])

    expect(getCacheControl({ scope: 'global', querySource: 'agent:default' })).toEqual({
      type: 'ephemeral',
      ttl: '1h',
      scope: 'global',
    })

    setPromptCache1hEligible(false)
    expect(getCacheControl({ querySource: 'sdk' })).toEqual({
      type: 'ephemeral',
    })
  })

  test('getAPIMetadata merges metadata with stable user, account, and session fields', () => {
    process.env.AGENC_EXTRA_METADATA = '{"workspace":"runtime","count":2}'

    const metadata = getAPIMetadata()
    const userId = JSON.parse(metadata.user_id)

    expect(userId).toMatchObject({
      workspace: 'runtime',
      count: 2,
      device_id: 'user-test-id',
      account_uuid: '',
    })
    expect(typeof userId.session_id).toBe('string')
    expect(userId.session_id.length).toBeGreaterThan(0)
  })

  test('updateUsage preserves nonzero input counters while applying output and server-tool deltas', () => {
    const current = {
      ...harness.usage(),
      input_tokens: 17,
      cache_creation_input_tokens: 13,
      cache_read_input_tokens: 11,
      output_tokens: 2,
      output_tokens_details: {
        thinking_tokens: 1,
      },
      server_tool_use: {
        web_search_requests: 1,
        web_fetch_requests: 4,
      },
      cache_creation: {
        ephemeral_1h_input_tokens: 5,
        ephemeral_5m_input_tokens: 7,
      },
      iterations: 1,
      speed: 'standard',
    }

    expect(
      updateUsage(current, {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: null,
        output_tokens: 9,
        output_tokens_details: {
          thinking_tokens: 6,
        },
        server_tool_use: {
          web_search_requests: 3,
        },
        cache_creation: {
          ephemeral_1h_input_tokens: 19,
        },
        iterations: 4,
        speed: 'fast',
      } as AnyRecord),
    ).toMatchObject({
      input_tokens: 17,
      cache_creation_input_tokens: 13,
      cache_read_input_tokens: 11,
      output_tokens: 9,
      output_tokens_details: {
        thinking_tokens: 6,
      },
      server_tool_use: {
        web_search_requests: 3,
        web_fetch_requests: 4,
      },
      cache_creation: {
        ephemeral_1h_input_tokens: 19,
        ephemeral_5m_input_tokens: 7,
      },
      iterations: 4,
      speed: 'fast',
    })
  })

  test('accumulateUsage sums token totals and carries most-recent scalar fields', () => {
    const total = {
      ...harness.usage(),
      input_tokens: 1,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 4,
      output_tokens_details: {
        thinking_tokens: 1,
      },
      server_tool_use: {
        web_search_requests: 5,
        web_fetch_requests: 6,
      },
      cache_creation: {
        ephemeral_1h_input_tokens: 7,
        ephemeral_5m_input_tokens: 8,
      },
      service_tier: 'standard',
      inference_geo: 'us',
      iterations: 1,
      speed: 'standard',
    }
    const next = {
      ...harness.usage(),
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 40,
      output_tokens_details: {
        thinking_tokens: 9,
      },
      server_tool_use: {
        web_search_requests: 50,
        web_fetch_requests: 60,
      },
      cache_creation: {
        ephemeral_1h_input_tokens: 70,
        ephemeral_5m_input_tokens: 80,
      },
      service_tier: 'priority',
      inference_geo: 'eu',
      iterations: 3,
      speed: 'fast',
    }

    expect(accumulateUsage(total, next)).toMatchObject({
      input_tokens: 11,
      cache_creation_input_tokens: 22,
      cache_read_input_tokens: 33,
      output_tokens: 44,
      output_tokens_details: {
        thinking_tokens: 10,
      },
      server_tool_use: {
        web_search_requests: 55,
        web_fetch_requests: 66,
      },
      cache_creation: {
        ephemeral_1h_input_tokens: 77,
        ephemeral_5m_input_tokens: 88,
      },
      service_tier: 'priority',
      inference_geo: 'eu',
      iterations: 3,
      speed: 'fast',
    })
  })

  test('cleanupStream aborts live streams and ignores undefined or already-broken streams', () => {
    const controller = new AbortController()
    cleanupStream({ controller } as AnyRecord)
    expect(controller.signal.aborted).toBe(true)

    expect(() => cleanupStream(undefined)).not.toThrow()
    expect(() =>
      cleanupStream({
        controller: {
          signal: { aborted: false },
          abort: () => {
            throw new Error('already closed')
          },
        },
      } as AnyRecord),
    ).not.toThrow()
  })

  test('getMaxOutputTokensForModel respects bounded environment overrides', () => {
    expect(getMaxOutputTokensForModel('test-model')).toBe(4096)

    process.env.AGENC_MAX_OUTPUT_TOKENS = '8192'
    expect(getMaxOutputTokensForModel('test-model')).toBe(8192)

    process.env.AGENC_MAX_OUTPUT_TOKENS = '999999'
    expect(getMaxOutputTokensForModel('test-model')).toBe(128000)
  })
})

describe('provider API requests', () => {
  test('verifyApiKey skips network verification for non-interactive sessions', async () => {
    await expect(verifyApiKey('test-key', true)).resolves.toBe(true)
    expect(harness.getproviderClient).not.toHaveBeenCalled()
  })

  test('verifyApiKey sends a minimal test message and returns false for invalid credentials', async () => {
    await expect(verifyApiKey('test-key', false)).resolves.toBe(true)

    expect(harness.getClientCalls[0]).toMatchObject({
      apiKey: 'test-key',
      maxRetries: 3,
      model: 'small-fast-model',
      source: 'verify_api_key',
    })
    expect(harness.createCalls[0].params).toMatchObject({
      model: 'small-fast-model',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'test' }],
      temperature: 1,
      betas: ['model-beta'],
    })

    resetHarness()
    harness.createError = new Error(
      '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    )

    await expect(verifyApiKey('bad-key', false)).resolves.toBe(false)
  })

  test('queryModelWithStreaming assembles request params, yields stream events, and mutates final usage onto the assistant message', async () => {
    harness.streamEvents = textStreamEvents('hello from stream')
    harness.responseHeaders = { 'x-litellm-model-id': 'gateway-model' }

    const seen: AnyRecord[] = []
    for await (const event of queryModelWithStreaming({
      messages: [userMessage()],
      systemPrompt: asSystemPrompt(['system one']),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: baseOptions({
        maxOutputTokensOverride: 1200,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
        taskBudget: { total: 100, remaining: 42 },
      }),
    })) {
      seen.push(event as AnyRecord)
    }

    const assistant = seen.find(event => event.type === 'assistant')
    expect(assistant).toMatchObject({
      requestId: 'req_stream_1',
      message: {
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'hello from stream' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 3,
          output_tokens: 5,
          server_tool_use: {
            web_search_requests: 2,
          },
        },
      },
    })
    expect(seen.filter(event => event.type === 'stream_event')).toHaveLength(
      textStreamEvents().length,
    )

    const streamingCall = harness.createCalls.find(
      ({ params }: AnyRecord) => params.stream === true,
    )
    expect(streamingCall.params).toMatchObject({
      model: 'normalized-test-model',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'hello',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      max_tokens: 1200,
      stream: true,
      output_config: {
        format: { type: 'json_schema', schema: { type: 'object' } },
        task_budget: { type: 'tokens', total: 100, remaining: 42 },
      },
    })
    expect(streamingCall.params.system.map((block: AnyRecord) => block.text)).toEqual([
      'attr:fingerprint',
      'system-prefix',
      'system one',
    ])
    expect(streamingCall.params.betas).toContain('structured-outputs-2025-12-15')
    expect(streamingCall.options).toMatchObject({
      signal: expect.any(AbortSignal),
      headers: {
        'x-client-request-id': expect.any(String),
      },
    })
    expect(harness.logAPISuccessAndDuration).toHaveBeenCalled()
  })

  test('queryModelWithStreaming falls back to nonstreaming when a stream ends before message_start', async () => {
    const onStreamingFallback = vi.fn()
    harness.streamEvents = []
    harness.nonStreamingResponse = {
      id: 'msg_fallback',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: 'fallback ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        ...harness.usage(),
        input_tokens: 3,
        output_tokens: 2,
      },
    }

    const seen: AnyRecord[] = []
    for await (const event of queryModelWithStreaming({
      messages: [userMessage()],
      systemPrompt: asSystemPrompt(['fallback system']),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: baseOptions({ onStreamingFallback }),
    })) {
      seen.push(event as AnyRecord)
    }

    expect(onStreamingFallback).toHaveBeenCalledOnce()
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'assistant',
        message: expect.objectContaining({
          content: [{ type: 'text', text: 'fallback ok' }],
        }),
      }),
    )
    expect(harness.createCalls.map((call: AnyRecord) => call.params.stream)).toEqual([
      true,
      undefined,
    ])
  })

  test('queryModelWithStreaming annotates cached-microcompact tool results before the cache boundary', async () => {
    harness.enabledFeatures.add('CACHED_MICROCOMPACT')
    harness.cachedMicrocompactEnabled = true
    harness.cachedMicrocompactModelSupported = true
    harness.streamEvents = textStreamEvents('cache reference path')
    const toolResultBlock: AnyRecord = {
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'tool done',
    }

    const seen: AnyRecord[] = []
    for await (const event of queryModelWithStreaming({
      messages: [
        userMessage([
          toolResultBlock,
          { type: 'text', text: 'continue after tool' },
        ]),
        userMessage('final prompt'),
      ],
      systemPrompt: asSystemPrompt(['cache system']),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: baseOptions({
        enablePromptCaching: true,
        querySource: 'repl_main_thread',
      }),
    })) {
      seen.push(event as AnyRecord)
    }

    expect(seen.some(event => event.type === 'assistant')).toBe(true)
    const streamingCall = harness.createCalls.find(
      ({ params }: AnyRecord) => params.stream === true,
    )
    const firstMessageContent = streamingCall.params.messages[0].content
    expect(firstMessageContent[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      cache_reference: 'toolu_1',
    })
    expect(streamingCall.params.messages[1].content[0]).toMatchObject({
      type: 'text',
      text: 'final prompt',
      cache_control: { type: 'ephemeral' },
    })
    expect(toolResultBlock).not.toHaveProperty('cache_reference')
  })

  test('queryHaiku and queryWithModel delegate through the nonstreaming query pipeline', async () => {
    harness.streamEvents = textStreamEvents('haiku path')
    const haiku = await queryHaiku({
      systemPrompt: asSystemPrompt(['haiku system']),
      userPrompt: 'haiku prompt',
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      signal: new AbortController().signal,
      options: {
        isNonInteractiveSession: true,
        querySource: 'sdk',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    expect(haiku.message.content).toEqual([
      { type: 'text', text: 'haiku path' },
    ])
    expect(
      harness.createCalls.some(
        ({ params }: AnyRecord) => params.model === 'normalized-small-fast-model',
      ),
    ).toBe(true)

    resetHarness()
    harness.streamEvents = textStreamEvents('specific model path')
    const specific = await queryWithModel({
      systemPrompt: asSystemPrompt(['model system']),
      userPrompt: 'model prompt',
      signal: new AbortController().signal,
      options: {
        ...baseOptions(),
        model: 'custom-model',
      },
    })

    expect(specific.message.content).toEqual([
      { type: 'text', text: 'specific model path' },
    ])
    expect(
      harness.createCalls.some(
        ({ params }: AnyRecord) => params.model === 'normalized-custom-model',
      ),
    ).toBe(true)
  })
})
