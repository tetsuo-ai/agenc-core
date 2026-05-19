import { describe, expect, test } from 'bun:test'
import { join } from 'path'

import { isAgenCSettingsPath } from './permissions/filesystem.ts'
import { getValidationTip } from './settings/validationTips.ts'

describe('AgenC settings path surfaces', () => {
  test('isAgenCSettingsPath recognizes project .agenc settings files', () => {
    expect(
      isAgenCSettingsPath(
        join(process.cwd(), '.agenc', 'settings.json'),
      ),
    ).toBe(true)

    expect(
      isAgenCSettingsPath(
        join(process.cwd(), '.agenc', 'settings.local.json'),
      ),
    ).toBe(true)
  })

})

describe('AgenC validation tips', () => {
  test('permissions.defaultMode invalid value keeps suggestion but no AgenC docs link', () => {
    const tip = getValidationTip({
      path: 'permissions.defaultMode',
      code: 'invalid_value',
      enumValues: [
        'acceptEdits',
        'bypassPermissions',
        'default',
        'dontAsk',
        'plan',
      ],
    })

    expect(tip).toEqual({
      suggestion:
        'Valid modes: "acceptEdits" (ask before file changes), "plan" (analysis only), "bypassPermissions" (auto-accept all), or "default" (standard behavior)',
    })
  })
})
