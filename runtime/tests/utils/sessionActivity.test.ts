import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerSessionActivityCallback,
  startSessionActivity,
  stopSessionActivity,
  unregisterSessionActivityCallback,
} from '../../src/utils/sessionActivity.js'

describe('sessionActivity heartbeat timer', () => {
  afterEach(() => {
    // Tear down callback + timers before clearing the refcount so no real
    // idle timer is left scheduled.
    unregisterSessionActivityCallback()
    stopSessionActivity('api_call')
    vi.restoreAllMocks()
  })

  it('unrefs the heartbeat interval so it does not keep the event loop alive', () => {
    const unref = vi.fn()
    const fakeTimer = { unref } as unknown as ReturnType<typeof setInterval>
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockReturnValue(fakeTimer)

    registerSessionActivityCallback(() => {})
    // refcount 0 -> 1 starts the heartbeat timer
    startSessionActivity('api_call')

    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    // Without the .unref() this assertion fails (revert-sensitive).
    expect(unref).toHaveBeenCalledTimes(1)
  })
})
