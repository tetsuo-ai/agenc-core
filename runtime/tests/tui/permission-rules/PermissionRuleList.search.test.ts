import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { sourceUrl } from '../../helpers/source-path.ts'

import {
  getPermissionRuleListAddLabel,
  getPermissionRuleListFooterText,
  getPermissionRuleSearchSeed,
} from './PermissionRuleList.js'

const source = readFileSync(
  sourceUrl('tui/permission-rules/PermissionRuleList.tsx'),
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

describe('permission rule list glyph fallbacks', () => {
  const asciiEnv = { AGENC_TUI_GLYPHS: 'ascii' }

  test('uses ASCII ellipsis for the add-row label', () => {
    expect(getPermissionRuleListAddLabel(asciiEnv)).toBe('Add a new rule...')
  })

  test('uses ASCII arrows and separators for footer help', () => {
    const output = getPermissionRuleListFooterText({
      defaultTab: 'allow',
      exitKeyName: 'Esc',
      exitPending: false,
      hasDenials: false,
      headerFocused: false,
      isSearchMode: false,
    }, asciiEnv)

    expect(output).toBe('^/v navigate - Enter select - Type to search - </> switch - Esc cancel')
    expect(output).not.toMatch(/[←→↑↓·…]/)
  })

  test('keeps search and header footer states ASCII-safe', () => {
    expect(getPermissionRuleListFooterText({
      defaultTab: 'allow',
      exitKeyName: 'Esc',
      exitPending: false,
      hasDenials: false,
      headerFocused: true,
      isSearchMode: false,
    }, asciiEnv)).toBe('</> tab switch - v return - Esc cancel')

    expect(getPermissionRuleListFooterText({
      defaultTab: 'allow',
      exitKeyName: 'Esc',
      exitPending: false,
      hasDenials: false,
      headerFocused: false,
      isSearchMode: true,
    }, asciiEnv)).toBe('Type to filter - Enter/v select - ^ tabs - Esc clear')
  })
})
