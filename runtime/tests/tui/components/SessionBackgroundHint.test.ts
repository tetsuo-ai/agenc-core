import { beforeEach, describe, expect, it, vi } from 'vitest'

const appStateMock = vi.hoisted(() => ({
  state: { tasks: {} as Record<string, unknown> },
  setAppState: vi.fn(),
}))

const taskMock = vi.hoisted(() => ({
  backgroundAll: vi.fn(),
  hasForegroundTasks: vi.fn(),
}))

const configMock = vi.hoisted(() => ({
  getGlobalConfig: vi.fn(),
  saveGlobalConfig: vi.fn(),
}))

vi.mock('../../tasks/LocalShellTask/LocalShellTask.js', () => taskMock)

vi.mock('../../utils/config.js', () => configMock)

describe('SessionBackgroundHint foreground task behavior', () => {
  beforeEach(() => {
    appStateMock.state = { tasks: {} }
    appStateMock.setAppState.mockClear()
    taskMock.backgroundAll.mockClear()
    taskMock.hasForegroundTasks.mockReset()
    configMock.getGlobalConfig.mockReset()
    configMock.saveGlobalConfig.mockClear()
  })

  it('activates Ctrl+B only when foreground tasks exist', async () => {
    const { shouldActivateSessionBackgroundShortcut } = await import(
      './SessionBackgroundHint.js'
    )

    expect(shouldActivateSessionBackgroundShortcut(false)).toBe(false)
    expect(shouldActivateSessionBackgroundShortcut(true)).toBe(true)
  })

  it('backgrounds foreground tasks and records first use', async () => {
    taskMock.hasForegroundTasks.mockReturnValue(true)
    configMock.getGlobalConfig.mockReturnValue({ hasUsedBackgroundTask: false })
    const { runSessionBackgroundShortcut } = await import(
      './SessionBackgroundHint.js'
    )

    const didBackground = runSessionBackgroundShortcut(
      () => appStateMock.state as never,
      appStateMock.setAppState as never,
      false,
    )

    expect(didBackground).toBe(true)
    expect(taskMock.backgroundAll).toHaveBeenCalledWith(
      expect.any(Function),
      appStateMock.setAppState,
    )
    expect(configMock.saveGlobalConfig).toHaveBeenCalledOnce()

    const updater = configMock.saveGlobalConfig.mock.calls[0]?.[0]
    expect(updater({ hasUsedBackgroundTask: false })).toEqual({
      hasUsedBackgroundTask: true,
    })
    const alreadyUsed = { hasUsedBackgroundTask: true }
    expect(updater(alreadyUsed)).toBe(alreadyUsed)
  })

  it('does not background when disabled or when no foreground task exists', async () => {
    const { runSessionBackgroundShortcut } = await import(
      './SessionBackgroundHint.js'
    )

    taskMock.hasForegroundTasks.mockReturnValue(true)
    expect(
      runSessionBackgroundShortcut(
        () => appStateMock.state as never,
        appStateMock.setAppState as never,
        true,
      ),
    ).toBe(false)
    expect(taskMock.backgroundAll).not.toHaveBeenCalled()

    taskMock.hasForegroundTasks.mockReturnValue(false)
    expect(
      runSessionBackgroundShortcut(
        () => appStateMock.state as never,
        appStateMock.setAppState as never,
        false,
      ),
    ).toBe(false)
    expect(taskMock.backgroundAll).not.toHaveBeenCalled()
  })
})
