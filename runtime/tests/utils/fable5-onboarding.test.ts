/**
 * Task 28: Claude Fable 5 onboarding.
 *
 * Capabilities verified against provider docs 2026-07-08: 1M context
 * (the default window for the model), 128K max output, $10/$50 pricing,
 * effort including max, always-on thinking (adaptive is
 * the only accepted explicit config; `disabled`/budget_tokens 400), NO
 * fast mode, NO assistant prefill, and the `refusal` stop reason. The
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  claudeFamilyVersion,
  getModelMaxOutputTokens,
  modelSupports1M,
} from '../../src/utils/context.js'
import { getModelCosts } from '../../src/utils/modelCost.js'
import {
  modelSupportsEffort,
  modelSupportsMaxEffort,
} from '../../src/utils/effort.js'
import { isFastModeSupportedByModel } from '../../src/utils/fastMode.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
} from '../../src/utils/thinking.js'
import { isAlwaysOnThinkingAnthropicModel } from '../../src/utils/model/alwaysOnThinking.js'
import { sanitizeModelName } from '../../src/utils/commitAttribution.js'
import {
  AGENC_FABLE_5_CONFIG,
  ALL_MODEL_CONFIGS,
} from '../../src/utils/model/configs.js'
import {
  firstPartyNameToCanonical,
  getMarketingNameForModel,
} from '../../src/utils/model/model.js'
import { BUILT_IN_PROVIDER_MODEL_CATALOG } from '../../src/llm/registry/provider-info.js'
import { runWithStartupProviderSelection } from '../../src/utils/model/providers.js'

const FABLE_5 = 'claude-fable-5'

beforeEach(() => {
  vi.stubEnv('AGENC_DISABLE_1M_CONTEXT', '')
  vi.stubEnv('USER_TYPE', '')
  vi.stubEnv('AGENC_PROVIDER', 'anthropic')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Fable 5 onboarding', () => {
  it('is registered as a model config with the canonical first-party id', () => {
    expect(AGENC_FABLE_5_CONFIG.firstParty).toBe(FABLE_5)
    expect(ALL_MODEL_CONFIGS.fable5).toBe(AGENC_FABLE_5_CONFIG)
    expect(firstPartyNameToCanonical('us.anthropic.agenc-fable-5-v1')).toBe(
      FABLE_5,
    )
  })

  it('supports 1M context (fable family threshold)', () => {
    expect(modelSupports1M(FABLE_5)).toBe(true)
    expect(claudeFamilyVersion(FABLE_5, 'fable')).toBe(5)
    // A hypothetical fable-5-1 inherits without a table edit.
    expect(modelSupports1M('claude-fable-5-1')).toBe(true)
    // The fable regex never claims opus/sonnet strings.
    expect(claudeFamilyVersion('claude-opus-4-8', 'fable')).toBeUndefined()
  })

  it('gets the 128K max-output limits', () => {
    expect(getModelMaxOutputTokens(FABLE_5)).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    })
  })

  it('bills at the $10/$50 tier with 1.25x/0.1x cache pricing', () => {
    const costs = getModelCosts(FABLE_5, {
      input_tokens: 0,
      output_tokens: 0,
    } as never)
    expect(costs.inputTokens).toBe(10)
    expect(costs.outputTokens).toBe(50)
    expect(costs.promptCacheWriteTokens).toBe(12.5)
    expect(costs.promptCacheReadTokens).toBe(1)
  })

  it('does NOT carry the opus fast-mode premium routing (no fast mode)', () => {
    // Fable 5 has no fast mode; a (never-produced) fast usage record must
    // not flip it onto the $30/$150 opus fast tier.
    const costs = getModelCosts(FABLE_5, {
      input_tokens: 0,
      output_tokens: 0,
      speed: 'fast',
    } as never)
    expect(costs.inputTokens).toBe(10)
    expect(costs.outputTokens).toBe(50)
  })

  it('supports effort including max', () => {
    runWithStartupProviderSelection({
      provider: 'anthropic',
      model: FABLE_5,
      environment: { ...process.env },
    }, () => {
      expect(modelSupportsEffort(FABLE_5)).toBe(true)
      expect(modelSupportsMaxEffort(FABLE_5)).toBe(true)
    })
  })

  it('has NO fast mode', () => {
    expect(isFastModeSupportedByModel(FABLE_5)).toBe(false)
  })

  it('is an always-on-thinking model (adaptive; disabled 400s upstream)', () => {
    expect(isAlwaysOnThinkingAnthropicModel(FABLE_5)).toBe(true)
    expect(isAlwaysOnThinkingAnthropicModel('us.anthropic.agenc-fable-5-v1')).toBe(
      true,
    )
    expect(isAlwaysOnThinkingAnthropicModel('claude-mythos-5')).toBe(true)
    // mythos-preview kept the old surface (budget_tokens) — excluded.
    expect(isAlwaysOnThinkingAnthropicModel('claude-mythos-preview')).toBe(false)
    expect(isAlwaysOnThinkingAnthropicModel('claude-opus-4-8')).toBe(false)
    expect(modelSupportsThinking(FABLE_5)).toBe(true)
    expect(modelSupportsAdaptiveThinking(FABLE_5)).toBe(true)
  })

  it('sanitizes commit attribution to the public fable-5 name', () => {
    expect(sanitizeModelName('agenc-fable-5-internal')).toBe(FABLE_5)
  })

  it('is selectable on the anthropic provider registry', () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.anthropic).toContain(FABLE_5)
    // The existing opus entries stay selectable.
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.anthropic).toContain(
      'claude-opus-4-8',
    )
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.anthropic).toContain(
      'claude-opus-4-7',
    )
  })

  it('maps display/marketing names', () => {
    expect(getMarketingNameForModel(FABLE_5)).toBe('Fable 5')
    expect(getMarketingNameForModel(`${FABLE_5}[1m]`)).toBe(
      'Fable 5 (with 1M context)',
    )
  })
})
