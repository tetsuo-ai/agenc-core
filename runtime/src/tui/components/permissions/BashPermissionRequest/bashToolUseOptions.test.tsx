import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../utils/permissions/permissionsLoader.js', () => ({
  shouldShowAlwaysAllowOptions: () => true,
}))

describe('bashToolUseOptions', () => {
  it('does not expose the removed classifier-reviewed option', async () => {
    const { bashToolUseOptions } = await import('./bashToolUseOptions.js')

    const options = bashToolUseOptions({
      onRejectFeedbackChange: () => {},
      onAcceptFeedbackChange: () => {},
    })

    expect(options.map(option => option.value)).toEqual(['yes', 'no'])
    expect(options.map(option => option.value)).not.toContain(
      'yes-classifier-reviewed',
    )
  })
})
