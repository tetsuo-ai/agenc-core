import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalArgv = process.argv.slice()
const originalEnv = { ...process.env }
const tempDirs: string[] = []

async function loadDebugModule(sessionId = 'session-test') {
  vi.resetModules()
  vi.doMock('../agenc/upstream/bootstrap/state.js', () => ({
    getSessionId: () => sessionId,
  }))
  return import('./debug.js')
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agenc-debug-test-'))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  process.argv = originalArgv.slice(0, 2)
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, originalEnv)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.resetModules()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe('debug utilities', () => {
  it('uses the active session id for the default debug log path', async () => {
    const configDir = await makeTempDir()
    process.env.AGENC_CONFIG_DIR = configDir

    const debug = await loadDebugModule('session-active')

    expect(debug.getDebugLogPath()).toBe(
      join(configDir, 'debug', 'session-active.txt'),
    )
  })

  it('preserves internal-user debug enable semantics', async () => {
    process.env.USER_TYPE = 'ant'

    const debug = await loadDebugModule()

    expect(debug.enableDebugLogging()).toBe(true)
  })

  it('writes internal-user debug logs without a debug flag', async () => {
    const configDir = await makeTempDir()
    process.env.AGENC_CONFIG_DIR = configDir
    process.env.NODE_ENV = 'production'
    process.env.USER_TYPE = 'ant'

    const debug = await loadDebugModule('session-ant')

    debug.logForDebugging('api: background diagnostic')
    await debug.flushDebugLogs()

    const content = await readFile(
      join(configDir, 'debug', 'session-ant.txt'),
      'utf8',
    )
    expect(content).toContain('[DEBUG] api: background diagnostic')
  })

  it('drains buffered internal-user debug logs during registered cleanup', async () => {
    const configDir = await makeTempDir()
    process.env.AGENC_CONFIG_DIR = configDir
    process.env.NODE_ENV = 'production'
    process.env.USER_TYPE = 'ant'

    const debug = await loadDebugModule('session-cleanup')
    const { runCleanupFunctions } = await import(
      './cleanupRegistry.js'
    )

    debug.logForDebugging('api: cleanup diagnostic')
    await runCleanupFunctions()

    const content = await readFile(
      join(configDir, 'debug', 'session-cleanup.txt'),
      'utf8',
    )
    expect(content).toContain('[DEBUG] api: cleanup diagnostic')
  })

  it('honors log-level filtering and JSON-escapes formatted multiline output', async () => {
    process.env.AGENC_DEBUG_LOG_LEVEL = 'warn'
    process.argv.push('--debug-to-stderr')
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      writes.push(String(chunk))
      return true
    })

    const debug = await loadDebugModule()

    debug.logForDebugging('api: ignored info', { level: 'info' })
    debug.setHasFormattedOutput(true)
    debug.logForDebugging('api: first line\nsecond line', { level: 'warn' })

    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('[WARN] "api: first line\\nsecond line"')
  })

  it('applies category filters from --debug=category', async () => {
    process.argv.push('--debug-to-stderr', '--debug=api')
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      writes.push(String(chunk))
      return true
    })

    const debug = await loadDebugModule()

    debug.logForDebugging('api: shown')
    debug.logForDebugging('hooks: hidden')

    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('api: shown')
  })
})
