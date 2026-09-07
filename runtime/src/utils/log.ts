import { feature } from 'bun:bundle'
import type { Dirent } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { tokenizeCliOptionRegion } from '../bin/cli-option-region.js'
import { TICK_TAG } from '../constants/xml.js'
import {
  type LogOption,
  type SerializedMessage,
  sortLogs,
} from '../types/logs.js'
import { CACHE_PATHS } from './cachePaths.js'
import { logForDebugging } from './debug.js'
import { stripDisplayTags, stripDisplayTagsAllowEmpty } from './displayTags.js'
import { toError } from './errors.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'
import { jsonParse } from './slowOperations.js'
import { getSelectedProviderName } from './model/providers.js'

/**
 * Gets the display title for a log/session with fallback logic.
 * Skips firstPrompt if it starts with a tick/goal tag (autonomous mode auto-prompt).
 * Strips display-unfriendly tags (like <ide_opened_file>) from the result.
 * Falls back to a truncated session ID when no other title is available.
 */
export function getLogDisplayTitle(
  log: LogOption,
  defaultTitle?: string,
): string {
  // Skip firstPrompt if it's a tick/goal message (autonomous mode auto-prompt)
  const isAutonomousPrompt = log.firstPrompt?.startsWith(`<${TICK_TAG}>`)
  // Strip display-unfriendly tags (command-name, ide_opened_file, etc.) early
  // so that command-only prompts (e.g. /clear) become empty and fall through
  // to the next fallback instead of showing raw XML tags.
  // Note: stripDisplayTags returns the original when stripping yields empty,
  // so we call stripDisplayTagsAllowEmpty to detect command-only prompts.
  const strippedFirstPrompt = log.firstPrompt
    ? stripDisplayTagsAllowEmpty(log.firstPrompt)
    : ''
  const useFirstPrompt = strippedFirstPrompt && !isAutonomousPrompt
  const title =
    log.agentName ||
    log.customTitle ||
    log.summary ||
    (useFirstPrompt ? strippedFirstPrompt : undefined) ||
    defaultTitle ||
    // For autonomous sessions without other context, show a meaningful label
    (isAutonomousPrompt ? 'Autonomous session' : undefined) ||
    // Fall back to truncated session ID for lite logs with no metadata
    (log.sessionId ? log.sessionId.slice(0, 8) : '') ||
    ''
  // Strip display-unfriendly tags (like <ide_opened_file>) for cleaner titles
  return stripDisplayTags(title).trim()
}

export function dateToFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

// In-memory error log for recent errors
// Moved from bootstrap/state.ts to break import cycle
const MAX_IN_MEMORY_ERRORS = 100
let inMemoryErrorLog: Array<{ error: string; timestamp: string }> = []

function addToInMemoryErrorLog(errorInfo: {
  error: string
  timestamp: string
}): void {
  if (inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    inMemoryErrorLog.shift() // Remove oldest error
  }
  inMemoryErrorLog.push(errorInfo)
}

/**
 * Sink interface for the error logging backend
 */
export type ErrorLogSink = {
  logError: (error: Error) => void
  logMCPError: (serverName: string, error: unknown) => void
  logMCPDebug: (serverName: string, message: string) => void
  getErrorsPath: () => string
  getMCPLogsPath: (serverName: string) => string
}

// Queued events for events logged before sink is attached
type QueuedErrorEvent =
  | { type: 'error'; message: string; stack: string; name: string }
  | { type: 'mcpError'; serverName: string; error: string }
  | { type: 'mcpDebug'; serverName: string; message: string }

export const ERROR_LOG_QUEUE_LIMITS = Object.freeze({
  errors: 100,
  debug: 100,
  textBytes: 8192,
  labelBytes: 256,
})

const errorQueue: QueuedErrorEvent[] = []
let droppedErrors = 0
let droppedDebug = 0

// Sink - initialized during app startup
let errorLogSink: { sink: ErrorLogSink } | null = null

function boundedLogText(
  text: string,
  maxBytes: number = ERROR_LOG_QUEUE_LIMITS.textBytes,
): string {
  // Copy a bounded prefix so a short substring cannot retain a large backing string.
  const bytes = Buffer.from(text.slice(0, maxBytes), 'utf8')
  if (text.length <= maxBytes && bytes.length <= maxBytes) {
    return bytes.toString('utf8')
  }
  const marker = '...[truncated]'
  let end = Math.min(bytes.length, maxBytes - marker.length)
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8') + marker
}

function formattedLogError(error: unknown): string {
  try {
    return boundedLogText(
      error instanceof Error ? error.stack || error.message : String(error),
    )
  } catch {
    return '[unprintable error]'
  }
}

function recordDroppedEvent(event: QueuedErrorEvent): void {
  if (event.type === 'mcpDebug') {
    droppedDebug = Math.min(Number.MAX_SAFE_INTEGER, droppedDebug + 1)
  } else {
    droppedErrors = Math.min(Number.MAX_SAFE_INTEGER, droppedErrors + 1)
  }
}

function deliverErrorLogEvent(sink: ErrorLogSink, event: QueuedErrorEvent): void {
  try {
    switch (event.type) {
      case 'error': {
        const error = new Error(event.message)
        error.name = event.name
        error.stack = event.stack
        sink.logError(error)
        break
      }
      case 'mcpError':
        sink.logMCPError(event.serverName, event.error)
        break
      case 'mcpDebug':
        sink.logMCPDebug(event.serverName, event.message)
        break
    }
  } catch {
    // A failed sink must neither recurse through logging nor stop the drain.
    recordDroppedEvent(event)
  }
}

function emitErrorLogEvent(event: QueuedErrorEvent): void {
  if (errorLogSink !== null) {
    deliverErrorLogEvent(errorLogSink.sink, event)
    return
  }
  const debug = event.type === 'mcpDebug'
  const sameKind = (queued: QueuedErrorEvent) =>
    (queued.type === 'mcpDebug') === debug
  const limit = debug
    ? ERROR_LOG_QUEUE_LIMITS.debug
    : ERROR_LOG_QUEUE_LIMITS.errors
  if (errorQueue.filter(sameKind).length >= limit) {
    const [evicted] = errorQueue.splice(errorQueue.findIndex(sameKind), 1)
    if (evicted) recordDroppedEvent(evicted)
  }
  errorQueue.push(event)
}

export function getErrorLogQueueStats(): {
  errors: number
  debug: number
  /** UTF-8 payload bytes; event count separately bounds object overhead. */
  retainedBytes: number
  droppedErrors: number
  droppedDebug: number
} {
  const debug = errorQueue.filter(event => event.type === 'mcpDebug').length
  return {
    errors: errorQueue.length - debug,
    debug,
    retainedBytes: errorQueue.reduce(
      (total, event) => total + Object.values(event).reduce(
        (bytes, value) => bytes + Buffer.byteLength(value, 'utf8'), 0,
      ), 0,
    ),
    droppedErrors,
    droppedDebug,
  }
}

/**
 * Attach the error log sink that will receive all error events.
 * Retained startup events are drained immediately. The returned disposer
 * detaches only this attachment and clears its retained state.
 *
 * An existing attachment keeps ownership; duplicate attachments receive
 * a no-op disposer.
 */
export function attachErrorLogSink(newSink: ErrorLogSink): () => void {
  if (errorLogSink !== null) {
    return () => {}
  }
  const attachment = { sink: newSink }
  errorLogSink = attachment
  const queuedEvents = errorQueue.splice(0)
  for (const event of queuedEvents) {
    if (errorLogSink !== attachment) break
    deliverErrorLogEvent(newSink, event)
  }
  return () => {
    if (errorLogSink !== attachment) return
    errorLogSink = null
    errorQueue.length = 0
    inMemoryErrorLog = []
    droppedErrors = 0
    droppedDebug = 0
  }
}

/**
 * Records bounded error text in recent history and the active process sink.
 * Before sink attachment, events enter the bounded startup queue.
 * The daemon routes diagnostics to its rotating log or inherited stderr.
 *
 * Usage:
 * ```ts
 * logError(new Error('Failed to connect'))
 * ```
 *
 * Call `getInMemoryErrors()` to retrieve recent errors for this sink lifetime.
 */
const isHardFailMode = memoize((): boolean => {
  return tokenizeCliOptionRegion(process.argv.slice(2)).optionArgs.includes(
    '--hard-fail',
  )
})

export function logError(error: unknown): void {
  if (feature('HARD_FAIL') && isHardFailMode()) {
    // biome-ignore lint/suspicious/noConsole:: intentional crash output
    console.error('[HARD FAIL] logError called')
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
  try {
    // Check if error reporting should be disabled
    const selectedProvider = getSelectedProviderName()
    if (
      // Cloud providers always disable error reporting.
      selectedProvider === 'amazon-bedrock' ||
      selectedProvider === 'vertex' ||
      selectedProvider === 'foundry' ||
      process.env.DISABLE_ERROR_REPORTING ||
      isEssentialTrafficOnly()
    ) {
      return
    }

    const err = toError(error)
    const errorStr = formattedLogError(err)

    const errorInfo = {
      error: errorStr,
      timestamp: new Date().toISOString(),
    }

    // Always add to in-memory log (no dependencies needed)
    addToInMemoryErrorLog(errorInfo)

    emitErrorLogEvent({
      type: 'error',
      message: boundedLogText(err.message),
      stack: errorStr,
      name: boundedLogText(err.name, ERROR_LOG_QUEUE_LIMITS.labelBytes),
    })
  } catch {
    // pass
  }
}

export function getInMemoryErrors(): { error: string; timestamp: string }[] {
  return [...inMemoryErrorLog]
}

/**
 * Loads the list of error logs
 * @returns List of error logs sorted by date
 */
export function loadErrorLogs(): Promise<LogOption[]> {
  return loadLogList(CACHE_PATHS.errors())
}

/**
 * Gets an error log by its index
 * @param index Index in the sorted list of logs (0-based)
 * @returns Log data or null if not found
 */
export async function getErrorLogByIndex(
  index: number,
): Promise<LogOption | null> {
  const logs = await loadErrorLogs()
  return logs[index] || null
}

/**
 * Internal function to load and process logs from a specified path
 * @param path Directory containing logs
 * @returns Array of logs sorted by date
 * @private
 */
async function loadLogList(path: string): Promise<LogOption[]> {
  let files: Dirent[]
  try {
    files = await readdir(path, { withFileTypes: true })
  } catch {
    logError(new Error(`No logs found at ${path}`))
    return []
  }
  const logData = await Promise.all(
    files.map(async (file, i) => {
      const fullPath = join(path, file.name)
      try {
        const content = await readFile(fullPath, { encoding: 'utf8' })
        const messages = jsonParse(content) as SerializedMessage[]
        const firstMessage = messages[0]
        const lastMessage = messages[messages.length - 1]
        const firstPrompt =
          firstMessage?.type === 'user' &&
          typeof firstMessage?.message?.content === 'string'
            ? firstMessage?.message?.content
            : 'No prompt'

        // For new random filenames, we'll get stats from the file itself
        const fileStats = await stat(fullPath)

        // Check if it's a sidechain by looking at filename
        const isSidechain = fullPath.includes('sidechain')

        // For new files, use the file modified time as date
        const date = dateToFilename(fileStats.mtime)

        return {
          date,
          fullPath,
          messages,
          value: i, // workaround: overwritten after sorting, right below this
          created: parseISOString(firstMessage?.timestamp || date),
          modified: lastMessage?.timestamp
            ? parseISOString(lastMessage.timestamp)
            : parseISOString(date),
          firstPrompt:
            firstPrompt.split('\n')[0]?.slice(0, 50) +
              (firstPrompt.length > 50 ? '…' : '') || 'No prompt',
          messageCount: messages.length,
          isSidechain,
        }
      } catch (e) {
        // Skip unreadable or corrupt log files — a partial write from a
        // crashed fire-and-forget persist shouldn't take down the whole
        // listing; the remaining valid logs still load.
        logForDebugging(`loadLogList: skipping ${file.name}: ${String(e)}`)
        return null
      }
    }),
  )

  return sortLogs(logData.filter(_ => _ !== null)).map((_, i) => ({
    ..._,
    value: i,
  }))
}

/**
 * Test-only wrapper exposing the private {@link loadLogList} so tests can
 * exercise per-file corruption tolerance against a controlled directory.
 */
export function _loadLogListForTesting(path: string): Promise<LogOption[]> {
  return loadLogList(path)
}

function parseISOString(s: string): Date {
  const b = s.split(/\D+/)
  return new Date(
    Date.UTC(
      parseInt(b[0]!, 10),
      parseInt(b[1]!, 10) - 1,
      parseInt(b[2]!, 10),
      parseInt(b[3]!, 10),
      parseInt(b[4]!, 10),
      parseInt(b[5]!, 10),
      parseInt(b[6]!, 10),
    ),
  )
}

export function logMCPError(serverName: string, error: unknown): void {
  try {
    emitErrorLogEvent({
      type: 'mcpError',
      serverName: boundedLogText(serverName, ERROR_LOG_QUEUE_LIMITS.labelBytes),
      error: formattedLogError(error),
    })
  } catch {
    // Silently fail
  }
}

export function logMCPDebug(serverName: string, message: string): void {
  try {
    emitErrorLogEvent({
      type: 'mcpDebug',
      serverName: boundedLogText(serverName, ERROR_LOG_QUEUE_LIMITS.labelBytes),
      message: boundedLogText(message),
    })
  } catch {
    // Silently fail
  }
}

/**
 * Reset error log state for testing purposes only.
 * @internal
 */
export function _resetErrorLogForTesting(): void {
  errorLogSink = null
  errorQueue.length = 0
  inMemoryErrorLog = []
  droppedErrors = 0
  droppedDebug = 0
}
