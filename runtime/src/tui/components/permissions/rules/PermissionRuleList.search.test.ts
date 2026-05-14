import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import { getPermissionRuleSearchSeed } from './PermissionRuleList.js'

const source = readFileSync(
  new URL('./PermissionRuleList.tsx', import.meta.url),
  'utf8',
)

describe('permission rule list search capture', () => {
  test('starts search for slash, digits, and normal printable keys', () => {
    expect(getPermissionRuleSearchSeed('/', {})).toBe('')
    expect(getPermissionRuleSearchSeed('1', {})).toBe('1')
    expect(getPermissionRuleSearchSeed('w', {})).toBe('w')
  })

  test('leaves rule-list command and modified keys available', () => {
    for (const reserved of ['j', 'k', 'm', 'i', 'r', ' ']) {
      expect(getPermissionRuleSearchSeed(reserved, {})).toBeNull()
    }
    expect(getPermissionRuleSearchSeed('w', { ctrl: true })).toBeNull()
    expect(getPermissionRuleSearchSeed('w', { meta: true })).toBeNull()
    expect(getPermissionRuleSearchSeed('down', {})).toBeNull()
  })

  test('prevents numeric select shortcuts from stealing type-to-search digits', () => {
    expect(source).toContain('disableSelection="numeric"')
  })
})
