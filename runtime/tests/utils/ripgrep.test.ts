import { expect, test } from 'bun:test'
import { existsSync } from 'fs'
import path from 'path'

import { selectPinnedRipgrepPath } from '../../src/tools/system/pinned-ripgrep.ts'
import {
  resolveBuiltinRipgrepCommand,
  resolveRipgrepConfig,
  wrapRipgrepUnavailableError,
} from '../../src/utils/ripgrep.ts'

const MOCK_BUILTIN_PATH = path.normalize(
  process.platform === 'win32'
    ? `vendor/ripgrep/${process.arch}-win32/rg.exe`
    : `vendor/ripgrep/${process.arch}-${process.platform}/rg`,
)

test('ripgrepCommand falls back to system rg when builtin binary is missing', () => {
  const config = resolveRipgrepConfig({
    userWantsSystemRipgrep: false,
    bundledMode: false,
    builtinCommand: MOCK_BUILTIN_PATH,
    builtinExists: false,
    systemExecutablePath: '/usr/bin/rg',
    processExecPath: '/fake/bun',
  })

  expect(config).toMatchObject({
    mode: 'system',
    command: 'rg',
    args: [],
  })
})

test('ripgrepCommand keeps builtin mode when bundled binary exists', () => {
  const config = resolveRipgrepConfig({
    userWantsSystemRipgrep: false,
    bundledMode: false,
    builtinCommand: MOCK_BUILTIN_PATH,
    builtinExists: true,
    systemExecutablePath: '/usr/bin/rg',
    processExecPath: '/fake/bun',
  })

  expect(config).toMatchObject({
    mode: 'builtin',
    command: MOCK_BUILTIN_PATH,
    args: [],
  })
})

test('resolveBuiltinRipgrepCommand prefers the packaged @vscode/ripgrep binary', () => {
  const pinned = selectPinnedRipgrepPath()
  if (pinned === undefined) {
    const resolved = resolveBuiltinRipgrepCommand(undefined)
    expect(resolved.exists).toBe(existsSync(resolved.command))
    return
  }

  const resolved = resolveBuiltinRipgrepCommand(pinned)
  expect(resolved.exists).toBe(true)
  expect(resolved.command).toBe(pinned)
  expect(existsSync(resolved.command)).toBe(true)
})

test('resolveBuiltinRipgrepCommand falls back to vendor when packaged path is missing', () => {
  const resolved = resolveBuiltinRipgrepCommand(
    path.join(path.dirname(MOCK_BUILTIN_PATH), 'missing-rg-binary'),
  )
  expect(resolved.command).toContain(
    `${path.sep}vendor${path.sep}ripgrep${path.sep}`,
  )
  expect(resolved.exists).toBe(existsSync(resolved.command))
})

test('wrapRipgrepUnavailableError explains missing packaged fallback', () => {
  const error = wrapRipgrepUnavailableError(
    { code: 'ENOENT', message: 'spawn rg ENOENT' },
    { mode: 'builtin', command: 'C:\\fake\\vendor\\ripgrep\\rg.exe', args: [] },
    'win32',
  )

  expect(error.name).toBe('RipgrepUnavailableError')
  expect(error.code).toBe('ENOENT')
  expect(error.message).toContain('packaged ripgrep fallback')
  expect(error.message).toContain('winget install BurntSushi.ripgrep.MSVC')
})

test('wrapRipgrepUnavailableError explains missing system ripgrep', () => {
  const error = wrapRipgrepUnavailableError(
    { code: 'ENOENT', message: 'spawn rg ENOENT' },
    { mode: 'system', command: 'rg', args: [] },
    'linux',
  )

  expect(error.message).toContain('system ripgrep binary was not found on PATH')
  expect(error.message).toContain('apt install ripgrep')
})
