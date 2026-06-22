import { describe, expect, it } from 'vitest'

import {
  COPILOT_MODELS,
  getAllCopilotModels,
  getCopilotModel,
  getCopilotModelIds,
} from '../../../src/utils/model/copilotModels.js'

const EXPECTED_COPILOT_MODEL_IDS = [
  'gpt-5.5',
  'gpt-5.5-mini',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-4o',
  'gpt-4.1',
  'claude-opus-4.6',
  'claude-opus-4.5',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-haiku-4.5',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'grok-code-fast-1',
] as const

describe('Copilot model registry', () => {
  it('keeps exported model IDs unique and ordered for picker consumers', () => {
    const ids = getCopilotModelIds()

    expect(ids).toEqual(EXPECTED_COPILOT_MODEL_IDS)
    expect(new Set(ids).size).toBe(ids.length)
    expect(getAllCopilotModels().map(model => model.id)).toEqual(ids)
  })

  it('keeps each registry key in sync with the built model id', () => {
    for (const [id, model] of Object.entries(COPILOT_MODELS)) {
      expect(model.id).toBe(id)
      expect(getCopilotModel(id)).toBe(model)
    }
  })

  it('applies shared defaults and selected per-model overrides', () => {
    expect(getCopilotModel('gpt-5.5')).toMatchObject({
      name: 'GPT-5.5',
      family: 'gpt',
      attachment: false,
      reasoning: true,
      tool_call: true,
      temperature: true,
      knowledge: '2025-05',
      release_date: '2025-05-01',
      last_updated: '2025-05-01',
      modalities: { input: ['text'], output: ['text'] },
      open_weights: false,
      cost: { input: 0, output: 0 },
      limit: { context: 400000, output: 32768 },
    })

    expect(getCopilotModel('gpt-4o')).toMatchObject({
      attachment: true,
      reasoning: false,
      knowledge: '2023-10',
      release_date: '2024-05-01',
      last_updated: '2024-05-01',
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 128000, output: 16384 },
    })

    expect(getCopilotModel('gemini-3.1-pro-preview')).toMatchObject({
      attachment: true,
      modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
      limit: { context: 128000, output: 32768 },
    })
  })

  it('does not share mutable nested metadata across built models', () => {
    const primary = getCopilotModel('gpt-5.5')
    const secondary = getCopilotModel('gpt-5.4')

    expect(primary).toBeDefined()
    expect(secondary).toBeDefined()
    expect(primary?.modalities).not.toBe(secondary?.modalities)
    expect(primary?.modalities.input).not.toBe(secondary?.modalities.input)
    expect(primary?.cost).not.toBe(secondary?.cost)
    expect(primary?.limit).not.toBe(secondary?.limit)
  })
})
