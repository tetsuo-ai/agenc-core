import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const originalEnv = { ...process.env }
const originalPlatform = process.platform

const envMock = { terminal: 'xterm' as string | null }
const execFileNoThrowMock = vi.fn(
  async () => ({ code: 0, stdout: '', stderr: '' }),
)

function installOscMocks(): void {
  vi.doMock('../../../utils/env.js', () => ({
    env: envMock,
  }))

  vi.doMock('../../../utils/execFileNoThrow.js', () => ({
    execFileNoThrow: execFileNoThrowMock,
    execFileNoThrowWithCwd: execFileNoThrowMock,
  }))
}

async function importFreshOscModule() {
  return import('./osc.ts')
}

async function flushClipboardCopy(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function waitForExecCall(
  command: string,
): Promise<(typeof execFileNoThrowMock.mock.calls)[number] | undefined> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const call = execFileNoThrowMock.mock.calls.find(([cmd]) => cmd === command)
    if (call) return call
    await flushClipboardCopy()
  }

  return undefined
}

describe('OSC wave200-025 coverage', () => {
  beforeEach(() => {
    vi.resetModules()
    installOscMocks()
    envMock.terminal = 'kitty'
    execFileNoThrowMock.mockReset()
    execFileNoThrowMock.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    process.env = { ...originalEnv }
    delete process.env['LC_TERMINAL']
    delete process.env['SSH_CONNECTION']
    delete process.env['STY']
    delete process.env['TMUX']
    Object.defineProperty(process, 'platform', { value: 'linux' })
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    vi.resetModules()
    vi.clearAllMocks()
  })

  test('formats tab status, wraps multiplexer sequences, and uses clipboard fallbacks', async () => {
    const {
      OSC,
      _resetLinuxCopyCache,
      parseOSC,
      setClipboard,
      tabStatus,
      wrapForMultiplexer,
    } = await importFreshOscModule()

    expect(
      tabStatus({
        indicator: { type: 'rgb', r: 1, g: 2, b: 3 },
        status: 'build;ok\\done',
        statusColor: { type: 'rgb', r: 255, g: 0, b: 16 },
      }),
    ).toBe(
      `\x1b]${OSC.TAB_STATUS};indicator=#010203;status=build\\;ok\\\\done;status-color=#ff0010\x1b\\`,
    )
    expect(
      tabStatus({ indicator: null, status: null, statusColor: null }),
    ).toBe(`\x1b]${OSC.TAB_STATUS};indicator=;status=;status-color=\x1b\\`)

    expect(
      parseOSC(
        `${OSC.TAB_STATUS};indicator=rgb:f/80/0;status=left\\;right\\\\done;status-color=#0a0b0c;unused=value`,
      ),
    ).toEqual({
      type: 'tabStatus',
      action: {
        indicator: { type: 'rgb', r: 255, g: 128, b: 0 },
        status: 'left;right\\done',
        statusColor: { type: 'rgb', r: 10, g: 11, b: 12 },
      },
    })
    expect(parseOSC(`${OSC.TAB_STATUS};indicator=;status=;status-color=`)).toEqual(
      {
        type: 'tabStatus',
        action: { indicator: null, status: null, statusColor: null },
      },
    )

    process.env['TMUX'] = '/tmp/tmux-1000/default,123,0'
    expect(wrapForMultiplexer('\x1b]0;title\x07')).toBe(
      '\x1bPtmux;\x1b\x1b]0;title\x07\x1b\\',
    )
    delete process.env['TMUX']
    process.env['STY'] = 'screen-session'
    expect(wrapForMultiplexer('plain')).toBe('\x1bPplain\x1b\\')
    delete process.env['STY']

    process.env['TMUX'] = '/tmp/tmux-1000/default,123,0'
    process.env['SSH_CONNECTION'] = 'client server'
    process.env['LC_TERMINAL'] = 'iTerm2'
    execFileNoThrowMock.mockClear()

    const tmuxText = 'tmux copy'
    const tmuxSequence = await setClipboard(tmuxText)
    const tmuxB64 = Buffer.from(tmuxText, 'utf8').toString('base64')

    expect(tmuxSequence).toBe(
      `\x1bPtmux;\x1b\x1b]52;c;${tmuxB64}\x07\x1b\\`,
    )
    expect(execFileNoThrowMock).toHaveBeenCalledWith(
      'tmux',
      ['load-buffer', '-'],
      {
        input: tmuxText,
        timeout: 2000,
        useCwd: false,
      },
    )

    delete process.env['TMUX']
    delete process.env['SSH_CONNECTION']
    delete process.env['LC_TERMINAL']
    _resetLinuxCopyCache()
    execFileNoThrowMock.mockReset()
    execFileNoThrowMock
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValue({ code: 0, stdout: '', stderr: '' })

    const linuxText = 'local linux'
    const linuxSequence = await setClipboard(linuxText)
    const linuxB64 = Buffer.from(linuxText, 'utf8').toString('base64')
    const xclipProbe = await waitForExecCall('xclip')

    expect(linuxSequence).toBe(`\x1b]52;c;${linuxB64}\x1b\\`)
    expect(execFileNoThrowMock.mock.calls[0]).toEqual([
      'wl-copy',
      [],
      { input: linuxText, timeout: 2000, useCwd: false },
    ])
    expect(xclipProbe).toEqual([
      'xclip',
      ['-selection', 'clipboard'],
      { input: linuxText, timeout: 2000, useCwd: false },
    ])
    await flushClipboardCopy()

    execFileNoThrowMock.mockClear()
    await setClipboard('cached linux')
    const cachedXclip = await waitForExecCall('xclip')

    expect(cachedXclip).toEqual([
      'xclip',
      ['-selection', 'clipboard'],
      { input: 'cached linux', timeout: 2000, useCwd: false },
    ])
  })
})
