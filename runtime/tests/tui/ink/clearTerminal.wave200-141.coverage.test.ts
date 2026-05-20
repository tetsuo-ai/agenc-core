import { afterEach, describe, expect, test, vi } from 'vitest'

type ClearTerminalModule = typeof import('./clearTerminal.js')

const CLEAR_MODERN = '\x1B[2J\x1B[3J\x1B[H'
const CLEAR_WINDOWS_CLASSIC = '\x1B[2J\x1B[0f'

const ENV_KEYS = [
  'MSYSTEM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'WT_SESSION',
] as const

type EnvKey = (typeof ENV_KEYS)[number]
type EnvOverrides = Partial<Record<EnvKey, string>>

const originalEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]))
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function setEnv(overrides: EnvOverrides = {}): void {
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }

  for (const [key, value] of Object.entries(overrides)) {
    process.env[key as EnvKey] = value
  }
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value,
  })
}

async function loadClearTerminal(
  platform: NodeJS.Platform,
  env: EnvOverrides = {},
): Promise<ClearTerminalModule> {
  vi.resetModules()
  setPlatform(platform)
  setEnv(env)
  return await import('./clearTerminal.js')
}

afterEach(() => {
  restoreEnv()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.resetModules()
})

describe('clear terminal sequence detection', () => {
  test('selects scrollback clearing only for terminals that support it', async () => {
    const linux = await loadClearTerminal('linux')
    expect(linux.getClearTerminalSequence()).toBe(CLEAR_MODERN)
    expect(linux.clearTerminal).toBe(CLEAR_MODERN)

    const classicWindows = await loadClearTerminal('win32')
    expect(classicWindows.getClearTerminalSequence()).toBe(
      CLEAR_WINDOWS_CLASSIC,
    )
    expect(classicWindows.clearTerminal).toBe(CLEAR_WINDOWS_CLASSIC)

    const windowsTerminal = await loadClearTerminal('win32', {
      WT_SESSION: 'session',
    })
    expect(windowsTerminal.getClearTerminalSequence()).toBe(CLEAR_MODERN)
    expect(windowsTerminal.clearTerminal).toBe(CLEAR_MODERN)

    const vscodeConpty = await loadClearTerminal('win32', {
      TERM_PROGRAM: 'vscode',
      TERM_PROGRAM_VERSION: '1.90.0',
    })
    expect(vscodeConpty.getClearTerminalSequence()).toBe(CLEAR_MODERN)

    const vscodeWithoutVersion = await loadClearTerminal('win32', {
      TERM_PROGRAM: 'vscode',
    })
    expect(vscodeWithoutVersion.getClearTerminalSequence()).toBe(
      CLEAR_WINDOWS_CLASSIC,
    )

    const minttyByProgram = await loadClearTerminal('win32', {
      TERM_PROGRAM: 'mintty',
    })
    expect(minttyByProgram.getClearTerminalSequence()).toBe(CLEAR_MODERN)

    const minttyByMsystem = await loadClearTerminal('win32', {
      MSYSTEM: 'MINGW64',
    })
    expect(minttyByMsystem.getClearTerminalSequence()).toBe(CLEAR_MODERN)
  })
})
