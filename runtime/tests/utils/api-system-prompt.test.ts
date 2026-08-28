import { beforeEach, describe, expect, test, vi } from 'vitest'

const cacheScope = vi.hoisted(() => ({ enabled: false }))

vi.mock('../../src/utils/betas.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/utils/betas.js')>()),
  shouldUseGlobalCacheScope: () => cacheScope.enabled,
}))

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../src/constants/prompts.js'
import { getCLISyspromptPrefix } from '../../src/constants/system.js'
import { splitSysPromptPrefix } from '../../src/utils/api.js'

describe('splitSysPromptPrefix', () => {
  const prefix = getCLISyspromptPrefix()

  beforeEach(() => {
    cacheScope.enabled = false
  })

  test('uses organization scope in default mode', () => {
    expect(splitSysPromptPrefix([prefix, 'static', 'dynamic'])).toEqual([
      { text: prefix, cacheScope: 'org' },
      { text: 'static\n\ndynamic', cacheScope: 'org' },
    ])
  })

  test('splits static and dynamic content at the global-cache boundary', () => {
    cacheScope.enabled = true

    expect(
      splitSysPromptPrefix([
        prefix,
        'static',
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
        'dynamic',
      ]),
    ).toEqual([
      { text: prefix, cacheScope: null },
      { text: 'static', cacheScope: 'global' },
      { text: 'dynamic', cacheScope: null },
    ])
  })

  test('omits the boundary when global caching is skipped', () => {
    cacheScope.enabled = true

    expect(
      splitSysPromptPrefix(
        [prefix, 'static', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'dynamic'],
        { skipGlobalCacheForSystemPrompt: true },
      ),
    ).toEqual([
      { text: prefix, cacheScope: 'org' },
      { text: 'static\n\ndynamic', cacheScope: 'org' },
    ])
  })
})
