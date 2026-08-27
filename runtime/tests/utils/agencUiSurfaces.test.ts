import { describe, expect, test } from 'bun:test'
import { join } from 'path'

import {
  checkPathSafetyForAutoEdit,
  isAgenCConfigPath,
} from '../../src/utils/permissions/filesystem.ts'
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

  test('retired command roots are ordinary paths while live skill roots stay protected', () => {
    const retiredCommand = join(
      process.cwd(),
      '.agenc',
      'commands',
      'review.md',
    )
    const retiredAgentCommand = join(
      process.cwd(),
      '.agents',
      'commands',
      'review.md',
    )
    const liveSkill = join(
      process.cwd(),
      '.agenc',
      'skills',
      'review',
      'SKILL.md',
    )

    expect(isAgenCConfigPath(retiredCommand)).toBe(false)
    expect(checkPathSafetyForAutoEdit(retiredCommand, [retiredCommand]))
      .toEqual({ safe: true })
    expect(isAgenCConfigPath(retiredAgentCommand)).toBe(false)
    expect(
      checkPathSafetyForAutoEdit(retiredAgentCommand, [retiredAgentCommand]),
    ).toEqual({ safe: true })
    expect(checkPathSafetyForAutoEdit(liveSkill, [liveSkill]))
      .toMatchObject({ safe: false })
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
