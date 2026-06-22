import type {
  Location,
  LocationLink,
  SymbolInformation,
} from 'vscode-languageserver-types'

/**
 * Checks if item is LocationLink (has targetUri) vs Location (has uri)
 */
function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item
}

/**
 * Converts LocationLink to Location format for uniform handling
 */
function locationLinkToLocation(link: LocationLink): Location {
  return {
    uri: link.targetUri,
    range: link.targetSelectionRange || link.targetRange,
  }
}

export function toLocation(item: Location | LocationLink): Location {
  return isLocationLink(item) ? locationLinkToLocation(item) : item
}

function isValidLocation(location: Location | null | undefined): location is Location {
  return Boolean(location?.uri)
}

export function partitionValidLocations(
  locations: readonly (Location | null | undefined)[],
): {
  readonly validLocations: Location[]
  readonly invalidLocationCount: number
} {
  const validLocations = locations.filter(isValidLocation)
  return {
    validLocations,
    invalidLocationCount: locations.length - validLocations.length,
  }
}

function isValidSymbolInformation(
  symbol: SymbolInformation | null | undefined,
): symbol is SymbolInformation {
  return Boolean(symbol?.location?.uri)
}

export function partitionValidSymbolInformation(
  symbols: readonly (SymbolInformation | null | undefined)[],
): {
  readonly validSymbols: SymbolInformation[]
  readonly invalidSymbolCount: number
} {
  const validSymbols = symbols.filter(isValidSymbolInformation)
  return {
    validSymbols,
    invalidSymbolCount: symbols.length - validSymbols.length,
  }
}
