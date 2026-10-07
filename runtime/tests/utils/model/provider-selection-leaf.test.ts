import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../../../src/llm/registry/model-catalog.js', () => {
  throw new Error('reading bound authority must not load the model catalog')
})
vi.mock('../../../src/llm/provider-environment.js', () => {
  throw new Error('reading bound authority must not recapture environment')
})
vi.mock('../../../src/app-server/protocol/index.js', () => {
  throw new Error('reading bound authority must not load the protocol registry')
})

afterEach(() => vi.resetModules())

it('keeps explicit normalization and rejects a missing bound authority', async () => {
  vi.resetModules()
  const selection = await import('../../../src/utils/model/provider-selection.js')
  expect(selection.getSelectedProviderName('  GROK  ')).toBe('grok')
  expect(() => selection.getSelectedProviderName(' ')).toThrow('non-empty provider name')
  expect(() => selection.getSelectedProviderName('xai')).toThrow('retired provider selector')
  expect(() => selection.getSelectedProviderName()).toThrow('No provider authority is bound')
})

it('reads the scoped session and returns its environment without recapture', async () => {
  vi.resetModules()
  const selection = await import('../../../src/utils/model/provider-selection.js')
  const scope = await import('../../../src/session/current-session.js')
  const environment = Object.freeze({ AGENC_CREDENTIAL_TEST: 'test-value' })
  const session = { services: { providerService: {
    current: () => ({ provider: 'grok', model: 'selected-model' }),
    environment: () => environment,
  } } }
  scope.runWithCurrentRuntimeSession(session as never, () => {
    expect(selection.getSelectedProviderName()).toBe('grok')
    expect(selection.getSelectedProviderModel()).toBe('selected-model')
    expect(selection.getSelectedProviderEnvironment()).toBe(environment)
    expect(Object.isFrozen(selection.getSelectedProviderSelection())).toBe(true)
  })
  scope.runWithCurrentRuntimeSession({ services: {} } as never, () => {
    expect(() => selection.getSelectedProviderName()).toThrow('session-owned provider binding')
  })
})

it('keeps ambiguous session authority fail closed', async () => {
  vi.resetModules()
  const selection = await import('../../../src/utils/model/provider-selection.js')
  const scope = await import('../../../src/session/current-session.js')
  try {
    scope.setCurrentRuntimeSession({ services: {} } as never)
    scope.setCurrentRuntimeSession({ services: {} } as never)
    expect(() => selection.getSelectedProviderName()).toThrow('Ambiguous runtime session')
  } finally {
    scope.clearCurrentRuntimeSession()
  }
})
