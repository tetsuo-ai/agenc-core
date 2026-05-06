import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  processUserInput: vi.fn(async () => ({
    messages: [],
    shouldQuery: false,
  })),
}))

vi.mock('src/services/analytics/index.js', () => ({
  logEvent: vi.fn(),
}))

vi.mock('src/utils/debug.js', () => ({
  logForDebugging: () => {},
}))

vi.mock('../tui/input/processUserInput.js', () => ({
  processUserInput: mocks.processUserInput,
}))

describe('handlePromptSubmit vim routing state', () => {
  test('threads vim routing state into the real input dispatch path', async () => {
    const { handlePromptSubmit } = await import('./handlePromptSubmit.js')
    const reserve = vi.fn()
    const cancelReservation = vi.fn()
    const setToolJSX = vi.fn()

    await handlePromptSubmit({
      input: 'alpha',
      mode: 'prompt',
      pastedContents: {},
      helpers: {
        clearBuffer: vi.fn(),
        resetHistory: vi.fn(),
        setCursorOffset: vi.fn(),
      },
      onInputChange: vi.fn(),
      setPastedContents: vi.fn(),
      queryGuard: {
        isActive: false,
        reserve,
        cancelReservation,
      } as never,
      commands: [],
      messages: [],
      mainLoopModel: 'gpt-5',
      ideSelection: undefined,
      querySource: 'repl' as never,
      setToolJSX,
      getToolUseContext: () =>
        ({
          getAppState: () => ({
            toolPermissionContext: { mode: 'default' },
          }),
        }) as never,
      setUserInputOnProcessing: vi.fn(),
      setAbortController: vi.fn(),
      onQuery: vi.fn(),
      setAppState: vi.fn(),
      vimRoutingState: {
        enabled: true,
        mode: 'NORMAL',
        keys: ['x'],
      },
    })

    expect(reserve).toHaveBeenCalled()
    expect(mocks.processUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'alpha',
        mode: 'prompt',
        vimRoutingState: {
          enabled: true,
          mode: 'NORMAL',
          keys: ['x'],
        },
      }),
    )
    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({
        clearLocalJSX: true,
      }),
    )
    expect(cancelReservation).toHaveBeenCalled()
  })
})
