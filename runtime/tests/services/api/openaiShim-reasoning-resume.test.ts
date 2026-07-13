import { afterEach, describe, expect, test } from 'bun:test'
import { createOpenAiShimClient } from '../../../src/services/api/openaiShim.ts'

// M-LLM-5 (core-todo.md): once the thinking block closed on a reasoning->content or
// reasoning->tool_call transition, hasEmittedThinkingStart was never reset, so a later
// delta.reasoning_content emitted a thinking_delta at a STALE index (the open text
// block / an unstarted index). The Anthropic stream consumer (services/api/anthropic.ts)
// then throws "Content block not found" / "not a thinking block", killing the request.
// This asserts the shim's own event stream invariant: every content_block_delta targets
// a started block of the matching type.

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

type OpenAiShimClient = ReturnType<typeof createOpenAiShimClient>

function chunk(delta: unknown): string {
  return `data: ${JSON.stringify({
    id: 'c',
    model: 'kimi-thinking',
    choices: [{ index: 0, delta }],
  })}\n\n`
}

function sse(frames: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('openai shim — M-LLM-5 reasoning resumes after content', () => {
  test('interleaved reasoning/content emits a well-formed block stream', async () => {
    globalThis.fetch = (async () =>
      sse([
        chunk({ reasoning_content: 'R1 ' }),
        chunk({ content: 'Answer part. ' }),
        // Reasoning resumes after the thinking block was closed — the bug trigger.
        chunk({ reasoning_content: 'R2 more' }),
        chunk({ content: 'final.' }),
        `data: ${JSON.stringify({
          id: 'c',
          model: 'kimi-thinking',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ])) as typeof fetch

    const client = createOpenAiShimClient({}) as OpenAiShimClient
    const result = await client.beta.messages
      .create({
        model: 'kimi-thinking',
        system: 'test',
        messages: [{ role: 'user', content: 'think then answer' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()

    const events: Array<Record<string, unknown>> = []
    for await (const event of result.data) events.push(event)

    // Reconstruct block types from content_block_start and validate every delta.
    const blockTypeByIndex = new Map<number, string>()
    for (const ev of events) {
      if (ev.type === 'content_block_start') {
        const cb = ev.content_block as { type?: string } | undefined
        blockTypeByIndex.set(ev.index as number, cb?.type ?? 'unknown')
      } else if (ev.type === 'content_block_delta') {
        const index = ev.index as number
        const deltaType = (ev.delta as { type?: string })?.type
        // Invariant the Anthropic consumer relies on: the index was started...
        expect(blockTypeByIndex.has(index)).toBe(true)
        // ...and a thinking_delta lands on a thinking block (not a text block).
        if (deltaType === 'thinking_delta') {
          expect(blockTypeByIndex.get(index)).toBe('thinking')
        }
        if (deltaType === 'text_delta') {
          expect(blockTypeByIndex.get(index)).toBe('text')
        }
      }
    }

    // Both reasoning segments and both content segments must be present.
    const thinking = events
      .filter((e) => (e.delta as { type?: string })?.type === 'thinking_delta')
      .map((e) => (e.delta as { thinking?: string }).thinking)
      .join('')
    const text = events
      .filter((e) => (e.delta as { type?: string })?.type === 'text_delta')
      .map((e) => (e.delta as { text?: string }).text)
      .join('')
    expect(thinking).toContain('R1')
    expect(thinking).toContain('R2')
    expect(text).toContain('Answer part.')
    expect(text).toContain('final.')
  })
})
