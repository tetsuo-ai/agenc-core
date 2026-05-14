import { describe, expect, it } from 'vitest'

import { getApiKeyApprovalPreview } from './ApproveApiKey.js'

describe('ApproveApiKey provider-neutral display', () => {
  it('formats the stored key tail without provider-specific env names or prefixes', () => {
    const preview = getApiKeyApprovalPreview('abcdefghijklmnopqrst')

    expect(preview).toBe('...abcdefghijklmnopqrst')
    expect(preview).not.toContain('sk-ant')
    expect(preview).not.toContain('ANTHROPIC_API_KEY')
  })
})
