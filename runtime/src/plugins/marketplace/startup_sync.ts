import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  defaultFetch,
  defaultRunProcess,
  type Fetcher,
  type MarketplaceOperationOptions,
  type ProcessRunner,
} from "./marketplace.js";

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
  return await isFile(manifest) && await isFile(curatedPluginsShaPath(agencHome));
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
        throw new Error(
          `curated plugin git sync failed: ${message(gitError)}; HTTP sync failed: ${message(httpError)}; backup archive skipped because a local snapshot exists`,
        );
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
  const repoPath = curatedPluginsRepoPath(agencHome);
  const shaPath = curatedPluginsShaPath(agencHome);
  const remoteSha = await gitLsRemoteHeadSha(gitBinary, gitUrl, run);
  const localSha = await readLocalGitOrShaFile(repoPath, shaPath, gitBinary, run);
  if (localSha === remoteSha && await isDirectory(join(repoPath, ".git"))) {
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
  run: ProcessRunner = defaultRunProcess,
): Promise<string> {
  const repoPath = curatedPluginsRepoPath(agencHome);
  const shaPath = curatedPluginsShaPath(agencHome);
  const remoteSha = await fetchCuratedRepoRemoteSha(apiBaseUrl, fetcher);
  const localSha = await readShaFile(shaPath);
  if (localSha === remoteSha && await isDirectory(repoPath)) {
    return remoteSha;
  }
  const stagedRepoDir = await prepareCuratedRepoParentAndTempDir(repoPath);
  try {
    const zipball = await fetchCuratedRepoZipball(apiBaseUrl, remoteSha, fetcher);
    await extractZipballToDir(zipball, stagedRepoDir, run);
    await ensureMarketplaceManifestExists(stagedRepoDir);
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
  run: ProcessRunner = defaultRunProcess,
): Promise<string> {
  const repoPath = curatedPluginsRepoPath(agencHome);
  const shaPath = curatedPluginsShaPath(agencHome);
  const stagedRepoDir = await prepareCuratedRepoParentAndTempDir(repoPath);
  try {
    const archiveMetadata = await fetchText(backupArchiveUrl, fetcher);
    const parsed = JSON.parse(archiveMetadata) as { readonly download_url?: string; readonly downloadUrl?: string };
    const downloadUrl = parsed.download_url ?? parsed.downloadUrl;
    if (!downloadUrl) throw new Error("curated plugins backup archive response did not include a download URL");
    const zipball = await fetchBytes(downloadUrl, fetcher);
    await extractZipballToDir(zipball, stagedRepoDir, run);
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
  await removeStaleCuratedRepoTempDirs(parent);
  return mkdtemp(join(parent, "plugins-clone-"));
}

async function removeStaleCuratedRepoTempDirs(parent: string): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("plugins-clone-")) continue;
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
  const response = await fetcher(url);
  const body = await response.text();
  if (!response.ok) throw new Error(`request from ${url} failed with status ${response.status}: ${body}`);
  return body;
}

async function fetchBytes(url: string, fetcher: Fetcher): Promise<Buffer> {
  const response = await fetcher(url);
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`request from ${url} failed with status ${response.status}: ${body.toString("utf8")}`);
  }
  return body;
}

async function extractZipballToDir(bytes: Buffer, destination: string, run: ProcessRunner): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const zipPath = join(destination, ".archive.zip");
  await writeFile(zipPath, bytes);
  await run("unzip", ["-q", zipPath, "-d", destination], {});
  await rm(zipPath, { force: true });
  await stripSingleArchiveRoot(destination);
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

async function readShaFile(shaPath: string): Promise<string | null> {
  const sha = await readFile(shaPath, "utf8").then((value) => value.trim(), () => null);
  return sha && sha.length > 0 ? sha : null;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((value) => value.isFile(), () => false);
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
