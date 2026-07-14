import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  flattenMessagesForAcp,
  GrokAcpProvider,
  isGrokComposerModel,
} from '../../src/llm/providers/grok/acp-adapter.ts'
import { createProvider } from '../../src/llm/provider.ts'
import type { LLMMessage } from '../../src/llm/types.ts'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'services',
  'xai',
  'fixtures',
  'fake-acp-agent.mjs',
)

describe('composer model detection', () => {
  test('matches grok-composer-* only', () => {
    expect(isGrokComposerModel('grok-composer-2.5-fast')).toBe(true)
    expect(isGrokComposerModel('GROK-COMPOSER-3')).toBe(true)
    expect(isGrokComposerModel('grok-4.5')).toBe(false)
    expect(isGrokComposerModel(undefined)).toBe(false)
  })
})

describe('factory routing', () => {
  test('composer models construct the ACP provider without an API key', () => {
    const provider = createProvider('grok', { model: 'grok-composer-2.5-fast' })
    expect(provider.name).toBe('grok')
    expect(provider).toBeInstanceOf(GrokAcpProvider)
  })

  test('non-composer models keep the direct-inference path', () => {
    const provider = createProvider('grok', {
      apiKey: 'xai-key',
      model: 'grok-4.5',
    })
    expect(provider).not.toBeInstanceOf(GrokAcpProvider)
  })
})

describe('message flattening', () => {
  test('flattens roles and content parts to a text transcript', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: 'data:...' } } as never,
        ],
      },
    ]
    const flattened = flattenMessagesForAcp(messages, 'system rules')
    expect(flattened).toContain('system rules')
    expect(flattened).toContain('be brief')
    expect(flattened).toContain('User: hello')
    expect(flattened).toContain('Assistant: hi there')
    expect(flattened).toContain('look at this')
    expect(flattened).toContain('[image_url]')
  })
})

describe('GrokAcpProvider end to end (fake agent)', () => {
  test('chat selects the model and returns the streamed text', async () => {
    const provider = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      binaryPath: FIXTURE,
    })
    try {
      const response = await provider.chat([{ role: 'user', content: 'hi' }])
      expect(response.content).toBe('[grok-composer-2.5-fast] Hello world')
      expect(response.model).toBe('grok-composer-2.5-fast')
      expect(response.finishReason).toBe('stop')
      expect(response.toolCalls).toEqual([])
    } finally {
      provider.dispose()
    }
  })

  test('chatStream streams deltas and ends with a done chunk', async () => {
    const provider = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      binaryPath: FIXTURE,
    })
    try {
      const chunks: Array<{ content: string; done: boolean }> = []
      const response = await provider.chatStream(
        [{ role: 'user', content: 'hi' }],
        chunk => chunks.push({ content: chunk.content, done: chunk.done }),
      )
      expect(response.content).toBe('[grok-composer-2.5-fast] Hello world')
      expect(chunks.at(-1)).toEqual({ content: '', done: true })
      expect(
        chunks.filter(chunk => !chunk.done).map(chunk => chunk.content).join(''),
      ).toBe(response.content)
    } finally {
      provider.dispose()
    }
  })

  test('reuses one CLI process across chats but a fresh session per chat', async () => {
    const provider = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      binaryPath: FIXTURE,
    })
    try {
      await provider.chat([{ role: 'user', content: 'first' }])
      const second = await provider.chat([{ role: 'user', content: 'second' }])
      // The fixture numbers sessions per process; a second chat on the same
      // process gets mock-session-2 and keeps the selected model.
      expect(second.content).toBe('[grok-composer-2.5-fast] Hello world')
    } finally {
      provider.dispose()
    }
  })

  test('missing Grok CLI surfaces a helpful provider error', async () => {
    const provider = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      binaryPath: 'definitely-not-a-real-grok-binary',
    })
    try {
      await expect(
        provider.chat([{ role: 'user', content: 'hi' }]),
      ).rejects.toMatchObject({
        name: 'LLMProviderError',
        message: expect.stringContaining('Grok Build CLI'),
      })
      expect(await provider.healthCheck()).toBe(false)
    } finally {
      provider.dispose()
    }
  })
})
