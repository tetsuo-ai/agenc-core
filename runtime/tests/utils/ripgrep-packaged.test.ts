import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { afterEach, expect, test, vi } from 'vitest'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agenc-packaged-ripgrep-'))
  roots.push(root)
  return root
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock('../../src/tools/system/pinned-ripgrep.js')
  vi.resetModules()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('uses the installed platform binary with no ripgrep on PATH', async () => {
  const { getRipgrepStatus, probeRipgrepAvailable } = await import('../../src/utils/ripgrep.js')
  const ingress = {
    environment: { PATH: temporaryRoot(), USE_BUILTIN_RIPGREP: '0' },
    systemExecutablePath: 'rg',
  }
  expect(getRipgrepStatus(ingress)).toMatchObject({ mode: 'builtin', path: rgPath })
  await expect(probeRipgrepAvailable(ingress)).resolves.toBe(true)
})

test('discovers Markdown through the packaged executable with an empty PATH', async () => {
  vi.stubEnv('PATH', temporaryRoot())
  vi.stubEnv('USE_BUILTIN_RIPGREP', '0')
  const { ripGrep, ripgrepCommand } = await import('../../src/utils/ripgrep.js')
  const workspace = temporaryRoot()
  mkdirSync(join(workspace, 'agents'))
  const agent = join(workspace, 'agents', 'local.md')
  writeFileSync(agent, 'Local agent')
  writeFileSync(join(workspace, 'agents', 'ignored.txt'), 'Not Markdown')
  expect(ripgrepCommand().rgPath).toBe(rgPath)
  await expect(ripGrep(['--files', '--glob', '*.md'], workspace, new AbortController().signal))
    .resolves.toEqual([agent])
})

test('uses a validated absolute system path when explicitly selected', async () => {
  const { getRipgrepStatus, probeRipgrepAvailable } = await import('../../src/utils/ripgrep.js')
  const ingress = {
    environment: { PATH: temporaryRoot(), USE_BUILTIN_RIPGREP: '0' },
    systemExecutablePath: rgPath,
  }
  expect(getRipgrepStatus(ingress)).toMatchObject({ mode: 'system', path: rgPath })
  await expect(probeRipgrepAvailable(ingress)).resolves.toBe(true)
})

test('rejects missing and directory system candidates before selecting the package', async () => {
  const root = temporaryRoot()
  const { getRipgrepStatus } = await import('../../src/utils/ripgrep.js')
  for (const systemExecutablePath of [root, join(root, 'missing')]) {
    expect(getRipgrepStatus({
      environment: { USE_BUILTIN_RIPGREP: '0' },
      systemExecutablePath,
    })).toMatchObject({ mode: 'builtin', path: rgPath })
  }
})

test.skipIf(process.platform === 'win32')('rejects a non-executable system candidate', async () => {
  const candidate = join(temporaryRoot(), 'rg')
  writeFileSync(candidate, 'not executable')
  chmodSync(candidate, 0o644)
  const { getRipgrepStatus } = await import('../../src/utils/ripgrep.js')
  expect(getRipgrepStatus({
    environment: { USE_BUILTIN_RIPGREP: '0' },
    systemExecutablePath: candidate,
  })).toMatchObject({ mode: 'builtin', path: rgPath })
})

test('falls back to the system when the optional platform package is absent', async () => {
  vi.doMock('../../src/tools/system/pinned-ripgrep.js', () => ({ resolvePinnedRipgrepPath: () => undefined }))
  const { getRipgrepStatus, probeRipgrepAvailable } = await import('../../src/utils/ripgrep.js')
  const ingress = { environment: { PATH: temporaryRoot() }, systemExecutablePath: rgPath }
  expect(getRipgrepStatus(ingress)).toMatchObject({ mode: 'system', path: rgPath })
  await expect(probeRipgrepAvailable(ingress)).resolves.toBe(true)
})

test('keeps unavailable status and probes safe when both candidates are missing', async () => {
  vi.doMock('../../src/tools/system/pinned-ripgrep.js', () => ({ resolvePinnedRipgrepPath: () => undefined }))
  vi.stubEnv('PATH', temporaryRoot())
  const { getRipgrepStatus, probeRipgrepAvailable, ripgrepCommand, RipgrepUnavailableError } = await import('../../src/utils/ripgrep.js')
  expect(getRipgrepStatus()).toMatchObject({ mode: 'builtin', working: false })
  await expect(probeRipgrepAvailable()).resolves.toBe(false)
  expect(ripgrepCommand).toThrow(RipgrepUnavailableError)
})

test('rejects an unusable packaged candidate before falling back to system rg', async () => {
  const candidate = temporaryRoot()
  vi.doMock('../../src/tools/system/pinned-ripgrep.js', () => ({ resolvePinnedRipgrepPath: () => candidate }))
  const { getRipgrepStatus, probeRipgrepAvailable } = await import('../../src/utils/ripgrep.js')
  const ingress = { environment: { PATH: temporaryRoot() }, systemExecutablePath: rgPath }
  expect(getRipgrepStatus(ingress)).toMatchObject({ mode: 'system', path: rgPath })
  await expect(probeRipgrepAvailable(ingress)).resolves.toBe(true)
})
