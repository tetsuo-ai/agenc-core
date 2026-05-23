import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { join } from 'node:path'

const originalEnv = { ...process.env }
const originalPlatform = process.platform
const mockedClipboardPath = join(process.cwd(), 'agenc-clipboard.txt')

const generateTempFilePathMock = vi.fn(() => mockedClipboardPath)

const execFileNoThrowMock = vi.fn(
  async () => ({ code: 0, stdout: '', stderr: '' }),
)
const logErrorMock = vi.fn()
const writeFileMock = vi.fn(async () => {})
const unlinkMock = vi.fn(async () => {})

function installOscMocks(): void {
  vi.doMock('../../../utils/execFileNoThrow.js', () => ({
    execFileNoThrow: execFileNoThrowMock,
    execFileNoThrowWithCwd: execFileNoThrowMock,
  }))

  vi.doMock('../../../utils/log.js', () => ({
    logError: logErrorMock,
  }))

  vi.doMock('node:fs/promises', () => ({
    unlink: unlinkMock,
    writeFile: writeFileMock,
  }))

  vi.doMock('../../../utils/tempfile.js', () => ({
    generateTempFilePath: generateTempFilePathMock,
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
  attempts = 20,
): Promise<(typeof execFileNoThrowMock.mock.calls)[number] | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const call = execFileNoThrowMock.mock.calls.find(([cmd]) => cmd === command)
    if (call) {
      return call
    }
    await flushClipboardCopy()
  }

  return undefined
}

describe('Windows clipboard fallback', () => {
  beforeEach(() => {
    vi.resetModules()
    installOscMocks()
    execFileNoThrowMock.mockClear()
    generateTempFilePathMock.mockClear()
    logErrorMock.mockClear()
    writeFileMock.mockClear()
    unlinkMock.mockClear()
    process.env = { ...originalEnv }
    delete process.env['SSH_CONNECTION']
    delete process.env['TMUX']
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  test('uses PowerShell instead of clip.exe for local Windows copy', async () => {
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('Привет мир')
    const windowsCall = await waitForExecCall('powershell')

    expect(execFileNoThrowMock.mock.calls.some(([cmd]) => cmd === 'clip')).toBe(
      false,
    )
    expect(windowsCall).toBeDefined()
  })

  test('passes Windows clipboard text through a UTF-8 temp file instead of stdin', async () => {
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('Привет мир')
    await flushClipboardCopy()

    const windowsCall = await waitForExecCall('powershell')

    expect(windowsCall?.[2]).toMatchObject({
      stdin: 'ignore',
    })
    expect(windowsCall?.[2]).not.toMatchObject({ input: 'Привет мир' })
    expect(windowsCall?.[2]).not.toMatchObject({
      env: expect.objectContaining({
        AGENC_CLIPBOARD_TEXT_B64: expect.any(String),
      }),
    })
    expect(windowsCall?.[1]).toContain(
      `$text = [System.IO.File]::ReadAllText('${mockedClipboardPath.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8); Set-Clipboard -Value $text`,
    )
  })

  test('logs Windows clipboard temp-file failures', async () => {
    const writeError = new Error('clipboard temp write failed')
    writeFileMock.mockRejectedValueOnce(writeError)
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('Привет мир')
    await flushClipboardCopy()

    expect(logErrorMock).toHaveBeenCalledWith(writeError)
  })

  test('logs Windows clipboard temp-file cleanup failures', async () => {
    const unlinkError = new Error('clipboard temp cleanup failed')
    unlinkMock.mockRejectedValueOnce(unlinkError)
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('Привет мир')
    await flushClipboardCopy()

    expect(logErrorMock).toHaveBeenCalledWith(unlinkError)
  })
})

describe('clipboard path behavior remains stable', () => {
  beforeEach(() => {
    vi.resetModules()
    installOscMocks()
    execFileNoThrowMock.mockClear()
    logErrorMock.mockClear()
    writeFileMock.mockClear()
    unlinkMock.mockClear()
    process.env = { ...originalEnv }
    delete process.env['SSH_CONNECTION']
    delete process.env['TMUX']
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  test('getClipboardPath stays native on local macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const { getClipboardPath } = await importFreshOscModule()

    expect(getClipboardPath()).toBe('native')
  })

  test('getClipboardPath stays tmux-buffer when TMUX is set', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env['TMUX'] = '/tmp/tmux-1000/default,123,0'
    const { getClipboardPath } = await importFreshOscModule()

    expect(getClipboardPath()).toBe('tmux-buffer')
  })

  test('Windows clipboard fallback is skipped over SSH', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env['SSH_CONNECTION'] = '1 2 3 4'
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('Привет мир')

    expect(execFileNoThrowMock.mock.calls.some(([cmd]) => cmd === 'powershell')).toBe(
      false,
    )
  })

  test('local macOS clipboard fallback still uses pbcopy', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('hello')

    expect(execFileNoThrowMock.mock.calls.some(([cmd]) => cmd === 'pbcopy')).toBe(
      true,
    )
  })

  test('local macOS clipboard fallback logs rejected native copy attempts', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const copyError = new Error('pbcopy rejected')
    execFileNoThrowMock.mockRejectedValueOnce(copyError)
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('hello')
    await flushClipboardCopy()

    expect(logErrorMock).toHaveBeenCalledWith(copyError)
  })

  test('local Linux clipboard probe logs rejected native copy attempts', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const probeError = new Error('wl-copy rejected')
    execFileNoThrowMock.mockRejectedValueOnce(probeError)
    const { _resetLinuxCopyCache, setClipboard } = await importFreshOscModule()

    _resetLinuxCopyCache()
    await setClipboard('hello')
    await flushClipboardCopy()

    expect(logErrorMock).toHaveBeenCalledWith(probeError)
  })
})
