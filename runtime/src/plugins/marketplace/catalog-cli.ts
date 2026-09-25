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

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import * as lockfile from "../../utils/lockfile.js";
import { writeDurableAtomicFile } from "../../utils/durable-atomic-file.js";
import { readStableFile } from "../../config/stable-file.js";
import { isExcludedPluginPayloadDirectory } from "../payload-paths.js";
import { normalizeSkillDisplayName, skillDisplayNameFromMarkdown } from "../skill-display-metadata.js";
import { verifiedAdvertisedPluginPayloadDigest } from "../resolution.js";
import { updateMarketplaceInventory } from "./inventory.js";

import {
  findInstallableMarketplacePlugin,
  loadMarketplace,
  marketplaceRootDir,
  marketplaceStoreRoot,
  readMarketplaceIndex,
  upgradeMarketplaceOp,
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
 * How long a cached copy of the official marketplace is served before it is
 * fetched again.
 *
 * The marketplace was installed once, on first use, and then read from disk
 * forever. A home that installed it on Sep 10 had a manifest with 5 plugins
 * while the live one listed 11, and the desktop's Plugins pane, which is built
 * from this catalog, showed the 5. Nothing refreshed it: the only way to see a
 * plugin published after install was to remove and re-add the marketplace by
 * hand. An hour keeps the pane current without a fetch on every open.
 */
export const OFFICIAL_MARKETPLACE_REFRESH_MS = 60 * 60_000;

/** A successful update or attempted refresh cannot have happened after the current clock. */
function marketplaceFreshnessTime(value: string | undefined, now: number): number {
  const parsed = value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(parsed) ? Math.min(parsed, now) : 0;
}

/** A read-only shortcut may skip the lock only when both persisted times are valid and in the past. */
function marketplaceFreshnessNeedsClaim(updatedAt: string, checkedAt: string | undefined,
  now: number): boolean {
  const updated = Date.parse(updatedAt);
  const checked = checkedAt === undefined ? 0 : Date.parse(checkedAt);
  return !Number.isFinite(updated) || !Number.isFinite(checked) ||
    updated > now || checked > now ||
    now - Math.max(updated, checked) > OFFICIAL_MARKETPLACE_REFRESH_MS;
}

async function claimMarketplaceRefresh(
  options: MarketplaceOperationOptions,
  name: string,
): Promise<boolean> {
  const now = (options.now ?? (() => new Date()))().getTime();
  return updateMarketplaceInventory({ pluginsDirectory: options.pluginStorageRoot }, (current) => {
    const record = current[name];
    if (record === undefined || record.refreshable === false || record.autoUpdate === false) {
      return { inventory: current, result: false };
    }
    const updated = marketplaceFreshnessTime(record.lastUpdated, now);
    const checked = marketplaceFreshnessTime(record.lastChecked, now);
    const rebased = {
      ...record,
      ...(updated !== Date.parse(record.lastUpdated)
        ? { lastUpdated: new Date(updated).toISOString() } : {}),
      ...(record.lastChecked !== undefined && checked !== Date.parse(record.lastChecked)
        ? { lastChecked: new Date(checked).toISOString() } : {}),
    };
    if (now - Math.max(updated, checked) <= OFFICIAL_MARKETPLACE_REFRESH_MS) {
      return { inventory: { ...current, [name]: rebased }, result: false };
    }
    return { inventory: { ...current,
      [name]: { ...rebased, lastChecked: new Date(now).toISOString() } }, result: true };
  });
}

/** Refresh configured sources before using their signed payload adverts. */
export async function refreshStaleMarketplaces(
  options: MarketplaceOperationOptions,
  upgrade: typeof upgradeMarketplaceOp = upgradeMarketplaceOp,
): Promise<void> {
  const index = await readMarketplaceIndex(options);
  const now = (options.now ?? (() => new Date()))().getTime();
  for (const record of Object.values(index.marketplaces)) {
    if (record.refreshable === false || record.autoUpdate === false) continue;
    if (!marketplaceFreshnessNeedsClaim(record.updatedAt, record.lastCheckedAt, now)) continue;
    if (!(await claimMarketplaceRefresh(options, record.name))) continue;
    try { await upgrade({ ...options, name: record.name }); }
    catch { /* Keep the verified cached marketplace while offline. */ }
  }
}

/**
 * Register the official marketplace when the profile has none, and fetch it
 * again once the cached copy is older than the refresh window. Returns true
 * when it was added or refreshed. Never throws: an offline first run must
 * still produce a catalog (an empty one), not a hard CLI failure.
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
  const official = index.marketplaces[OFFICIAL_MARKETPLACE_NAME];
  const hasAny = Object.keys(index.marketplaces).length > 0;
  const now = (options.now ?? (() => new Date()))().getTime();
  // A manifest older than the window is fetched again in place. Failure keeps
  // the cached copy: a stale catalog is a catalog, an empty one is an outage.
  const stale = official !== undefined && official.autoUpdate !== false &&
    official.refreshable !== false &&
    marketplaceFreshnessNeedsClaim(official.updatedAt, official.lastCheckedAt, now) &&
    await claimMarketplaceRefresh(options, OFFICIAL_MARKETPLACE_NAME);
  if (hasAny && !stale) return false;
  try {
    await addMarketplace({
      ...options,
      source: OFFICIAL_MARKETPLACE_URL,
      name: OFFICIAL_MARKETPLACE_NAME,
      force: stale,
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
  /** Manifest version read at the pinned commit, when available. */
  readonly version?: string;
  readonly payloadDigest?: string;
  readonly sourceCommit?: string;
  readonly lastRefreshTime?: string;
  /** Skills the pinned manifest declares, with SKILL.md descriptions. */
  readonly skills?: readonly { name: string; description?: string }[];
  /** Commands the pinned manifest declares. */
  readonly commands?: readonly { name: string; description?: string; argumentHint?: string }[];
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
  const declared = /^https:\/\/github\.com(\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?)$/iu.exec(source.url);
  if (declared === null || parsed.protocol !== "https:" || parsed.hostname !== "github.com" ||
    parsed.pathname !== declared[1] || !/^[a-f0-9]{40}$/iu.test(source.sha)) return undefined;
  const [owner, rawRepo] = declared[1]!.replace(/^\/|\/$/gu, "").split("/");
  const repo = rawRepo?.replace(/\.git$/u, "");
  if (owner === undefined || repo === undefined || repo.length === 0) return undefined;
  const prefix = source.path === undefined ? [] : source.path.split("/");
  const clean = relativePath.replace(/^\.\//u, "").replace(/^\/+/u, "");
  const parts = [...prefix, ...clean.split("/")];
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." ||
    part.includes("\\") || part.includes("\0") ||
    isExcludedPluginPayloadDirectory(part))) return undefined;
  const pathname = `/${[owner, repo, source.sha, ...parts].map(encodeURIComponent).join("/")}`;
  const raw = new URL(`https://raw.githubusercontent.com${pathname}`);
  return raw.pathname === pathname && raw.hostname === "raw.githubusercontent.com"
    ? raw.href : undefined;
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
 * store keyed by commit + path. Display cards reuse that cache. Signed
 * comparisons reverify signed bytes cached for the exact pinned source,
 * including on a later process invocation.
 * Every failure is silent: a missing logo is a generic card.
 */
interface MarketplaceComponentRow {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly argumentHint?: string;
}

interface PendingSkillFetch {
  readonly index: number;
  readonly path: string;
}

interface PrefetchedCardMeta {
  readonly logoPath?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly version?: string;
  readonly payloadDigest?: string;
  readonly interface?: Record<string, unknown>;
  readonly skills?: readonly MarketplaceComponentRow[];
  readonly commands?: readonly MarketplaceComponentRow[];
}

/** Card copy is display text, not documents; keep it card-sized. */
const CARD_DISPLAY_NAME_MAX = 80;
const CARD_DESCRIPTION_MAX = 280;
const CARD_LONG_DESCRIPTION_MAX = 2000;
const CARD_URL_MAX = 300;
const CARD_LIST_MAX = 12;
const CARD_PROMPT_MAX = 4;
const CARD_SKILLS_MAX = 8;
const SKILL_PREFETCH_MAX_BYTES = 32 * 1024;
// Older sidecars did not retain skill display labels, even for the same source SHA.
const CARD_METADATA_VERSION = 1;

function cardString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxLength);
}

function cardStringList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((entry) => cardString(entry, maxLength))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, maxItems);
  return items.length > 0 ? items : undefined;
}

/**
 * The bounded, display-only projection of a pinned manifest interface.
 * Never trusts lengths, never carries the logo (that travels as a
 * verified cached file path), never carries screenshots (unfetched
 * relative paths are useless to a catalog client).
 */
function cardInterface(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const put = (key: string, entry: unknown): void => {
    if (entry !== undefined) out[key] = entry;
  };
  put("displayName", cardString(raw.displayName, CARD_DISPLAY_NAME_MAX));
  put("shortDescription", cardString(raw.shortDescription, CARD_DESCRIPTION_MAX));
  put("longDescription", cardString(raw.longDescription, CARD_LONG_DESCRIPTION_MAX));
  put("developerName", cardString(raw.developerName, CARD_DISPLAY_NAME_MAX));
  put("category", cardString(raw.category, CARD_DISPLAY_NAME_MAX));
  put("capabilities", cardStringList(raw.capabilities, CARD_LIST_MAX, 64));
  put("websiteUrl", cardString(raw.websiteUrl, CARD_URL_MAX));
  put("privacyPolicyUrl", cardString(raw.privacyPolicyUrl, CARD_URL_MAX));
  put("termsOfServiceUrl", cardString(raw.termsOfServiceUrl, CARD_URL_MAX));
  put("defaultPrompt", cardStringList(raw.defaultPrompt, CARD_PROMPT_MAX, 200));
  const brand = cardString(raw.brandColor, 16);
  if (brand !== undefined && /^#[0-9a-f]{3,8}$/iu.test(brand)) {
    out.brandColor = brand;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function cardComponentRows(value: unknown): readonly MarketplaceComponentRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.flatMap((entry): MarketplaceComponentRow[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    const name = cardString(raw.name, CARD_DISPLAY_NAME_MAX);
    if (name === undefined) return [];
    const displayName = normalizeSkillDisplayName(raw.displayName);
    const description = cardString(raw.description, CARD_DESCRIPTION_MAX);
    const argumentHint = cardString(raw.argumentHint, 120);
    return [{
      name,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(argumentHint !== undefined ? { argumentHint } : {}),
    }];
  }).slice(0, CARD_LIST_MAX);
  return rows.length > 0 ? rows : undefined;
}

async function prefetchSkillRows(
  fetcher: Fetcher,
  source: MarketplacePlugin["source"],
  declaredSkills: unknown,
): Promise<{ readonly rows: readonly MarketplaceComponentRow[]; readonly pending: readonly PendingSkillFetch[] } | undefined> {
  if (!Array.isArray(declaredSkills)) return undefined;
  const rows: MarketplaceComponentRow[] = [];
  const pending: PendingSkillFetch[] = [];
  for (const declared of declaredSkills.slice(0, CARD_SKILLS_MAX)) {
    if (typeof declared !== "string" || declared.length === 0) continue;
    const clean = declared.replace(/^\.\//u, "").replace(/\/+$/u, "");
    const name = clean.split("/").pop();
    if (name === undefined || name.length === 0) continue;
    if (clean.split("/").some(isExcludedPluginPayloadDirectory)) continue;
    let details: Pick<MarketplaceComponentRow, "displayName" | "description"> = {};
    const skillUrl = pinnedRawUrl(source, `${clean}/SKILL.md`);
    if (skillUrl !== undefined) {
      const bytes = await fetchBounded(fetcher, skillUrl, SKILL_PREFETCH_MAX_BYTES);
      if (bytes !== undefined) {
        details = skillDetails(bytes);
      } else {
        pending.push({ index: rows.length, path: clean });
      }
    }
    rows.push({ name, ...details });
  }
  return rows.length > 0 ? { rows, pending } : undefined;
}

function skillDetails(bytes: Uint8Array): Pick<MarketplaceComponentRow, "displayName" | "description"> {
  const head = Buffer.from(bytes).toString("utf8");
  const displayName = skillDisplayNameFromMarkdown(head);
  const match = /^description:\s*(.+)$/mu.exec(head);
  const description = match?.[1]?.trim().slice(0, CARD_DESCRIPTION_MAX);
  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function metaFromSidecar(value: unknown, logoPath: string | undefined): PrefetchedCardMeta {
  const raw = typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
  const surface = cardInterface(raw.interface);
  const displayName =
    cardString(raw.displayName, CARD_DISPLAY_NAME_MAX) ??
    (surface?.displayName as string | undefined);
  const description = cardString(raw.description, CARD_DESCRIPTION_MAX);
  const version = cardString(raw.version, 64);
  const payloadDigest = cardString(raw.payloadDigest, 71);
  const skills = cardComponentRows(raw.skills);
  const commands = cardComponentRows(raw.commands);
  return {
    ...(logoPath !== undefined ? { logoPath } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(payloadDigest !== undefined ? { payloadDigest } : {}),
    ...(surface !== undefined ? { interface: surface } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(commands !== undefined ? { commands } : {}),
  };
}

const cardFetches = new Map<string, Promise<PrefetchedCardMeta | undefined>>();
const authenticatedAdverts = new Map<string, { readonly manifest: Uint8Array; readonly signature: Uint8Array }>();
const MAX_PERSISTED_AUTHENTICATED_ADVERTS = 128;

function advertBinding(key: Uint8Array, manifestUrl: string, manifest: Uint8Array,
  signature: Uint8Array): Buffer {
  return createHmac("sha256", key).update(manifestUrl).update("\0")
    .update(manifest).update("\0").update(signature).digest();
}

/** The binding secret belongs to Core's private home state, outside plugin stores. */
async function advertBindingKeyPath(agencHome: string): Promise<string> {
  const home = await realpath(agencHome);
  const directory = join(home, "private", "plugin-adverts");
  await mkdir(join(home, "private"), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  for (const path of [join(home, "private"), directory]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((info.mode & 0o777) !== 0o700 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())))) {
      throw new Error(`advert binding directory is not owner-only: ${path}`);
    }
  }
  return join(directory, "binding-key");
}

async function readAdvertBindingKey(agencHome: string): Promise<Buffer | undefined> {
  try {
    const path = await advertBindingKeyPath(agencHome);
    const snapshot = await readStableFile(path);
    if (snapshot === null) return undefined;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      info.dev !== snapshot.dev || info.ino !== snapshot.ino ||
      (process.platform !== "win32" &&
        (snapshot.mode !== 0o600 || (info.mode & 0o777) !== 0o600 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())))) return undefined;
    const key = snapshot.bytes.toString("utf8");
    return /^[a-f0-9]{64}$/u.test(key) ? Buffer.from(key, "hex") : undefined;
  } catch { return undefined; }
}

async function ensureAdvertBindingKey(agencHome: string): Promise<Buffer> {
  const keyPath = await advertBindingKeyPath(agencHome);
  return withAdvertSidecarLock(keyPath, async () => {
    const existing = await readAdvertBindingKey(agencHome);
    if (existing !== undefined) return existing;
    if (await lstat(keyPath).then(() => true, () => false)) {
      throw new Error("advert binding key failed owner or mode validation");
    }
    const key = randomBytes(32);
    await writeDurableAtomicFile(keyPath, `${keyPath}.tmp-${process.pid}-${randomUUID()}`,
      key.toString("hex"), 0o600);
    return key;
  });
}

function authenticatedAdvertPath(cacheRoot: string, key: string): string {
  return join(cacheRoot, `${key}.authenticated.json`);
}

async function readAuthenticatedAdvert(
  path: string, manifestUrl: string, agencHome: string,
): Promise<{ readonly manifest: Uint8Array; readonly signature: Uint8Array } | undefined> {
  try {
    if ((await stat(path)).size > 720_000) return undefined;
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (record.manifestUrl !== manifestUrl ||
      typeof record.manifest !== "string" || typeof record.signature !== "string" ||
      typeof record.binding !== "string" || !/^[a-f0-9]{64}$/u.test(record.binding) ||
      record.manifest.length > 350_000 || record.signature.length > 350_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(record.manifest) ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(record.signature)) return undefined;
    const manifest = Buffer.from(record.manifest, "base64");
    const signature = Buffer.from(record.signature, "base64");
    if (manifest.length === 0 || manifest.length > MANIFEST_PREFETCH_MAX_BYTES ||
      signature.length === 0 || signature.length > 256 * 1024) return undefined;
    const key = await readAdvertBindingKey(agencHome);
    if (key === undefined || !timingSafeEqual(Buffer.from(record.binding, "hex"),
      advertBinding(key, manifestUrl, manifest, signature))) return undefined;
    return { manifest, signature };
  } catch { return undefined; }
}

async function writeAuthenticatedAdvert(
  path: string, manifestUrl: string, manifest: Uint8Array, signature: Uint8Array,
  agencHome: string,
): Promise<void> {
  const cacheRoot = dirname(path);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await withAdvertSidecarLock(join(cacheRoot, ".authenticated-budget"), async () => {
    const key = await ensureAdvertBindingKey(agencHome);
    const entries = (await readdir(cacheRoot)).filter((name) => name.endsWith(".authenticated.json"));
    const currentName = path.slice(cacheRoot.length + 1);
    const older = await Promise.all(entries.filter((name) => name !== currentName).map(async (name) => ({
      name, mtimeMs: (await stat(join(cacheRoot, name))).mtimeMs,
    })));
    older.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    const keepOthers = MAX_PERSISTED_AUTHENTICATED_ADVERTS - 1;
    for (const entry of older.slice(0, Math.max(0, older.length - keepOthers))) {
      const sourceSidecar = join(cacheRoot,
        entry.name.replace(/\.authenticated\.json$/u, ".meta.json"));
      await withAdvertSidecarLock(sourceSidecar, async () => {
        // The sidecar owns the deadline and any in-flight advert or skill claim.
        // Eviction removes only the authenticated bytes, under that source's lock.
        await rm(join(cacheRoot, entry.name), { force: true });
      });
    }
    await writeDurableAtomicFile(path, `${path}.tmp-${process.pid}-${randomUUID()}`,
      `${JSON.stringify({ manifestUrl, manifest: Buffer.from(manifest).toString("base64"),
        signature: Buffer.from(signature).toString("base64"),
        binding: advertBinding(key, manifestUrl, manifest, signature).toString("hex") })}\n`, 0o600);
  });
}

function advertSidecarPath(cacheRoot: string, key: string): string {
  return join(cacheRoot, `${key}.meta.json`);
}

async function readAdvertSidecar(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

async function withAdvertSidecarLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const release = await lockfile.lock(path, {
    realpath: false, stale: 30_000,
    retries: { retries: 20, factor: 1.35, minTimeout: 10, maxTimeout: 250, randomize: true },
    lockfilePath: `${path}.lock`,
  });
  try { return await operation(); }
  finally { await release(); }
}

async function writeAdvertSidecar(path: string, sidecar: Record<string, unknown>): Promise<void> {
  await writeDurableAtomicFile(path, `${path}.tmp-${process.pid}-${randomUUID()}`,
    `${JSON.stringify(sidecar)}\n`);
}

/** Fold previous sidecar deadlines into one source-wide deadline on first claim. */
function migratedAdvertSidecar(cached: Record<string, unknown>): Record<string, unknown> {
  const { manifestRetryAfter, authRetryAfter, authRecoveryAfter, authRefreshPending,
    ...current } = cached;
  const legacy = [manifestRetryAfter, authRetryAfter, authRecoveryAfter]
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value)).filter(Number.isFinite);
  const existing = typeof current.advertRetryAfter === "string"
    ? Date.parse(current.advertRetryAfter) : NaN;
  const deadline = Math.max(...legacy, ...(Number.isFinite(existing) ? [existing] : []));
  if (Number.isFinite(deadline)) current.advertRetryAfter = new Date(deadline).toISOString();
  return current;
}

/** Caller holds the sidecar lock. Persist every claim before fetching. */
async function claimAdvertDeadline(path: string, cached: Record<string, unknown>,
  now: number, recovery: boolean): Promise<string | undefined> {
  const current = migratedAdvertSidecar(cached);
  const migrated = JSON.stringify(current) !== JSON.stringify(cached);
  const deadline = typeof current.advertRetryAfter === "string"
    ? Date.parse(current.advertRetryAfter) : NaN;
  if (deadline > now + OFFICIAL_MARKETPLACE_REFRESH_MS) {
    await writeAdvertSidecar(path, { ...current,
      advertRetryAfter: new Date(now + OFFICIAL_MARKETPLACE_REFRESH_MS).toISOString() });
    return undefined;
  }
  if (deadline > now && !(recovery && current.advertRecoveryEligible === true)) {
    if (migrated) await writeAdvertSidecar(path, current);
    return undefined;
  }
  const claim = randomUUID();
  const { payloadDigest: _digest, signedManifestSha256: _hash,
    signedSignature: _signature, ...display } = current;
  await writeAdvertSidecar(path, { ...display, advertClaim: claim,
    advertRetryAfter: new Date(now + OFFICIAL_MARKETPLACE_REFRESH_MS).toISOString(),
    advertRecoveryEligible: false });
  return claim;
}

/** Persist the deadline before any network fetch; the lock spans CLI processes. */
async function claimAdvertRefresh(path: string, now: number): Promise<string | undefined> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return await withAdvertSidecarLock(path, async () => {
      const cached = await readAdvertSidecar(path);
      return claimAdvertDeadline(path, cached, now, false);
    });
  } catch { return undefined; }
}

async function finishAdvertRefresh(path: string, claim: string, metadata: Record<string, unknown>,
  authenticated: boolean): Promise<void> {
  try {
    await withAdvertSidecarLock(path, async () => {
      const cached = await readAdvertSidecar(path);
      if (cached.advertClaim !== claim) return;
      const { advertClaim: _claim, ...rest } = cached;
      await writeAdvertSidecar(path, { ...rest, ...metadata,
        ...(authenticated ? { advertRecoveryEligible: true } : {}) });
    });
  } catch { /* The claimed deadline remains in force after cache write failures. */ }
}

/** A display-only catalog may have claimed the manifest window first. */
async function claimAdvertAuthentication(
  path: string, now: number, recovery: boolean, authenticatedPath: string,
  manifestUrl: string, agencHome: string,
): Promise<{ readonly claim?: string; readonly digest?: string }> {
  try {
    return await withAdvertSidecarLock(path, async () => {
      const cached = await readAdvertSidecar(path);
      // Another process may have rebound the advert after this caller observed
      // an unbound file. Recheck it while holding the same lock as both claims.
      const rebound = await readAuthenticatedAdvert(authenticatedPath, manifestUrl, agencHome);
      if (rebound !== undefined) {
        try {
          const digest = await verifiedAdvertisedPluginPayloadDigest(
            rebound.manifest, rebound.signature, { agencHome });
          return { digest };
        } catch { /* Current publisher trust still requires a fresh attempt. */ }
      }
      const claim = await claimAdvertDeadline(path, cached, now, recovery);
      return { claim };
    });
  } catch { return {}; }
}

async function authenticatedDigestDuringWindow(
  options: MarketplaceOperationOptions,
  source: MarketplacePlugin["source"],
  fetcher: Fetcher,
  manifestUrl: string,
  sidecarPath: string,
  authenticatedPath: string,
  cacheIdentity: string,
  now: number,
): Promise<string | undefined> {
  if (options.agencHome === undefined) return undefined;
  const authenticated = authenticatedAdverts.get(cacheIdentity) ??
    await readAuthenticatedAdvert(authenticatedPath, manifestUrl, options.agencHome);
  if (authenticated !== undefined) {
    try {
      return await verifiedAdvertisedPluginPayloadDigest(
        authenticated.manifest, authenticated.signature, { agencHome: options.agencHome });
    } catch { /* Current publisher trust may reject formerly signed bytes. */ }
  }
  const unboundEntry = authenticated === undefined && await stat(authenticatedPath)
    .then(() => true, () => false);
  const claim = await claimAdvertAuthentication(sidecarPath, now, unboundEntry,
    authenticatedPath, manifestUrl, options.agencHome);
  if (claim.digest !== undefined) return claim.digest;
  if (claim.claim === undefined) return undefined;
  const signatureUrl = pinnedRawUrl(source, ".agenc-plugin/signature.json");
  if (signatureUrl === undefined) return undefined;
  const manifest = await fetchBounded(fetcher, manifestUrl, MANIFEST_PREFETCH_MAX_BYTES);
  const signature = await fetchBounded(fetcher, signatureUrl, 256 * 1024);
  if (manifest === undefined || signature === undefined) return undefined;
  try {
    const digest = await verifiedAdvertisedPluginPayloadDigest(
      manifest, signature, { agencHome: options.agencHome });
    authenticatedAdverts.set(cacheIdentity, { manifest, signature });
    if (authenticatedAdverts.size > 128) authenticatedAdverts.delete(authenticatedAdverts.keys().next().value!);
    let persistedAuthentication = false;
    try {
      await writeAuthenticatedAdvert(authenticatedPath, manifestUrl, manifest, signature,
        options.agencHome);
      persistedAuthentication = true;
    } catch { /* The in-memory verified advert is still safe to use. */ }
    await finishAdvertRefresh(sidecarPath, claim.claim, {}, persistedAuthentication && !unboundEntry);
    return digest;
  } catch { return undefined; }
}

/** Skill documents have their own retry state; they do not reopen the manifest advert claim. */
async function retryIncompleteSkillMetadata(
  path: string,
  cached: Record<string, unknown>,
  fetcher: Fetcher,
  source: MarketplacePlugin["source"],
  now: number,
): Promise<Record<string, unknown>> {
  const rows = cardComponentRows(cached.skills);
  if (rows === undefined || !Array.isArray(cached.pendingSkillFetches)) return cached;
  if (cached.pendingSkillFetches.length > CARD_SKILLS_MAX) return cached;
  const pending = cached.pendingSkillFetches.filter((entry): entry is PendingSkillFetch => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as Record<string, unknown>;
    return Number.isInteger(candidate.index) && (candidate.index as number) >= 0 &&
      (candidate.index as number) < rows.length &&
      typeof candidate.path === "string" && candidate.path.length <= MANIFEST_PREFETCH_MAX_BYTES &&
      candidate.path.split("/").pop() === rows[candidate.index as number]?.name;
  });
  if (pending.length === 0 || pending.length !== cached.pendingSkillFetches.length) return cached;
  let claim: string | undefined;
  try {
    claim = await withAdvertSidecarLock(path, async () => {
      const current = await readAdvertSidecar(path);
      if (JSON.stringify(current.pendingSkillFetches) !== JSON.stringify(cached.pendingSkillFetches) ||
        current.advertRetryAfter !== cached.advertRetryAfter) {
        return undefined;
      }
      const skillDeadline = typeof current.skillRetryAfter === "string"
        ? Date.parse(current.skillRetryAfter) : NaN;
      if (skillDeadline > now + OFFICIAL_MARKETPLACE_REFRESH_MS) {
        await writeAdvertSidecar(path, { ...current,
          skillRetryAfter: new Date(now + OFFICIAL_MARKETPLACE_REFRESH_MS).toISOString() });
        return undefined;
      }
      if (skillDeadline > now) return undefined;
      const next = randomUUID();
      await writeAdvertSidecar(path, { ...current, skillClaim: next,
        skillRetryAfter: new Date(now + OFFICIAL_MARKETPLACE_REFRESH_MS).toISOString() });
      return next;
    });
  } catch { return cached; }
  if (claim === undefined) return cached;
  const updatedRows = [...rows];
  const remaining: PendingSkillFetch[] = [];
  for (const entry of pending) {
    const url = pinnedRawUrl(source, entry.path + "/SKILL.md");
    const bytes = url === undefined ? undefined : await fetchBounded(fetcher, url, SKILL_PREFETCH_MAX_BYTES);
    if (bytes === undefined) {
      remaining.push(entry);
    } else {
      updatedRows[entry.index] = { ...updatedRows[entry.index]!, ...skillDetails(bytes) };
    }
  }
  try {
    return await withAdvertSidecarLock(path, async () => {
      const current = await readAdvertSidecar(path);
      if (current.skillClaim !== claim) return current;
      const { skillClaim: _claim, ...rest } = current;
      const updated = { ...rest, skills: updatedRows, pendingSkillFetches: remaining,
        ...(remaining.length === 0 ? { cardMetadataVersion: CARD_METADATA_VERSION } : {}) };
      await writeAdvertSidecar(path, updated);
      return updated;
    });
  } catch { return cached; }
}

async function prefetchPinnedCardMeta(
  options: MarketplaceOperationOptions,
  plugin: MarketplacePlugin,
  includePayloadDigest = false,
): Promise<PrefetchedCardMeta | undefined> {
  const manifestUrl = pinnedRawUrl(plugin.source, ".agenc-plugin/plugin.json");
  if (manifestUrl === undefined) return undefined;
  const flightKey = `${logoCacheRoot(options)}:${options.agencHome ?? ""}:${includePayloadDigest}:${manifestUrl}`;
  const current = cardFetches.get(flightKey);
  if (current !== undefined) return current;
  const pending = prefetchPinnedCardMetaOnce(options, plugin, includePayloadDigest, manifestUrl);
  cardFetches.set(flightKey, pending);
  try {
    return await pending;
  } finally {
    cardFetches.delete(flightKey);
  }
}

async function prefetchPinnedCardMetaOnce(
  options: MarketplaceOperationOptions,
  plugin: MarketplacePlugin,
  includePayloadDigest: boolean,
  manifestUrl: string,
): Promise<PrefetchedCardMeta | undefined> {
  const cacheRoot = logoCacheRoot(options);
  await rm(join(cacheRoot, ".advert-binding-key"), { force: true }).catch(() => {});
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as Fetcher);
  if (typeof fetcher !== "function") return undefined;
  const key = createHash("sha256").update(manifestUrl).digest("hex").slice(0, 24);
  const sidecarPath = advertSidecarPath(cacheRoot, key);
  const authenticatedPath = authenticatedAdvertPath(cacheRoot, key);
  const cacheIdentity = `${cacheRoot}:${manifestUrl}`;
  const cached = await readAdvertSidecar(sidecarPath);
  let cachedLogoPath: string | undefined;
  if (typeof cached.logoExt === "string" && /^(png|jpg|webp)$/u.test(cached.logoExt)) {
    const cachedLogo = join(cacheRoot, `${key}.${cached.logoExt}`);
    try {
      const stats = await stat(cachedLogo);
      if (stats.isFile() && stats.size > 0) cachedLogoPath = cachedLogo;
    } catch { /* Meta survives a pruned logo file. */ }
  }
  // Persisted display metadata is untrusted for update comparisons. Only
  // bytes fetched for this exact URL in this process can yield a cached digest.
  const { payloadDigest: _untrustedDigest, ...staleCached } = metaFromSidecar(cached, cachedLogoPath);
  const now = (options.now ?? (() => new Date()))().getTime();
  // Legacy complete display sidecars predate advert deadlines. They are still
  // reusable for card copy; signed update comparisons must claim a fresh fetch.
  if (cached.advertRetryAfter === undefined && cached.manifestRetryAfter === undefined &&
    cached.authRetryAfter === undefined && cached.authRecoveryAfter === undefined &&
    cached.cardMetadataVersion === CARD_METADATA_VERSION && !includePayloadDigest) {
    return staleCached;
  }
  const claim = await claimAdvertRefresh(sidecarPath, now);
  if (claim === undefined) {
    const current = await readAdvertSidecar(sidecarPath);
    const displaySidecar = await retryIncompleteSkillMetadata(
      sidecarPath, current, fetcher, plugin.source, now);
    const { payloadDigest: _currentDigest, ...display } =
      metaFromSidecar(displaySidecar, cachedLogoPath);
    if (includePayloadDigest) {
      const payloadDigest = await authenticatedDigestDuringWindow(options, plugin.source,
        fetcher, manifestUrl, sidecarPath, authenticatedPath, cacheIdentity, now);
      if (payloadDigest !== undefined) return { ...display, payloadDigest };
    }
    return display;
  }
  const lastAuthenticated = async (): Promise<PrefetchedCardMeta> => {
    if (!includePayloadDigest) return staleCached;
    const payloadDigest = await authenticatedDigestDuringWindow(options, plugin.source,
      fetcher, manifestUrl, sidecarPath, authenticatedPath, cacheIdentity, now);
    return payloadDigest === undefined ? staleCached : { ...staleCached, payloadDigest };
  };
  const manifestBytes = await fetchBounded(
    fetcher,
    manifestUrl,
    MANIFEST_PREFETCH_MAX_BYTES,
  );
  if (manifestBytes === undefined) {
    return lastAuthenticated();
  }
  const signatureUrl = includePayloadDigest
    ? pinnedRawUrl(plugin.source, ".agenc-plugin/signature.json") : undefined;
  const signatureBytes = signatureUrl === undefined ? undefined
    : await fetchBounded(fetcher, signatureUrl, 256 * 1024);
  let payloadDigest: string | undefined;
  if (signatureBytes !== undefined && options.agencHome !== undefined) {
    try { payloadDigest = await verifiedAdvertisedPluginPayloadDigest(manifestBytes, signatureBytes,
      { agencHome: options.agencHome });
    }
    catch { /* An invalid advertised signature is not a verified update. */ }
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(manifestBytes).toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return lastAuthenticated();
    manifest = parsed as Record<string, unknown>;
  } catch {
    return lastAuthenticated();
  }
  if (includePayloadDigest && payloadDigest === undefined) {
    const previous = await lastAuthenticated();
    if (previous.payloadDigest !== undefined) return previous;
  }
  let persistedAuthentication = false;
  if (payloadDigest !== undefined && signatureBytes !== undefined && options.agencHome !== undefined) {
    authenticatedAdverts.set(cacheIdentity, { manifest: manifestBytes, signature: signatureBytes });
    if (authenticatedAdverts.size > 128) authenticatedAdverts.delete(authenticatedAdverts.keys().next().value!);
    try {
      await writeAuthenticatedAdvert(authenticatedPath, manifestUrl, manifestBytes, signatureBytes,
        options.agencHome);
      persistedAuthentication = true;
    }
    catch { /* Current invocation can still use its authenticated bytes. */ }
  }
  const surface = cardInterface(manifest.interface);
  const description = cardString(manifest.description, CARD_DESCRIPTION_MAX);
  const version = cardString(manifest.version, 64);
  const commands =
    typeof manifest.commands === "object" && manifest.commands !== null
      ? cardComponentRows(
          Object.entries(manifest.commands as Record<string, unknown>).map(
            ([name, entry]) => ({
              name,
              description:
                typeof entry === "object" && entry !== null
                  ? (entry as { description?: unknown }).description
                  : undefined,
              argumentHint:
                typeof entry === "object" && entry !== null
                  ? (entry as { argumentHint?: unknown }).argumentHint
                  : undefined,
            }),
          ),
        )
      : undefined;
  const skillMetadata = await prefetchSkillRows(fetcher, plugin.source, manifest.skills);
  const skills = skillMetadata?.rows;
  const declaredLogo =
    typeof manifest.interface === "object" && manifest.interface !== null
      ? ((manifest.interface as { logo?: unknown }).logo)
      : undefined;
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
  const sidecar = {
    cardMetadataVersion: skillMetadata?.pending.length ? undefined : CARD_METADATA_VERSION,
    pendingSkillFetches: skillMetadata?.pending ?? [],
    ...(skillMetadata?.pending.length ? {
      skillRetryAfter: new Date(now + OFFICIAL_MARKETPLACE_REFRESH_MS).toISOString(),
    } : {}),
    ...(surface?.displayName !== undefined
      ? { displayName: surface.displayName }
      : {}),
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(surface !== undefined ? { interface: surface } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(commands !== undefined ? { commands } : {}),
    ...(logoExt !== undefined ? { logoExt } : {}),
  };
  await finishAdvertRefresh(sidecarPath, claim, sidecar, persistedAuthentication);
  return { ...metaFromSidecar(sidecar, logoPath),
    ...(payloadDigest !== undefined ? { payloadDigest } : {}) };
}

async function catalogRowsForMarketplace(
  options: MarketplaceOperationOptions,
  marketplace: Marketplace,
  product: string | undefined,
  lastRefreshTime: string,
  includePayloadDigests: boolean,
  includeAllProducts: boolean,
  selectPlugin?: (marketplaceName: string, plugin: MarketplacePlugin) => boolean,
): Promise<readonly MarketplaceCatalogPluginRow[]> {
  const rows: MarketplaceCatalogPluginRow[] = [];
  for (const plugin of marketplace.plugins) {
    if (plugin.policy.installation === "NOT_AVAILABLE") continue;
    if (!includeAllProducts && !marketplacePluginSupportsProduct(plugin.policy, product)) continue;
    if (selectPlugin !== undefined && !selectPlugin(marketplace.name, plugin)) continue;
    const manifestLogo = await resolveLogoPath(marketplace.root, plugin);
    const prefetched = await prefetchPinnedCardMeta(options, plugin, includePayloadDigests);
    let localPayloadDigest: string | undefined;
    let localVersion: string | undefined;
    if (plugin.source.type === "local") {
      try {
        const manifest: unknown = JSON.parse(await readFile(
          join(plugin.source.path, ".agenc-plugin", "plugin.json"), "utf8"));
        if (typeof manifest === "object" && manifest !== null) {
          localVersion = cardString((manifest as Record<string, unknown>).version, 64);
        }
      } catch { /* An unreadable local manifest has no advertised version. */ }
    }
    if (includePayloadDigests && plugin.source.type === "local" && options.agencHome !== undefined) {
      try {
        localPayloadDigest = await verifiedAdvertisedPluginPayloadDigest(
          await readFile(join(plugin.source.path, ".agenc-plugin", "plugin.json")),
          await readFile(join(plugin.source.path, ".agenc-plugin", "signature.json")),
          { agencHome: options.agencHome },
        );
      } catch { /* Local packages may be unsigned. */ }
    }
    const logoPath = manifestLogo ?? prefetched?.logoPath;
    const logoRoot =
      manifestLogo !== undefined
        ? marketplace.root
        : prefetched?.logoPath !== undefined
          ? logoCacheRoot(options)
          : undefined;
    // The marketplace entry's own declarations win field-by-field over
    // what the pinned manifest reports; the cast is needed because a
    // spread re-widens exact-optional properties.
    const surface =
      plugin.interface !== undefined || prefetched?.interface !== undefined
        ? ({
            ...(prefetched?.interface ?? {}),
            ...(plugin.interface ?? {}),
          } as MarketplacePlugin["interface"])
        : undefined;
    rows.push({
      id: `${plugin.name}@${marketplace.name}`,
      name: plugin.name,
      marketplace: marketplace.name,
      source: plugin.source,
      policy: plugin.policy,
      ...(surface !== undefined ? { interface: surface } : {}),
      root: marketplace.root,
      lastRefreshTime,
      ...(plugin.source.type === "git" && plugin.source.sha !== undefined
        ? { sourceCommit: plugin.source.sha } : {}),
      ...((prefetched?.payloadDigest ?? localPayloadDigest) !== undefined
        ? { payloadDigest: prefetched?.payloadDigest ?? localPayloadDigest } : {}),
      ...(prefetched?.description !== undefined
        ? { description: prefetched.description }
        : {}),
      ...((prefetched?.version ?? localVersion) !== undefined
        ? { version: prefetched?.version ?? localVersion }
        : {}),
      ...(prefetched?.skills !== undefined ? { skills: prefetched.skills } : {}),
      ...(prefetched?.commands !== undefined
        ? { commands: prefetched.commands }
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
  includePayloadDigests = false,
  includeAllProducts = false,
  selectPlugin?: (marketplaceName: string, plugin: MarketplacePlugin) => boolean,
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
        plugins: await catalogRowsForMarketplace(options, marketplace, product, record.updatedAt,
          includePayloadDigests, includeAllProducts, selectPlugin),
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
