import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { resolveHomeContext } from '../../src/config/home.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
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
