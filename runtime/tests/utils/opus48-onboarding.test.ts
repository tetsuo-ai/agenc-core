/**
 * Task 12: Claude Opus 4.8 onboarding + version-threshold hardening.
 *
 * Capabilities verified against provider docs 2026-07-07: 1M context,
 * 128K max output, $5/$25 pricing (fast premium $30/$150), fast mode
 * (4.8 is the durable fast tier), structured outputs, effort incl.
 * max, advisor both directions. The threshold tests pin the hardening:
 * a hypothetical next minor release inherits family capabilities
 * instead of silently regressing (the 4.7 half-onboarding incident).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  claudeFamilyVersion,
  getModelMaxOutputTokens,
  modelSupports1M,
} from '../../src/utils/context.js'
import { getModelCosts } from '../../src/utils/modelCost.js'
import { modelSupportsStructuredOutputs } from '../../src/utils/betas.js'
import {
  modelSupportsEffort,
  modelSupportsMaxEffort,
} from '../../src/utils/effort.js'
import {
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from '../../src/utils/advisor.js'
import { sanitizeModelName } from '../../src/utils/commitAttribution.js'
import {
  AGENC_OPUS_4_8_CONFIG,
  ALL_MODEL_CONFIGS,
} from '../../src/utils/model/configs.js'
import { firstPartyNameToCanonical } from '../../src/utils/model/model.js'
import { BUILT_IN_PROVIDER_MODEL_CATALOG } from '../../src/llm/registry/provider-info.js'

const OPUS_48 = 'claude-opus-4-8'

beforeEach(() => {
  vi.stubEnv('AGENC_DISABLE_1M_CONTEXT', '')
  vi.stubEnv('USER_TYPE', '')
  // Pin the provider to firstParty regardless of the host machine's env
  // (an ambient XAI_API_KEY/AGENC_USE_* would flip getAPIProvider()).
  vi.stubEnv('XAI_API_KEY', '')
  vi.stubEnv('MINIMAX_API_KEY', '')
  vi.stubEnv('AGENC_USE_OPENAI', '')
  vi.stubEnv('AGENC_USE_GEMINI', '')
  vi.stubEnv('AGENC_USE_GITHUB', '')
  vi.stubEnv('AGENC_USE_MISTRAL', '')
  vi.stubEnv('AGENC_USE_MINIMAX', '')
  vi.stubEnv('NVIDIA_NIM', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Opus 4.8 onboarding', () => {
  it('is registered as a model config with the canonical first-party id', () => {
    expect(AGENC_OPUS_4_8_CONFIG.firstParty).toBe(OPUS_48)
    expect(ALL_MODEL_CONFIGS.opus48).toBe(AGENC_OPUS_4_8_CONFIG)
    expect(firstPartyNameToCanonical('us.anthropic.agenc-opus-4-8-v1')).toBe(
      OPUS_48,
    )
  })

  it('supports 1M context', () => {
    expect(modelSupports1M(OPUS_48)).toBe(true)
  })

  it('gets the Opus 4.6+ output limits (128K upper)', () => {
    expect(getModelMaxOutputTokens(OPUS_48)).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    })
    // The 4.7 half-onboarding gap: it used to fall through to the
    // generic opus-4 32K branch.
    expect(getModelMaxOutputTokens('claude-opus-4-7').upperLimit).toBe(128_000)
  })

  it('bills at the $5/$25 tier with the fast-mode premium', () => {
    const base = getModelCosts(OPUS_48, {
      input_tokens: 0,
      output_tokens: 0,
    } as never)
    expect(base.inputTokens).toBe(5)
    expect(base.outputTokens).toBe(25)
  })

  it('supports structured outputs, effort (incl. max), and advisor', () => {
    expect(modelSupportsStructuredOutputs(OPUS_48)).toBe(true)
    expect(modelSupportsEffort(OPUS_48)).toBe(true)
    expect(modelSupportsMaxEffort(OPUS_48)).toBe(true)
    expect(modelSupportsAdvisor(OPUS_48)).toBe(true)
    expect(isValidAdvisorModel(OPUS_48)).toBe(true)
  })

  it('sanitizes commit attribution to the public 4.8 name', () => {
    expect(sanitizeModelName('agenc-opus-4-8-internal')).toBe(OPUS_48)
  })

  it('is selectable on the anthropic provider registry', () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.anthropic).toContain(OPUS_48)
    // The prior default stays selectable.
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.anthropic).toContain(
      'claude-opus-4-7',
    )
  })
})

describe('version-threshold hardening', () => {
  it('parses claude family versions', () => {
    expect(claudeFamilyVersion('claude-opus-4-6', 'opus')).toBe(4.06)
    expect(claudeFamilyVersion('claude-opus-4-10', 'opus')).toBe(4.1)
    expect(claudeFamilyVersion('claude-sonnet-4', 'sonnet')).toBe(4)
    expect(claudeFamilyVersion('claude-sonnet-4-6', 'opus')).toBeUndefined()
  })

  it('a hypothetical opus-4-9 inherits 1M support without a table edit', () => {
    expect(modelSupports1M('claude-opus-4-9')).toBe(true)
    expect(modelSupports1M('claude-opus-4-10')).toBe(true)
  })

  it('keeps pre-4.6 opus and pre-4 sonnet excluded from 1M', () => {
    // Dated Opus 4.0 id: the date suffix must not parse as a minor version.
    expect(modelSupports1M('claude-opus-4-20250514')).toBe(false)
    expect(claudeFamilyVersion('claude-opus-4-20250514', 'opus')).toBe(4)
    expect(modelSupports1M('claude-opus-4-5-20251101')).toBe(false)
    expect(modelSupports1M('claude-opus-4-1-20250805')).toBe(false)
    expect(modelSupports1M('claude-3-7-sonnet-20250219')).toBe(false)
    expect(modelSupports1M('claude-sonnet-4-6')).toBe(true)
    expect(modelSupports1M('claude-haiku-4-5-20251001')).toBe(false)
  })
})
