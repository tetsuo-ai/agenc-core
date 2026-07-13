import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import memoize from 'lodash-es/memoize.js'

import {
  getSessionId,
  setSessionTrustAccepted,
} from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { getAgenCConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { writeToStderr } from './process.js'

export type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

type DebugFilter = {
  include: string[]
  exclude: string[]
  isExclusive: boolean
}

type WriteFn = (content: string) => void

type BufferedWriter = {
  write: (content: string) => void
  flush: () => void
  dispose: () => void
}

const LEVEL_ORDER: Record<DebugLogLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
}

export const getMinDebugLogLevel = memoize((): DebugLogLevel => {
  const raw = process.env.AGENC_DEBUG_LOG_LEVEL?.toLowerCase().trim()
  if (raw && Object.hasOwn(LEVEL_ORDER, raw)) {
    return raw as DebugLogLevel
  }
  return 'debug'
})

let runtimeDebugEnabled = false

export const isDebugMode = memoize((): boolean => {
  return (
    runtimeDebugEnabled ||
    isEnvTruthy(process.env.DEBUG) ||
    isEnvTruthy(process.env.DEBUG_SDK) ||
    process.argv.includes('--debug') ||
    process.argv.includes('-d') ||
    isDebugToStdErr() ||
    process.argv.some(arg => arg.startsWith('--debug=')) ||
    getDebugFilePath() !== null
  )
})

export function enableDebugLogging(): boolean {
  const wasActive = isDebugMode() || process.env.USER_TYPE === 'ant'
  runtimeDebugEnabled = true
  isDebugMode.cache.clear?.()
  return wasActive
}

export function markSessionTrustAccepted(): void {
  setSessionTrustAccepted(true)
}

const parseDebugFilter = memoize(
  (filterString?: string): DebugFilter | null => {
    if (!filterString || filterString.trim() === '') {
      return null
    }

    const filters = filterString
      .split(',')
      .map(f => f.trim())
      .filter(Boolean)

    if (filters.length === 0) {
      return null
    }

    const hasExclusive = filters.some(f => f.startsWith('!'))
    const hasInclusive = filters.some(f => !f.startsWith('!'))

    if (hasExclusive && hasInclusive) {
      return null
    }

    const cleanFilters = filters.map(f => f.replace(/^!/, '').toLowerCase())

    return {
      include: hasExclusive ? [] : cleanFilters,
      exclude: hasExclusive ? cleanFilters : [],
      isExclusive: hasExclusive,
    }
  },
)

export const getDebugFilter = memoize((): DebugFilter | null => {
  const debugArg = process.argv.find(arg => arg.startsWith('--debug='))
  if (!debugArg) {
    return null
  }

  const filterPattern = debugArg.substring('--debug='.length)
  return parseDebugFilter(filterPattern)
})

export const isDebugToStdErr = memoize((): boolean => {
  return (
    process.argv.includes('--debug-to-stderr') || process.argv.includes('-d2e')
  )
})

export const getDebugFilePath = memoize((): string | null => {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i]!
    if (arg.startsWith('--debug-file=')) {
      return arg.substring('--debug-file='.length)
    }
    if (arg === '--debug-file' && i + 1 < process.argv.length) {
      return process.argv[i + 1]!
    }
  }
  return null
})

function extractDebugCategories(message: string): string[] {
  const categories: string[] = []

  const mcpMatch = message.match(/^MCP server ["']([^"']+)["']/)
  if (mcpMatch && mcpMatch[1]) {
    categories.push('mcp')
    categories.push(mcpMatch[1].toLowerCase())
  } else {
    const prefixMatch = message.match(/^([^:[]+):/)
    if (prefixMatch && prefixMatch[1]) {
      categories.push(prefixMatch[1].trim().toLowerCase())
    }
  }

  const bracketMatch = message.match(/^\[([^\]]+)]/)
  if (bracketMatch && bracketMatch[1]) {
    categories.push(bracketMatch[1].trim().toLowerCase())
  }

  if (message.toLowerCase().includes('1p event:')) {
    categories.push('1p')
  }

  const secondaryMatch = message.match(
    /:\s*([^:]+?)(?:\s+(?:type|mode|status|event))?:/,
  )
  if (secondaryMatch && secondaryMatch[1]) {
    const secondary = secondaryMatch[1].trim().toLowerCase()
    if (secondary.length < 30 && !secondary.includes(' ')) {
      categories.push(secondary)
    }
  }

  return Array.from(new Set(categories))
}

function shouldShowDebugCategories(
  categories: string[],
  filter: DebugFilter | null,
): boolean {
  if (!filter) {
    return true
  }

  if (categories.length === 0) {
    return false
  }

  if (filter.isExclusive) {
    return !categories.some(cat => filter.exclude.includes(cat))
  }

  return categories.some(cat => filter.include.includes(cat))
}

function shouldShowDebugMessage(
  message: string,
  filter: DebugFilter | null,
): boolean {
  if (!filter) {
    return true
  }

  return shouldShowDebugCategories(extractDebugCategories(message), filter)
}

function shouldLogDebugMessage(message: string): boolean {
  if (process.env.NODE_ENV === 'test' && !isDebugToStdErr()) {
    return false
  }

  if (process.env.USER_TYPE !== 'ant' && !isDebugMode()) {
    return false
  }

  if (
    typeof process === 'undefined' ||
    typeof process.versions === 'undefined' ||
    typeof process.versions.node === 'undefined'
  ) {
    return false
  }

  return shouldShowDebugMessage(message, getDebugFilter())
}

let hasFormattedOutput = false

export function setHasFormattedOutput(value: boolean): void {
  hasFormattedOutput = value
}

export function getHasFormattedOutput(): boolean {
  return hasFormattedOutput
}

function createBufferedWriter({
  writeFn,
  flushIntervalMs = 1000,
  maxBufferSize = 100,
  maxBufferBytes = Infinity,
  immediateMode = false,
}: {
  writeFn: WriteFn
  flushIntervalMs?: number
  maxBufferSize?: number
  maxBufferBytes?: number
  immediateMode?: boolean
}): BufferedWriter {
  let buffer: string[] = []
  let bufferBytes = 0
  let flushTimer: NodeJS.Timeout | null = null
  let pendingOverflow: string[] | null = null

  function clearTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  function flush(): void {
    if (pendingOverflow) {
      writeFn(pendingOverflow.join(''))
      pendingOverflow = null
    }
    if (buffer.length === 0) return
    writeFn(buffer.join(''))
    buffer = []
    bufferBytes = 0
    clearTimer()
  }

  function scheduleFlush(): void {
    if (!flushTimer) {
      flushTimer = setTimeout(flush, flushIntervalMs)
    }
  }

  function flushDeferred(): void {
    if (pendingOverflow) {
      pendingOverflow.push(...buffer)
      buffer = []
      bufferBytes = 0
      clearTimer()
      return
    }

    const detached = buffer
    buffer = []
    bufferBytes = 0
    clearTimer()
    pendingOverflow = detached
    setImmediate(() => {
      const toWrite = pendingOverflow
      pendingOverflow = null
      if (toWrite) writeFn(toWrite.join(''))
    })
  }

  return {
    write(content: string): void {
      if (immediateMode) {
        writeFn(content)
        return
      }
      buffer.push(content)
      bufferBytes += content.length
      scheduleFlush()
      if (buffer.length >= maxBufferSize || bufferBytes >= maxBufferBytes) {
        flushDeferred()
      }
    },
    flush,
    dispose(): void {
      flush()
    },
  }
}

let debugWriter: BufferedWriter | null = null
let pendingWrite: Promise<void> = Promise.resolve()

async function appendAsync(
  needMkdir: boolean,
  dir: string,
  path: string,
  content: string,
): Promise<void> {
  if (needMkdir) {
    await mkdir(dir, { recursive: true }).catch(() => {})
  }
  await appendFile(path, content)
  void updateLatestDebugLogSymlink()
}

function noop(): void {}

function getDebugWriter(): BufferedWriter {
  if (!debugWriter) {
    let ensuredDir: string | null = null
    debugWriter = createBufferedWriter({
      writeFn: content => {
        const path = getDebugLogPath()
        const dir = dirname(path)
        const needMkdir = ensuredDir !== dir
        ensuredDir = dir
        if (isDebugMode()) {
          if (needMkdir) {
            try {
              mkdirSync(dir, { recursive: true })
            } catch {
              // Continue and let appendFileSync report persistent filesystem errors.
            }
          }
          appendFileSync(path, content)
          void updateLatestDebugLogSymlink()
          return
        }
        pendingWrite = pendingWrite
          .then(appendAsync.bind(null, needMkdir, dir, path, content))
          .catch(noop)
      },
      flushIntervalMs: 1000,
      maxBufferSize: 100,
      immediateMode: isDebugMode(),
    })
    registerCleanup(async () => {
      debugWriter?.dispose()
      await pendingWrite
    })
  }

  return debugWriter
}

export async function flushDebugLogs(): Promise<void> {
  debugWriter?.flush()
  await pendingWrite
}

export function logForDebugging(
  message: string,
  { level }: { level: DebugLogLevel } = {
    level: 'debug',
  },
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinDebugLogLevel()]) {
    return
  }
  if (!shouldLogDebugMessage(message)) {
    return
  }

  if (hasFormattedOutput && message.includes('\n')) {
    message = JSON.stringify(message)
  }

  const timestamp = new Date().toISOString()
  const output = `${timestamp} [${level.toUpperCase()}] ${message.trim()}\n`
  if (isDebugToStdErr()) {
    writeToStderr(output)
    return
  }

  getDebugWriter().write(output)
}

export function getDebugLogPath(): string {
  return (
    getDebugFilePath() ??
    process.env.AGENC_DEBUG_LOGS_DIR ??
    join(getAgenCConfigHomeDir(), 'debug', `${getSessionId()}.txt`)
  )
}

// Last target the `latest` symlink was pointed at. NOT memoized on the empty
// arg list: the debug log path is session-scoped (getSessionId), and /resume
// switches the active session id, so a memoized once-per-process updater left the
// `latest` symlink pointing at the pre-resume session file forever. Re-link only
// when the resolved target actually changes.
let lastLinkedDebugLogPath: string | null = null

export async function updateLatestDebugLogSymlink(): Promise<void> {
  try {
    const debugLogPath = getDebugLogPath()
    if (debugLogPath === lastLinkedDebugLogPath) return
    const debugLogsDir = dirname(debugLogPath)
    const latestSymlinkPath = join(debugLogsDir, 'latest')

    await unlink(latestSymlinkPath).catch(() => {})
    await symlink(debugLogPath, latestSymlinkPath)
    lastLinkedDebugLogPath = debugLogPath
  } catch {
    // Symlink updates are best effort for platforms and filesystems without support.
  }
}

export function logAntError(_context: string, _error: unknown): void {
  // Internal-only elevated error surfacing is disabled in AgenC.
}
