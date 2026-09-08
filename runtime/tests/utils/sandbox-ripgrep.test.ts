import { afterEach, expect, test, vi } from 'vitest'
import type { AgenCConfig } from '../../src/config/schema.js'

afterEach(() => {
  vi.doUnmock('../../src/utils/settings/settings.js')
  vi.doUnmock('../../src/utils/settings/canonicalAuthority.js')
  vi.doUnmock('../../src/utils/ripgrep.js')
  vi.restoreAllMocks()
  vi.resetModules()
})

async function sandboxFixture(settings: AgenCConfig = { configVersion: 2 }) {
  let hasAuthority = true
  vi.doMock('../../src/utils/settings/canonicalAuthority.js', async importOriginal => ({
    ...await importOriginal<typeof import('../../src/utils/settings/canonicalAuthority.js')>(),
    getCanonicalSettingsAuthority: () => hasAuthority ? { current: () => settings } : null,
  }))
  vi.doMock('../../src/utils/settings/settings.js', async importOriginal => ({
    ...await importOriginal<typeof import('../../src/utils/settings/settings.js')>(),
    getExecutionAuthoritySettings: () => settings,
    getSettingsForSource: () => null,
    getSettingsFilePathForSource: () => undefined,
  }))
  const unavailable = vi.fn()
  vi.doMock('../../src/utils/ripgrep.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../../src/utils/ripgrep.js')>()
    unavailable.mockImplementation(() => {
      throw new actual.RipgrepUnavailableError('fixture has no ripgrep', { mode: 'builtin', command: '@vscode/ripgrep' }, 'ENOENT')
    })
    return { ...actual, ripgrepCommand: unavailable }
  })
  const { SandboxManager: base } = await import('@anthropic-ai/sandbox-runtime')
  const dependencies = vi.spyOn(base, 'checkDependencies').mockReturnValue({ errors: [], warnings: [] })
  const runtime = await import('../../src/utils/sandbox/sandbox-runtime.js')
  return {
    ...runtime,
    unavailable,
    dependencies,
    setSettings: (value: AgenCConfig) => { settings = value },
    clearAuthority: () => { hasAuthority = false },
  }
}

test('honors an explicit sandbox executable before resolving default ripgrep', async () => {
  const settings: AgenCConfig = { configVersion: 2, sandbox: { ripgrep: { command: '/custom/rg', args: ['--no-config'] } } }
  const fixture = await sandboxFixture(settings)
  expect(fixture.convertToSandboxRuntimeConfig(settings).ripgrep).toEqual({ command: '/custom/rg', args: ['--no-config'] })
  expect(fixture.SandboxManager.checkDependencies()).toEqual({ errors: [], warnings: [] })
  expect(fixture.dependencies).toHaveBeenCalledWith({ command: '/custom/rg', args: ['--no-config'] })
  expect(fixture.unavailable).not.toHaveBeenCalled()
})

test('reports missing ripgrep through dependency errors without throwing during configuration', async () => {
  const fixture = await sandboxFixture()
  expect(fixture.convertToSandboxRuntimeConfig({ configVersion: 2 }).ripgrep).toBeUndefined()
  expect(fixture.SandboxManager.checkDependencies()).toEqual({ errors: ['fixture has no ripgrep'], warnings: [] })
  expect(fixture.dependencies).not.toHaveBeenCalled()
})

test('rechecks a changed sandbox override instead of caching an earlier missing binary', async () => {
  const fixture = await sandboxFixture()
  expect(fixture.SandboxManager.checkDependencies().errors).toEqual(['fixture has no ripgrep'])
  fixture.setSettings({ configVersion: 2, sandbox: { ripgrep: { command: '/custom/rg' } } })
  expect(fixture.SandboxManager.checkDependencies()).toEqual({ errors: [], warnings: [] })
  expect(fixture.dependencies).toHaveBeenCalledWith({ command: '/custom/rg', args: [] })
})

test('reports dependency availability before a settings authority has been installed', async () => {
  const fixture = await sandboxFixture()
  fixture.clearAuthority()
  expect(fixture.SandboxManager.checkDependencies()).toEqual({ errors: ['fixture has no ripgrep'], warnings: [] })
})
