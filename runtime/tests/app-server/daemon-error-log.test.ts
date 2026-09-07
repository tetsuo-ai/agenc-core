import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installAgenCDaemonErrorLogSink } from '../../src/app-server/daemon-error-log.js'
import { installAgenCDaemonLogSink } from '../../src/app-server/daemon-cli.js'
import {
  _resetErrorLogForTesting,
  getErrorLogQueueStats,
  logMCPDebug,
  logMCPError,
} from '../../src/utils/log.js'

beforeEach(() => { _resetErrorLogForTesting() })
afterEach(() => { _resetErrorLogForTesting() })

it('drains startup events to the rotating daemon log and detaches before it closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenc-daemon-error-log-'))
  const path = join(root, 'daemon.log')
  const fakeConsole = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
  const installed = installAgenCDaemonLogSink({ path, console: fakeConsole })
  if (!installed) throw new Error('file sink not installed')
  let detach = () => {}
  try {
    logMCPError('server', 'startup error')
    detach = installAgenCDaemonErrorLogSink({ path, write: line => installed.sink.write(line) })
    logMCPDebug('server', 'live debug message')
    expect(getErrorLogQueueStats()).toMatchObject({ errors: 0, debug: 0, retainedBytes: 0 })
    detach()
    logMCPDebug('server', 'after shutdown')
    const contents = await readFile(path, 'utf8')
    expect(contents).toContain('startup error')
    expect(contents).toContain('live debug message')
    expect(contents).not.toContain('after shutdown')
  } finally {
    detach()
    installed.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('redacts persisted diagnostic text and escapes server-provided line breaks', () => {
  const writes: string[] = []
  const detach = installAgenCDaemonErrorLogSink({ path: '/log', write: line => { writes.push(line) } })
  try {
    logMCPError('server\nforged line', 'Authorization: Bearer abcdefghijklmnop=')
    logMCPDebug('server', 'api_key=opaque-value-12345')
    expect(writes).toHaveLength(2)
    expect(writes.join('')).not.toContain('abcdefghijklmnop=')
    expect(writes.join('')).not.toContain('opaque-value-12345')
    expect(writes.join('')).toContain('[REDACTED_SECRET]')
    expect(writes[0]!.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(writes[0]!)).toMatchObject({ server: 'server\nforged line', level: 'error' })
  } finally { detach() }
})

it('keeps foreground debug diagnostics on the configured debug destination', () => {
  const write = vi.fn()
  const writeDebug = vi.fn()
  const detach = installAgenCDaemonErrorLogSink({ path: '/log', write, writeDebug })
  try {
    logMCPError('server', 'visible failure')
    logMCPDebug('server', 'debug details')
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]?.[0]).toContain('visible failure')
    expect(writeDebug).toHaveBeenCalledOnce()
    expect(writeDebug.mock.calls[0]?.[0]).toContain('debug details')
  } finally { detach() }
})
