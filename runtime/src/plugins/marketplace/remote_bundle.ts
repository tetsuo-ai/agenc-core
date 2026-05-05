import { gunzipSync } from "node:zlib";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { findPluginManifestPath } from "../manifest.js";
import { sanitizeMarketplaceInstallName } from "./marketplace.js";
import {
  defaultFetch,
  type Fetcher,
} from "./marketplace.js";
import {
  assertHttpsOrLoopbackUrl,
  fetchWithTimeout,
  readResponseBytesWithLimit,
  readResponseErrorText,
  redactUrlForError,
} from "./fetchGuards.js";

export interface ValidatedRemotePluginBundle {
  readonly pluginId: string;
  readonly marketplaceName: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly bundleDownloadUrl: string;
}

export interface RemotePluginBundleInstallResult {
  readonly pluginId: string;
  readonly installedPath: string;
  readonly version: string;
}

const REMOTE_PLUGIN_BUNDLE_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const REMOTE_PLUGIN_BUNDLE_MAX_EXTRACTED_BYTES = 250 * 1024 * 1024;
const REMOTE_PLUGIN_INSTALL_STAGING_DIR = "plugins/.remote-plugin-install-staging";
const REMOTE_PLUGIN_CACHE_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;

export function validateRemotePluginBundle(
  remotePluginId: string,
  remoteMarketplaceName: string,
  pluginName: string,
  releaseVersion: string | undefined,
  bundleDownloadUrl: string | undefined,
  options: { readonly allowLoopbackHttp?: boolean } = {},
): ValidatedRemotePluginBundle {
  const localMarketplaceName = validateRemotePluginCacheSegment(remoteMarketplaceName, "marketplace name", remotePluginId);
  const localPluginName = validateRemotePluginCacheSegment(pluginName, "plugin name", remotePluginId);
  const pluginVersion = releaseVersion?.trim();
  if (!pluginVersion) {
    throw new Error(`backend did not return a release version for remote plugin '${remotePluginId}'`);
  }
  validatePluginVersionSegment(pluginVersion);
  const url = bundleDownloadUrl?.trim();
  if (!url) {
    throw new Error(`backend did not return a download URL for remote plugin '${remotePluginId}'`);
  }
  try {
    assertHttpsOrLoopbackUrl(url, `remote plugin bundle download URL for '${remotePluginId}'`, {
      allowLoopbackHttp: options.allowLoopbackHttp === true,
    });
  } catch (error) {
    const protocol = parseUrlProtocol(url);
    if (error instanceof Error && error.message.includes("must use HTTPS")) {
      throw new Error(`backend returned an unsupported download URL scheme for remote plugin '${remotePluginId}': ${protocol}`);
    }
    if (error instanceof TypeError) {
      throw new Error(`backend returned an invalid download URL for remote plugin '${remotePluginId}'`);
    }
    throw error;
  }
  return {
    pluginId: `${localPluginName}@${localMarketplaceName}`,
    marketplaceName: localMarketplaceName,
    pluginName: localPluginName,
    pluginVersion,
    bundleDownloadUrl: url,
  };
}

export async function downloadAndInstallRemotePluginBundle(
  agencHome: string,
  bundle: ValidatedRemotePluginBundle,
  fetcher: Fetcher = defaultFetch,
): Promise<RemotePluginBundleInstallResult> {
  assertHttpsOrLoopbackUrl(bundle.bundleDownloadUrl, "remote plugin bundle download URL", {
    allowLoopbackHttp: true,
  });
  const bytes = await downloadRemotePluginBundleWithLimit(
    bundle.bundleDownloadUrl,
    REMOTE_PLUGIN_BUNDLE_MAX_DOWNLOAD_BYTES,
    fetcher,
  );
  return installRemotePluginBundle(agencHome, bundle, Buffer.from(bytes));
}

export async function installRemotePluginBundle(
  agencHome: string,
  bundle: ValidatedRemotePluginBundle,
  bundleBytes: Buffer,
): Promise<RemotePluginBundleInstallResult> {
  const stagingRoot = join(agencHome, REMOTE_PLUGIN_INSTALL_STAGING_DIR);
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const extractDir = await mkdtemp(join(stagingRoot, "remote-plugin-bundle-"));
  try {
    await extractPluginBundleTarGz(bundleBytes, extractDir);
    const pluginRoot = await findExtractedPluginRoot(extractDir);
    await validateExtractedPluginManifest(pluginRoot, bundle);
    const installRoot = remotePluginInstallRoot(agencHome, bundle);
    const parent = dirname(installRoot);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const backup = `${installRoot}.backup-${process.pid}-${Date.now()}`;
    let hadExisting = false;
    try {
      if (await pathExists(installRoot)) {
        await rename(installRoot, backup);
        hadExisting = true;
      }
      await rename(pluginRoot, installRoot);
      if (hadExisting) await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rm(installRoot, { recursive: true, force: true });
      if (hadExisting && await pathExists(backup)) await rename(backup, installRoot);
      throw error;
    }
    return {
      pluginId: bundle.pluginId,
      installedPath: installRoot,
      version: bundle.pluginVersion,
    };
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

export async function extractPluginBundleTarGz(
  bytes: Buffer,
  destination: string,
  maxTotalBytes = REMOTE_PLUGIN_BUNDLE_MAX_EXTRACTED_BYTES,
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const tar = gunzipTarWithLimit(bytes, maxTotalBytes);
  let offset = 0;
  let extractedBytes = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    assertTarHeaderChecksum(header);
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = readTarOctal(header, 124, 12);
    const mode = readTarOctal(header, 100, 8);
    const typeFlag = String.fromCharCode(header[156] ?? 0) || "0";
    const outputPath = checkedTarOutputPath(destination, path);
    if (offset + size > tar.length) {
      throw new Error(`remote plugin bundle tar entry '${path}' is truncated`);
    }
    if (typeFlag === "5") {
      await mkdir(outputPath, { recursive: true, mode: 0o700 });
    } else if (typeFlag === "0" || typeFlag === "\0") {
      extractedBytes = enforceTotalExtractedSize(size, extractedBytes, maxTotalBytes);
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      await writeFile(outputPath, tar.subarray(offset, offset + size), { mode: mode & 0o777 });
      if ((mode & 0o111) !== 0) {
        await chmod(outputPath, mode & 0o777).catch(() => {});
      }
    } else if (typeFlag === "1" || typeFlag === "2") {
      throw new Error(`remote plugin bundle tar entry '${path}' is a link`);
    } else {
      throw new Error(`remote plugin bundle tar entry '${path}' has unsupported type ${typeFlag}`);
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

function parseUrlProtocol(url: string): string {
  try {
    return new URL(url).protocol.replace(/:$/u, "");
  } catch {
    return "invalid";
  }
}

export function checkedTarOutputPath(destination: string, entryName: string): string {
  const root = resolve(destination);
  const parts = entryName.split(/[\\/]+/u).filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) {
    throw new Error("remote plugin bundle tar entry has an empty path");
  }
  if (parts.some((part) => part === "..") || entryName.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(entryName)) {
    throw new Error(`remote plugin bundle tar entry '${entryName}' escapes extraction root`);
  }
  const output = resolve(root, ...parts);
  if (output !== root && !output.startsWith(`${root}${sep}`)) {
    throw new Error(`remote plugin bundle tar entry '${entryName}' escapes extraction root`);
  }
  return output;
}

export function remotePluginInstallRoot(
  agencHome: string,
  bundle: ValidatedRemotePluginBundle,
): string {
  const marketplaceName = validateRemotePluginCacheSegment(bundle.marketplaceName, "marketplace name", bundle.pluginId);
  const pluginName = validateRemotePluginCacheSegment(bundle.pluginName, "plugin name", bundle.pluginId);
  return join(
    agencHome,
    "plugins",
    "cache",
    sanitizeMarketplaceInstallName(marketplaceName),
    sanitizeMarketplaceInstallName(pluginName),
    sanitizeRemotePluginVersionSegment(bundle.pluginVersion),
  );
}

export function validateRemotePluginCacheSegment(
  segment: string,
  kind: "plugin name" | "marketplace name",
  remotePluginId: string,
): string {
  const trimmed = segment.trim();
  if (!REMOTE_PLUGIN_CACHE_SEGMENT_RE.test(trimmed)) {
    throw new Error(
      `backend returned an invalid local plugin id for remote plugin '${remotePluginId}': invalid ${kind}; only ASCII letters, digits, '_' and '-' are allowed`,
    );
  }
  return trimmed;
}

async function downloadRemotePluginBundleWithLimit(
  bundleDownloadUrl: string,
  maxBytes: number,
  fetcher: Fetcher,
): Promise<Buffer> {
  const response = await fetchWithTimeout(
    fetcher,
    bundleDownloadUrl,
    {},
    { label: `remote plugin bundle download from ${redactUrlForError(bundleDownloadUrl)}` },
  );
  if (!response.ok) {
    const body = await readResponseErrorText(response);
    throw new Error(`remote plugin bundle download from ${redactUrlForError(bundleDownloadUrl)} failed with status ${response.status}: ${body}`);
  }
  return readResponseBytesWithLimit(response, maxBytes, `remote plugin bundle download from ${redactUrlForError(bundleDownloadUrl)}`);
}

async function findExtractedPluginRoot(extractionRoot: string): Promise<string> {
  if (await findPluginManifestPath(extractionRoot) !== null) {
    return extractionRoot;
  }
  const entries = await readdir(extractionRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 1) {
    const nested = join(extractionRoot, directories[0]!.name);
    if (await findPluginManifestPath(nested) !== null) {
      return nested;
    }
  }
  throw new Error("remote plugin bundle did not contain a standard plugin root with plugin.json");
}

function validatePluginVersionSegment(version: string): void {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/u.test(version) ||
    version === "." ||
    version === ".."
  ) {
    throw new Error(`invalid remote plugin release version segment: ${version}`);
  }
}

async function validateExtractedPluginManifest(
  pluginRoot: string,
  bundle: ValidatedRemotePluginBundle,
): Promise<void> {
  const manifestPath = await findPluginManifestPath(pluginRoot);
  if (manifestPath === null) {
    throw new Error("remote plugin bundle did not contain a plugin manifest");
  }
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
    readonly name?: unknown;
    readonly version?: unknown;
  };
  if (parsed.name !== bundle.pluginName) {
    throw new Error(`remote plugin bundle manifest name mismatch: expected '${bundle.pluginName}', got '${String(parsed.name)}'`);
  }
  if (parsed.version !== bundle.pluginVersion) {
    throw new Error(`remote plugin bundle manifest version mismatch: expected '${bundle.pluginVersion}', got '${String(parsed.version)}'`);
  }
}

function sanitizeRemotePluginVersionSegment(version: string): string {
  validatePluginVersionSegment(version);
  return version;
}

function readTarString(header: Buffer, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul >= 0 ? nul : slice.length).toString("utf8");
}

function readTarOctal(header: Buffer, offset: number, length: number): number {
  const raw = readTarString(header, offset, length).trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/u.test(raw)) {
    throw new Error("remote plugin bundle tar entry has an invalid octal header");
  }
  return Number.parseInt(raw, 8);
}

function assertTarHeaderChecksum(header: Buffer): void {
  const expected = readTarOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (expected !== actual) {
    throw new Error("remote plugin bundle tar entry has an invalid checksum");
  }
}

function gunzipTarWithLimit(bytes: Buffer, maxTotalBytes: number): Buffer {
  try {
    const output = gunzipSync(bytes, { maxOutputLength: maxTotalBytes + 1 });
    if (output.byteLength > maxTotalBytes) {
      throw new Error(`remote plugin bundle decompressed size exceeded maximum size of ${maxTotalBytes} bytes`);
    }
    return output;
  } catch (error) {
    if (error instanceof Error && error.message.includes("maximum size")) throw error;
    throw new Error(`remote plugin bundle could not be decompressed within ${maxTotalBytes} bytes`);
  }
}

function enforceTotalExtractedSize(
  entrySize: number,
  extractedBytes: number,
  maxTotalBytes: number,
): number {
  const next = extractedBytes + entrySize;
  if (!Number.isSafeInteger(next) || next > maxTotalBytes) {
    throw new Error(`remote plugin bundle extracted size would be ${next} bytes, exceeding the maximum total size of ${maxTotalBytes} bytes`);
  }
  return next;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readInstalledRemotePluginManifest(installPath: string): Promise<unknown> {
  const manifestPath = await findPluginManifestPath(installPath);
  if (manifestPath === null) return null;
  return JSON.parse(await readFile(manifestPath, "utf8"));
}
