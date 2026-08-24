import { describe, expect, test } from 'bun:test'

import { validatePermissionsConfig } from '../../../src/config/schema.ts'

describe('canonical permissions.bypassPermissionsMode', () => {
  test('accepts the explicit allow and disable policies', () => {
    expect(validatePermissionsConfig({ bypassPermissionsMode: 'allow' }))
      .toEqual({ bypassPermissionsMode: 'allow' })
    expect(validatePermissionsConfig({ bypassPermissionsMode: 'disable' }))
      .toEqual({ bypassPermissionsMode: 'disable' })
  })

  test('rejects unknown values and removed aliases', () => {
    expect(() => validatePermissionsConfig({ bypassPermissionsMode: true }))
      .toThrow(/allow.*disable/u)
    expect(() => validatePermissionsConfig({ allowBypassPermissionsMode: true }))
      .toThrow(/unknown field/u)
    expect(() => validatePermissionsConfig({ disableBypassPermissionsMode: 'disable' }))
      .toThrow(/unknown field/u)
  })
})
