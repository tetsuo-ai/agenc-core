import { describe, expect, it, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

describe('buildPlanApprovalOptions', () => {
  it('returns only local plan approval choices plus the keep-planning input', async () => {
    const { buildPlanApprovalOptions } = await import(
      './ExitPlanModePermissionRequest.js'
    )

    const options = buildPlanApprovalOptions({
      showClearContext: false,
      usedPercent: null,
      isAutoModeAvailable: false,
      isBypassPermissionsModeAvailable: false,
      onFeedbackChange: () => {},
    })

    expect(options.map(option => option.value)).toEqual([
      'yes-accept-edits-keep-context',
      'yes-default-keep-context',
      'no',
    ])
  })
})
