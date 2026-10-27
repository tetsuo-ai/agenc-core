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
  } catch {
    // If we can't set raw mode, just silently continue without early capture
    isCapturing = false
  }
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
