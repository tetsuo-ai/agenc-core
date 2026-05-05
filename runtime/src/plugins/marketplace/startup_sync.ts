import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import { dirname, join, resolve, sep } from "node:path";
import {
  defaultFetch,
  defaultRunProcess,
  type Fetcher,
  type MarketplaceOperationOptions,
  type ProcessRunner,
} from "./marketplace.js";
import {
  assertHttpsOrLoopbackUrl,
  fetchWithTimeout,
  readResponseBytesWithLimit,
  readResponseErrorText,
  readResponseTextWithLimit,
  redactUrlForError,
} from "./fetchGuards.js";
import { validateMarketplaceManifest } from "../validation.js";

export interface StartupSyncOptions extends MarketplaceOperationOptions {
  readonly gitUrl?: string;
  readonly apiBaseUrl?: string;
  readonly backupArchiveUrl?: string;
  readonly gitBinary?: string;
}

const CURATED_PLUGINS_RELATIVE_DIR = "plugins/marketplaces/agenc-curated";
const CURATED_PLUGINS_SHA_FILE = "plugins/marketplaces/agenc-curated.sha";
const CURATED_PLUGINS_GIT_URL = "https://agenc.tech/plugins/curated.git";
const CURATED_PLUGINS_API_BASE_URL = "https://agenc.tech/api/plugins/curated";
const CURATED_PLUGINS_BACKUP_ARCHIVE_URL = "https://agenc.tech/api/plugins/curated/archive";
const CURATED_PLUGINS_BACKUP_ARCHIVE_FALLBACK_VERSION = "export-backup";
const CURATED_PLUGINS_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const CURATED_PLUGINS_MAX_EXTRACTED_BYTES = 250 * 1024 * 1024;
const CURATED_PLUGINS_MAX_ARCHIVE_ENTRIES = 20_000;
const CURATED_PLUGINS_MAX_METADATA_BYTES = 64 * 1024;
const inflateRawAsync = promisify(inflateRaw);

export function curatedPluginsRepoPath(agencHome: string): string {
  return join(agencHome, CURATED_PLUGINS_RELATIVE_DIR);
}

export async function readCuratedPluginsSha(agencHome: string): Promise<string | null> {
  return readShaFile(curatedPluginsShaPath(agencHome));
}

export function curatedPluginsShaPath(agencHome: string): string {
  return join(agencHome, CURATED_PLUGINS_SHA_FILE);
}

export async function hasLocalCuratedPluginsSnapshot(agencHome: string): Promise<boolean> {
  const manifest = join(curatedPluginsRepoPath(agencHome), ".agents", "plugins", "marketplace.json");
  return await isFile(manifest) &&
    await isFile(curatedPluginsShaPath(agencHome)) &&
    await marketplaceManifestValid(manifest);
}

export async function syncCuratedPluginsRepo(
  agencHome: string,
  options: StartupSyncOptions = {},
): Promise<string> {
  const gitBinary = options.gitBinary ?? "git";
  const run = options.runProcess ?? defaultRunProcess;
  const fetcher = options.fetcher ?? defaultFetch;
  const gitUrl = options.gitUrl ?? CURATED_PLUGINS_GIT_URL;
  try {
    return await syncCuratedPluginsRepoViaGit(agencHome, gitUrl, gitBinary, run);
  } catch (gitError) {
    try {
      return await syncCuratedPluginsRepoViaHttp(
        agencHome,
        options.apiBaseUrl ?? CURATED_PLUGINS_API_BASE_URL,
        fetcher,
        run,
      );
    } catch (httpError) {
      if (await hasLocalCuratedPluginsSnapshot(agencHome)) {
        return await readCuratedPluginsSha(agencHome) ?? CURATED_PLUGINS_BACKUP_ARCHIVE_FALLBACK_VERSION;
      }
      return syncCuratedPluginsRepoViaBackupArchive(
        agencHome,
        options.backupArchiveUrl ?? CURATED_PLUGINS_BACKUP_ARCHIVE_URL,
        fetcher,
        run,
      ).catch((archiveError) => {
        throw new Error(
          `curated plugin git sync failed: ${message(gitError)}; HTTP sync failed: ${message(httpError)}; backup archive sync failed: ${message(archiveError)}`,
        );
      });
    }
  }
}

export async function syncCuratedPluginsRepoViaGit(
  agencHome: string,
  gitUrl: string,
  gitBinary: string,
  run: ProcessRunner = defaultRunProcess,
): Promise<string> {
  assertHttpsOrLoopbackUrl(gitUrl, "curated plugins git URL", { allowLoopbackHttp: true });
  const repoPath = curatedPluginsRepoPath(agencHome);
  const shaPath = curatedPluginsShaPath(agencHome);
  const remoteSha = await gitLsRemoteHeadSha(gitBinary, gitUrl, run);
  const localSha = await readLocalGitOrShaFile(repoPath, shaPath, gitBinary, run);
  if (localSha === remoteSha && await isDirectory(join(repoPath, ".git")) && await hasLocalCuratedPluginsSnapshot(agencHome)) {
    return remoteSha;
  }
  const stagedRepoDir = await prepareCuratedRepoParentAndTempDir(repoPath);
  try {
    await run(gitBinary, ["clone", "--depth", "1", gitUrl, stagedRepoDir], {});
    const clonedSha = await gitHeadSha(stagedRepoDir, gitBinary, run);
    if (clonedSha !== remoteSha) {
      throw new Error(`curated plugins clone HEAD mismatch: expected ${remoteSha}, got ${clonedSha}`);
    }
    await ensureMarketplaceManifestExists(stagedRepoDir);
    await activateCuratedRepo(repoPath, stagedRepoDir);
    await writeCuratedPluginsSha(shaPath, remoteSha);
    return remoteSha;
  } catch (error) {
    await rm(stagedRepoDir, { recursive: true, force: true });
    throw error;
  }
}

export async function syncCuratedPluginsRepoViaHttp(
  agencHome: string,
  apiBaseUrl: string,
  fetcher: Fetcher = defaultFetch,
  _run: ProcessRunner = defaultRunProcess,
): Promise<string> {
  const repoPath = curatedPluginsRepoPath(agencHome);
  const shaPath = curatedPluginsShaPath(agencHome);
  const remoteSha = await fetchCuratedRepoRemoteSha(apiBaseUrl, fetcher);
  const localSha = await readShaFile(shaPath);
  if (localSha === remoteSha && await isDirectory(repoPath) && await hasLocalCuratedPluginsSnapshot(agencHome)) {
    return remoteSha;
  }
  const stagedRepoDir = await prepareCuratedRepoParentAndTempDir(repoPath);
  try {
    const zipball = await fetchCuratedRepoZipball(apiBaseUrl, remoteSha, fetcher);
    await extractZipballToDir(zipball, stagedRepoDir);
    await ensureMarketplaceManifestExists(stagedRepoDir);
    await verifyExtractedCuratedRepoSha(stagedRepoDir, remoteSha);
    await activateCuratedRepo(repoPath, stagedRepoDir);
    await writeCuratedPluginsSha(shaPath, remoteSha);
    return remoteSha;
  } catch (error) {
    await rm(stagedRepoDir, { recursive: true, force: true });
    throw error;
  }
}

export async function syncCuratedPluginsRepoViaBackupArchive(
  agencHome: string,
  backupArchiveUrl: string,
  fetcher: Fetcher = defaultFetch,
  _run: ProcessRunner = defaultRunProcess,
): Promise<string> {
  const repoPath = curatedPluginsRepoPath(agencHome);
  const shaPath = curatedPluginsShaPath(agencHome);
  const stagedRepoDir = await prepareCuratedRepoParentAndTempDir(repoPath);
  try {
    const archiveUrl = assertHttpsOrLoopbackUrl(backupArchiveUrl, "curated plugins backup metadata URL", {
      allowLoopbackHttp: true,
    });
    const archiveMetadata = await fetchText(backupArchiveUrl, fetcher);
    const parsed = JSON.parse(archiveMetadata) as { readonly download_url?: string; readonly downloadUrl?: string };
    const downloadUrl = parsed.download_url ?? parsed.downloadUrl;
    if (!downloadUrl) throw new Error("curated plugins backup archive response did not include a download URL");
    const downloadParsed = assertHttpsOrLoopbackUrl(downloadUrl, "curated plugins backup download URL", {
      allowLoopbackHttp: true,
      ...(archiveUrl.hostname.toLowerCase() === "agenc.tech" ? { allowedHttpsHosts: ["agenc.tech"] } : {}),
    });
    const zipball = await fetchBytes(downloadParsed.toString(), fetcher);
    await extractZipballToDir(zipball, stagedRepoDir);
    await ensureMarketplaceManifestExists(stagedRepoDir);
    const version = await readExtractedBackupArchiveGitSha(stagedRepoDir) ??
      CURATED_PLUGINS_BACKUP_ARCHIVE_FALLBACK_VERSION;
    await activateCuratedRepo(repoPath, stagedRepoDir);
    await writeCuratedPluginsSha(shaPath, version);
    return version;
  } catch (error) {
    await rm(stagedRepoDir, { recursive: true, force: true });
    throw error;
  }
}

async function prepareCuratedRepoParentAndTempDir(repoPath: string): Promise<string> {
  const parent = dirname(repoPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stagingParent = join(parent, ".curated-staging");
  await mkdir(stagingParent, { recursive: true, mode: 0o700 });
  await removeStaleCuratedRepoTempDirs(stagingParent);
  return mkdtemp(join(stagingParent, "clone-"));
}

async function removeStaleCuratedRepoTempDirs(parent: string): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("clone-")) continue;
    const path = join(parent, entry.name);
    const metadata = await stat(path).catch(() => null);
    if (metadata === null || metadata.mtimeMs >= cutoff) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

async function activateCuratedRepo(repoPath: string, stagedRepoPath: string): Promise<void> {
  if (await pathExists(repoPath)) {
    const backup = `${repoPath}.backup-${process.pid}-${Date.now()}`;
    await rename(repoPath, backup);
    try {
      await rename(stagedRepoPath, repoPath);
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rename(backup, repoPath).catch(() => {});
      throw error;
    }
  } else {
    await rename(stagedRepoPath, repoPath);
  }
}

async function ensureMarketplaceManifestExists(repoPath: string): Promise<void> {
  const manifest = join(repoPath, ".agents", "plugins", "marketplace.json");
  if (!await isFile(manifest)) {
    throw new Error(`curated plugins archive missing marketplace manifest at ${manifest}`);
  }
}

async function writeCuratedPluginsSha(shaPath: string, remoteSha: string): Promise<void> {
  await mkdir(dirname(shaPath), { recursive: true, mode: 0o700 });
  await writeFile(shaPath, `${remoteSha}\n`, { mode: 0o600 });
}

async function readLocalGitOrShaFile(
  repoPath: string,
  shaPath: string,
  gitBinary: string,
  run: ProcessRunner,
): Promise<string | null> {
  if (await isDirectory(join(repoPath, ".git"))) {
    const sha = await gitHeadSha(repoPath, gitBinary, run).catch(() => null);
    if (sha !== null) return sha;
  }
  return readShaFile(shaPath);
}

async function gitLsRemoteHeadSha(
  gitBinary: string,
  gitUrl: string,
  run: ProcessRunner,
): Promise<string> {
  const output = await run(gitBinary, ["ls-remote", gitUrl, "HEAD"], {});
  const firstLine = output.stdout.split("\n").find((line) => line.trim().length > 0);
  const sha = firstLine?.split(/\s+/u)[0];
  if (!sha) throw new Error("git ls-remote returned empty output for curated plugins repo");
  return sha;
}

async function gitHeadSha(repoPath: string, gitBinary: string, run: ProcessRunner): Promise<string> {
  const output = await run(gitBinary, ["-C", repoPath, "rev-parse", "HEAD"], {});
  const sha = output.stdout.trim();
  if (!sha) throw new Error(`git rev-parse HEAD returned empty output in ${repoPath}`);
  return sha;
}

async function fetchCuratedRepoRemoteSha(apiBaseUrl: string, fetcher: Fetcher): Promise<string> {
  const text = await fetchText(`${apiBaseUrl.replace(/\/+$/u, "")}/sha`, fetcher);
  const parsed = JSON.parse(text) as { readonly sha?: string };
  if (!parsed.sha) throw new Error("curated plugins repository response did not include a HEAD sha");
  return parsed.sha;
}

async function fetchCuratedRepoZipball(
  apiBaseUrl: string,
  remoteSha: string,
  fetcher: Fetcher,
): Promise<Buffer> {
  return fetchBytes(`${apiBaseUrl.replace(/\/+$/u, "")}/zipball/${encodeURIComponent(remoteSha)}`, fetcher);
}

async function fetchText(url: string, fetcher: Fetcher): Promise<string> {
  assertHttpsOrLoopbackUrl(url, "curated plugins metadata URL", { allowLoopbackHttp: true });
  const response = await fetchWithTimeout(
    fetcher,
    url,
    {},
    { label: `curated plugins metadata request from ${redactUrlForError(url)}` },
  );
  if (!response.ok) {
    const body = await readResponseErrorText(response);
    throw new Error(`request from ${redactUrlForError(url)} failed with status ${response.status}: ${body}`);
  }
  return readResponseTextWithLimit(
    response,
    CURATED_PLUGINS_MAX_METADATA_BYTES,
    `request from ${redactUrlForError(url)}`,
  );
}

async function fetchBytes(url: string, fetcher: Fetcher): Promise<Buffer> {
  assertHttpsOrLoopbackUrl(url, "curated plugins archive URL", { allowLoopbackHttp: true });
  const response = await fetchWithTimeout(
    fetcher,
    url,
    {},
    { label: `curated plugins archive request from ${redactUrlForError(url)}` },
  );
  if (!response.ok) {
    const body = await readResponseErrorText(response);
    throw new Error(`request from ${redactUrlForError(url)} failed with status ${response.status}: ${body}`);
  }
  return readResponseBytesWithLimit(response, CURATED_PLUGINS_MAX_ARCHIVE_BYTES, `request from ${redactUrlForError(url)}`);
}

async function extractZipballToDir(bytes: Buffer, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await extractZipEntries(bytes, destination);
  await stripSingleArchiveRoot(destination);
}

async function extractZipEntries(bytes: Buffer, destination: string): Promise<void> {
  const entries = readZipCentralDirectory(bytes);
  let totalExtracted = 0;
  for (const entry of entries) {
    const outputPath = checkedArchiveOutputPath(destination, entry.name);
    if (entry.isDirectory) {
      await mkdir(outputPath, { recursive: true, mode: 0o700 });
      continue;
    }
    totalExtracted += entry.uncompressedSize;
    if (totalExtracted > CURATED_PLUGINS_MAX_EXTRACTED_BYTES) {
      throw new Error(`curated plugins archive extracted size exceeded ${CURATED_PLUGINS_MAX_EXTRACTED_BYTES} bytes`);
    }
    const content = await inflateZipEntry(bytes, entry);
    if (content.byteLength !== entry.uncompressedSize) {
      throw new Error(`curated plugins archive entry '${entry.name}' size mismatch`);
    }
    const actualCrc32 = crc32(content);
    if (actualCrc32 !== entry.crc32) {
      throw new Error(`curated plugins archive entry '${entry.name}' CRC mismatch`);
    }
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, content, { mode: 0o600 });
  }
}

function readZipCentralDirectory(bytes: Buffer): readonly ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = bytes.readUInt32LE(eocdOffset + 12);
  let offset = bytes.readUInt32LE(eocdOffset + 16);
  if (entryCount > CURATED_PLUGINS_MAX_ARCHIVE_ENTRIES) {
    throw new Error(`curated plugins archive has too many entries: ${entryCount}`);
  }
  if (offset + centralDirectorySize > bytes.byteLength) {
    throw new Error("curated plugins archive central directory is truncated");
  }
  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength) {
      throw new Error("curated plugins archive central directory entry is truncated");
    }
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("curated plugins archive central directory is malformed");
    }
    const method = bytes.readUInt16LE(offset + 10);
    const crc32Value = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error("curated plugins archive uses unsupported zip64 entries");
    }
    if (offset + 46 + nameLength + extraLength + commentLength > bytes.byteLength) {
      throw new Error("curated plugins archive central directory entry is truncated");
    }
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if ((externalAttributes >>> 16 & 0o170000) === 0o120000) {
      throw new Error(`curated plugins archive entry '${name}' is a symlink`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`curated plugins archive entry '${name}' uses unsupported compression method ${method}`);
    }
    entries.push({
      name,
      method,
      crc32: crc32Value,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith("/"),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minOffset = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("curated plugins archive is missing a zip central directory");
}

async function inflateZipEntry(bytes: Buffer, entry: ZipEntry): Promise<Buffer> {
  if (entry.localHeaderOffset + 30 > bytes.byteLength) {
    throw new Error(`curated plugins archive local header is truncated for '${entry.name}'`);
  }
  if (bytes.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
    throw new Error(`curated plugins archive local header is malformed for '${entry.name}'`);
  }
  const localCrc32 = bytes.readUInt32LE(entry.localHeaderOffset + 14);
  if (localCrc32 !== entry.crc32) {
    throw new Error(`curated plugins archive entry '${entry.name}' CRC metadata mismatch`);
  }
  const localNameLength = bytes.readUInt16LE(entry.localHeaderOffset + 26);
  const localExtraLength = bytes.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.byteLength) {
    throw new Error(`curated plugins archive entry '${entry.name}' is truncated`);
  }
  const compressed = bytes.subarray(dataStart, dataEnd);
  if (entry.method === 0) return Buffer.from(compressed);
  return inflateRawAsync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
}

function checkedArchiveOutputPath(destination: string, entryName: string): string {
  const root = resolve(destination);
  const parts = entryName.split(/[\\/]+/u).filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) {
    throw new Error("curated plugins archive entry has an empty path");
  }
  if (parts.some((part) => part === "..") || entryName.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(entryName)) {
    throw new Error(`curated plugins archive entry '${entryName}' escapes extraction root`);
  }
  const output = resolve(root, ...parts);
  if (output !== root && !output.startsWith(`${root}${sep}`)) {
    throw new Error(`curated plugins archive entry '${entryName}' escapes extraction root`);
  }
  return output;
}

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly isDirectory: boolean;
}

const CRC32_TABLE = makeCrc32Table();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

async function stripSingleArchiveRoot(destination: string): Promise<void> {
  const entries = await readdir(destination, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());
  if (dirs.length !== 1 || files.length !== 0) return;
  const inner = join(destination, dirs[0]!.name);
  const tmp = `${destination}.swap-${process.pid}-${Date.now()}`;
  await rename(inner, tmp);
  await rm(destination, { recursive: true, force: true });
  await rename(tmp, destination);
}

async function readExtractedBackupArchiveGitSha(repoPath: string): Promise<string | null> {
  const headPath = join(repoPath, ".git", "HEAD");
  const head = await readFile(headPath, "utf8").then((value) => value.trim(), () => null);
  if (head === null || head.length === 0) return null;
  if (!head.startsWith("ref: ")) return head;
  const reference = head.slice("ref: ".length).trim();
  if (!reference.startsWith("refs/") || reference.includes("..")) {
    throw new Error(`curated plugins backup archive git ref is invalid: ${reference}`);
  }
  const refSha = await readFile(join(repoPath, ".git", reference), "utf8").then((value) => value.trim(), () => null);
  return refSha && refSha.length > 0 ? refSha : null;
}

async function verifyExtractedCuratedRepoSha(
  repoPath: string,
  expectedSha: string,
): Promise<void> {
  const extractedSha = await readExtractedBackupArchiveGitSha(repoPath);
  if (extractedSha === null) {
    throw new Error("curated plugins archive is missing embedded git identity");
  }
  if (extractedSha !== expectedSha) {
    throw new Error(`curated plugins archive git identity mismatch: expected ${expectedSha}, got ${extractedSha}`);
  }
}

async function readShaFile(shaPath: string): Promise<string | null> {
  const sha = await readFile(shaPath, "utf8").then((value) => value.trim(), () => null);
  return sha && sha.length > 0 ? sha : null;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((value) => value.isFile(), () => false);
}

async function marketplaceManifestValid(path: string): Promise<boolean> {
  return validateMarketplaceManifest(path)
    .then((result) => result.success, () => false);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((value) => value.isDirectory(), () => false);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
