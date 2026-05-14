import { describe, expect, test } from 'vitest'

import {
  CONSOLE_OAUTH_PASTE_PROMPT,
  getConsoleOAuthPasteLayout,
} from './ConsoleOAuthFlow.layout.js'

describe('getConsoleOAuthPasteLayout', () => {
  test('keeps the paste input inline when the terminal has room', () => {
    expect(getConsoleOAuthPasteLayout(120)).toEqual({
      flexDirection: 'row',
      inputColumns: 120 - 1 - CONSOLE_OAUTH_PASTE_PROMPT.length - 1,
    })
  })

  test('moves the paste input onto its own row in narrow terminals', () => {
    expect(getConsoleOAuthPasteLayout(30)).toEqual({
      flexDirection: 'column',
      inputColumns: 29,
    })
  })

  test('never returns zero or negative paste input width', () => {
    expect(getConsoleOAuthPasteLayout(0)).toEqual({
      flexDirection: 'column',
      inputColumns: 1,
    })
    expect(getConsoleOAuthPasteLayout(Number.NaN)).toEqual({
      flexDirection: 'column',
      inputColumns: 1,
    })
  })
})
