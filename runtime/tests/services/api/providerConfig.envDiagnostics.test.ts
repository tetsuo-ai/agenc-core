import { afterEach, expect, mock, test } from 'bun:test'

function providerSelection(
  provider: string,
  model: string,
  overrides: Readonly<Record<string, string | undefined>>,
) {
  return {
    provider,
    model,
    environment: Object.freeze({
      AGENC_PROVIDER: provider,
      AGENC_MODEL: model,
      ...overrides,
    }),
  }
}

afterEach(() => {
  mock.restore()
})

test('logs a warning when OPENAI_BASE_URL is literal undefined', async () => {
  const debugSpy = mock(() => {})
  mock.module('src/utils/debug.js', () => ({
    logForDebugging: debugSpy,
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`../../../src/services/api/providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest(
    providerSelection('openai', 'gpt-4o', {
      OPENAI_BASE_URL: 'undefined',
    }),
  )

  expect(resolved.baseUrl).toBe('https://api.openai.com/v1')

  const warningCall = debugSpy.mock.calls.find(call =>
    typeof call?.[0] === 'string' &&
    call[0].includes('OPENAI_BASE_URL') &&
    call[0].includes('"undefined"'),
  )

  expect(warningCall).toBeDefined()
  expect(warningCall?.[1]).toEqual({ level: 'warn' })
})

test('does not warn for OPENAI_API_BASE when OPENAI_BASE_URL is active', async () => {
  const debugSpy = mock(() => {})
  mock.module('src/utils/debug.js', () => ({
    logForDebugging: debugSpy,
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`../../../src/services/api/providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest(
    providerSelection('openai', 'qwen2.5-coder:7b', {
      OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
      OPENAI_API_BASE: 'undefined',
    }),
  )

  expect(resolved.baseUrl).toBe('http://127.0.0.1:11434/v1')

  const aliasWarning = debugSpy.mock.calls.find(call =>
    typeof call?.[0] === 'string' &&
    call[0].includes('OPENAI_API_BASE') &&
    call[0].includes('"undefined"'),
  )

  expect(aliasWarning).toBeUndefined()
})

test('uses OPENAI_API_BASE as fallback in mistral mode when MISTRAL_BASE_URL is unset', async () => {
  const debugSpy = mock(() => {})
  mock.module('src/utils/debug.js', () => ({
    logForDebugging: debugSpy,
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`../../../src/services/api/providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest(
    providerSelection('mistral', 'mistral-medium-latest', {
      OPENAI_API_BASE: 'http://127.0.0.1:11434/v1',
    }),
  )

  expect(resolved.baseUrl).toBe('http://127.0.0.1:11434/v1')
  expect(debugSpy.mock.calls).toHaveLength(0)
})
