import { expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  terminal: 'first', value: { unrelated: 'keep' } as Record<string, unknown>, writes: 0,
}))
vi.mock('../../src/utils/envDynamic.js', () => ({ envDynamic: { get terminal() { return state.terminal } } }))
vi.mock('../../src/utils/config.js', () => ({
  getRuntimeState: () => state.value,
  updateRuntimeState: (update: (value: typeof state.value) => typeof state.value) => {
    state.writes++
    state.value = update(state.value)
  },
}))
vi.mock('../../src/tui/components/IdeOnboardingDialog.js', () => { throw new Error('UI must stay deferred') })

test('keeps terminal-specific onboarding state in the existing store without loading UI', async () => {
  const { hasIdeOnboardingDialogBeenShown, markDialogAsShown } = await import('../../src/utils/ideOnboardingState.js')
  expect(hasIdeOnboardingDialogBeenShown()).toBe(false)
  markDialogAsShown()
  expect(hasIdeOnboardingDialogBeenShown()).toBe(true)
  const same = state.value
  markDialogAsShown()
  expect(state.value).toBe(same)
  state.terminal = 'second'
  expect(hasIdeOnboardingDialogBeenShown()).toBe(false)
  markDialogAsShown()
  state.terminal = ''
  expect(hasIdeOnboardingDialogBeenShown()).toBe(false)
  markDialogAsShown()
  expect(state.value).toEqual({ unrelated: 'keep', hasIdeOnboardingBeenShown: {
    first: true, second: true, unknown: true,
  } })
  expect(state.writes).toBe(4)
})
