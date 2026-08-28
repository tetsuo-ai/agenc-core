import { describe, expect, test } from 'bun:test'
import {
  collectProviderCodeCompletedResponse,
  providerCodeStreamToprovider,
  convertproviderMessagesToResponsesInput,
  convertProviderCodeResponseToproviderMessage,
  convertToolsToResponsesTools,
  performProviderCodeRequest,
} from '../../../src/services/api/openAiCodeTransform.ts'
import { __test as webSearchToolTest } from '../../../src/tools/WebSearchTool/WebSearchTool.ts'

async function collectStreamEventTypes(responseText: string): Promise<string[]> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(responseText))
      controller.close()
    },
  })

  const events: string[] = []
  for await (const event of providerCodeStreamToprovider(new Response(stream), 'gpt-5.4')) {
    events.push(event.type)
  }
  return events
}

async function collectCompletedResponse(responseText: string): Promise<Record<string, unknown>> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(responseText))
      controller.close()
    },
  })

  return collectProviderCodeCompletedResponse(new Response(stream))
}

async function importFreshProviderConfigModule() {
  return import(`../../../src/services/api/providerConfig.ts?ts=${Date.now()}-${Math.random()}`)
}

describe('ProviderCode provider config', () => {
  test('resolves providerCodeplan alias to ProviderCode transport with reasoning', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()

    const resolved = resolveProviderRequest({
      provider: 'openai',
      model: 'providerCodeplan',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    })
    expect(resolved.transport).toBe('providerCode_responses')
    expect(resolved.resolvedModel).toBe('gpt-5.5')
    expect(resolved.reasoning).toEqual({ effort: 'high' })
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  })

  test('resolves providerCodespark alias to ProviderCode transport with ProviderCode base URL', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()

    const resolved = resolveProviderRequest({
      provider: 'openai',
      model: 'providerCodespark',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    })
    expect(resolved.transport).toBe('providerCode_responses')
    expect(resolved.resolvedModel).toBe('gpt-5.3-providerCode-spark')
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  })

  test('does not force ProviderCode transport when a local non-ProviderCode base URL is explicit', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    const resolved = resolveProviderRequest({
      provider: 'openai',
      model: 'providerCodeplan',
      baseUrl: 'http://127.0.0.1:8080/v1',
    })

    expect(resolved.transport).toBe('chat_completions')
    expect(resolved.baseUrl).toBe('http://127.0.0.1:8080/v1')
    expect(resolved.resolvedModel).toBe('gpt-5.5')
  })

  test('uses the explicit prepared base URL', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    const resolved = resolveProviderRequest({
      provider: 'openai',
      model: 'providerCodeplan',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    })
    expect(resolved.transport).toBe('providerCode_responses')
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  })

  test('default gpt-4o uses OpenAi base URL (no regression)', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    const resolved = resolveProviderRequest({
      provider: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
    })
    expect(resolved.transport).toBe('chat_completions')
    expect(resolved.baseUrl).toBe('https://api.openai.com/v1')
    expect(resolved.resolvedModel).toBe('gpt-4o')
  })

  test('resolves an explicit providerCodeplan model to the ProviderCode endpoint', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()

    const resolved = resolveProviderRequest({
      provider: 'openai',
      model: 'providerCodeplan',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    })
    expect(resolved.transport).toBe('providerCode_responses')
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
    expect(resolved.resolvedModel).toBe('gpt-5.5')
  })

  test('does not override custom base URL for providerCodeplan (e.g., local provider)', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()

    const resolved = resolveProviderRequest({
      provider: 'openai',
      model: 'providerCodeplan',
      baseUrl: 'http://localhost:11434/v1',
    })
    expect(resolved.transport).toBe('chat_completions')
    expect(resolved.baseUrl).toBe('http://localhost:11434/v1')
  })

})

describe('ProviderCode request translation', () => {
  test('sends the subscription access token and account header to the canonical backend', async () => {
    const originalFetch = globalThis.fetch
    let capturedInput: string | URL | Request | undefined
    let capturedInit: RequestInit | undefined
    globalThis.fetch = (async (input, init) => {
      capturedInput = input
      capturedInit = init
      return new Response('', { status: 200 })
    }) as typeof fetch
    try {
      await performProviderCodeRequest({
        request: {
          transport: 'providerCode_responses',
          requestedModel: 'providerCodeplan',
          resolvedModel: 'gpt-5.5',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
        },
        credentials: {
          bearerToken: 'stored-subscription-token',
          accountId: 'acct_stored',
          source: 'native-secure-storage',
        },
        environment: Object.freeze({}),
        params: {
          model: 'gpt-5.5',
          messages: [],
          max_tokens: 1024,
        },
        defaultHeaders: {},
      })

      expect(String(capturedInput)).toBe(
        'https://chatgpt.com/backend-api/codex/responses',
      )
      expect(capturedInit?.headers).toMatchObject({
        Authorization: 'Bearer stored-subscription-token',
        'chatgpt-account-id': 'acct_stored',
        originator: 'agenc',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('normalizes optional parameters into strict Responses schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Agent',
        description: 'Spawn a sub-agent',
        input_schema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            prompt: { type: 'string' },
            subagent_type: { type: 'string' },
          },
          required: ['description', 'prompt'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Agent',
        description: 'Spawn a sub-agent',
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            prompt: { type: 'string' },
            subagent_type: { type: 'string' },
          },
          required: ['description', 'prompt', 'subagent_type'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('keeps strict mode for tools whose schema already matches Responses requirements', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Ping',
        description: 'Ping tool',
        input_schema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Ping',
        description: 'Ping tool',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('preserves Grep tool pattern field in ProviderCode strict schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Grep',
        description: 'Search file contents',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern' },
            path: { type: 'string' },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Grep',
        description: 'Search file contents',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern' },
            path: { type: 'string' },
          },
          required: ['pattern', 'path'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('preserves Glob tool pattern field in ProviderCode strict schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Glob',
        description: 'Find files by pattern',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern' },
            path: { type: 'string' },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Glob',
        description: 'Find files by pattern',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern' },
            path: { type: 'string' },
          },
          required: ['pattern', 'path'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('strips validator pattern keyword but keeps string field named pattern in ProviderCode schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'RegexProbe',
        description: 'Probe regex schema handling',
        input_schema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              pattern: '^[a-z]+$',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'RegexProbe',
        description: 'Probe regex schema handling',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('removes unsupported uri format from strict Responses schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'WebFetch',
        description: 'Fetch a URL',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
            prompt: { type: 'string' },
          },
          required: ['url', 'prompt'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'WebFetch',
        description: 'Fetch a URL',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['url', 'prompt'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('sanitizes malformed enum/default values for Responses tool schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__clientry__create_task',
        description: 'Create a task',
        input_schema: {
          type: 'object',
          properties: {
            priority: {
              type: 'integer',
              description: 'Priority: 0=low, 1=medium, 2=high, 3=urgent',
              default: true,
              enum: [false, 0, 1, 2, 3],
            },
          },
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'mcp__clientry__create_task',
        description: 'Create a task',
        parameters: {
          type: 'object',
          properties: {
            priority: {
              type: 'integer',
              description: 'Priority: 0=low, 1=medium, 2=high, 3=urgent',
              enum: [0, 1, 2, 3],
            },
          },
          required: ['priority'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('converts assistant tool use and user tool result into Responses items', () => {
    const items = convertproviderMessagesToResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Working...' },
          { type: 'tool_use', id: 'call_123', name: 'search', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_123', content: 'done' },
        ],
      },
    ])

    expect(items).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Working...' }],
      },
      {
        type: 'function_call',
        id: 'fc_123',
        call_id: 'call_123',
        name: 'search',
        arguments: '{"q":"x"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'done',
      },
    ])
  })

  test('converts completed ProviderCode tool response into provider message', () => {
    const message = convertProviderCodeResponseToproviderMessage(
      {
        id: 'resp_1',
        model: 'gpt-5.3-providerCode-spark',
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'ping',
            arguments: '{"value":"ping"}',
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.3-providerCode-spark',
    )

    expect(message.stop_reason).toBe('tool_use')
    expect(message.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'ping',
        input: { value: 'ping' },
      },
    ])
  })

  test('ignores malformed completed ProviderCode output entries', () => {
    const message = convertProviderCodeResponseToproviderMessage(
      {
        id: 'resp_1',
        model: 'gpt-5.4',
        output: [
          null,
          'noise',
          { type: 'message', content: [null, { type: 'output_text', text: 42 }] },
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Usable text.' }],
          },
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'ping',
            arguments: '{"value":"ping"}',
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.4',
    )

    expect(message.stop_reason).toBe('tool_use')
    expect(message.content).toEqual([
      { type: 'text', text: 'Usable text.' },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'ping',
        input: { value: 'ping' },
      },
    ])
  })

  test('strips <think> tag block from completed ProviderCode text responses', () => {
    const message = convertProviderCodeResponseToproviderMessage(
      {
        id: 'resp_1',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text:
                  '<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?',
              },
            ],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.4',
    )

    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'Hey! How can I help you today?',
      },
    ])
  })

  test('strips unterminated <think> tag at block boundary in ProviderCode completed response', () => {
    const message = convertProviderCodeResponseToproviderMessage(
      {
        id: 'resp_1',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text:
                  'Here is the answer.\n<think>wait, let me reconsider the user request',
              },
            ],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.4',
    )

    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'Here is the answer.',
      },
    ])
  })

  test('recovers ProviderCode web search text and sources from sparse completed response', () => {
    const output = webSearchToolTest.makeOutputFromProviderCodeWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            sources: [
              {
                title: 'AgenC repo',
                url: 'https://github.com/example/agenc',
              },
            ],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'AgenC is available on GitHub.',
                sources: [
                  {
                    title: 'Docs',
                    url: 'https://docs.example.com/agenc',
                  },
                ],
              },
            ],
          },
        ],
      },
      'AgenC GitHub 2026',
      0.42,
    )

    expect(output.results).toEqual([
      'AgenC is available on GitHub.',
      {
        tool_use_id: 'providerCode-web-search',
        content: [
          {
            title: 'AgenC repo',
            url: 'https://github.com/example/agenc',
          },
          {
            title: 'Docs',
            url: 'https://docs.example.com/agenc',
          },
        ],
      },
    ])
  })

  test('falls back to a non-empty ProviderCode web search result message', () => {
    const output = webSearchToolTest.makeOutputFromProviderCodeWebSearchResponse(
      { output: [] },
      'AgenC GitHub 2026',
      0.11,
    )

    expect(output.results).toEqual(['No results found.'])
  })

  test('surfaces ProviderCode web search failure reason with a message', () => {
    const output = webSearchToolTest.makeOutputFromProviderCodeWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
            error: { message: 'upstream search provider rate-limited' },
          },
        ],
      },
      'AgenC GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual([
      'Web search failed: upstream search provider rate-limited',
    ])
  })

  test('surfaces ProviderCode web search failure reason nested under action.error', () => {
    const output = webSearchToolTest.makeOutputFromProviderCodeWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
            action: { error: { message: 'query blocked' } },
          },
        ],
      },
      'AgenC GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual(['Web search failed: query blocked'])
  })

  test('handles ProviderCode web search failure with no reason attached', () => {
    const output = webSearchToolTest.makeOutputFromProviderCodeWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
          },
        ],
      },
      'AgenC GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual(['Web search failed.'])
  })

  test('a failure item does not suppress sources from a later message item', () => {
    const output = webSearchToolTest.makeOutputFromProviderCodeWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
            error: { message: 'partial outage' },
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Partial results below.',
                sources: [
                  { title: 'Docs', url: 'https://docs.example.com/agenc' },
                ],
              },
            ],
          },
        ],
      },
      'AgenC GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual([
      'Web search failed: partial outage',
      'Partial results below.',
      {
        tool_use_id: 'providerCode-web-search',
        content: [
          { title: 'Docs', url: 'https://docs.example.com/agenc' },
        ],
      },
    ])
  })

  test('ignores malformed ProviderCode web search response entries', () => {
    const output = webSearchToolTest.makeOutputFromProviderCodeWebSearchResponse(
      {
        output: [
          null,
          'noise',
          {
            type: 'message',
            content: [
              null,
              { type: 'text', text: 'Usable result.' },
              {
                type: 'text',
                annotations: [
                  null,
                  { type: 'url_citation', title: 'Docs', url: 'https://docs.example.com' },
                  { type: 'url_citation', title: 'Missing URL' },
                ],
              },
            ],
          },
        ],
      },
      'AgenC GitHub 2026',
      0.07,
    )

    expect(output.results).toEqual([
      'Usable result.',
      {
        tool_use_id: 'providerCode-web-search',
        content: [
          { title: 'Docs', url: 'https://docs.example.com' },
        ],
      },
    ])
  })

  test('translates ProviderCode SSE text stream into provider events', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":0}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":1}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"ok","item_id":"msg_1","output_index":0,"sequence_number":2}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"ok"}],"role":"assistant"},"output_index":0,"sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const eventTypes = await collectStreamEventTypes(responseText)

    expect(eventTypes).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })

  test('ignores malformed ProviderCode SSE payloads before valid stream events', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: null',
      '',
      'event: response.output_item.added',
      'data: []',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":"bad"}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","part":{"type":"output_text","text":""}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":123}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const textDeltas: string[] = []
    for await (const event of providerCodeStreamToprovider(
      new Response(stream),
      'gpt-5.4',
    )) {
      const delta = (event as { delta?: { type?: string; text?: string } }).delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        textDeltas.push(delta.text)
      }
    }

    expect(textDeltas).toEqual(['ok'])
  })

  test('collectProviderCodeCompletedResponse skips non-object SSE JSON and drains trailing events', async () => {
    const response = await collectCompletedResponse([
      'event: response.output_text.delta',
      'data: null',
      '',
      'event: response.output_text.delta',
      'data: []',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}',
      '',
    ].join('\n'))

    expect(response).toEqual({
      id: 'resp_1',
      status: 'completed',
      output: [],
    })
  })

  test('strips <think> tag block from ProviderCode SSE text stream', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":0}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":1}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?","item_id":"msg_1","output_index":0,"sequence_number":2}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?"}],"role":"assistant"},"output_index":0,"sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?"}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const textDeltas: string[] = []
    for await (const event of providerCodeStreamToprovider(
      new Response(stream),
      'gpt-5.4',
    )) {
      const delta = (event as { delta?: { type?: string; text?: string } }).delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        textDeltas.push(delta.text)
      }
    }

    expect(textDeltas.join('')).toBe('Hey! How can I help you today?')
  })

  test('preserves prose without tags (no phrase-based false positive)', async () => {
    // Regression test: older phrase-based sanitizer would incorrectly strip text
    // starting with "I should" or "The user". The tag-based approach leaves it alone.
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":0}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":1}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"I should note that the user role requires a briefly concise friendly response format.","item_id":"msg_1","output_index":0,"sequence_number":2}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"I should note that the user role requires a briefly concise friendly response format."}],"role":"assistant"},"output_index":0,"sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I should note that the user role requires a briefly concise friendly response format."}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const textDeltas: string[] = []
    for await (const event of providerCodeStreamToprovider(
      new Response(stream),
      'gpt-5.4',
    )) {
      const delta = (event as { delta?: { type?: string; text?: string } }).delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        textDeltas.push(delta.text)
      }
    }

    expect(textDeltas.join('')).toBe(
      'I should note that the user role requires a briefly concise friendly response format.',
    )
  })
})
