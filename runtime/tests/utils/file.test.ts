import { describe, expect, test } from 'bun:test'

import { addLineNumbers, stripLineNumberPrefix } from '../../src/utils/file.js'

describe('addLineNumbers', () => {
  test('uses the unambiguous arrow compact prefix and preserves leading tabs', () => {
    expect(
      addLineNumbers({ content: '\tfirst\n\t\tsecond', startLine: 41 }),
    ).toBe('41→\tfirst\n42→\t\tsecond')
  })

  test('always uses the compact prefix — never left-pads the line number', () => {
    // The GrowthBook-gated padded-arrow fallback was removed, so even small
    // line numbers stay compact instead of padding out to six columns.
    expect(addLineNumbers({ content: 'alpha\nbeta', startLine: 1 })).toBe(
      '1→alpha\n2→beta',
    )
  })

  test('returns an empty string for empty content', () => {
    expect(addLineNumbers({ content: '', startLine: 1 })).toBe('')
  })
})

describe('stripLineNumberPrefix', () => {
  test('strips compact arrow, legacy padded arrow, and legacy tab prefixes', () => {
    // The padded + tab prefixes must still round-trip: older sessions/files on
    // disk were written before the format was unified to the compact arrow.
    expect(stripLineNumberPrefix('41→\tfirst')).toBe('\tfirst')
    expect(stripLineNumberPrefix('     2→beta')).toBe('beta')
    expect(stripLineNumberPrefix('7\t\tlegacy-tab')).toBe('\tlegacy-tab')
  })
})
