import type { Writable } from 'node:stream'

import { afterEach, describe, expect, test, vi } from 'vitest'

import type { Diff } from '../../../src/tui/ink/frame.js'
import type { Terminal } from '../../../src/tui/ink/terminal.js'

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

async function importTerminal(overrides: EnvOverrides = {}) {
  vi.resetModules()
  resetTerminalEnv(overrides)
  return import('../../../src/tui/ink/terminal.js')
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
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('terminal coverage swarm row 237', () => {
  test('detects Ghostty in real sessions from TERM_PROGRAM and TERM', async () => {
    const termProgram = await importTerminal({
      NODE_ENV: 'development',
      TERM_PROGRAM: 'ghostty',
    })
    expect(termProgram.isGhosttyTerminal()).toBe(true)
    expect(termProgram.shouldSkipMainScreenSyncMarkers()).toBe(true)
    expect(termProgram.shouldUseMainScreenRewrite()).toBe(true)

    const term = await importTerminal({
      NODE_ENV: 'development',
      TERM: 'xterm-ghostty',
    })
    expect(term.isGhosttyTerminal()).toBe(true)
  })

  test('falls back when no XTVERSION name or terminal name is available', async () => {
    const noXtversion = await importTerminal()
    expect(noXtversion.isXtermJs()).toBe(false)

    setStdoutIsTTY(true)
    const noTerminalName = await importTerminal({
      AGENC_ENABLE_EXTENDED_KEYS: '1',
    })
    expect(noTerminalName.supportsExtendedKeys()).toBe(false)
  })

  test('ignores clear patches with non-positive counts', async () => {
    const terminal = await importTerminal()
    const writes: string[] = []
    const output = makeTerminal(writes)
    const diff: Diff = [
      { type: 'clear', count: 0 },
      { type: 'stdout', content: 'after-clear' },
    ]

    terminal.writeDiffToTerminal(output, diff, true)

    expect(writes).toEqual(['after-clear'])
  })
})
