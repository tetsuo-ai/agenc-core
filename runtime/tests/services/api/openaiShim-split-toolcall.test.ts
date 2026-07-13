import { afterEach, describe, expect, test } from 'bun:test'
import { createOpenAiShimClient } from '../../../src/services/api/openaiShim.ts'

// M-LLM-7 (core-todo.md): a streaming tool call was registered only when a single
// delta carried BOTH tc.id AND tc.function.name. Providers that split them across
// chunks (vLLM / LM Studio / OpenRouter passthroughs) never registered the call;
// later argument deltas hit activeToolCalls.get(index) === undefined and were dropped,
// so the stream ended with finish_reason tool_calls but ZERO tool_use blocks, stalling
// the agent loop. This pins that id / name / arguments are assembled across chunks.

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

type OpenAiShimClient = ReturnType<typeof createOpenAiShimClient>

function frame(delta: unknown, finish_reason?: string): string {
  return `data: ${JSON.stringify({
    id: 'c',
    model: 'vllm-model',
    choices: [{ index: 0, delta, ...(finish_reason ? { finish_reason } : {}) }],
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

async function collectToolUse(frames: string[]) {
  globalThis.fetch = (async () => sse(frames)) as typeof fetch
  const client = createOpenAiShimClient({}) as OpenAiShimClient
  const result = await client.beta.messages
    .create({
      model: 'vllm-model',
      system: 'test',
      messages: [{ role: 'user', content: 'list files' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) events.push(event)

  const start = events.find(
    (e) =>
      e.type === 'content_block_start' &&
      (e.content_block as { type?: string } | undefined)?.type === 'tool_use',
  ) as { index?: number; content_block?: Record<string, unknown> } | undefined
  const args = events
    .filter(
      (e) =>
        e.type === 'content_block_delta' &&
        (e.delta as { type?: string })?.type === 'input_json_delta' &&
        e.index === start?.index,
    )
    .map((e) => (e.delta as { partial_json?: string }).partial_json ?? '')
    .join('')
  return { start, args }
}

describe('openai shim — M-LLM-7 split tool-call assembly', () => {
  test('assembles a tool call whose id and name arrive in separate chunks', async () => {
    const { start, args } = await collectToolUse([
      frame({ tool_calls: [{ index: 0, id: 'call_1' }] }),
      frame({ tool_calls: [{ index: 0, function: { name: 'Bash' } }] }),
      frame({ tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] }),
      frame({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ])
    expect(start?.content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'Bash' })
    expect(args).toContain('"command"')
    expect(args).toContain('ls')
  })

  test('still assembles when id+name arrive together (regression guard)', async () => {
    const { start, args } = await collectToolUse([
      frame({
        tool_calls: [{ index: 0, id: 'call_2', function: { name: 'Bash', arguments: '{"command":' } }],
      }),
      frame({ tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] }),
      frame({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ])
    expect(start?.content_block).toMatchObject({ type: 'tool_use', id: 'call_2', name: 'Bash' })
    expect(args).toContain('pwd')
  })
})
