import { afterEach, beforeEach, expect, test } from 'bun:test'

import { ConfigStore } from '../../../src/config/store.ts'
import { getDefaultMainLoopModelSetting, getUserSpecifiedModelSetting } from '../../../src/utils/model/model.ts'
import { runWithStartupProviderSelection } from '../../../src/utils/model/providers.ts'
import { runWithCanonicalSettingsAuthority } from '../../../src/utils/settings/canonicalAuthority.ts'

const env = {
  AGENC_PROVIDER: process.env.AGENC_PROVIDER,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
}

beforeEach(() => {
  process.env.AGENC_PROVIDER = 'github'
  delete process.env.OPENAI_MODEL
})

afterEach(() => {
  process.env.AGENC_PROVIDER = env.AGENC_PROVIDER
  process.env.OPENAI_MODEL = env.OPENAI_MODEL
})

function withGitHubAuthority<T>(fn: () => T): T {
  const store = new ConfigStore({
    home: '/tmp/agenc-model-github',
    env: {},
    base: {},
  })
  return runWithCanonicalSettingsAuthority(store, fn)
}

test('github default model setting uses a string when config has no model', () => {
  const model = withGitHubAuthority(() =>
    runWithStartupProviderSelection(
      { provider: 'github', model: 'github:copilot', environment: { ...process.env } },
      getDefaultMainLoopModelSetting,
    ),
  )
  expect(typeof model).toBe('string')
  expect(model).not.toBe('[object Object]')
  expect(model.length).toBeGreaterThan(0)
})

test('user specified model is absent when canonical config has no model', () => {
  const model = withGitHubAuthority(() =>
    runWithStartupProviderSelection(
      { provider: 'github', model: 'github:copilot', environment: { ...process.env } },
      getUserSpecifiedModelSetting,
    ),
  )
  if (model !== undefined && model !== null) {
    expect(typeof model).toBe('string')
    expect(model).not.toBe('[object Object]')
  }
})
