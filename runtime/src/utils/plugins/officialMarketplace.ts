/**
 * Constants for the official provider plugins marketplace.
 *
 * The official marketplace is hosted on GitHub and provides first-party
 * plugins developed by provider. This file defines the constants needed
 * to install and identify this marketplace.
 */

import { OFFICIAL_GITHUB_ORG, type MarketplaceSource } from './schemas.js'

/**
 * Display name for the official marketplace.
 * This is the name under which the marketplace will be registered
 * in the known_marketplaces.json file.
 */
export const OFFICIAL_MARKETPLACE_NAME = 'agenc-plugins-official'
export const OFFICIAL_MARKETPLACE_REPO =
  `${OFFICIAL_GITHUB_ORG}/${OFFICIAL_MARKETPLACE_NAME}` as const

/**
 * Source configuration for the official provider plugins marketplace.
 * Used when auto-installing the marketplace on startup.
 */
export const OFFICIAL_MARKETPLACE_SOURCE = {
  source: 'github',
  repo: OFFICIAL_MARKETPLACE_REPO,
} as const satisfies MarketplaceSource
