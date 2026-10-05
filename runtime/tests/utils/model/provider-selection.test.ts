import { expect, it } from 'vitest'
import * as compatibility from '../../../src/utils/model/providers.js'
import * as leaf from '../../../src/utils/model/provider-selection.js'

it('shares the same projection functions through the compatibility facade', () => {
  expect(compatibility.getSelectedProviderName).toBe(leaf.getSelectedProviderName)
  expect(compatibility.getSelectedProviderSelection).toBe(leaf.getSelectedProviderSelection)
  expect(compatibility.getSelectedProviderModel).toBe(leaf.getSelectedProviderModel)
  expect(compatibility.getSelectedProviderEnvironment).toBe(leaf.getSelectedProviderEnvironment)
})

it('keeps concurrent startup scopes and captured credential environments isolated', async () => {
  const run = (provider: string) => {
    const environment = { AGENC_CREDENTIAL_TEST: provider }
    return compatibility.runWithStartupProviderSelection({
      provider, model: `${provider}-model`, environment,
    }, async () => {
      environment.AGENC_CREDENTIAL_TEST = 'mutated'
      await Promise.resolve()
      expect(leaf.getSelectedProviderName()).toBe(provider)
      expect(leaf.getSelectedProviderModel()).toBe(`${provider}-model`)
      expect(leaf.getSelectedProviderEnvironment().AGENC_CREDENTIAL_TEST).toBe(provider)
      expect(Object.isFrozen(leaf.getSelectedProviderEnvironment())).toBe(true)
      expect(leaf.getSelectedProviderSelection()).toBe(compatibility.getSelectedProviderSelection())
    })
  }
  await Promise.all([run('grok'), run('openai')])
})
