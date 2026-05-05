import { join } from "node:path";
import { resolveAgencHome } from "../../config/index.js";
import {
  readMarketplaceIndex,
  type MarketplaceOperationOptions,
} from "./marketplace.js";

export const INSTALLED_MARKETPLACES_DIR = "plugins/marketplaces";

export function marketplaceInstallRoot(
  agencHome: string,
): string {
  return join(agencHome, INSTALLED_MARKETPLACES_DIR);
}

export async function installedMarketplaceRootsFromIndex(
  options: MarketplaceOperationOptions = {},
): Promise<readonly string[]> {
  const index = await readMarketplaceIndex(options);
  return Object.values(index.marketplaces)
    .map((marketplace) =>
      marketplace.sourceType === "local"
        ? marketplace.sourceDescriptor.source === "file"
          ? marketplace.installedPath
          : marketplace.installedPath
        : marketplace.installedPath,
    )
    .sort((a, b) => a.localeCompare(b));
}

export async function installedMarketplaceRootsFromConfig(
  config: Readonly<Record<string, { readonly path?: string }>> | undefined,
  options: MarketplaceOperationOptions = {},
): Promise<readonly string[]> {
  const roots = new Set<string>(await installedMarketplaceRootsFromIndex(options));
  const agencHome = options.agencHome ?? resolveAgencHome(options.env);
  const defaultRoot = marketplaceInstallRoot(agencHome);
  for (const [marketplaceName, entry] of Object.entries(config ?? {})) {
    const path = entry.path?.trim() || join(defaultRoot, marketplaceName);
    roots.add(path);
  }
  return [...roots].sort((a, b) => a.localeCompare(b));
}
