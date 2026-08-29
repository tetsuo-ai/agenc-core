import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as fsPromises from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

const originalEnv = { ...process.env }
const originalArgv = [...process.argv]
const fsPromisesModulePath = 'fs/promises'

async function importFreshEnvUtils() {
  vi.resetModules()
  return import('../../src/utils/envUtils.ts')
}

async function importFreshSettings() {
  vi.resetModules()
  return import('../../src/utils/settings/settings.ts')
}

async function importFreshLocalInstaller() {
  vi.resetModules()
  return import('../../src/utils/localInstaller.ts')
}

beforeEach(() => {
  delete process.env.AGENC_CONFIG_DIR
  delete process.env.AGENC_HOME
})

afterEach(() => {
  process.env = { ...originalEnv }
  process.argv = [...originalArgv]
  vi.doUnmock(fsPromisesModulePath)
  vi.clearAllMocks()
  vi.resetModules()
})

describe('AgenC paths', () => {
  test('uses AGENC_HOME and rejects AGENC_CONFIG_DIR', async () => {
    process.env.AGENC_HOME = '/tmp/custom-agenc'
    const { getAgenCHomeDir } = await importFreshEnvUtils()

    expect(getAgenCHomeDir()).toBe('/tmp/custom-agenc')

    process.env.AGENC_CONFIG_DIR = '/tmp/obsolete-agenc'
    expect(() => getAgenCHomeDir()).toThrow(
      'AGENC_CONFIG_DIR is no longer a runtime configuration authority',
    )
  })

  test('project and local settings paths use .agenc', async () => {
    const { getRelativeSettingsFilePathForSource } = await importFreshSettings()

    expect(getRelativeSettingsFilePathForSource('projectSettings')).toBe(
      '.agenc/config.toml',
    )
    expect(getRelativeSettingsFilePathForSource('localSettings')).toBe(
      '.agenc/config.local.toml',
    )
  })

  test('local installer uses agenc wrapper path', async () => {
    // Force .agenc config home so the test doesn't fall back to
    // ~/.agenc when ~/.agenc doesn't exist on this machine.
    delete process.env.AGENC_CONFIG_DIR
    process.env.AGENC_HOME = join(homedir(), '.agenc')
    const { getLocalAgenCPath } = await importFreshLocalInstaller()

    expect(getLocalAgenCPath()).toBe(
      join(homedir(), '.agenc', 'local', 'agenc'),
    )
  })

  test('local installation detection matches .agenc path', async () => {
    const { isManagedLocalInstallationPath } =
      await importFreshLocalInstaller()

    expect(
      isManagedLocalInstallationPath(
        `${join(homedir(), '.agenc', 'local')}/node_modules/.bin/agenc`,
      ),
    ).toBe(true)
  })

  test('candidate local install dirs contain only the canonical home path', async () => {
    const { getCandidateLocalInstallDirs } = await importFreshLocalInstaller()

    expect(
      getCandidateLocalInstallDirs({
        configHomeDir: join(homedir(), '.agenc'),
      }),
    ).toEqual([join(homedir(), '.agenc', 'local')])
  })

  test('canonical local installs are detected when they expose the agenc binary', async () => {
    vi.doMock(fsPromisesModulePath, () => ({
      ...fsPromises,
      access: async (path: string) => {
        if (
          path === join(homedir(), '.agenc', 'local', 'node_modules', '.bin', 'agenc')
        ) {
          return
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    }))

    const { getDetectedLocalInstallDir, localInstallationExists } =
      await importFreshLocalInstaller()

    expect(await localInstallationExists()).toBe(true)
    expect(await getDetectedLocalInstallDir()).toBe(
      join(homedir(), '.agenc', 'local'),
    )
  })
})
