import { describe, expect, it } from 'vitest'
import type { Location, LocationLink, Range } from 'vscode-languageserver-types'

import { toLocation } from '../../../src/tools/LSPTool/locations.js'

const targetRange: Range = {
  start: { line: 3, character: 4 },
  end: { line: 3, character: 12 },
}

const selectionRange: Range = {
  start: { line: 3, character: 8 },
  end: { line: 3, character: 10 },
}

describe('LSP location helpers', () => {
  it('returns Location values unchanged', () => {
    const location: Location = {
      uri: 'file:///repo/src/file.ts',
      range: targetRange,
    }

    expect(toLocation(location)).toBe(location)
  })

  it('converts LocationLink values to target locations', () => {
    const link: LocationLink = {
      targetUri: 'file:///repo/src/file.ts',
      targetRange,
      targetSelectionRange: selectionRange,
    }

    expect(toLocation(link)).toEqual({
      uri: 'file:///repo/src/file.ts',
      range: selectionRange,
    })
  })

  it('falls back to targetRange when targetSelectionRange is missing', () => {
    const link = {
      targetUri: 'file:///repo/src/file.ts',
      targetRange,
    } as LocationLink

    expect(toLocation(link)).toEqual({
      uri: 'file:///repo/src/file.ts',
      range: targetRange,
    })
  })
})
