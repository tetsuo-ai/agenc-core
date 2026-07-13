import { afterEach, describe, expect, test } from 'bun:test'
import { createOpenAiShimClient } from '../../../src/services/api/openaiShim.ts'

// openaiShim minor (core-todo.md): _convertNonStreamingResponse dereferenced
// tc.function.name/.arguments without a shape check, so a malformed provider response
// (tool_calls: [{ id }] or a non-function entry) threw a bare TypeError that bypassed
// the shim's classifyOpenAiHttpFailure routing. Fixed by skipping such entries.

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

type OpenAiShimClient = ReturnType<typeof createOpenAiShimClient>

describe('openai shim — malformed non-streaming tool_call', () => {
  test('skips a tool_call missing function.name instead of throwing', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'some-model',
          choices: [
            {
              index: 0,
              message: {
                content: 'hi',
                // Malformed: no `function` field.
                tool_calls: [{ id: 'call_bad' }, { id: 'call_bad2', function: { arguments: '{}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch

    const client = createOpenAiShimClient({}) as OpenAiShimClient
    let result: unknown
    await expect(
      (async () => {
        result = await client.beta.messages.create({
          model: 'some-model',
          system: 'test',
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 64,
          stream: false,
        })
      })(),
    ).resolves.toBeUndefined()

    // The malformed tool_calls are dropped; text content survives.
    const content = (result as { content?: Array<{ type: string }> }).content ?? []
    expect(content.some((c) => c.type === 'tool_use')).toBe(false)
    expect(content.some((c) => c.type === 'text')).toBe(true)
  })
})
