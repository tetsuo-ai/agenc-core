import { describe, expect, test } from 'vitest'

import {
  HASH_CHANNEL_RE,
  HAS_AT_SYMBOL_RE,
  extractCompletionToken,
  extractSearchToken,
} from '../hooks/typeaheadTokens.js'

describe('typeaheadTokens coverage swarm row 191', () => {
  test('returns null for empty input and cursor-only whitespace', () => {
    expect(extractCompletionToken('', 0, true)).toBeNull()
    expect(extractCompletionToken('   ', 3, false)).toBeNull()
  })

  test('extends quoted @ tokens across the cursor through the closing quote', () => {
    const text = 'attach @"folder name/file.md" after'
    const cursor = 'attach @"folder'.length

    expect(extractCompletionToken(text, cursor, true)).toEqual({
      token: '@"folder name/file.md"',
      startPos: 'attach '.length,
      isQuoted: true,
    })
  })

  test('keeps unterminated quoted @ tokens searchable without a trailing quote', () => {
    const token = extractCompletionToken('open @"folder name', 'open @"folder name'.length, true)

    expect(token).toEqual({
      token: '@"folder name',
      startPos: 'open '.length,
      isQuoted: true,
    })
    expect(extractSearchToken(token!)).toBe('folder name')
  })

  test('falls back to the plain suffix when an @ token contains an invalid path char', () => {
    const text = 'open @bad?tail'

    expect(extractCompletionToken(text, text.length, true)).toEqual({
      token: 'tail',
      startPos: 'open @bad?'.length,
      isQuoted: false,
    })
  })

  test('uses plain-token extraction when @ matching is enabled but no @ is present', () => {
    const text = 'open src/components/Button.tsx'
    const cursor = 'open src/components'.length

    expect(extractCompletionToken(text, cursor, true)).toEqual({
      token: 'src/components/Button.tsx',
      startPos: 'open '.length,
      isQuoted: false,
    })
  })

  test('does not extend @ token suffixes across punctuation after the cursor', () => {
    const text = 'see @src, then continue'
    const cursor = 'see @src'.length

    expect(extractCompletionToken(text, cursor, true)).toEqual({
      token: '@src',
      startPos: 'see '.length,
      isQuoted: false,
    })
  })

  test('extracts search text from at-prefixed and plain tokens', () => {
    expect(extractSearchToken({ token: '@/tmp/file.ts' })).toBe('/tmp/file.ts')
    expect(extractSearchToken({ token: 'src/hooks' })).toBe('src/hooks')
    expect(extractSearchToken({ token: '@"src/with space"', isQuoted: true })).toBe(
      'src/with space',
    )
  })

  test('matches trailing @ mentions and hash channels only at supported boundaries', () => {
    expect('send @src/hooks'.match(HAS_AT_SYMBOL_RE)?.[2]).toBe('src/hooks')
    expect('send @"src/with space"'.match(HAS_AT_SYMBOL_RE)?.[2]).toBe(
      '"src/with space"',
    )
    expect('send #team_updates'.match(HASH_CHANNEL_RE)?.[2]).toBe('team_updates')
    expect('send #Team'.match(HASH_CHANNEL_RE)).toBeNull()
  })
})
