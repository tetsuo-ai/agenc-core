import { describe, expect, test, vi } from 'vitest'

import { requestTuiSessionTurnCancel } from '../../src/tui/sessionCancel.js'

describe('requestTuiSessionTurnCancel', () => {
  test('prefers daemon cancelActiveTurn when available', () => {
    const cancelActiveTurn = vi.fn()
    const abortAllTasks = vi.fn()

    requestTuiSessionTurnCancel({ cancelActiveTurn, abortAllTasks })

    expect(cancelActiveTurn).toHaveBeenCalledWith('interrupted')
    expect(abortAllTasks).not.toHaveBeenCalled()
  })

  test('falls back to abortAllTasks for direct runtime sessions', () => {
    const abortAllTasks = vi.fn()

    requestTuiSessionTurnCancel({ abortAllTasks })

    expect(abortAllTasks).toHaveBeenCalledWith('interrupted')
  })

  test('swallows asynchronous cancellation failures', async () => {
    const cancelActiveTurn = vi.fn(async () => {
      throw new Error('socket closed')
    })

    requestTuiSessionTurnCancel({ cancelActiveTurn })
    await Promise.resolve()

    expect(cancelActiveTurn).toHaveBeenCalledWith('interrupted')
  })
})
