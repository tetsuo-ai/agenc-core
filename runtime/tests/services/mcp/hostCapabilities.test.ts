import assert from 'node:assert/strict'
import { test } from 'vitest'

import { configureMcpHostRequestHandlers } from './hostCapabilities.js'

type FakeHandler = (request?: unknown, extra?: unknown) => unknown

class FakeClient {
  readonly handlers: FakeHandler[] = []

  setRequestHandler(_schema: unknown, handler: FakeHandler): void {
    this.handlers.push(handler)
  }
}

test('configureMcpHostRequestHandlers delegates sampling/createMessage to injected handler', async () => {
  const client = new FakeClient()
  let captured: unknown

  configureMcpHostRequestHandlers(client as never, 'srv', {
    rootPath: process.cwd(),
    samplingHandlers: {
      async createMessage(params) {
        captured = params
        return {
          role: 'assistant',
          model: 'test-model',
          stopReason: 'endTurn',
          content: { type: 'text', text: 'sampled' },
        }
      },
    },
  })

  const abort = new AbortController()
  const result = await client.handlers[1]?.(
    {
      method: 'sampling/createMessage',
      params: {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: 'hello' },
          },
        ],
        maxTokens: 16,
      },
    },
    {
      requestId: 9,
      signal: abort.signal,
      _meta: { trace: 'local' },
    },
  )

  assert.deepEqual(result, {
    role: 'assistant',
    model: 'test-model',
    stopReason: 'endTurn',
    content: { type: 'text', text: 'sampled' },
  })
  assert.deepEqual(captured, {
    serverName: 'srv',
    requestId: 9,
    request: {
      method: 'sampling/createMessage',
      params: {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: 'hello' },
          },
        ],
        maxTokens: 16,
      },
    },
    contextMeta: { trace: 'local' },
    signal: abort.signal,
  })
})
