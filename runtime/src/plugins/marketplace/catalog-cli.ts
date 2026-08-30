/**
 * Structured catalog + install surface for GUI clients.
 *
 * `plugin marketplace list` reports configured marketplaces but never the
 * plugins inside them, so a desktop client had no way to enumerate what
 * it could install. This module serializes every configured marketplace's
 * installable plugins — filtered by the requesting product — into one
 * JSON document, and performs a qualified-id install on top of the same
 * resolution the interactive path uses.
 *
 * Artwork is the one thing a remote client cannot resolve for itself: a
 * manifest's `logo` is relative to the marketplace root, which lives
 * inside this machine's plugin store. Each row therefore carries the
 * absolute `root` it was resolved against plus a `logoPath` that is
 * guaranteed to sit inside that root, so the client can serve it under
 * its own trusted scheme instead of guessing.
 */

import { isAbsolute, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";

import {
  findInstallableMarketplacePlugin,
  loadMarketplace,
  marketplaceRootDir,
  readMarketplaceIndex,
  type Marketplace,
  type MarketplacePlugin,
  type MarketplaceRecord,
  type MarketplaceOperationOptions,
} from "./marketplace.js";

export const PLUGIN_MARKETPLACE_CATALOG_SCHEMA_VERSION = 1;
export const PLUGIN_MARKETPLACE_CATALOG_KIND =
  "agenc.plugin.marketplace.catalog";
export const PLUGIN_MARKETPLACE_INSTALL_KIND =
  "agenc.plugin.marketplace.install";

export interface MarketplaceCatalogPluginRow {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly source: MarketplacePlugin["source"];
  readonly policy: MarketplacePlugin["policy"];
  readonly interface?: MarketplacePlugin["interface"];
  /** Absolute marketplace root this row's relative assets resolve against. */
  readonly root: string;
  /** Absolute path of the manifest logo, present only when it exists. */
  readonly logoPath?: string;
}

export interface MarketplaceCatalogMarketplace {
  readonly name: string;
  readonly displayName?: string;
  readonly sourceType: MarketplaceRecord["sourceType"];
  readonly source: string;
  readonly plugins: readonly MarketplaceCatalogPluginRow[];
}

export interface MarketplaceCatalogError {
  readonly marketplace: string;
  readonly path: string;
  readonly message: string;
}

export interface MarketplaceCatalogDocument {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly product?: string;
  readonly marketplaces: readonly MarketplaceCatalogMarketplace[];
  readonly errors: readonly MarketplaceCatalogError[];
}

/** A plugin is offered to a product when the policy names it (or names none). */
export function marketplacePluginSupportsProduct(
  policy: MarketplacePlugin["policy"],
  product: string | undefined,
): boolean {
  const products = policy.products;
  if (products === undefined) return true;
  if (products.length === 0) return false;
  return product !== undefined && products.includes(product);
}

/**
 * Absolute path of a manifest-declared logo, or undefined when absent,
 * missing on disk, or resolving outside the marketplace root. The client
 * is trusted to serve only what this returns.
 */
async function resolveLogoPath(
  root: string,
  plugin: MarketplacePlugin,
): Promise<string | undefined> {
  const logo = plugin.interface?.logo;
  if (typeof logo !== "string" || logo.length === 0) return undefined;
  // The manifest normalizer already resolved declared assets to absolute
  // in-root paths; a protocol value never comes from that path and is not
  // artwork this machine vouches for.
  if (/^[a-z][a-z0-9+.-]*:/iu.test(logo)) return undefined;
  const candidate = isAbsolute(logo) ? logo : resolve(root, logo);
  try {
    const [realRoot, realLogo] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
    const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (!realLogo.startsWith(rootWithSep)) return undefined;
    const stats = await stat(realLogo);
    return stats.isFile() && stats.size > 0 ? realLogo : undefined;
  } catch {
    return undefined;
  }
}

async function catalogRowsForMarketplace(
  marketplace: Marketplace,
  product: string | undefined,
): Promise<readonly MarketplaceCatalogPluginRow[]> {
  const rows: MarketplaceCatalogPluginRow[] = [];
  for (const plugin of marketplace.plugins) {
    if (plugin.policy.installation === "NOT_AVAILABLE") continue;
    if (!marketplacePluginSupportsProduct(plugin.policy, product)) continue;
    const logoPath = await resolveLogoPath(marketplace.root, plugin);
    rows.push({
      id: `${plugin.name}@${marketplace.name}`,
      name: plugin.name,
      marketplace: marketplace.name,
      source: plugin.source,
      policy: plugin.policy,
      ...(plugin.interface !== undefined
        ? { interface: plugin.interface }
        : {}),
      root: marketplace.root,
      ...(logoPath !== undefined ? { logoPath } : {}),
    });
  }
  return rows;
}

/**
 * Every installable plugin across every configured marketplace. One
 * unreadable marketplace becomes an entry in `errors` rather than an
 * empty catalog: a client should still see the marketplaces that work.
 */
export async function buildMarketplaceCatalog(
  options: MarketplaceOperationOptions,
  product?: string,
): Promise<MarketplaceCatalogDocument> {
  const index = await readMarketplaceIndex(options);
  const records = Object.values(index.marketplaces).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const marketplaces: MarketplaceCatalogMarketplace[] = [];
  const errors: MarketplaceCatalogError[] = [];
  for (const record of records) {
    try {
      const marketplace = await loadMarketplace(
        record.manifestPath,
        record.name,
      );
      marketplaces.push({
        name: record.name,
        ...(marketplace.interface?.displayName !== undefined
          ? { displayName: marketplace.interface.displayName }
          : {}),
        sourceType: record.sourceType,
        source: record.source,
        plugins: await catalogRowsForMarketplace(marketplace, product),
      });
    } catch (error) {
      errors.push({
        marketplace: record.name,
        path: record.manifestPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    schemaVersion: PLUGIN_MARKETPLACE_CATALOG_SCHEMA_VERSION,
    kind: PLUGIN_MARKETPLACE_CATALOG_KIND,
    ...(product !== undefined ? { product } : {}),
    marketplaces,
    errors,
  };
}

export interface QualifiedMarketplacePluginId {
  readonly pluginName: string;
  readonly marketplaceName?: string;
}

/**
 * Split `plugin@marketplace`. The marketplace half is optional so a
 * bare name still resolves when exactly one marketplace offers it; the
 * split is on the LAST `@` because plugin names may contain scopes.
 */
export function parseQualifiedMarketplacePluginId(
  raw: string,
): QualifiedMarketplacePluginId {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("plugin id must not be empty");
  }
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) {
    return { pluginName: trimmed };
  }
  return {
    pluginName: trimmed.slice(0, at),
    marketplaceName: trimmed.slice(at + 1),
  };
}

export interface ResolvedMarketplaceInstallTarget {
  readonly record: MarketplaceRecord;
  readonly pluginName: string;
  readonly source: MarketplacePlugin["source"];
  readonly marketplaceName: string;
  readonly root: string;
}

/**
 * Resolve a qualified id to an installable plugin. A marketplace-less id
 * is accepted only when exactly one configured marketplace offers that
 * plugin to this product — ambiguity is an error, never a silent pick.
 */
export async function resolveMarketplaceInstallTarget(
  options: MarketplaceOperationOptions,
  qualifiedId: string,
  product?: string,
): Promise<ResolvedMarketplaceInstallTarget> {
  const { pluginName, marketplaceName } =
    parseQualifiedMarketplacePluginId(qualifiedId);
  const index = await readMarketplaceIndex(options);
  const records = Object.values(index.marketplaces);
  const candidates =
    marketplaceName === undefined
      ? records
      : records.filter(
          (record) =>
            record.name.toLowerCase() === marketplaceName.toLowerCase(),
        );
  if (candidates.length === 0) {
    throw new Error(
      marketplaceName === undefined
        ? "no AgenC plugin marketplaces are configured"
        : `marketplace '${marketplaceName}' is not configured`,
    );
  }
  const matches: ResolvedMarketplaceInstallTarget[] = [];
  const failures: string[] = [];
  for (const record of candidates) {
    try {
      const resolved = await findInstallableMarketplacePlugin(
        record.manifestPath,
        pluginName,
        product,
        record.name,
      );
      matches.push({
        record,
        pluginName: resolved.pluginName,
        source: resolved.source,
        marketplaceName: resolved.marketplaceName,
        root: marketplaceRootDir(record.manifestPath),
      });
    } catch (error) {
      failures.push(
        `${record.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const [match, ...rest] = matches;
  if (match === undefined) {
    throw new Error(
      `plugin '${pluginName}' is not installable: ${failures.join("; ")}`,
    );
  }
  if (rest.length > 0) {
    throw new Error(
      `plugin '${pluginName}' is offered by ${matches.length} marketplaces; qualify it as ${pluginName}@<marketplace>`,
    );
  }
  return match;
}

/**
 * Local marketplaces are whatever the operator put on disk; anything
 * fetched from elsewhere must carry a publisher signature this machine
 * can verify against its keyring.
 */
export function installRequiresSignature(record: MarketplaceRecord): boolean {
  return record.sourceType !== "local";
}

