import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { resolveMigrationHomeContext } from '../../../src/config/home.js'
import {
  getCanonicalSecureStorageIdentity,
  getRetiredSecureStorageIdentity,
  secureStorageIdentitiesDiffer,
} from '../../../src/utils/secureStorage/migrationIdentity.js'

const roots: string[] = []

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'agenc-vault-identity-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('retired native secure storage identity reconstruction', () => {
  test('uses platform homedir rather than an ambient HOME alias', () => {
    const platformHome = join(temp(), 'platform-home')
    const retired = getRetiredSecureStorageIdentity(
      { HOME: '/wrong-shell-home' },
      platformHome,
    )

    expect(retired.homePath).toBe(join(platformHome, '.agenc'))
  })

  test('binds an explicit historical USER-derived account override', () => {
    const platformHome = temp()
    const retired = getRetiredSecureStorageIdentity(
      { USER: 'current-shell-user' },
      platformHome,
      'historical-shell-user',
    )

    expect(retired.accountName).toBe('historical-shell-user')
  })

  test('detects both historical service-name mismatch directions', () => {
    const platformHome = temp()
    const relocated = join(platformHome, 'relocated')
    const relocatedEnv = { AGENC_HOME: relocated }
    const relocatedHome = resolveMigrationHomeContext(relocatedEnv, {
      platformHome,
    })
    expect(secureStorageIdentitiesDiffer(
      getCanonicalSecureStorageIdentity(relocatedHome),
      getRetiredSecureStorageIdentity(relocatedEnv, platformHome),
      'linux',
    )).toBe(true)

    const defaultPath = join(platformHome, '.agenc')
    const configDirEnv = { AGENC_CONFIG_DIR: defaultPath }
    const defaultHome = resolveMigrationHomeContext(configDirEnv, {
      platformHome,
    })
    expect(secureStorageIdentitiesDiffer(
      getCanonicalSecureStorageIdentity(defaultHome),
      getRetiredSecureStorageIdentity(configDirEnv, platformHome),
      'linux',
    )).toBe(true)
  })

  test('treats Windows symlink aliases as the same concrete DPAPI target', () => {
    const root = temp()
    const physicalHome = join(root, 'physical-home')
    const aliasHome = join(root, 'alias-home')
    mkdirSync(physicalHome)
    symlinkSync(physicalHome, aliasHome, 'dir')
    const serviceName = 'AgenC-test-credentials'

    expect(secureStorageIdentitiesDiffer(
      { serviceName, accountName: 'test-user', homePath: physicalHome },
      { serviceName, accountName: 'test-user', homePath: aliasHome },
      'win32',
    )).toBe(false)
  })

  test('treats Windows case aliases as the same target before it exists', () => {
    const root = temp()
    const serviceName = 'AgenC-test-credentials'
    expect(secureStorageIdentitiesDiffer(
      { serviceName, accountName: 'test-user', homePath: join(root, 'Case-Home') },
      { serviceName, accountName: 'test-user', homePath: join(root, 'case-home') },
      'win32',
    )).toBe(false)
  })

  test('treats account drift as a different physical credential identity', () => {
    const root = temp()
    const identity = {
      serviceName: 'AgenC-test-credentials',
      homePath: join(root, 'home'),
    }

    expect(secureStorageIdentitiesDiffer(
      { ...identity, accountName: 'first-user' },
      { ...identity, accountName: 'second-user' },
      'linux',
    )).toBe(true)
    expect(secureStorageIdentitiesDiffer(
      { ...identity, accountName: 'first-user' },
      { ...identity, accountName: 'second-user' },
      'win32',
    )).toBe(true)
  })
})
