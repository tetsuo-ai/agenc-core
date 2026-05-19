import { afterEach, expect, mock, test } from 'bun:test'
import * as fsPromises from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { sourceUrl } from '../helpers/source-path.ts'

const originalEnv = { ...process.env }
const originalMacro = (globalThis as Record<string, unknown>).MACRO

afterEach(() => {
  process.env = { ...originalEnv }
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  mock.restore()
})

async function importFreshInstaller() {
  const url = sourceUrl('utils/nativeInstaller/installer.ts')
  url.search = `ts=${Date.now()}-${Math.random()}`
  return import(url.href)
}

test('cleanupNpmInstallations removes both agenc and legacy agenc local install dirs', async () => {
  const removedPaths: string[] = []
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@gitlawb/agenc',
  }

  mock.module('fs/promises', () => ({
    ...fsPromises,
    rm: async (path: string) => {
      removedPaths.push(path)
    },
  }))

  mock.module(sourceUrl('utils/execFileNoThrow.js').href, () => ({
    execSyncWithDefaults_DEPRECATED: () => '',
    execFileNoThrow: async () => ({
      code: 1,
      stderr: 'npm ERR! code E404',
    }),
    execFileNoThrowWithCwd: async () => ({
      code: 1,
      stderr: 'npm ERR! code E404',
    }),
  }))

  const { cleanupNpmInstallations } = await importFreshInstaller()
  await cleanupNpmInstallations()

  expect(removedPaths).toContain(join(homedir(), '.agenc', 'local'))
  expect(removedPaths).toContain(join(homedir(), '.agenc', 'local'))
})
