import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'

import { formatZodError } from 'src/utils/settings/validation.js'
import { getValidationTip } from 'src/utils/settings/validationTips.js'

describe('formatZodError too_small handling', () => {
  it('keeps the "Number must be ..." phrasing for numeric origins', () => {
    const schema = z.number().min(5)
    const result = schema.safeParse(3)
    expect(result.success).toBe(false)
    if (result.success) return
    const [err] = formatZodError(result.error, 'settings')
    expect(err!.message).toBe('Number must be greater than or equal to 5')
  })

  it('preserves a schema author\'s custom message for array (non-number) origins', () => {
    // Regression: too_small was unconditionally rewritten to "Number must be
    // greater than or equal to N", discarding custom array messages and
    // mislabelling array origins as "Number".
    const schema = z.object({
      serverCommand: z
        .array(z.string())
        .min(1, 'Server command must have at least one element (the command)'),
    })
    const result = schema.safeParse({ serverCommand: [] })
    expect(result.success).toBe(false)
    if (result.success) return
    const [err] = formatZodError(result.error, 'settings')
    expect(err!.message).toBe(
      'Server command must have at least one element (the command)',
    )
    expect(err!.message).not.toContain('Number')
  })
})

describe('getValidationTip malformed-JSON matcher', () => {
  it('attaches the syntax-error suggestion for a null root (received as the string "null")', () => {
    // Regression: the matcher compared `received === null` (JS literal) but
    // formatZodError supplies the type-name string 'null', so the suggestion
    // was dead code.
    const tip = getValidationTip({
      path: '',
      code: 'invalid_type',
      expected: 'object',
      received: 'null',
    })
    expect(tip?.suggestion).toContain('missing commas')
  })

  it('does not attach the suggestion for a non-root path', () => {
    const tip = getValidationTip({
      path: 'permissions',
      code: 'invalid_type',
      expected: 'object',
      received: 'null',
    })
    expect(tip?.suggestion).toBeUndefined()
  })
})
