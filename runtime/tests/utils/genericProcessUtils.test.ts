import { describe, expect, it } from 'vitest'

import { parsePidList } from '../../src/utils/genericProcessUtils.js'

describe('parsePidList', () => {
  it('parses newline and comma separated PID output', () => {
    expect(parsePidList('123\n456,789\r\n')).toEqual([123, 456, 789])
  })

  it('trims whitespace and skips invalid tokens', () => {
    expect(parsePidList(' 12 \n nope \n 34abc \n , 56 ')).toEqual([
      12,
      34,
      56,
    ])
  })

  it('returns an empty list for blank output', () => {
    expect(parsePidList('\n \t')).toEqual([])
  })
})
