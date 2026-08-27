import { afterEach, expect, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../../src/bootstrap/state.ts'
import { parseUserSpecifiedModel } from '../../../src/utils/model/model.ts'
import { getModelStrings } from '../../../src/utils/model/modelStrings.ts'
import { runWithCanonicalRuntimeAuthority } from '../../helpers/canonical-runtime-authority.bun.ts'

const originalEnv = {
  AGENC_PROVIDER: process.env.AGENC_PROVIDER,
  XAI_API_KEY: process.env.XAI_API_KEY,
}

function clearProviderFlags(): void {
  delete process.env.AGENC_PROVIDER
  delete process.env.XAI_API_KEY
}

function withModelAuthority<T>(
  provider: string,
  model: string,
  operation: () => T,
): T {
  return runWithCanonicalRuntimeAuthority(operation, {
    environment: { ...process.env },
    model,
    provider,
  })
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  resetModelStringsForTestingOnly()
})

test('GitHub provider model strings are concrete IDs', () => {
  clearProviderFlags()
  process.env.AGENC_PROVIDER = 'github'

  const modelStrings = withModelAuthority(
    'github',
    'github:copilot',
    getModelStrings,
  )

  for (const value of Object.values(modelStrings)) {
    expect(typeof value).toBe('string')
    expect(value.trim().length).toBeGreaterThan(0)
  }
})

test('GitHub provider model strings are safe to parse', () => {
  clearProviderFlags()
  process.env.AGENC_PROVIDER = 'github'

  withModelAuthority('github', 'github:copilot', () => {
    const modelStrings = getModelStrings()
    expect(() =>
      parseUserSpecifiedModel(modelStrings.sonnet46 as any),
    ).not.toThrow()
  })
})

// Regression: only AGENC_OPUS_4_6_CONFIG defines `xai`/`mistral` keys, so for
// every other ModelKey the provider-specific lookup was undefined at runtime
// (tsc-blind because ModelConfig has an open index signature). Downstream this
// produced model IDs like 'undefined[1m]' in the /model picker.
test('xai provider model strings are concrete IDs for every model key', () => {
  clearProviderFlags()
  process.env.AGENC_PROVIDER = 'grok'
  process.env.XAI_API_KEY = 'xai-test-key'

  const modelStrings = withModelAuthority('grok', 'grok-4.6', getModelStrings)

  const entries = Object.entries(modelStrings)
  expect(entries.length).toBeGreaterThan(0)
  for (const [key, value] of entries) {
    expect(value, `xai model string for key "${key}"`).toBeDefined()
    expect(typeof value).toBe('string')
    expect((value as string).trim().length).toBeGreaterThan(0)
  }
})

test('mistral provider model strings are concrete IDs for every model key', () => {
  clearProviderFlags()
  process.env.AGENC_PROVIDER = 'mistral'

  const modelStrings = withModelAuthority(
    'mistral',
    'mistral-medium-latest',
    getModelStrings,
  )

  const entries = Object.entries(modelStrings)
  expect(entries.length).toBeGreaterThan(0)
  for (const [key, value] of entries) {
    expect(value, `mistral model string for key "${key}"`).toBeDefined()
    expect(typeof value).toBe('string')
    expect((value as string).trim().length).toBeGreaterThan(0)
  }
})
