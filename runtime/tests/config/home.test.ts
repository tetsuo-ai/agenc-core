import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { resolveHomeContext, resolveProcessHomePathInput } from '../../src/config/home.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('explicit process home path ingress', () => {
  test('preserves symlink coordinates for validation in the candidate filesystem root', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-process-home-input-'))
    roots.push(root)
    const physical = join(root, 'physical')
    const alias = join(root, 'alias')
    mkdirSync(physical)
    symlinkSync(physical, alias, 'dir')

    expect(resolveProcessHomePathInput({ AGENC_HOME: alias })).toBe(alias)
    expect(resolveProcessHomePathInput({ HOME: alias })).toBe(join(alias, '.agenc'))
    expect(resolveHomeContext({ AGENC_HOME: alias }, { platformHome: root }).path).toBe(physical)
  })

  test('uses only explicit candidate coordinates and the shared home precedence', () => {
    expect(resolveProcessHomePathInput({ AGENC_HOME: ' /candidate-home ', HOME: '/other' })).toBe('/candidate-home')
    expect(resolveProcessHomePathInput({ AGENC_HOME: ' ', HOME: ' /foreign/user ' })).toBe('/foreign/user/.agenc')
    expect(resolveProcessHomePathInput({})).toBeNull()
    expect(resolveProcessHomePathInput({ AGENC_HOME: ' ', HOME: ' ' })).toBeNull()
  })

  test('rejects the retired authority even when candidate home coordinates are unknown', () => {
    // An explicit invalid-input payload, never an installed test home alias.
    const retiredAuthorityInput = Object.fromEntries([['AGENC_CONFIG_DIR', '']])
    expect(() => resolveProcessHomePathInput(retiredAuthorityInput)).toThrow('AGENC_CONFIG_DIR')
  })
})

describe('canonical AgenC home identity', () => {
  test('is stable before and after creating a child beneath a symlinked parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-home-symlink-'))
    roots.push(root)
    const physicalParent = join(root, 'physical-parent')
    const aliasParent = join(root, 'alias-parent')
    const requestedHome = join(aliasParent, 'new-home')
    mkdirSync(physicalParent)
    symlinkSync(physicalParent, aliasParent, 'dir')

    const before = resolveHomeContext(
      { AGENC_HOME: requestedHome },
      { platformHome: root },
    )
    mkdirSync(requestedHome)
    const after = resolveHomeContext(
      { AGENC_HOME: requestedHome },
      { platformHome: root },
    )

    expect(before.path).toBe(join(physicalParent, 'new-home'))
    expect(after.path).toBe(before.path)
  })

  test('treats a missing Windows default-home case alias as one identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-home-windows-case-'))
    roots.push(root)
    const explicit = join(root, '.AGENC')

    const before = resolveHomeContext(
      { AGENC_HOME: explicit },
      { platformHome: root, platform: 'win32' },
    )
    mkdirSync(explicit)
    const after = resolveHomeContext(
      { AGENC_HOME: explicit },
      { platformHome: root, platform: 'win32' },
    )

    expect(before.isDefault).toBe(true)
    expect(after.isDefault).toBe(true)
    expect(before.identityKey).toBe(after.identityKey)
  })

  test('keeps canonical native secure storage account stable across USER drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-home-account-'))
    roots.push(root)

    const first = resolveHomeContext(
      { AGENC_HOME: join(root, 'home'), USER: 'spoofed-first' },
      { platformHome: root },
    )
    const second = resolveHomeContext(
      { AGENC_HOME: join(root, 'home'), USER: 'spoofed-second' },
      { platformHome: root },
    )
    const omitted = resolveHomeContext(
      { AGENC_HOME: join(root, 'home') },
      { platformHome: root },
    )

    expect(first.secureStorageAccount).toBe(second.secureStorageAccount)
    expect(second.secureStorageAccount).toBe(omitted.secureStorageAccount)
    expect(first.secureStorageAccount).toBe(
      process.platform === 'win32' ? 'current-user' : `uid:${userInfo().uid}`,
    )
    expect(first.secureStorageAccount).not.toBe('spoofed-first')
  })
})
