import { describe, expect, it } from 'vitest'

import {
  getPromptInputProactiveNextTickAt,
  isPromptInputProactiveActive,
  subscribeToPromptInputProactiveChanges,
} from './proactiveAdapter.js'

describe('PromptInput proactive adapter', () => {
  it('does not throw when optional proactive modules are absent', () => {
    expect(() => isPromptInputProactiveActive()).not.toThrow()
    expect(() => getPromptInputProactiveNextTickAt()).not.toThrow()
    expect(() => subscribeToPromptInputProactiveChanges(() => {})).not.toThrow()
  })

  it('falls back to inactive no-op behavior without the optional module', () => {
    const unsubscribe = subscribeToPromptInputProactiveChanges(() => {})

    expect(isPromptInputProactiveActive()).toBe(false)
    expect(getPromptInputProactiveNextTickAt()).toBeNull()
    expect(() => unsubscribe()).not.toThrow()
  })
})
