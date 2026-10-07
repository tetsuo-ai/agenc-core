import { afterEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ reads: 0, fail: false, mismatch: false }))
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
    if (String(args[0]).endsWith('/openrouter-models.data.json')) {
      state.reads++
      if (state.fail) throw new Error('catalog-data-unavailable')
      if (state.mismatch) return '[]'
    }
    return Reflect.apply(original.readFileSync, original, args)
  } }
})

afterEach(() => {
  state.reads = 0
  state.fail = false
  state.mismatch = false
  vi.resetModules()
})

describe('catalog data on first use', () => {
  test('defaults, provider names, flat authority and other-provider metadata need no OpenRouter rows', async () => {
    state.fail = true
    const registry = await import('../../../src/llm/registry/model-catalog.js')
    const info = await import('../../../src/llm/registry/provider-info.js')
    expect(info.DEFAULT_BUILT_IN_PROVIDER_SELECTION).toEqual({ provider: 'grok', model: 'grok-4.6' })
    expect(registry.deriveFlatCatalog().openrouter).toContain('openai/gpt-6-sol')
    expect(info.BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter[0]).toBe('x-ai/grok-4.5')
    expect(registry.registeredModelCatalogProviderIds()[0]).toBe('openrouter')
    expect(registry.listRegisteredModelCatalogEntries(' DeepSeek ').length).toBeGreaterThan(0)
    expect(registry.resolveRegisteredModelCatalogEntry({ provider: 'deepseek', model: 'deepseek-flash' })?.model).toBe('deepseek-flash')
    expect(registry.resolveRegisteredModelCatalogEntry({ provider: 'openrouter', model: 'not-in-the-catalog' })).toBeUndefined()
    expect(registry.listRegisteredModelCatalogEntries('not-a-provider')).toEqual([])
    expect(state.reads).toBe(0)
  })

  test('first capability access fails closed and retries without changing names or defaults', async () => {
    const registry = await import('../../../src/llm/registry/model-catalog.js')
    state.fail = true
    const resolve = () => registry.resolveRegisteredModelCatalogEntry({ provider: 'openrouter', model: 'openai/gpt-6-sol' })
    expect(resolve).toThrow('catalog-data-unavailable')
    expect(state.reads).toBe(1)
    state.fail = false
    const row = resolve()
    expect(row?.provider).toBe('openrouter')
    expect(resolve()).toBe(row)
    expect(registry.listRegisteredModelCatalogEntries('openrouter').find(entry => entry.model === row?.model)).toBe(row)
    expect(state.reads).toBe(2)
  })

  test('a mismatched data index is an error and is not cached', async () => {
    const { OPENROUTER_MODELS } = await import('../../../src/llm/registry/openrouter-models.js')
    state.mismatch = true
    expect(() => OPENROUTER_MODELS[0]).toThrow('does not match its model index')
    state.mismatch = false
    expect(OPENROUTER_MODELS[0]?.model).toBe('anthropic/claude-haiku-5.5')
    expect(state.reads).toBe(2)
  })

  test('public arrays preserve freezing, enumeration, serialization, order and row identity', async () => {
    const { OPENROUTER_MODELS } = await import('../../../src/llm/registry/openrouter-models.js')
    const registry = await import('../../../src/llm/registry/model-catalog.js')
    expect(Array.isArray(OPENROUTER_MODELS)).toBe(true)
    expect(Object.isFrozen(OPENROUTER_MODELS)).toBe(true)
    expect(Object.keys(OPENROUTER_MODELS)).toHaveLength(OPENROUTER_MODELS.length)
    expect(Object.isFrozen(registry.REGISTERED_MODEL_CATALOG)).toBe(true)
    expect(state.reads).toBe(0)
    const row = OPENROUTER_MODELS[0]!
    const registered = registry.REGISTERED_MODEL_CATALOG[0]!
    expect(registered.model).toBe(row.model)
    expect(registered.inputModalities).toBe(row.modalities)
    expect(registry.listRegisteredModelCatalogEntries()[0]).toBe(registered)
    expect([...OPENROUTER_MODELS][0]).toBe(row)
    expect(JSON.parse(JSON.stringify(OPENROUTER_MODELS))).toEqual([...OPENROUTER_MODELS])
    expect(registry.registeredModelCatalogProviderIds()).toEqual([...new Set(registry.REGISTERED_MODEL_CATALOG.map(entry => entry.provider))])
    expect(() => (OPENROUTER_MODELS as unknown[]).push(row)).toThrow(TypeError)
    expect(state.reads).toBe(1)
  })

  test('cost projection retains routed rates and the full conservative ceiling without capability rows', async () => {
    state.fail = true
    const { DEFAULT_MODEL_COSTS, conservativeModelCost } = await import('../../../src/session/cost.js')
    expect(DEFAULT_MODEL_COSTS['openrouter:openai/gpt-6-sol']).toBeDefined()
    expect(conservativeModelCost().inputUsdPer1K).toBeGreaterThan(0)
    expect(state.reads).toBe(0)
  })
})
