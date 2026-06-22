import { describe, expect, it } from 'vitest'
import type {
  Location,
  LocationLink,
  Range,
  SymbolInformation,
} from 'vscode-languageserver-types'

import {
  partitionValidLocations,
  partitionValidSymbolInformation,
  toLocation,
} from '../../../src/tools/LSPTool/locations.js'

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

  it('partitions locations by usable URI', () => {
    const first: Location = {
      uri: 'file:///repo/src/one.ts',
      range: targetRange,
    }
    const second: Location = {
      uri: 'file:///repo/src/two.ts',
      range: selectionRange,
    }

    expect(
      partitionValidLocations([
        first,
        null,
        { uri: '', range: targetRange },
        undefined,
        second,
      ]),
    ).toEqual({
      validLocations: [first, second],
      invalidLocationCount: 3,
    })
  })

  it('partitions symbol information by usable location URI', () => {
    const symbol: SymbolInformation = {
      name: 'example',
      kind: 12,
      location: {
        uri: 'file:///repo/src/file.ts',
        range: targetRange,
      },
    }

    expect(
      partitionValidSymbolInformation([
        symbol,
        null,
        { ...symbol, location: { uri: '', range: selectionRange } },
        undefined,
      ]),
    ).toEqual({
      validSymbols: [symbol],
      invalidSymbolCount: 3,
    })
  })
})
