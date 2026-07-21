import type { Writable } from 'stream'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { Diff } from './frame.ts'
import type { Terminal } from './terminal.ts'

type EnvOverrides = Record<string, string | undefined>

const TERMINAL_ENV_KEYS = [
  'AGENC_ENABLE_EXTENDED_KEYS',
  'ALACRITTY_LOG',
  'ConEmuANSI',
  'ConEmuPID',
  'ConEmuTask',
  'CURSOR_TRACE_ID',
  'GNOME_TERMINAL_SERVICE',
  'KITTY_WINDOW_ID',
  'KONSOLE_VERSION',
  'MSYSTEM',
  'NODE_ENV',
  'PTYXIS_VERSION',
  'SESSIONNAME',
  'SSH_CLIENT',
  'SSH_CONNECTION',
  'SSH_TTY',
  'STY',
  'TERM',
  'TERMINAL_EMULATOR',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERMINATOR_UUID',
  'TILIX_ID',
  'TMUX',
  'VSCODE_GIT_ASKPASS_MAIN',
  'VTE_VERSION',
  'VisualStudioVersion',
  'WSL_DISTRO_NAME',
  'WT_SESSION',
  'XTERM_VERSION',
  'ZED_TERM',
  '__CFBundleIdentifier',
] as const

const originalEnv = new Map(
  TERMINAL_ENV_KEYS.map(key => [key, process.env[key]]),
)
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(
  process.stdout,
  'isTTY',
)
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function resetTerminalEnv(overrides: EnvOverrides = {}): void {
  for (const key of TERMINAL_ENV_KEYS) {
    delete process.env[key]
  }
  process.env.NODE_ENV = 'test'
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function restoreTerminalEnv(): void {
  for (const key of TERMINAL_ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function setStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value,
    writable: true,
  })
}

function restoreStdoutIsTTY(): void {
  if (originalStdoutIsTTY) {
    Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTTY)
  } else {
    delete (process.stdout as { isTTY?: boolean }).isTTY
  }
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value,
  })
}

async function importTerminal(overrides: EnvOverrides = {}) {
  vi.resetModules()
  resetTerminalEnv(overrides)
  return import('./terminal.ts')
}

function makeTerminal(writes: string[]): Terminal {
  const stdout = {
    write: (chunk: string | Uint8Array): boolean => {
      writes.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      )
      return true
    },
  } as unknown as Writable

  return {
    stderr: stdout,
    stdout,
  }
}

afterEach(() => {
  restoreTerminalEnv()
  restoreStdoutIsTTY()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('terminal capability detection', () => {
  test('detects progress reporting support from TTY state and terminal env', async () => {
    const terminal = await importTerminal()

    setStdoutIsTTY(false)
    expect(terminal.isProgressReportingAvailable()).toBe(false)

    setStdoutIsTTY(true)
    resetTerminalEnv({ WT_SESSION: '1' })
    expect(terminal.isProgressReportingAvailable()).toBe(false)

    resetTerminalEnv({ ConEmuPID: '100' })
    expect(terminal.isProgressReportingAvailable()).toBe(true)

    resetTerminalEnv({ TERM_PROGRAM_VERSION: 'not-a-version' })
    expect(terminal.isProgressReportingAvailable()).toBe(false)

    resetTerminalEnv({
      TERM_PROGRAM: 'ghostty',
      TERM_PROGRAM_VERSION: '1.1.9',
    })
    expect(terminal.isProgressReportingAvailable()).toBe(false)

    resetTerminalEnv({
      TERM_PROGRAM: 'ghostty',
      TERM_PROGRAM_VERSION: '1.2.0',
    })
    expect(terminal.isProgressReportingAvailable()).toBe(true)

    resetTerminalEnv({
      TERM_PROGRAM: 'iTerm.app',
      TERM_PROGRAM_VERSION: '3.6.5',
    })
    expect(terminal.isProgressReportingAvailable()).toBe(false)

    resetTerminalEnv({
      TERM_PROGRAM: 'iTerm.app',
      TERM_PROGRAM_VERSION: '3.6.6',
    })
    expect(terminal.isProgressReportingAvailable()).toBe(true)

    resetTerminalEnv({
      TERM_PROGRAM: 'WezTerm',
      TERM_PROGRAM_VERSION: '20240203',
    })
    expect(terminal.isProgressReportingAvailable()).toBe(false)
  })

  test('detects synchronized output support from known terminals', async () => {
    const terminal = await importTerminal()

    const supportedCases: EnvOverrides[] = [
      { TERM_PROGRAM: 'WezTerm' },
      { TERM: 'xterm-kitty' },
      { KITTY_WINDOW_ID: '42' },
      { TERM: 'xterm-ghostty' },
      { TERM: 'foot-extra' },
      { TERM: 'xterm-alacritty' },
      { ZED_TERM: '1' },
      { WT_SESSION: 'session' },
      { VTE_VERSION: '6800' },
    ]

    for (const env of supportedCases) {
      resetTerminalEnv(env)
      expect(terminal.isSynchronizedOutputSupported()).toBe(true)
    }

    resetTerminalEnv({ TERM_PROGRAM: 'WezTerm', TMUX: '1' })
    expect(terminal.isSynchronizedOutputSupported()).toBe(false)

    resetTerminalEnv({ TERM_PROGRAM: 'Apple_Terminal', VTE_VERSION: '6799' })
    expect(terminal.isSynchronizedOutputSupported()).toBe(false)

    // Ptyxis reports a new VTE_VERSION but mishandles DEC 2026/DECSTBM, so it
    // is opted out even though its VTE_VERSION would otherwise qualify.
    resetTerminalEnv({ PTYXIS_VERSION: '50.1', VTE_VERSION: '8400' })
    expect(terminal.isSynchronizedOutputSupported()).toBe(false)
  })

  test('freezes synchronized output and extended key support at import time', async () => {
    const synced = await importTerminal({ TERM_PROGRAM: 'WezTerm' })
    expect(synced.SYNC_OUTPUT_SUPPORTED).toBe(true)
    expect(synced.supportsExtendedKeys()).toBe(false)

    const extendedKeys = await importTerminal({
      AGENC_ENABLE_EXTENDED_KEYS: '1',
      TERM_PROGRAM: 'WezTerm',
    })
    expect(extendedKeys.SYNC_OUTPUT_SUPPORTED).toBe(true)
    expect(extendedKeys.supportsExtendedKeys()).toBe(true)

    const xtermJs = await importTerminal({
      AGENC_ENABLE_EXTENDED_KEYS: '1',
      TERM_PROGRAM: 'vscode',
    })
    expect(xtermJs.supportsExtendedKeys()).toBe(false)

    const tmux = await importTerminal({
      AGENC_ENABLE_EXTENDED_KEYS: '1',
      TMUX: '1',
    })
    expect(tmux.SYNC_OUTPUT_SUPPORTED).toBe(false)
    expect(tmux.supportsExtendedKeys()).toBe(true)
  })

  test('uses XTVERSION once for terminal identity probes', async () => {
    const testMode = await importTerminal({ TERM_PROGRAM: 'ghostty' })
    expect(testMode.isGhosttyTerminal()).toBe(false)

    const ghostty = await importTerminal({ NODE_ENV: 'development' })
    expect(ghostty.isGhosttyTerminal()).toBe(false)

    ghostty.setXtversionName('Ghostty 1.2.0')
    expect(ghostty.isGhosttyTerminal()).toBe(true)
    expect(ghostty.shouldSkipMainScreenSyncMarkers()).toBe(true)
    expect(ghostty.shouldUseMainScreenRewrite()).toBe(true)

    ghostty.setXtversionName('xterm.js 5.3.0')
    expect(ghostty.isGhosttyTerminal()).toBe(true)
    expect(ghostty.isXtermJs()).toBe(false)

    const xterm = await importTerminal()
    xterm.setXtversionName('xterm.js 5.3.0')
    expect(xterm.isXtermJs()).toBe(true)

    resetTerminalEnv({ TERM_PROGRAM: 'vscode' })
    expect(xterm.isXtermJs()).toBe(true)
  })

  test('detects cursor-up viewport yank risk on Windows-style terminals', async () => {
    const terminal = await importTerminal()

    setPlatform('linux')
    resetTerminalEnv()
    expect(terminal.hasCursorUpViewportYankBug()).toBe(false)

    resetTerminalEnv({ WT_SESSION: 'session' })
    expect(terminal.hasCursorUpViewportYankBug()).toBe(true)

    setPlatform('win32')
    resetTerminalEnv()
    expect(terminal.hasCursorUpViewportYankBug()).toBe(true)
  })
})

describe('writeDiffToTerminal', () => {
  test('serializes every patch type and skips empty diffs', async () => {
    const terminal = await importTerminal()
    const writes: string[] = []
    const output = makeTerminal(writes)

    terminal.writeDiffToTerminal(output, [], true)
    expect(writes).toEqual([])

    const diff: Diff = [
      { type: 'stdout', content: 'hi' },
      { type: 'clear', count: 2 },
      { type: 'clearTerminal', reason: 'clear' },
      { type: 'cursorHide' },
      { type: 'cursorShow' },
      { type: 'cursorMove', x: -2, y: 3 },
      { type: 'cursorTo', col: 5 },
      { type: 'carriageReturn' },
      { type: 'hyperlink', uri: '' },
      { type: 'styleStr', str: '\x1b[31m' },
    ]

    terminal.writeDiffToTerminal(output, diff, true)
    expect(writes).toEqual([
      'hi' +
        '\x1b[2K\x1b[1A\x1b[2K\x1b[G' +
        '\x1b[2J\x1b[3J\x1b[H' +
        '\x1b[?25l' +
        '\x1b[?25h' +
        '\x1b[2D\x1b[3B' +
        '\x1b[5G' +
        '\r' +
        '\x1b]8;;\x07' +
        '\x1b[31m',
    ])

    terminal.writeDiffToTerminal(output, [{ type: 'stdout', content: 'sync' }])
    expect(writes[1]).toBe('\x1b[?2026hsync\x1b[?2026l')
  })
})
