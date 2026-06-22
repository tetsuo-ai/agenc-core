import { afterEach, expect, test, vi } from 'vitest'
import * as fsPromises from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

const execModulePath = '../../src/utils/execFileNoThrow.js'

const originalEnv = { ...process.env }
const originalMacro = (globalThis as Record<string, unknown>).MACRO

afterEach(() => {
  process.env = { ...originalEnv }
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  vi.doUnmock('fs/promises')
  vi.doUnmock(execModulePath)
  vi.clearAllMocks()
  vi.resetModules()
})

async function importFreshInstaller() {
  vi.resetModules()
  return import('../../src/utils/nativeInstaller/installer.ts')
}

test('cleanupNpmInstallations checks runtime, launcher, and local install dirs', async () => {
  const removedPaths: string[] = []
  const uninstallPackages: string[] = []
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@tetsuo-ai/agenc',
  }

  vi.doMock('fs/promises', () => ({
    ...fsPromises,
    rm: async (path: string) => {
      removedPaths.push(path)
    },
  }))

  vi.doMock(execModulePath, () => ({
    execSyncWithDefaults_DEPRECATED: () => '',
    execFileNoThrow: async () => ({
      code: 1,
      stderr: 'npm ERR! code E404',
    }),
    execFileNoThrowWithCwd: async (_cmd: string, args: string[]) => {
      uninstallPackages.push(args.at(-1) ?? '')
      return {
        code: 1,
        stderr: 'npm ERR! code E404',
      }
    },
  }))

  const { cleanupNpmInstallations } = await importFreshInstaller()
  await cleanupNpmInstallations()

  expect(uninstallPackages).toEqual(['@tetsuo-ai/runtime', '@tetsuo-ai/agenc'])
  expect(removedPaths).toEqual([join(homedir(), '.agenc', 'local')])
})
