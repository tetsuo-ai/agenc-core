import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  canonicalProjectPath,
  projectStorageKey,
} from '../../src/utils/project-storage-key.js'

describe('versioned project keys under Node and Bun', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'agenc-project-key-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('hashes every identity and bounds the ASCII directory component', () => {
    const paths = [root, join(root, 'a.b'), join(root, 'a-b'), `/${'deep/'.repeat(100)}end`]
    const keys = paths.map(path => projectStorageKey(path))
    expect(new Set(keys).size).toBe(paths.length)
    for (const key of keys) {
      expect(key).toMatch(/^v2-[a-zA-Z0-9_-]+-[a-f0-9]{64}$/u)
      expect(Buffer.byteLength(key)).toBeLessThanOrEqual(132)
    }
  })

  test('canonicalizes relative, trailing separator and symlink aliases', () => {
    const project = join(root, 'repo')
    const alias = join(root, 'alias')
    mkdirSync(project)
    symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const expected = projectStorageKey(project)
    expect(projectStorageKey(relative(process.cwd(), project))).toBe(expected)
    expect(projectStorageKey(`${project}/`)).toBe(expected)
    expect(projectStorageKey(alias)).toBe(expected)
    expect(projectStorageKey(join(alias, 'missing', 'child'))).toBe(
      projectStorageKey(join(project, 'missing', 'child')),
    )
    expect(canonicalProjectPath(alias)).toBe(realpathSync(project))
  })

  test('does not cache a previous symlink target', () => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    const alias = join(root, 'alias')
    mkdirSync(first)
    mkdirSync(second)
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(first, alias, linkType)
    const firstKey = projectStorageKey(alias)
    rmSync(alias)
    symlinkSync(second, alias, linkType)
    expect(projectStorageKey(alias)).toBe(projectStorageKey(second))
    expect(projectStorageKey(alias)).not.toBe(firstKey)
  })

  test('resolves parent traversal using native filesystem semantics', () => {
    const parent = join(root, 'parent')
    const target = join(parent, 'child')
    const alias = join(root, 'alias')
    mkdirSync(target, { recursive: true })
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const expectedParent = process.platform === 'win32' ? root : parent
    expect(projectStorageKey(`${alias}/..`)).toBe(projectStorageKey(expectedParent))
    expect(projectStorageKey(`${alias}/../missing`)).toBe(
      projectStorageKey(join(expectedParent, 'missing')),
    )
  })

  test('preserves distinct case and Unicode spellings on case-sensitive filesystems', () => {
    const names = ['cafe\u0301', 'caf\u00e9', 'Upper', 'upper']
    const identities = names.map(name => canonicalProjectPath(join(root, name)))
    const keys = names.map(name => projectStorageKey(join(root, name)))
    expect(new Set(keys).size).toBe(new Set(identities).size)
    if (process.platform !== 'win32') expect(new Set(keys).size).toBe(4)
  })

  test('uses the same Windows drive identity for slash and drive-letter variants', () => {
    expect(projectStorageKey('C:\\work\\acme\\api', 'win32')).toBe(
      'v2-C--work-acme-api-76329105cc12825df372af1972254b314f9ad74021cd7ef072806998182b5abe',
    )
    expect(projectStorageKey('c:/work/acme/api/', 'win32')).toBe(
      projectStorageKey('C:\\work\\acme\\api', 'win32'),
    )
    expect(projectStorageKey('C:\\work\\acme\\api', 'win32')).not.toBe(
      projectStorageKey('C:\\work\\acme-api', 'win32'),
    )
    expect(projectStorageKey('C:\\work\\acme\\api', 'win32')).toBe(
      projectStorageKey('\\\\?\\C:\\work\\acme\\api', 'win32'),
    )
  })

  test('normalizes UNC dot segments without merging different shares', () => {
    expect(projectStorageKey('\\\\server\\share\\repo\\.', 'win32')).toBe(
      projectStorageKey('\\\\server\\share\\repo', 'win32'),
    )
    expect(projectStorageKey('\\\\server\\share\\repo', 'win32')).not.toBe(
      projectStorageKey('\\\\server\\share-repo', 'win32'),
    )
  })

  test('rejects invalid text instead of hashing replacement characters', () => {
    for (const input of ['', 'bad\0path', '\ud800', '\udfff']) {
      expect(() => projectStorageKey(input)).toThrow('Project path must be')
    }
  })

  test('requires absolute paths when the platform is explicitly foreign', () => {
    const foreignPlatform = process.platform === 'win32' ? 'posix' : 'win32'
    expect(() => projectStorageKey('relative', foreignPlatform)).toThrow('Foreign project paths must be absolute')
  })

  test('explicit platform mode is lexical even when it matches the host', () => {
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    mkdirSync(target)
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const platform = process.platform === 'win32' ? 'win32' : 'posix'
    expect(projectStorageKey(alias)).toBe(projectStorageKey(target))
    expect(projectStorageKey(alias, platform)).not.toBe(projectStorageKey(target, platform))
  })

  test('does not interpret native POSIX backslashes as Windows separators', () => {
    const first = '/workspace/C:\\work\\repo'
    const second = '/workspace/C:/work/repo'
    expect(projectStorageKey(first, 'posix')).not.toBe(projectStorageKey(second, 'posix'))
    if (process.platform !== 'win32') {
      expect(projectStorageKey('C:\\work\\repo')).not.toBe(projectStorageKey('C:/work/repo'))
    }
  })
})
