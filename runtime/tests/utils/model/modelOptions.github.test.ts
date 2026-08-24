import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { resetModelStringsForTestingOnly } from '../../../src/bootstrap/state.ts'

async function importFreshModelOptionsModule() {
  vi.resetModules()
  const [
    modelOptions,
    providers,
    { ConfigStore },
    { runWithCanonicalSettingsAuthority },
  ] = await Promise.all([
    import('../../../src/utils/model/modelOptions.ts'),
    import('../../../src/utils/model/providers.ts'),
    import('../../../src/config/store.ts'),
    import('../../../src/utils/settings/canonicalAuthority.ts'),
  ])
  const store = new ConfigStore({
    home: '/tmp/agenc-model-options-github',
    env: {},
    base: {},
  })
  return {
    ...modelOptions,
    ...providers,
    withAuthority: <T>(fn: () => T): T =>
      runWithCanonicalSettingsAuthority(store, fn),
  }
}

const originalEnv = {
  AGENC_PROVIDER: process.env.AGENC_PROVIDER,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
}

function restoreEnv(key: keyof typeof originalEnv): void {
  if (originalEnv[key] === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = originalEnv[key]
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  delete process.env.AGENC_PROVIDER
  delete process.env.OPENAI_BASE_URL
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  for (const key of Object.keys(originalEnv) as Array<keyof typeof originalEnv>) {
    restoreEnv(key)
  }
  resetModelStringsForTestingOnly()
})

test('GitHub provider exposes default + all Copilot models in /model options', async () => {
  process.env.AGENC_PROVIDER = 'github'

  const { getModelOptions, runWithStartupProviderSelection, withAuthority } =
    await importFreshModelOptionsModule()
  const options = withAuthority(() =>
    runWithStartupProviderSelection({ provider: 'github', model: 'gpt-4o', environment: { ...process.env } }, () => getModelOptions(false)),
  )
  const nonDefault = options.filter(
    (option: { value: unknown }) => option.value !== null,
  )

  expect(nonDefault.length).toBeGreaterThan(1)
  expect(nonDefault.some((o: { value: unknown }) => o.value === 'gpt-4o')).toBe(true)
  expect(nonDefault.some((o: { value: unknown }) => o.value === 'gpt-5.3-codex')).toBe(true)
})
