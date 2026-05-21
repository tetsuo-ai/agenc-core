import { describe, expect, test } from 'vitest'

import {
  generateProgressiveArgumentHint,
  parseArgumentNames,
  parseArguments,
  substituteArguments,
} from 'src/tui/slash/argument-substitution.js'

describe('argument substitution coverage edges', () => {
  test('parses blank input and filters non-string shell tokens', () => {
    expect(parseArguments('')).toEqual([])
    expect(parseArguments('   \t  ')).toEqual([])
    expect(parseArguments('build && test # trailing')).toEqual([
      'build',
      'test',
    ])
  })

  test('drops invalid argument-name shapes from frontmatter values', () => {
    expect(parseArgumentNames(undefined)).toEqual([])
    expect(parseArgumentNames(42 as never)).toEqual([])
    expect(parseArgumentNames('  topic   123 focus  ')).toEqual([
      'topic',
      'focus',
    ])
    expect(parseArgumentNames(['alpha', '', '007', 42 as never, 'omega']))
      .toEqual(['alpha', 'omega'])
  })

  test('renders all progressive hint names before any args are typed', () => {
    expect(generateProgressiveArgumentHint(['topic', 'focus'], [])).toBe(
      '[topic] [focus]',
    )
  })

  test('leaves content unchanged for null args and when append is disabled', () => {
    expect(
      substituteArguments(
        'Use $ARGUMENTS later',
        null as unknown as string | undefined,
      ),
    ).toBe('Use $ARGUMENTS later')

    expect(substituteArguments('Plain body', 'alpha beta', false)).toBe(
      'Plain body',
    )
    expect(substituteArguments('Plain body', '')).toBe('Plain body')
  })

  test('replaces placeholders with empty values for an explicit empty arg string', () => {
    expect(
      substituteArguments(
        'all=$ARGUMENTS first=$0 named=$topic',
        '',
        true,
        ['topic'],
      ),
    ).toBe('all= first= named=')
  })

  test('respects named and indexed placeholder boundaries', () => {
    expect(
      substituteArguments(
        '$topic $topic[0] $topicExtra one=$1 sticky=$1x missing=$ARGUMENTS[9]',
        'alpha beta',
        true,
        ['topic'],
      ),
    ).toBe('alpha $topic[0] $topicExtra one=beta sticky=$1x missing=')
  })

  test('skips empty argument-name entries while replacing later names', () => {
    expect(
      substituteArguments('$first/$second/$third', 'one two three', true, [
        'first',
        '',
        'third',
      ]),
    ).toBe('one/$second/three')
  })
})
