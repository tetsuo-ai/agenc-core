import { afterEach, expect, test, vi } from 'vitest'

async function loadOllamaModelsModule() {
  vi.resetModules()
  return import('../../../src/utils/model/ollamaModels.ts')
}

const originalFetch = globalThis.fetch
const originalEnv = {
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.clearAllMocks()
  vi.resetModules()
  for (const key of Object.keys(originalEnv) as Array<keyof typeof originalEnv>) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }
})

test('fetchOllamaModels maps normalized Ollama tags into model picker options', async () => {
  const { fetchOllamaModels } = await loadOllamaModelsModule()
  const requestedUrls: string[] = []

  globalThis.fetch = vi.fn(input => {
    const url = typeof input === 'string' ? input : input.url
    requestedUrls.push(url)
    return Promise.resolve(
      new Response(
        JSON.stringify({
          models: [
            {
              name: 'qwen2.5-coder:7b',
              size: 4_200_000_000,
              details: {
                parameter_size: '7B',
                quantization_level: 'Q4_K_M',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
  }) as typeof globalThis.fetch

  await expect(fetchOllamaModels()).resolves.toEqual([
    {
      value: 'qwen2.5-coder:7b',
      label: 'qwen2.5-coder:7b',
      description: 'Ollama · 7B · Q4_K_M · 4.2GB',
    },
  ])
  expect(requestedUrls).toEqual(['http://localhost:11434/api/tags'])
})

test('fetchOllamaModels ignores malformed Ollama tag entries', async () => {
  const { fetchOllamaModels } = await loadOllamaModelsModule()

  globalThis.fetch = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          models: [
            null,
            'noise',
            { name: 42, size: 100 },
            { name: '   ' },
            {
              name: 'llama3.3:latest',
              size: 0,
              details: {
                parameter_size: 70,
                quantization_level: null,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    ),
  ) as typeof globalThis.fetch

  await expect(fetchOllamaModels()).resolves.toEqual([
    {
      value: 'llama3.3:latest',
      label: 'llama3.3:latest',
      description: 'Ollama model',
    },
  ])
})

test('fetchOllamaModels treats malformed Ollama tag payloads as empty', async () => {
  const { fetchOllamaModels } = await loadOllamaModelsModule()

  globalThis.fetch = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ models: { name: 'not-array' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  ) as typeof globalThis.fetch

  await expect(fetchOllamaModels()).resolves.toEqual([])
})
