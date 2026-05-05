import type { MarketplaceSource } from "./marketplace.js";

export const AGENC_OFFICIAL_MARKETPLACE_NAME = "agenc-official";

export const AGENC_OFFICIAL_MARKETPLACE_SOURCE = {
  source: "git",
  url: "https://agenc.tech/plugins/official.git",
} as const satisfies MarketplaceSource;
