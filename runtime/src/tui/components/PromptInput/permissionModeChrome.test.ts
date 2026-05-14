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

  test('uses ASCII prompt glyphs when requested', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' }

    expect(promptGlyphForPermissionMode('bypassPermissions', env)).toBe('>')
    expect(promptGlyphForPermissionMode('default', env)).toBe('>')
  })

  test('keeps regular permission modes on the existing title path', () => {
    expect(permissionModeFooterChrome('acceptEdits')).toMatchObject({
      symbol: '⏵⏵',
      label: 'accept edits on',
      emphasize: false,
    })
  })

  test('uses ASCII footer symbols when requested', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' }

    expect(permissionModeFooterChrome('plan', env).symbol).toBe('||')
    expect(permissionModeFooterChrome('acceptEdits', env).symbol).toBe('>>')
    expect(permissionModeFooterChrome('auto', env).symbol).toBe('>>')
    expect(permissionModeFooterChrome('unattended', env).symbol).toBe('>')
  })
})
