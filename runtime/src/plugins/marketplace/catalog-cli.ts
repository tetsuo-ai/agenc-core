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

import { createHash } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";

import {
  findInstallableMarketplacePlugin,
  loadMarketplace,
  marketplaceRootDir,
  marketplaceStoreRoot,
  readMarketplaceIndex,
  type Fetcher,
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

/**
 * The marketplace AgenC publishes. A fresh profile has no marketplaces at
 * all, so a GUI client's first catalog request would truthfully return
 * nothing installable; registering this once turns that into the shipped
 * plugin set. Opt out with AGENC_SKIP_OFFICIAL_MARKETPLACE=1.
 */
export const OFFICIAL_MARKETPLACE_NAME = "agenc-plugins";
export const OFFICIAL_MARKETPLACE_URL =
  "https://agenc.tech/plugins/marketplace.json";

/**
 * Register the official marketplace when the profile has none. Returns
 * true when it was added. Never throws: an offline first run must still
 * produce a catalog (an empty one), not a hard CLI failure.
 */
export async function ensureOfficialMarketplace(
  options: MarketplaceOperationOptions,
  addMarketplace: (input: {
    readonly source: string;
    readonly name: string;
    readonly force: boolean;
  } & MarketplaceOperationOptions) => Promise<unknown>,
): Promise<boolean> {
  if (options.env?.AGENC_SKIP_OFFICIAL_MARKETPLACE === "1") return false;
  const index = await readMarketplaceIndex(options);
  if (Object.keys(index.marketplaces).length > 0) return false;
  try {
    await addMarketplace({
      ...options,
      source: OFFICIAL_MARKETPLACE_URL,
      name: OFFICIAL_MARKETPLACE_NAME,
      force: false,
    });
    return true;
  } catch {
    return false;
  }
}

export interface MarketplaceCatalogPluginRow {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly source: MarketplacePlugin["source"];
  readonly policy: MarketplacePlugin["policy"];
  readonly interface?: MarketplacePlugin["interface"];
  /** Absolute marketplace root this row's relative assets resolve against. */
  readonly root: string;
  /** Manifest description read at the pinned commit, when available. */
  readonly description?: string;
  /** Absolute path of the plugin logo, present only when it exists. */
  readonly logoPath?: string;
  /**
   * Directory `logoPath` is proven to sit inside. Prefetched artwork is
   * cached outside the marketplace root, so a client must contain its
   * check to this directory rather than assume `root`.
   */
  readonly logoRoot?: string;
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

/** Where prefetched catalog artwork is cached, inside the plugin store. */
function logoCacheRoot(options: MarketplaceOperationOptions): string {
  return join(marketplaceStoreRoot(options), ".logo-cache");
}

/** Bounded reads: a catalog must never be a memory or bandwidth hazard. */
const MANIFEST_PREFETCH_MAX_BYTES = 256 * 1024;
const LOGO_PREFETCH_MAX_BYTES = 4 * 1024 * 1024;

const IMAGE_MAGIC: readonly { readonly bytes: readonly number[]; readonly ext: string }[] = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], ext: "png" },
  { bytes: [0xff, 0xd8, 0xff], ext: "jpg" },
  { bytes: [0x52, 0x49, 0x46, 0x46], ext: "webp" },
];

function imageExtension(bytes: Uint8Array): string | undefined {
  for (const candidate of IMAGE_MAGIC) {
    if (candidate.bytes.every((byte, index) => bytes[index] === byte)) {
      return candidate.ext;
    }
  }
  return undefined;
}

/**
 * Raw-content URL for a file inside a SHA-pinned GitHub plugin source.
 * Only github.com sources with an explicit sha qualify: the pin is what
 * makes the fetched bytes content-addressed rather than "whatever the
 * branch says today".
 */
function pinnedRawUrl(
  source: MarketplacePlugin["source"],
  relativePath: string,
): string | undefined {
  if (source.type !== "git" || source.sha === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(source.url);
  } catch {
    return undefined;
  }
  if (parsed.hostname !== "github.com") return undefined;
  const segments = parsed.pathname.replace(/^\/+/u, "").replace(/\.git$/u, "").split("/");
  const [owner, repo, ...rest] = segments;
  if (owner === undefined || repo === undefined || rest.length > 0) return undefined;
  const prefix = source.path === undefined ? "" : `${source.path.replace(/^\/+|\/+$/gu, "")}/`;
  const clean = relativePath.replace(/^\.\//u, "").replace(/^\/+/u, "");
  if (clean.length === 0 || clean.includes("..")) return undefined;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${source.sha}/${prefix}${clean}`;
}

async function fetchBounded(
  fetcher: Fetcher,
  url: string,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  try {
    const response = await fetcher(url);
    if (!response.ok) return undefined;
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > 0 && buffer.byteLength <= maxBytes
      ? buffer
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Materialize a catalog plugin's logo before it is installed.
 *
 * A URL marketplace ships names and sources, not artwork, so the only
 * honest way to show a plugin's own logo on its card is to read the
 * plugin manifest at the pinned commit, take the `logo` it declares, and
 * fetch exactly that file. The bytes are cached under the marketplace
 * store keyed by commit + path, so a catalog is one network round trip
 * per plugin on first sight and none afterwards. Every failure is
 * silent: a missing logo is a generic card, never a broken catalog.
 */
interface PrefetchedCardMeta {
  readonly logoPath?: string;
  readonly displayName?: string;
  readonly description?: string;
}

/** Card copy is display text, not documents; keep it card-sized. */
const CARD_DISPLAY_NAME_MAX = 80;
const CARD_DESCRIPTION_MAX = 280;

function cardString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxLength);
}

async function prefetchPinnedCardMeta(
  options: MarketplaceOperationOptions,
  plugin: MarketplacePlugin,
): Promise<PrefetchedCardMeta | undefined> {
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as Fetcher);
  if (typeof fetcher !== "function") return undefined;
  const manifestUrl = pinnedRawUrl(plugin.source, ".agenc-plugin/plugin.json");
  if (manifestUrl === undefined) return undefined;
  const cacheRoot = logoCacheRoot(options);
  const key = createHash("sha256").update(manifestUrl).digest("hex").slice(0, 24);
  try {
    const cachedRaw: unknown = JSON.parse(
      await readFile(join(cacheRoot, `${key}.meta.json`), "utf8"),
    );
    if (typeof cachedRaw === "object" && cachedRaw !== null) {
      const cached = cachedRaw as {
        displayName?: unknown;
        description?: unknown;
        logoExt?: unknown;
      };
      const meta: {
        logoPath?: string;
        displayName?: string;
        description?: string;
      } = {};
      const displayName = cardString(cached.displayName, CARD_DISPLAY_NAME_MAX);
      const description = cardString(cached.description, CARD_DESCRIPTION_MAX);
      if (displayName !== undefined) meta.displayName = displayName;
      if (description !== undefined) meta.description = description;
      if (typeof cached.logoExt === "string" && /^(png|jpg|webp)$/u.test(cached.logoExt)) {
        const cachedLogo = join(cacheRoot, `${key}.${cached.logoExt}`);
        try {
          const stats = await stat(cachedLogo);
          if (stats.isFile() && stats.size > 0) meta.logoPath = cachedLogo;
        } catch {
          // Meta survives a pruned logo file.
        }
      }
      return meta;
    }
  } catch {
    // Not cached yet.
  }
  const manifestBytes = await fetchBounded(
    fetcher,
    manifestUrl,
    MANIFEST_PREFETCH_MAX_BYTES,
  );
  if (manifestBytes === undefined) return undefined;
  let declaredLogo: unknown;
  let displayName: string | undefined;
  let description: string | undefined;
  try {
    const manifest: unknown = JSON.parse(
      Buffer.from(manifestBytes).toString("utf8"),
    );
    if (typeof manifest !== "object" || manifest === null) return undefined;
    const shaped = manifest as {
      description?: unknown;
      interface?: { logo?: unknown; displayName?: unknown };
    };
    declaredLogo = shaped.interface?.logo;
    displayName = cardString(shaped.interface?.displayName, CARD_DISPLAY_NAME_MAX);
    description = cardString(shaped.description, CARD_DESCRIPTION_MAX);
  } catch {
    return undefined;
  }
  let logoPath: string | undefined;
  let logoExt: string | undefined;
  if (typeof declaredLogo === "string" && declaredLogo.length > 0) {
    const logoUrl = pinnedRawUrl(plugin.source, declaredLogo);
    if (logoUrl !== undefined) {
      const logoBytes = await fetchBounded(
        fetcher,
        logoUrl,
        LOGO_PREFETCH_MAX_BYTES,
      );
      if (logoBytes !== undefined) {
        const ext = imageExtension(logoBytes);
        if (ext !== undefined) {
          const destination = join(cacheRoot, `${key}.${ext}`);
          try {
            await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
            await writeFile(destination, logoBytes, { mode: 0o600 });
            logoPath = destination;
            logoExt = ext;
          } catch {
            // A failed logo write only downgrades the card.
          }
        }
      }
    }
  }
  try {
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      join(cacheRoot, `${key}.meta.json`),
      `${JSON.stringify({
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(logoExt !== undefined ? { logoExt } : {}),
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Uncached is refetched next catalog, never fatal.
  }
  return {
    ...(logoPath !== undefined ? { logoPath } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

async function catalogRowsForMarketplace(
  options: MarketplaceOperationOptions,
  marketplace: Marketplace,
  product: string | undefined,
): Promise<readonly MarketplaceCatalogPluginRow[]> {
  const rows: MarketplaceCatalogPluginRow[] = [];
  for (const plugin of marketplace.plugins) {
    if (plugin.policy.installation === "NOT_AVAILABLE") continue;
    if (!marketplacePluginSupportsProduct(plugin.policy, product)) continue;
    const manifestLogo = await resolveLogoPath(marketplace.root, plugin);
    const prefetched =
      manifestLogo === undefined
        ? await prefetchPinnedCardMeta(options, plugin)
        : undefined;
    const logoPath = manifestLogo ?? prefetched?.logoPath;
    const logoRoot =
      manifestLogo !== undefined
        ? marketplace.root
        : prefetched?.logoPath !== undefined
          ? logoCacheRoot(options)
          : undefined;
    const displayName =
      plugin.interface?.displayName ?? prefetched?.displayName;
    // Overlaying displayName keeps every other declared field; the cast
    // is needed because a spread re-widens exact-optional properties.
    const surface =
      displayName !== undefined
        ? ({ ...plugin.interface, displayName } as MarketplacePlugin["interface"])
        : plugin.interface;
    rows.push({
      id: `${plugin.name}@${marketplace.name}`,
      name: plugin.name,
      marketplace: marketplace.name,
      source: plugin.source,
      policy: plugin.policy,
      ...(surface !== undefined ? { interface: surface } : {}),
      root: marketplace.root,
      ...(prefetched?.description !== undefined
        ? { description: prefetched.description }
        : {}),
      ...(logoPath !== undefined ? { logoPath } : {}),
      ...(logoRoot !== undefined ? { logoRoot } : {}),
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
        plugins: await catalogRowsForMarketplace(options, marketplace, product),
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

