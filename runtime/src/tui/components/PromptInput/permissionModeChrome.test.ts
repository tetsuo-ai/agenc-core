import { describe, expect, test } from 'vitest'

import {
  permissionModeFooterChrome,
  promptGlyphForPermissionMode,
} from './permissionModeChrome.js'

describe('permission mode chrome', () => {
  test('renders bypass permissions as an explicit YOLO footer chip', () => {
    expect(permissionModeFooterChrome('bypassPermissions')).toEqual({
      symbol: '!',
      label: 'YOLO',
      emphasize: true,
    })
  })

  test('uses a distinct prompt glyph for bypass permissions', () => {
    expect(promptGlyphForPermissionMode('bypassPermissions')).toBe('▶')
    expect(promptGlyphForPermissionMode('default')).toBe('❯')
  })

  test('keeps regular permission modes on the existing title path', () => {
    expect(permissionModeFooterChrome('acceptEdits')).toMatchObject({
      symbol: '⏵⏵',
      label: 'accept edits on',
      emphasize: false,
    })
  })
})
