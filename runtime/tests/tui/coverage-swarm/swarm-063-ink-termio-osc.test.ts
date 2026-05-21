import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const originalEnv = { ...process.env }
const originalPlatform = process.platform

const envMock = { terminal: 'xterm' as string | null }
const execFileNoThrowMock = vi.fn(
  async () => ({ code: 0, stdout: '', stderr: '' }),
)

function installOscMocks(): void {
  vi.doMock('../../../src/utils/env.js', () => ({
    env: envMock,
  }))

  vi.doMock('../../../src/utils/execFileNoThrow.js', () => ({
    execFileNoThrow: execFileNoThrowMock,
    execFileNoThrowWithCwd: execFileNoThrowMock,
  }))
}

async function importFreshOscModule() {
  return import('../../../src/tui/ink/termio/osc.js')
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

function successfulExecResult(): {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
} {
  return { code: 0, stdout: '', stderr: '' }
}

function failedExecResult(): {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
} {
  return { code: 1, stdout: '', stderr: '' }
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

async function settleClipboardProbe(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) await flushClipboardCopy()
}

function oscContent(sequence: string): string {
  const withoutPrefix = sequence.startsWith('\x1b]')
    ? sequence.slice(2)
    : sequence

  if (withoutPrefix.endsWith('\x1b\\')) return withoutPrefix.slice(0, -2)
  if (withoutPrefix.endsWith('\x07')) return withoutPrefix.slice(0, -1)
  return withoutPrefix
}

describe('osc coverage swarm row 063', () => {
  beforeEach(() => {
    vi.resetModules()
    installOscMocks()
    envMock.terminal = 'xterm'
    execFileNoThrowMock.mockReset()
    execFileNoThrowMock.mockResolvedValue(successfulExecResult())
    process.env = { ...originalEnv }
    delete process.env['LC_TERMINAL']
    delete process.env['SSH_CONNECTION']
    delete process.env['STY']
    delete process.env['TMUX']
    setPlatform('linux')
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    setPlatform(originalPlatform)
    vi.doUnmock('../../../src/utils/env.js')
    vi.doUnmock('../../../src/utils/execFileNoThrow.js')
    vi.resetModules()
    vi.clearAllMocks()
  })

  test('formats OSC terminators and parses title and hyperlink branches', async () => {
    const { OSC, osc, parseOSC } = await importFreshOscModule()

    expect(osc(OSC.SET_TITLE, 'plain')).toBe(`\x1b]${OSC.SET_TITLE};plain\x07`)

    envMock.terminal = 'kitty'
    expect(osc(OSC.SET_TITLE, 'kitty')).toBe(
      `\x1b]${OSC.SET_TITLE};kitty\x1b\\`,
    )

    expect(parseOSC(`${OSC.SET_TITLE_AND_ICON};both`)).toEqual({
      type: 'title',
      action: { type: 'both', title: 'both' },
    })
    expect(parseOSC(`${OSC.SET_ICON};icon`)).toEqual({
      type: 'title',
      action: { type: 'iconName', name: 'icon' },
    })
    expect(parseOSC(`${OSC.SET_TITLE};window`)).toEqual({
      type: 'title',
      action: { type: 'windowTitle', title: 'window' },
    })
    expect(parseOSC(`${OSC.HYPERLINK};;https://example.test/a;b`)).toEqual({
      type: 'link',
      action: {
        type: 'start',
        url: 'https://example.test/a;b',
        params: undefined,
      },
    })
    expect(
      parseOSC(`${OSC.HYPERLINK};id=abc:ignored:rel=help;https://example.test`),
    ).toEqual({
      type: 'link',
      action: {
        type: 'start',
        url: 'https://example.test',
        params: { id: 'abc', rel: 'help' },
      },
    })
    expect(parseOSC(`${OSC.HYPERLINK};;`)).toEqual({
      type: 'link',
      action: { type: 'end' },
    })
    expect(parseOSC('not-a-command')).toEqual({
      type: 'unknown',
      sequence: '\x1b]not-a-command',
    })
  })

  test('parses tab-status colors and generates status and link outputs', async () => {
    const {
      LINK_END,
      OSC,
      link,
      parseOSC,
      parseOscColor,
      supportsTabStatus,
      tabStatus,
    } = await importFreshOscModule()

    expect(parseOscColor('#Aa10ff')).toEqual({
      type: 'rgb',
      r: 170,
      g: 16,
      b: 255,
    })
    expect(parseOscColor('rgb:0000/8000/ffff')).toEqual({
      type: 'rgb',
      r: 0,
      g: 128,
      b: 255,
    })
    expect(parseOscColor('rgb:ffff/zz/0')).toBeNull()
    expect(
      parseOSC(
        `${OSC.TAB_STATUS};status;indicator=bogus;status-color=rgb:zz/0/0`,
      ),
    ).toEqual({
      type: 'tabStatus',
      action: {
        status: null,
        indicator: null,
        statusColor: null,
      },
    })

    expect(tabStatus({})).toBe(`\x1b]${OSC.TAB_STATUS};\x07`)
    expect(
      tabStatus({
        indicator: { type: 'default' },
        statusColor: { type: 'indexed', index: 4 },
      }),
    ).toBe(`\x1b]${OSC.TAB_STATUS};indicator=;status-color=\x07`)
    expect(link('')).toBe(LINK_END)
    expect(link('https://agenc.test/docs', { id: 'manual', title: 'Docs' })).toBe(
      '\x1b]8;id=manual:title=Docs;https://agenc.test/docs\x07',
    )
    expect(parseOSC(oscContent(link('https://agenc.test/auto')))).toEqual({
      type: 'link',
      action: {
        type: 'start',
        url: 'https://agenc.test/auto',
        params: { id: expect.any(String) },
      },
    })
    expect(supportsTabStatus()).toBe(false)
  })

  test('selects clipboard paths and falls back when tmux buffer loading fails', async () => {
    const {
      OSC,
      getClipboardPath,
      setClipboard,
      tmuxLoadBuffer,
      wrapForMultiplexer,
    } = await importFreshOscModule()

    expect(getClipboardPath()).toBe('osc52')
    expect(wrapForMultiplexer('raw')).toBe('raw')
    expect(await tmuxLoadBuffer('outside')).toBe(false)
    expect(execFileNoThrowMock).not.toHaveBeenCalled()

    process.env['TMUX'] = '/tmp/tmux-1000/default,123,0'
    execFileNoThrowMock.mockResolvedValueOnce(failedExecResult())

    expect(await tmuxLoadBuffer('inside')).toBe(false)
    expect(execFileNoThrowMock).toHaveBeenLastCalledWith(
      'tmux',
      ['load-buffer', '-w', '-'],
      {
        input: 'inside',
        timeout: 2000,
        useCwd: false,
      },
    )

    process.env['SSH_CONNECTION'] = 'client server'
    execFileNoThrowMock.mockReset()
    execFileNoThrowMock.mockResolvedValueOnce(failedExecResult())

    const text = 'tmux fallback'
    const sequence = await setClipboard(text)

    expect(sequence).toBe(
      `\x1b]${OSC.CLIPBOARD};c;${Buffer.from(text, 'utf8').toString('base64')}\x07`,
    )
    expect(execFileNoThrowMock).toHaveBeenCalledTimes(1)
  })

  test('caches linux clipboard probes for wl-copy, xsel, and missing tools', async () => {
    const { _resetLinuxCopyCache, setClipboard } = await importFreshOscModule()

    _resetLinuxCopyCache()
    await setClipboard('wayland')
    expect(await waitForExecCall('wl-copy')).toEqual([
      'wl-copy',
      [],
      { input: 'wayland', timeout: 2000, useCwd: false },
    ])
    await settleClipboardProbe()

    execFileNoThrowMock.mockClear()
    await setClipboard('cached wayland')
    expect(execFileNoThrowMock.mock.calls).toEqual([
      [
        'wl-copy',
        [],
        { input: 'cached wayland', timeout: 2000, useCwd: false },
      ],
    ])

    _resetLinuxCopyCache()
    execFileNoThrowMock.mockReset()
    execFileNoThrowMock
      .mockResolvedValueOnce(failedExecResult())
      .mockResolvedValueOnce(failedExecResult())
      .mockResolvedValueOnce(successfulExecResult())
      .mockResolvedValue(successfulExecResult())

    await setClipboard('xsel probe')
    expect(await waitForExecCall('xsel')).toEqual([
      'xsel',
      ['--clipboard', '--input'],
      { input: 'xsel probe', timeout: 2000, useCwd: false },
    ])
    await settleClipboardProbe()

    execFileNoThrowMock.mockClear()
    await setClipboard('cached xsel')
    expect(execFileNoThrowMock.mock.calls).toEqual([
      [
        'xsel',
        ['--clipboard', '--input'],
        { input: 'cached xsel', timeout: 2000, useCwd: false },
      ],
    ])

    _resetLinuxCopyCache()
    execFileNoThrowMock.mockReset()
    execFileNoThrowMock.mockResolvedValue(failedExecResult())

    await setClipboard('missing tools')
    expect(await waitForExecCall('xsel')).toEqual([
      'xsel',
      ['--clipboard', '--input'],
      { input: 'missing tools', timeout: 2000, useCwd: false },
    ])
    await settleClipboardProbe()

    execFileNoThrowMock.mockClear()
    await setClipboard('still missing')
    expect(execFileNoThrowMock).not.toHaveBeenCalled()
  })
})
