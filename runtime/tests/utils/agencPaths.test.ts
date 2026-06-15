import { afterEach, describe, expect, test, vi } from 'vitest'
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

afterEach(() => {
  process.env = { ...originalEnv }
  process.argv = [...originalArgv]
  vi.doUnmock(fsPromisesModulePath)
  vi.clearAllMocks()
  vi.resetModules()
})

describe('AgenC paths', () => {
  test('defaults user config home to ~/.agenc', async () => {
    delete process.env.AGENC_CONFIG_DIR
    const { resolveAgenCConfigHomeDir } = await importFreshEnvUtils()

    expect(
      resolveAgenCConfigHomeDir({
        homeDir: homedir(),
        openAgenCExists: true,
        legacyAgenCExists: false,
      }),
    ).toBe(join(homedir(), '.agenc'))
  })

  test('falls back to ~/.agenc when legacy config exists and ~/.agenc does not', async () => {
    delete process.env.AGENC_CONFIG_DIR
    const { resolveAgenCConfigHomeDir } = await importFreshEnvUtils()

    expect(
      resolveAgenCConfigHomeDir({
        homeDir: homedir(),
        openAgenCExists: false,
        legacyAgenCExists: true,
      }),
    ).toBe(join(homedir(), '.agenc'))
  })

  test('uses AGENC_CONFIG_DIR override when provided', async () => {
    process.env.AGENC_CONFIG_DIR = '/tmp/custom-agenc'
    const { getAgenCConfigHomeDir, resolveAgenCConfigHomeDir } =
      await importFreshEnvUtils()

    expect(getAgenCConfigHomeDir()).toBe('/tmp/custom-agenc')
    expect(
      resolveAgenCConfigHomeDir({
        configDirEnv: '/tmp/custom-agenc',
      }),
    ).toBe('/tmp/custom-agenc')
  })

  test('project and local settings paths use .agenc', async () => {
    const { getRelativeSettingsFilePathForSource } = await importFreshSettings()

    expect(getRelativeSettingsFilePathForSource('projectSettings')).toBe(
      '.agenc/settings.json',
    )
    expect(getRelativeSettingsFilePathForSource('localSettings')).toBe(
      '.agenc/settings.local.json',
    )
  })

  test('local installer uses agenc wrapper path', async () => {
    // Force .agenc config home so the test doesn't fall back to
    // ~/.agenc when ~/.agenc doesn't exist on this machine.
    process.env.AGENC_CONFIG_DIR = join(homedir(), '.agenc')
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

  test('local installation detection still matches legacy .agenc path', async () => {
    const { isManagedLocalInstallationPath } =
      await importFreshLocalInstaller()

    expect(
      isManagedLocalInstallationPath(
        `${join(homedir(), '.agenc', 'local')}/node_modules/.bin/agenc`,
      ),
    ).toBe(true)
  })

  test('candidate local install dirs include both agenc and legacy agenc paths', async () => {
    const { getCandidateLocalInstallDirs } = await importFreshLocalInstaller()

    expect(
      getCandidateLocalInstallDirs({
        configHomeDir: join(homedir(), '.agenc'),
        homeDir: homedir(),
      }),
    ).toEqual([join(homedir(), '.agenc', 'local')])
  })

  test('legacy local installs are detected when they still expose the agenc binary', async () => {
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
