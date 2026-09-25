/**
 * Claude Opus 5.5 onboarding.
 *
 * Facts from platform.claude.com (models overview, Opus 5.5 overview and
 * migration guide, pricing, effort, fast mode; read 2026-09-22): model id
 * `claude-opus-5-5` (Bedrock `anthropic.claude-opus-5-5`), 1M context,
 * 128K max output, $4/$20 per MTok with 5-minute cache writes at $5 and
 * cache reads at $0.20 (0.05x input), effort low through max with medium as
 * the API default, always-on adaptive thinking (`disabled` and
 * `budget_tokens` return 400), fast mode at $8/$40 on the Claude API. It is
 * the recommended default; Opus 5 is legacy but still served. Not probed
 * live: the wire contract here is the documented one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  claudeFamilyVersion,
  getModelMaxOutputTokens,
  modelSupports1M,
} from '../../src/utils/context.js'
import { getModelCosts } from '../../src/utils/modelCost.js'
import {
  getDisplayedEffortLevel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
} from '../../src/utils/effort.js'
import { modelSupportsAdaptiveThinking } from '../../src/utils/thinking.js'
import { isAlwaysOnThinkingAnthropicModel } from '../../src/utils/model/alwaysOnThinking.js'
import {
  AGENC_OPUS_5_5_CONFIG,
  AGENC_OPUS_5_CONFIG,
  ALL_MODEL_CONFIGS,
  CANONICAL_ID_TO_KEY,
} from '../../src/utils/model/configs.js'
import { firstPartyNameToCanonical } from '../../src/utils/model/model.js'
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from '../../src/llm/registry/provider-info.js'
import { runWithStartupProviderSelection } from '../../src/utils/model/providers.js'

const OPUS_55 = 'claude-opus-5-5'
const OPUS_5 = 'claude-opus-5'

beforeEach(() => {
  vi.stubEnv('AGENC_DISABLE_1M_CONTEXT', '')
  vi.stubEnv('AGENC_PROVIDER', 'anthropic')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Opus 5.5 onboarding', () => {
  it('is registered as its own model config next to Opus 5', () => {
    expect(AGENC_OPUS_5_5_CONFIG.firstParty).toBe(OPUS_55)
    expect(AGENC_OPUS_5_5_CONFIG.vertex).toBe(OPUS_55)
    expect(AGENC_OPUS_5_5_CONFIG.foundry).toBe(OPUS_55)
    expect(ALL_MODEL_CONFIGS.opus55).toBe(AGENC_OPUS_5_5_CONFIG)
    expect(CANONICAL_ID_TO_KEY[OPUS_55]).toBe('opus55')
    expect(ALL_MODEL_CONFIGS.opus5).toBe(AGENC_OPUS_5_CONFIG)
    expect(CANONICAL_ID_TO_KEY[OPUS_5]).toBe('opus5')
  })

  it('canonicalizes to Opus 5.5 without collapsing onto Opus 5', () => {
    expect(firstPartyNameToCanonical(OPUS_55)).toBe(OPUS_55)
    expect(firstPartyNameToCanonical('us.anthropic.agenc-opus-5-5-v1')).toBe(
      OPUS_55,
    )
    expect(firstPartyNameToCanonical('anthropic.claude-opus-5-5')).toBe(OPUS_55)
    expect(firstPartyNameToCanonical(OPUS_5)).toBe(OPUS_5)
    expect(firstPartyNameToCanonical('us.anthropic.agenc-opus-5-v1')).toBe(
      OPUS_5,
    )
  })

  it('gets the 1M context window and 128K max output', () => {
    expect(claudeFamilyVersion(OPUS_55, 'opus')).toBe(5.05)
    expect(modelSupports1M(OPUS_55)).toBe(true)
    expect(getModelMaxOutputTokens(OPUS_55)).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    })
  })

  it('bills $4/$20 with $5 cache writes and 0.05x cache reads', () => {
    const usage = { input_tokens: 0, output_tokens: 0 } as never
    expect(getModelCosts(OPUS_55, usage)).toMatchObject({
      inputTokens: 4,
      outputTokens: 20,
      promptCacheWriteTokens: 5,
      promptCacheReadTokens: 0.2,
    })
    // Opus 5 keeps its own $5/$25 tier with the standard 0.1x cache read.
    expect(getModelCosts(OPUS_5, usage)).toMatchObject({
      inputTokens: 5,
      outputTokens: 25,
      promptCacheWriteTokens: 6.25,
      promptCacheReadTokens: 0.5,
    })
  })

  it('bills a fast-served turn at the documented fast-mode rates', () => {
    // Fast-mode doc, 2026-09-22: Opus 5.5 $8/$40; Opus 5 and 4.8 $10/$50;
    // prompt-caching multipliers apply on top.
    const fast = { input_tokens: 0, output_tokens: 0, speed: 'fast' } as never
    expect(getModelCosts(OPUS_55, fast)).toMatchObject({
      inputTokens: 8,
      outputTokens: 40,
      promptCacheWriteTokens: 10,
      promptCacheReadTokens: 0.4,
    })
    for (const model of [OPUS_5, 'claude-opus-4-8']) {
      expect(getModelCosts(model, fast), model).toMatchObject({
        inputTokens: 10,
        outputTokens: 50,
        promptCacheWriteTokens: 12.5,
        promptCacheReadTokens: 1,
      })
    }
    // Requested fast but served standard: the standard tier.
    const standard = { input_tokens: 0, output_tokens: 0, speed: 'standard' } as never
    expect(getModelCosts(OPUS_55, standard).inputTokens).toBe(4)
  })

  it('supports effort including max', () => {
    runWithStartupProviderSelection({
      provider: 'anthropic',
      model: OPUS_55,
      environment: { ...process.env },
    }, () => {
      expect(modelSupportsEffort(OPUS_55)).toBe(true)
      expect(modelSupportsMaxEffort(OPUS_55)).toBe(true)
      // No effort configured: AgenC sends none and the API runs Opus 5.5 at
      // medium, which is what the TUI reports.
      expect(getDisplayedEffortLevel(OPUS_55, undefined)).toBe('medium')
    })
  })

  it('is an always-on-thinking model while Opus 5 is not', () => {
    expect(isAlwaysOnThinkingAnthropicModel(OPUS_55)).toBe(true)
    expect(isAlwaysOnThinkingAnthropicModel('us.anthropic.agenc-opus-5-5-v1')).toBe(
      true,
    )
    expect(isAlwaysOnThinkingAnthropicModel(OPUS_5)).toBe(false)
    expect(modelSupportsAdaptiveThinking(OPUS_55)).toBe(true)
  })

  it('is the Anthropic default and leads the picker, with Opus 5 kept as legacy', () => {
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.anthropic).toBe(OPUS_55)
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.anthropic[0]).toBe(OPUS_55)
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.anthropic).toContain(OPUS_5)
  })
})
