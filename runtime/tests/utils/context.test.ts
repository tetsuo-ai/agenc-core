import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from '../../src/utils/context.ts'
import { runWithStartupProviderSelection } from '../../src/utils/model/providers.ts'

function providerTest(
  name: string,
  body: () => void | Promise<void>,
): void {
  test(name, () => runWithStartupProviderSelection({ provider: 'openai', model: process.env.OPENAI_MODEL ?? 'gpt-4o', environment: { ...process.env } }, body))
}

const originalEnv = {
  AGENC_PROVIDER: process.env.AGENC_PROVIDER,
  AGENC_MAX_OUTPUT_TOKENS: process.env.AGENC_MAX_OUTPUT_TOKENS,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
}

beforeEach(() => {
  delete process.env.AGENC_PROVIDER
  delete process.env.AGENC_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL
})

afterEach(() => {
  if (originalEnv.AGENC_PROVIDER === undefined) {
    delete process.env.AGENC_PROVIDER
  } else {
    process.env.AGENC_PROVIDER = originalEnv.AGENC_PROVIDER
  }
  if (originalEnv.AGENC_MAX_OUTPUT_TOKENS === undefined) {
    delete process.env.AGENC_MAX_OUTPUT_TOKENS
  } else {
    process.env.AGENC_MAX_OUTPUT_TOKENS =
      originalEnv.AGENC_MAX_OUTPUT_TOKENS
  }
  if (originalEnv.OPENAI_MODEL === undefined) {
    delete process.env.OPENAI_MODEL
  } else {
    process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
  }
})

providerTest('deepseek-v4-flash uses provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-flash')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('deepseek-v4-flash')).toEqual({
    default: 262_144,
    upperLimit: 262_144,
  })
})

providerTest('gpt-4o uses provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('gpt-4o')).toBe(128_000)
  expect(getModelMaxOutputTokens('gpt-4o')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})

providerTest('gpt-5.4 family uses provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('gpt-5.4')).toBe(1_050_000)
  expect(getModelMaxOutputTokens('gpt-5.4')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })

  expect(getContextWindowForModel('gpt-5.4-mini')).toBe(400_000)
  expect(getModelMaxOutputTokens('gpt-5.4-mini')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })

  expect(getContextWindowForModel('gpt-5.4-nano')).toBe(400_000)
  expect(getModelMaxOutputTokens('gpt-5.4-nano')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })
})

providerTest('MiniMax-M2.7 uses explicit provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('MiniMax-M2.7')).toBe(204_800)
  expect(getModelMaxOutputTokens('MiniMax-M2.7')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
})

providerTest('unknown openai-compatible models use the 128k fallback window (not 8k, see #635)', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('some-unknown-3p-model')).toBe(128_000)
})

providerTest('MiniMax-M2.5 and M2.1 use explicit provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('MiniMax-M2.5')).toBe(204_800)
  expect(getContextWindowForModel('MiniMax-M2.5-highspeed')).toBe(204_800)
  expect(getContextWindowForModel('MiniMax-M2.1')).toBe(204_800)
  expect(getContextWindowForModel('MiniMax-M2.1-highspeed')).toBe(204_800)
  expect(getModelMaxOutputTokens('MiniMax-M2.5')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
})

providerTest('DashScope qwen3.6-plus uses provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3.6-plus')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('qwen3.6-plus')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

providerTest('DashScope qwen3.5-plus uses provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3.5-plus')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('qwen3.5-plus')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

providerTest('DashScope qwen3-coder-plus uses provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-coder-plus')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('qwen3-coder-plus')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

providerTest('DashScope qwen3-coder-next uses provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-coder-next')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-coder-next')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

providerTest('DashScope qwen3-max uses provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-max')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-max')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

providerTest('DashScope qwen3-max dated variant resolves to base entry via prefix match', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-max-2026-01-23')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-max-2026-01-23')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

providerTest('DashScope kimi-k2.5 uses provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('kimi-k2.5')).toBe(262_144)
  expect(getModelMaxOutputTokens('kimi-k2.5')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

providerTest('Kimi Code kimi-for-coding uses provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('kimi-for-coding')).toBe(262_144)
  expect(getModelMaxOutputTokens('kimi-for-coding')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

providerTest('DashScope glm-5 uses provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('glm-5')).toBe(202_752)
  expect(getModelMaxOutputTokens('glm-5')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})

providerTest('DashScope glm-4.7 uses provider-specific context and output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('glm-4.7')).toBe(202_752)
  expect(getModelMaxOutputTokens('glm-4.7')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})

providerTest('Z.AI uppercase GLM models use Coding Plan output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('GLM-5.1')).toBe(202_752)
  expect(getModelMaxOutputTokens('GLM-5.1')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
  expect(getModelMaxOutputTokens('GLM-5-Turbo')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
  expect(getModelMaxOutputTokens('GLM-4.5-Air')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

providerTest('lowercase GLM aliases keep conservative output caps', () => {
  process.env.AGENC_PROVIDER = 'openai'
  delete process.env.AGENC_MAX_OUTPUT_TOKENS

  expect(getModelMaxOutputTokens('glm-5.1')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
  expect(getModelMaxOutputTokens('glm-5-turbo')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
  expect(getModelMaxOutputTokens('glm-4.5-air')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})
