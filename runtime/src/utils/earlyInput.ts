/**
 * Early Input Capture
 *
 * This module captures terminal input that is typed before the REPL is fully
 * initialized. Users often type `agenc` and immediately start typing their
 * prompt, but those early keystrokes would otherwise be lost during startup.
 *
 * Usage:
 * 1. Call startCapturingEarlyInput() as early as possible in cli.tsx
 * 2. When REPL is ready, call consumeEarlyInput() to get any buffered text
 * 3. stopCapturingEarlyInput() is called automatically when input is consumed
 */

import { lastGrapheme } from './intl.js'
import { tokenizeCliOptionRegion } from '../bin/cli-option-region.js'
import {
  setCachedTerminalBackground,
  themeFromOscColor,
} from './terminalBackground.js'

/**
 * Startup terminal queries: the OSC 11 background color (BEL-terminated, the
 * widest support), then DA1 as a sentinel. Every terminal answers DA1 and
 * terminals answer in order, so the DA1 reply means any background report has
 * already arrived (or the terminal has none).
 */
const STARTUP_TERMINAL_QUERIES = '\x1b]11;?\x07\x1b[c'
const DA1_REPORT = /^\x1b\[\?[\d;]*c$/
/** Upper bound on waiting for the DA1 reply: one round trip, even over SSH. */
const TERMINAL_REPORTS_TIMEOUT_MS = 400

let pendingReports: { readonly promise: Promise<void>; readonly settle: () => void } | null = null

function settleTerminalReports(): void {
  const pending = pendingReports
  pendingReports = null
  pending?.settle()
}

// Buffer for early input characters
let earlyInputBuffer = ''
let pendingEscape = ''
// Flag to track if we're currently capturing
let isCapturing = false
// Reference to the readable handler so we can remove it later
let readableHandler: (() => void) | null = null

/**
 * Start capturing stdin data early, before the REPL is initialized.
 * Should be called as early as possible in the startup sequence.
 *
 * Only captures if stdin is a TTY (interactive terminal).
 */
export function startCapturingEarlyInput(): void {
  const { optionArgs } = tokenizeCliOptionRegion(process.argv.slice(2))
  // Only capture in interactive mode: stdin must be a TTY, and we must not
  // be in print mode. Raw mode disables ISIG (terminal Ctrl+C → SIGINT),
  // which would make -p uninterruptible.
  if (
    !process.stdin.isTTY ||
    isCapturing ||
    optionArgs.includes('-p') ||
    optionArgs.includes('--print')
  ) {
    return
  }

  isCapturing = true
  earlyInputBuffer = ''
  pendingEscape = ''

  // Set stdin to raw mode and use 'readable' event like Ink does
  // This ensures compatibility with how the REPL will handle stdin later
  try {
    process.stdin.setEncoding('utf8')
    process.stdin.setRawMode(true)
    process.stdin.ref()

    readableHandler = () => {
      let chunk = process.stdin.read()
      while (chunk !== null) {
        if (typeof chunk === 'string') {
          processChunk(chunk)
        }
        chunk = process.stdin.read()
      }
    }

    process.stdin.on('readable', readableHandler)
    // Ask the terminal for its background while this capture owns raw stdin,
    // so the 'auto' theme is right from the first frame. processChunk strips
    // the replies from the typed text and records the background; the caller
    // waits for them with waitForTerminalReports() before raw mode is given
    // back, so a reply is never echoed onto the screen. A terminal without
    // OSC 11 leaves the default, and the OSC 11 watcher polls after mount.
    if (process.stdout.isTTY) {
      let settle = (): void => {}
      const promise = new Promise<void>(resolve => { settle = resolve })
      pendingReports = { promise, settle }
      process.stdout.write(STARTUP_TERMINAL_QUERIES)
    }
  } catch {
    // If we can't set raw mode, just silently continue without early capture
    isCapturing = false
  }
}

/**
 * Record an OSC 11 background color report (the reply to the query sent when
 * capture starts) so 'auto' resolves before the first frame.
 */
function recordBackgroundReport(sequence: string): void {
  if (DA1_REPORT.test(sequence)) {
    settleTerminalReports()
    return
  }
  const report = /^\x1b\]11;([^\x07\x1b]*)/.exec(sequence)
  if (!report) return
  const background = themeFromOscColor(report[1]!)
  if (background) setCachedTerminalBackground(background)
}

/**
 * Wait until the terminal has answered the startup queries (its DA1 reply
 * arrived), at most `timeoutMs`. Call it right after startCapturingEarlyInput
 * and before the captured input is consumed: raw mode stays on meanwhile, so
 * the replies are read here instead of being echoed by the terminal.
 */
export async function waitForTerminalReports(
  timeoutMs: number = TERMINAL_REPORTS_TIMEOUT_MS,
): Promise<void> {
  const pending = pendingReports
  if (pending === null) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    pending.promise,
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
}

/**
 * Process a chunk of input data
 */
function processChunk(str: string): void {
  str = pendingEscape + str
  pendingEscape = ''
  let i = 0
  while (i < str.length) {
    const char = str[i]!
    const code = char.charCodeAt(0)

    // Cancellation and double-press exit belong to the ready composer. During
    // startup/resume, keep the captured draft until it can be safely delivered.
    if (code === 3) {
      i++
      continue
    }

    // Ctrl+D (code 4) - EOF, stop capturing
    if (code === 4) {
      stopCapturingEarlyInput()
      return
    }

    // Backspace (code 127 or 8) - remove last grapheme cluster
    if (code === 127 || code === 8) {
      if (earlyInputBuffer.length > 0) {
        const last = lastGrapheme(earlyInputBuffer)
        earlyInputBuffer = earlyInputBuffer.slice(0, -(last.length || 1))
      }
      i++
      continue
    }

    // Ignore complete terminal reports and paste wrappers, even when the
    // sequence is split across chunks. Keep the text inside a pasted block.
    if (code === 27) {
      const rest = str.slice(i)
      const sequence = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[@-~]|\][^\x07]*(?:\x07|\x1b\\))/.exec(rest)
      if (sequence) {
        recordBackgroundReport(sequence[0])
        i += sequence[0].length
      } else if (/^\x1b(?:\[[0-?]*[ -/]*|O|\][^\x07]*)?$/.test(rest)) {
        pendingEscape = rest
        break
      } else {
        i++
      }
      continue
    }

    // Skip other control characters (except tab and newline)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      i++
      continue
    }

    // Convert carriage return to newline
    if (code === 13) {
      earlyInputBuffer += '\n'
      i++
      continue
    }

    // Add printable characters and allowed control chars to buffer
    earlyInputBuffer += char
    i++
  }
}

/**
 * Stop capturing early input.
 * Called automatically when input is consumed, or can be called manually.
 */
export function stopCapturingEarlyInput(): void {
  if (!isCapturing) {
    return
  }

  isCapturing = false
  pendingEscape = ''
  settleTerminalReports()

  if (readableHandler) {
    process.stdin.removeListener('readable', readableHandler)
    readableHandler = null
  }

  // Don't reset stdin state - the REPL's Ink App will manage stdin state.
  // If we call setRawMode(false) here, it can interfere with the REPL's
  // own stdin setup which happens around the same time.
}

/**
 * Consume any early input that was captured.
 * Returns the captured input and clears the buffer.
 * Automatically stops capturing when called.
 */
export function consumeEarlyInput(options: {
  readonly restoreRawMode?: boolean
  readonly preserveWhitespace?: boolean
} = {}): string {
  stopCapturingEarlyInput()
  if (options.restoreRawMode && process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false)
      process.stdin.unref()
    } catch { /* revoked terminal */ }
  }
  const input = options.preserveWhitespace ? earlyInputBuffer : earlyInputBuffer.trim()
  earlyInputBuffer = ''
  return input
}

/**
 * Check if there is any early input available without consuming it.
 */
export function hasEarlyInput(): boolean {
  return earlyInputBuffer.trim().length > 0
}

/**
 * Seed the early input buffer with text that will appear pre-filled
 * in the prompt input when the REPL renders. Does not auto-submit.
 */
export function seedEarlyInput(text: string): void {
  earlyInputBuffer = text
}

/**
 * Check if early input capture is currently active.
 */
export function isCapturingEarlyInput(): boolean {
  return isCapturing
}
