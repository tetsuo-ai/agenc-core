import type { Location, LocationLink } from 'vscode-languageserver-types'

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
