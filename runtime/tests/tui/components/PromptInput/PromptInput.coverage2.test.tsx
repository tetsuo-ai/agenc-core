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
import { applyBusyInputSubmissionPolicy } from './PromptInput.js'

describe('PromptInput busy bash coverage', () => {
  afterEach(() => {
    resetCommandQueue()
  })

  test('swallows empty bash submissions while busy without queueing or clearing input state', () => {
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
        input: ' \n\t ',
        addNotification,
        setInput,
        setCursorOffset,
        clearBuffer,
        resetHistory,
        onModeChange,
      }),
    ).toBe(true)

    expect(getCommandQueue()).toEqual([])
    expect(addNotification).not.toHaveBeenCalled()
    expect(setInput).not.toHaveBeenCalled()
    expect(setCursorOffset).not.toHaveBeenCalled()
    expect(clearBuffer).not.toHaveBeenCalled()
    expect(resetHistory).not.toHaveBeenCalled()
    expect(onModeChange).not.toHaveBeenCalled()
  })
})
