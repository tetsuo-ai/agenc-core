import { describe, expect, test } from 'vitest'

import { expandTabs } from '../../../src/tui/ink/tabstops.js'

describe('tabstops coverage swarm row 061', () => {
  test('returns text without tabs unchanged', () => {
    expect(expandTabs('plain text\nwith ansi \x1b[31mred\x1b[39m')).toBe(
      'plain text\nwith ansi \x1b[31mred\x1b[39m',
    )
  })

  test('expands tabs to the next default eight-column stop', () => {
    expect(expandTabs('\tstart')).toBe('        start')
    expect(expandTabs('abc\tdef')).toBe('abc     def')
    expect(expandTabs('abcdefgh\tz')).toBe('abcdefgh        z')
    expect(expandTabs('a\tb\tc')).toBe('a       b       c')
  })

  test('resets the column after newlines', () => {
    expect(expandTabs('abcd\tX\nab\tY\n\tZ')).toBe(
      'abcd    X\nab      Y\n        Z',
    )
  })

  test('uses the provided tab interval', () => {
    expect(expandTabs('ab\tc', 4)).toBe('ab  c')
    expect(expandTabs('abcd\tc', 4)).toBe('abcd    c')
    expect(expandTabs('a\tb\nabc\tz', 3)).toBe('a  b\nabc   z')
  })

  test('preserves terminal sequences without advancing the column', () => {
    expect(expandTabs('ab\x1b[31m\tc\x1b[39m')).toBe(
      'ab\x1b[31m      c\x1b[39m',
    )
    expect(expandTabs('ab\x1b[31mcd\tz\x1b[39m')).toBe(
      'ab\x1b[31mcd    z\x1b[39m',
    )
  })

  test('counts wide characters by terminal display width', () => {
    expect(expandTabs('界\tz')).toBe('界      z')
    expect(expandTabs('a界\tz', 4)).toBe('a界 z')
  })
})
