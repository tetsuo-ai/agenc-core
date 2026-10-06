import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'

import { formatZodError } from 'src/utils/settings/validation.js'
import { getValidationTip } from 'src/utils/settings/validationTips.js'
import { validatePermissionsConfig } from '../../src/config/schema.js'
import { parseRuleString, serializeRuleValue } from '../../src/permissions/rules.js'
import { PermissionRuleSchema, validatePermissionRule } from '../../src/utils/settings/permissionValidation.js'

describe('permission array validation guidance', () => {
  it.each(['allow', 'deny'] as const)('prints valid %s rule examples', (behavior) => {
    const tip = getValidationTip({
      path: `permissions.${behavior}`,
      code: 'invalid_type',
      expected: 'array',
      received: 'string',
    })
    const arrays = [...tip!.suggestion!.matchAll(/\[[^\]]+\]/g)]
    expect(arrays.length).toBeGreaterThan(0)
    for (const [array] of arrays) {
      const examples: string[] = JSON.parse(array)
      expect(examples.length).toBeGreaterThan(0)
      for (const rule of examples) {
        const parsed = parseRuleString(rule)
        expect(parsed, rule).not.toBeNull()
        expect(serializeRuleValue(parsed!), rule).toBe(rule)
        expect(validatePermissionRule(rule), rule).toEqual({ valid: true })
      }
      expect(validatePermissionsConfig({ [behavior]: examples })![behavior])
        .toEqual(examples)
    }
  })
})

describe('permission rule validation guidance', () => {
  it.each([
    'system.bash(npm:* run)',
    'exec_command(npm:* run)',
    'system.bash(:*)',
    'exec_command(:*)',
    'FileRead()',
    'web_fetch()',
    'FileRead(src:*)',
    'FileRead(fi*le)',
    'mcp__server__tool(pattern)',
    'WebSearch(typescript*)',
    'web_fetch(https://example.com)',
    'web_fetch(example.com)',
  ])('prints valid correction examples for %s', (invalidRule) => {
    const result = PermissionRuleSchema().safeParse(invalidRule)
    expect(result.success).toBe(false)
    if (result.success) return
    const examplesText = result.error.issues[0]!.message.split('Examples: ')[1]
    expect(examplesText).toBeDefined()
    const examples = examplesText!.split(', ').map(example => example.split(' - ')[0]!)
    expect(examples.length).toBeGreaterThan(0)
    for (const rule of examples) {
      const parsed = parseRuleString(rule)
      expect(parsed, rule).not.toBeNull()
      expect(serializeRuleValue(parsed!), rule).toBe(rule)
      expect(validatePermissionRule(rule), rule).toEqual({ valid: true })
    }
    expect(validatePermissionsConfig({ allow: examples })!.allow).toEqual(examples)
  })

  it.each(['Read()', 'Bash()'])('does not recommend removed names for %s', (rule) => {
    expect(validatePermissionRule(rule)).toMatchObject({
      valid: false,
      error: 'Empty parentheses',
      suggestion: 'Use the canonical tool name or run agenc config migrate',
    })
    expect(validatePermissionRule(rule).examples).toBeUndefined()
  })
})

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
