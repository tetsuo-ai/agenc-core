import { describe, expect, test } from 'bun:test'
import { join } from 'path'

import { isAgenCConfigPath } from '../../src/utils/permissions/filesystem.ts'
import { getValidationTip } from '../../src/utils/settings/validationTips.ts'

describe('AgenC config path surfaces', () => {
  test('isAgenCConfigPath recognizes canonical config files in any project', () => {
    expect(
      isAgenCConfigPath(
        join(process.cwd(), '.agenc', 'config.toml'),
      ),
    ).toBe(true)

    expect(
      isAgenCConfigPath(
        join(process.cwd(), '..', 'other-project', '.agenc', 'config.local.toml'),
      ),
    ).toBe(true)
  })

  test('legacy JSON migration inputs are protected but unrelated files are not', () => {
    expect(
      isAgenCConfigPath(
        join(process.cwd(), '..', 'other-project', '.agenc', 'settings.json'),
      ),
    ).toBe(true)
    expect(
      isAgenCConfigPath(
        join(process.cwd(), '..', 'other-project', '.agenc', 'unrelated.json'),
      ),
    ).toBe(false)
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
