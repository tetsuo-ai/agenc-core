import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: () => ({}),
  saveGlobalConfig: () => {},
}))

vi.mock('../../history/history.js', () => ({
  formatImageRef: () => '',
  formatPastedTextRef: () => '',
  getPastedTextRefNumLines: () => 0,
  parseReferences: () => [],
}))

vi.mock('../../../utils/messageQueueManager.js', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/messageQueueManager.js')>(
    '../../../utils/messageQueueManager.js',
  )
  return actual
})

import {
  getCommandQueue,
  resetCommandQueue,
} from '../../../utils/messageQueueManager.js'
import {
  applyBusyInputSubmissionPolicy,
  calculatePromptMaxVisibleLines,
} from './PromptInput.js'

describe('PromptInput fullscreen layout budget', () => {
  test.each([
    [0, 1],
    [1, 1],
    [3, 2],
    [5, 2],
    [8, 2],
    [24, 7],
  ])('caps prompt input viewport to the bottom slot at terminal height %i', (rows, expected) => {
    expect(calculatePromptMaxVisibleLines(rows, true)).toBe(expected)
  })

  test('does not cap the prompt input viewport outside fullscreen', () => {
    expect(calculatePromptMaxVisibleLines(3, false)).toBeUndefined()
  })
})

describe('PromptInput busy input policy', () => {
  afterEach(() => {
    resetCommandQueue()
  })

  test('queues bash input for the next turn while the live TUI is busy', () => {
    const addNotification = vi.fn()
    const setInput = vi.fn()
    const setCursorOffset = vi.fn()
    const clearBuffer = vi.fn()
    const resetHistory = vi.fn()
    const onModeChange = vi.fn()

    expect(
      applyBusyInputSubmissionPolicy({
        isLoading: true,
        mode: 'bash',
        input: '  echo queued  ',
        addNotification,
        setInput,
        setCursorOffset,
        clearBuffer,
        resetHistory,
        onModeChange,
      }),
    ).toBe(true)

    expect(getCommandQueue()).toMatchObject([
      {
        value: 'echo queued',
        preExpansionValue: '!echo queued',
        mode: 'bash',
      },
    ])
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'busy-bash-queued',
        text: 'Bash command queued for next turn',
      }),
    )
    expect(setInput).toHaveBeenCalledWith('')
    expect(setCursorOffset).toHaveBeenCalledWith(0)
    expect(clearBuffer).toHaveBeenCalledTimes(1)
    expect(resetHistory).toHaveBeenCalledTimes(1)
    expect(onModeChange).toHaveBeenCalledWith('prompt')
  })

  test('preserves non-prompt input visibly while the live TUI is busy', () => {
    const addNotification = vi.fn()
    const setInput = vi.fn()

    expect(
      applyBusyInputSubmissionPolicy({
        isLoading: true,
        mode: 'orphaned-permission',
        input: 'message to agent',
        addNotification,
        setInput,
        setCursorOffset: vi.fn(),
        clearBuffer: vi.fn(),
        resetHistory: vi.fn(),
        onModeChange: vi.fn(),
      }),
    ).toBe(true)

    expect(getCommandQueue()).toEqual([])
    expect(setInput).not.toHaveBeenCalled()
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'busy-mode-preserved',
        text: 'orphaned-permission input is available after the current turn finishes',
      }),
    )
  })

  test('does not claim normal prompt input', () => {
    expect(
      applyBusyInputSubmissionPolicy({
        isLoading: true,
        mode: 'prompt',
        input: 'send to model',
        addNotification: vi.fn(),
        setInput: vi.fn(),
        setCursorOffset: vi.fn(),
        clearBuffer: vi.fn(),
        resetHistory: vi.fn(),
        onModeChange: vi.fn(),
      }),
    ).toBe(false)
  })
})
