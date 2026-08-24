/**
 * AgenC-managed installer and resolver for Ledger's official wallet-cli.
 *
 * The AgenC runtime is self-contained and intentionally does not assume that
 * npm, Bun, pnpm, or yarn exists on the host. Instead, an explicitly approved
 * install resolves the current `latest` release from the canonical npm
 * registry, downloads the matching platform package, verifies its sha512
 * integrity, and extracts it under `<AGENC_HOME>/tools/wallet-cli`.
 *
 * Nothing in this module installs automatically. Callers must obtain user
 * confirmation before invoking `installLatestWalletCli`.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createWriteStream,
} from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { extract, list, type ReadEntry } from "tar";
import { resolveHomeContext } from "../../config/home.js";
import * as lockfile from "../../utils/lockfile.js";

export const WALLET_CLI_PACKAGE = "@ledgerhq/wallet-cli";
export const WALLET_CLI_INSTALL_TOOL_NAME = "install_ledger_wallet_cli";
export const WALLET_CLI_STATUS_TOOL_NAME = "ledger_wallet_cli_status";

const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const METADATA_MAX_BYTES = 512 * 1024;
const ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;
const UNPACKED_MAX_BYTES = 256 * 1024 * 1024;
const VERIFY_TIMEOUT_MS = 15_000;
const CURRENT_SCHEMA_VERSION = 1;
const VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export interface PlatformSpec {
  readonly packageName: string;
  readonly archiveExecutable: string;
  readonly executableName: string;
}

const PLATFORM_SPECS: Readonly<Record<string, PlatformSpec>> = Object.freeze({
  "linux:x64": {
    packageName: "@ledgerhq/wallet-cli-linux-x64",
    archiveExecutable: "package/bin/wallet-cli",
    executableName: "wallet-cli",
  },
  "linux:arm64": {
    packageName: "@ledgerhq/wallet-cli-linux-arm64",
    archiveExecutable: "package/bin/wallet-cli",
    executableName: "wallet-cli",
  },
  "darwin:arm64": {
    packageName: "@ledgerhq/wallet-cli-darwin-arm64",
    archiveExecutable: "package/bin/wallet-cli",
    executableName: "wallet-cli",
  },
  "win32:x64": {
    packageName: "@ledgerhq/wallet-cli-windows-x64",
    archiveExecutable: "package/bin/wallet-cli.exe",
    executableName: "wallet-cli.exe",
  },
});

interface NpmDistribution {
  readonly tarball: string;
  readonly integrity: string;
  readonly unpackedSize?: number;
}

interface WrapperMetadata {
  readonly name: string;
  readonly version: string;
  readonly optionalDependencies: Readonly<Record<string, string>>;
}

interface PlatformMetadata {
  readonly name: string;
  readonly version: string;
  readonly bin: Readonly<Record<string, string>>;
  readonly dist: NpmDistribution;
}

interface ManagedWalletCliRecord {
  readonly schemaVersion: 1;
  readonly package: typeof WALLET_CLI_PACKAGE;
  readonly platformPackage: string;
  readonly version: string;
  readonly integrity: string;
  readonly installedAt: string;
}

export interface WalletCliExecutable {
  readonly path: string;
  readonly source: "managed" | "path";
  readonly version?: string;
}

export interface WalletCliStatus {
  readonly installed: boolean;
  readonly executable: string | null;
  readonly source: "managed" | "path" | null;
  readonly version: string | null;
  readonly installTool: typeof WALLET_CLI_INSTALL_TOOL_NAME;
  readonly package: typeof WALLET_CLI_PACKAGE;
}

export interface WalletCliInstallResult {
  readonly installed: true;
  readonly executable: string;
  readonly version: string;
  readonly platformPackage: string;
  readonly package: typeof WALLET_CLI_PACKAGE;
  readonly alreadyCurrent: boolean;
}

export interface WalletCliProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}

export interface WalletCliInstallDependencies {
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly now?: () => Date;
  readonly extractPackage?: (
    archivePath: string,
    destination: string,
    spec: PlatformSpec,
    expectedVersion: string,
  ) => Promise<string>;
  readonly verifyExecutable?: (
    executable: string,
    expectedVersion: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface WalletCliInstallOptions {
  readonly agencHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
  readonly dependencies?: WalletCliInstallDependencies;
}

function platformSpec(
  platform = process.platform,
  arch = process.arch,
): PlatformSpec | null {
  return PLATFORM_SPECS[`${platform}:${arch}`] ?? null;
}

function walletCliRoot(agencHome: string): string {
  return join(resolve(agencHome), "tools", "wallet-cli");
}

function currentRecordPath(agencHome: string): string {
  return join(walletCliRoot(agencHome), "current.json");
}

function managedExecutablePath(
  agencHome: string,
  version: string,
  executableName: string,
): string {
  return join(
    walletCliRoot(agencHome),
    "versions",
    version,
    "bin",
    executableName,
  );
}

function isDescendantPath(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function validateManagedRoot(
  agencHome: string,
  create: boolean,
): Promise<{ readonly root: string; readonly canonicalRoot: string } | null> {
  const root = walletCliRoot(agencHome);
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("AgenC wallet-cli tool root must be a real directory");
  }
  const [canonicalHome, canonicalRoot] = await Promise.all([
    realpath(resolve(agencHome)),
    realpath(root),
  ]);
  if (!isDescendantPath(canonicalHome, canonicalRoot)) {
    throw new Error("AgenC wallet-cli tool root escapes AGENC_HOME");
  }
  return { root, canonicalRoot };
}

async function validateManagedDirectory(
  canonicalRoot: string,
  directory: string,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("AgenC wallet-cli managed path must be a real directory");
  }
  const canonicalDirectory = await realpath(directory);
  if (!isDescendantPath(canonicalRoot, canonicalDirectory)) {
    throw new Error("AgenC wallet-cli managed path escapes its tool root");
  }
  return canonicalDirectory;
}

function resolvedAgencHome(
  agencHome: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  return resolveHomeContext(
    agencHome === undefined ? env : { ...env, AGENC_HOME: agencHome },
    env.HOME === undefined ? {} : { platformHome: env.HOME },
  ).path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManagedRecord(value: unknown): value is ManagedWalletCliRecord {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === CURRENT_SCHEMA_VERSION &&
    value.package === WALLET_CLI_PACKAGE &&
    typeof value.platformPackage === "string" &&
    value.platformPackage.startsWith("@ledgerhq/wallet-cli-") &&
    typeof value.version === "string" &&
    VERSION_PATTERN.test(value.version) &&
    typeof value.integrity === "string" &&
    /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value.integrity) &&
    typeof value.installedAt === "string"
  );
}

async function isExecutable(
  path: string,
  options: { readonly allowSymlink?: boolean } = {},
): Promise<boolean> {
  try {
    const fileStat =
      options.allowSymlink === true ? await stat(path) : await lstat(path);
    if (!fileStat.isFile()) return false;
    if (process.platform !== "win32") {
      await access(path, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

async function isSafeManagedExecutable(
  executable: string,
  canonicalRoot: string,
): Promise<boolean> {
  const canonicalExecutable = await realpath(executable).catch(() => null);
  return (
    canonicalExecutable !== null &&
    isDescendantPath(canonicalRoot, canonicalExecutable) &&
    (await isExecutable(executable))
  );
}

async function readManagedRecord(
  agencHome: string,
): Promise<ManagedWalletCliRecord | null> {
  try {
    const value = JSON.parse(
      await readFile(currentRecordPath(agencHome), "utf8"),
    ) as unknown;
    return isManagedRecord(value) ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function pathCandidates(
  command: string,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  if (pathValue.length === 0) return [];
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];
  const candidates: string[] = [];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      candidates.push(join(directory, `${command}${extension.toLowerCase()}`));
      if (extension !== extension.toLowerCase()) {
        candidates.push(join(directory, `${command}${extension}`));
      }
    }
  }
  return candidates;
}

async function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  for (const candidate of pathCandidates(command, env)) {
    // Package managers commonly expose global CLI binaries through symlinks.
    if (await isExecutable(candidate, { allowSymlink: true })) return candidate;
  }
  return null;
}

export async function resolveWalletCliExecutable(options: {
  readonly agencHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
} = {}): Promise<WalletCliExecutable | null> {
  const env = options.env ?? process.env;
  const agencHome = resolvedAgencHome(options.agencHome, env);
  const spec = platformSpec(options.platform, options.arch);
  const record = await readManagedRecord(agencHome);
  if (record !== null && spec !== null && record.platformPackage === spec.packageName) {
    const root = await validateManagedRoot(agencHome, false);
    if (root === null) return null;
    const executable = managedExecutablePath(
      agencHome,
      record.version,
      spec.executableName,
    );
    if (await isSafeManagedExecutable(executable, root.canonicalRoot)) {
      return {
        path: executable,
        source: "managed",
        version: record.version,
      };
    }
  }

  const external = await findOnPath("wallet-cli", env);
  return external === null
    ? null
    : { path: external, source: "path" };
}

function parseVersion(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      isRecord(parsed) &&
      parsed.ok === true &&
      isRecord(parsed.data) &&
      typeof parsed.data.version === "string" &&
      VERSION_PATTERN.test(parsed.data.version)
    ) {
      return parsed.data.version;
    }
  } catch {
    // Older wallet-cli builds may emit plain text.
  }
  const match = trimmed.match(
    /(?:wallet-cli\s+)?v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/u,
  );
  return match?.[1] ?? null;
}

export function runWalletCliProcess(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    /** Disable stdout capture for commands whose payload must not enter logs. */
    readonly captureStdout?: boolean;
  },
): Promise<WalletCliProcessResult> {
  return new Promise((resolveResult) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [
        "ignore",
        options.captureStdout === false ? "ignore" : "pipe",
        "pipe",
      ],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: WalletCliProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolveResult(result);
    };
    const abort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best effort. The close/error event completes the result.
      }
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            abort();
          }, options.timeoutMs);
    timer?.unref?.();

    if (options.signal?.aborted === true) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (data) => {
      stdout += data.toString("utf8");
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString("utf8");
    });
    child.on("error", (error) => {
      finish({
        stdout,
        stderr: `${stderr}${String(error)}`,
        code: -1,
        timedOut,
      });
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code, timedOut });
    });
  });
}

export async function getWalletCliStatus(options: {
  readonly agencHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
} = {}): Promise<WalletCliStatus> {
  const resolved = await resolveWalletCliExecutable(options);
  if (resolved === null) {
    return {
      installed: false,
      executable: null,
      source: null,
      version: null,
      installTool: WALLET_CLI_INSTALL_TOOL_NAME,
      package: WALLET_CLI_PACKAGE,
    };
  }
  return {
    installed: true,
    executable: resolved.path,
    source: resolved.source,
    // Managed installs are version-bound by current.json and verified during
    // installation. Do not execute an arbitrary PATH binary merely to answer a
    // read-only status query.
    version: resolved.version ?? null,
    installTool: WALLET_CLI_INSTALL_TOOL_NAME,
    package: WALLET_CLI_PACKAGE,
  };
}

async function boundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new Error("npm registry metadata exceeds the allowed size");
    }
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("npm registry metadata response has no readable body");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("npm registry metadata emitted an invalid chunk");
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("metadata size limit exceeded");
        throw new Error("npm registry metadata exceeds the allowed size");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function registryMetadataUrl(packageName: string, tagOrVersion: string): URL {
  return new URL(
    `/${encodeURIComponent(packageName)}/${encodeURIComponent(tagOrVersion)}`,
    REGISTRY_ORIGIN,
  );
}

async function fetchMetadata(
  packageName: string,
  tagOrVersion: string,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const url = registryMetadataUrl(packageName, tagOrVersion);
  const response = await fetchImpl(url, {
    redirect: "error",
    signal,
    headers: { accept: "application/json" },
  });
  if (!response.ok || (response.url.length > 0 && response.url !== url.href)) {
    throw new Error(
      `npm registry metadata request failed for ${packageName}@${tagOrVersion} (HTTP ${response.status})`,
    );
  }
  const parsed = JSON.parse(
    await boundedText(response, METADATA_MAX_BYTES),
  ) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`npm registry returned invalid metadata for ${packageName}`);
  }
  return parsed;
}

function parseWrapperMetadata(value: Record<string, unknown>): WrapperMetadata {
  if (
    value.name !== WALLET_CLI_PACKAGE ||
    typeof value.version !== "string" ||
    !VERSION_PATTERN.test(value.version) ||
    !isRecord(value.optionalDependencies)
  ) {
    throw new Error("official wallet-cli latest metadata is invalid");
  }
  const optionalDependencies: Record<string, string> = {};
  for (const [name, version] of Object.entries(value.optionalDependencies)) {
    if (typeof version === "string") optionalDependencies[name] = version;
  }
  return {
    name: value.name,
    version: value.version,
    optionalDependencies,
  };
}

function parsePlatformMetadata(
  value: Record<string, unknown>,
  spec: PlatformSpec,
  expectedVersion: string,
): PlatformMetadata {
  if (
    value.name !== spec.packageName ||
    value.version !== expectedVersion ||
    !isRecord(value.bin) ||
    !isRecord(value.dist)
  ) {
    throw new Error("official wallet-cli platform metadata is invalid");
  }
  const binValue = value.bin["wallet-cli"];
  const expectedBin =
    spec.executableName.endsWith(".exe")
      ? "./bin/wallet-cli.exe"
      : "./bin/wallet-cli";
  const integrity = value.dist.integrity;
  const tarball = value.dist.tarball;
  const unpackedSize = value.dist.unpackedSize;
  if (
    typeof binValue !== "string" ||
    binValue !== expectedBin ||
    typeof integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity) ||
    typeof tarball !== "string" ||
    (unpackedSize !== undefined &&
      (!Number.isSafeInteger(unpackedSize) ||
        (unpackedSize as number) <= 0 ||
        (unpackedSize as number) > UNPACKED_MAX_BYTES))
  ) {
    throw new Error("official wallet-cli platform distribution is invalid");
  }
  const tarballUrl = new URL(tarball);
  if (
    tarballUrl.protocol !== "https:" ||
    tarballUrl.origin !== REGISTRY_ORIGIN ||
    !tarballUrl.pathname.startsWith(
      `/@ledgerhq/${spec.packageName.slice("@ledgerhq/".length)}/-/`,
    ) ||
    !tarballUrl.pathname.endsWith(`-${expectedVersion}.tgz`) ||
    tarballUrl.search.length > 0 ||
    tarballUrl.hash.length > 0
  ) {
    throw new Error("official wallet-cli tarball URL is not canonical");
  }
  const bin: Record<string, string> = { "wallet-cli": binValue };
  return {
    name: value.name,
    version: value.version,
    bin,
    dist: {
      tarball: tarballUrl.href,
      integrity,
      ...(typeof unpackedSize === "number" ? { unpackedSize } : {}),
    },
  };
}

function expectedIntegrityDigest(integrity: string): Buffer {
  const encoded = integrity.slice("sha512-".length);
  const digest = Buffer.from(encoded, "base64");
  if (digest.byteLength !== 64) {
    throw new Error("official wallet-cli sha512 integrity is invalid");
  }
  return digest;
}

async function downloadArchive(
  distribution: NpmDistribution,
  destination: string,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): Promise<void> {
  const response = await fetchImpl(distribution.tarball, {
    redirect: "error",
    signal,
    headers: { accept: "application/octet-stream" },
  });
  if (
    !response.ok ||
    (response.url.length > 0 && response.url !== distribution.tarball)
  ) {
    throw new Error(
      `wallet-cli download failed without redirects (HTTP ${response.status})`,
    );
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > ARCHIVE_MAX_BYTES
    ) {
      throw new Error("wallet-cli archive has an invalid content length");
    }
  }
  if (response.body === null) {
    throw new Error("wallet-cli archive response has no readable body");
  }

  const digest = createHash("sha512");
  let received = 0;
  const source = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream<Uint8Array>,
  );
  source.on("data", (chunk: Buffer) => {
    received += chunk.byteLength;
    if (received > ARCHIVE_MAX_BYTES) {
      source.destroy(new Error("wallet-cli archive exceeds the allowed size"));
      return;
    }
    digest.update(chunk);
  });
  await pipeline(
    source,
    createWriteStream(destination, {
      flags: "wx",
      mode: 0o600,
    }),
  );
  if (received <= 0) throw new Error("wallet-cli archive is empty");
  const actual = digest.digest();
  const expected = expectedIntegrityDigest(distribution.integrity);
  if (!actual.equals(expected)) {
    throw new Error("wallet-cli archive failed sha512 integrity verification");
  }
}

function normalizedArchivePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/u, "");
}

function archivePathIsSafe(value: string): boolean {
  const normalized = normalizedArchivePath(value);
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:\//u.test(normalized) &&
    !normalized.split("/").includes("..")
  );
}

async function extractVerifiedPackage(
  archivePath: string,
  destination: string,
  spec: PlatformSpec,
  expectedVersion: string,
): Promise<string> {
  const allowedFiles = new Set([
    "package/LICENSE",
    "package/THIRD_PARTY_NOTICES.md",
    "package/package.json",
    spec.archiveExecutable,
  ]);
  let executableEntries = 0;
  let unpackedBytes = 0;
  await list({
    file: archivePath,
    strict: true,
    onentry(entry: ReadEntry) {
      const path = normalizedArchivePath(entry.path);
      if (!archivePathIsSafe(path)) {
        throw new Error(`wallet-cli archive contains an unsafe path: ${path}`);
      }
      if (
        entry.type !== "File" &&
        entry.type !== "Directory" &&
        entry.meta !== true
      ) {
        throw new Error(
          `wallet-cli archive contains unsupported entry type: ${entry.type}`,
        );
      }
      if (entry.type === "File") {
        unpackedBytes += entry.size;
        if (unpackedBytes > UNPACKED_MAX_BYTES) {
          throw new Error("wallet-cli archive exceeds the unpacked size limit");
        }
      }
      if (path === spec.archiveExecutable) {
        if (entry.type !== "File" || entry.size <= 0) {
          throw new Error("wallet-cli archive executable is not a regular file");
        }
        executableEntries += 1;
      }
    },
  });
  if (executableEntries !== 1) {
    throw new Error("wallet-cli archive must contain exactly one executable");
  }

  await mkdir(destination, { recursive: true, mode: 0o700 });
  await extract({
    file: archivePath,
    cwd: destination,
    strict: true,
    strip: 1,
    preserveOwner: false,
    noMtime: true,
    filter(path) {
      return allowedFiles.has(normalizedArchivePath(path));
    },
  });
  const executable = join(destination, "bin", spec.executableName);
  const executableStat = await lstat(executable);
  if (!executableStat.isFile() || executableStat.size <= 0) {
    throw new Error("wallet-cli extracted executable is invalid");
  }
  const manifest = JSON.parse(
    await readFile(join(destination, "package.json"), "utf8"),
  ) as unknown;
  const expectedBin =
    spec.executableName.endsWith(".exe")
      ? "./bin/wallet-cli.exe"
      : "./bin/wallet-cli";
  if (
    !isRecord(manifest) ||
    manifest.name !== spec.packageName ||
    manifest.version !== expectedVersion ||
    !isRecord(manifest.bin) ||
    manifest.bin["wallet-cli"] !== expectedBin
  ) {
    throw new Error("wallet-cli extracted package manifest is invalid");
  }
  await chmod(executable, 0o700);
  return executable;
}

async function verifyExecutableVersion(
  executable: string,
  expectedVersion: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runWalletCliProcess(executable, ["--version"], {
    cwd: process.cwd(),
    timeoutMs: VERIFY_TIMEOUT_MS,
    signal,
  });
  if (result.code !== 0 || parseVersion(result.stdout) !== expectedVersion) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `downloaded wallet-cli failed version verification${detail ? `: ${detail}` : ""}`,
    );
  }
}

async function writeCurrentRecord(
  agencHome: string,
  record: ManagedWalletCliRecord,
): Promise<void> {
  const path = currentRecordPath(agencHome);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      await rename(temporary, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EEXIST" && code !== "EPERM")) {
        throw error;
      }
      await rm(path, { force: true });
      await rename(temporary, path);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function installUnderLock(
  options: WalletCliInstallOptions,
  agencHome: string,
  spec: PlatformSpec,
  managedRoot: { readonly root: string; readonly canonicalRoot: string },
): Promise<WalletCliInstallResult> {
  const dependencies = options.dependencies ?? {};
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is unavailable; cannot download wallet-cli");
  }
  const progress = options.onProgress ?? (() => {});
  progress("Checking the official npm registry for wallet-cli@latest");
  const wrapper = parseWrapperMetadata(
    await fetchMetadata(
      WALLET_CLI_PACKAGE,
      "latest",
      fetchImpl,
      options.signal,
    ),
  );
  if (wrapper.optionalDependencies[spec.packageName] !== wrapper.version) {
    throw new Error(
      `wallet-cli@${wrapper.version} does not publish ${spec.packageName}@${wrapper.version}`,
    );
  }
  const platform = parsePlatformMetadata(
    await fetchMetadata(
      spec.packageName,
      wrapper.version,
      fetchImpl,
      options.signal,
    ),
    spec,
    wrapper.version,
  );

  const finalExecutable = managedExecutablePath(
    agencHome,
    wrapper.version,
    spec.executableName,
  );
  const existing = await readManagedRecord(agencHome);
  if (
    existing?.version === wrapper.version &&
    existing.platformPackage === spec.packageName &&
    existing.integrity === platform.dist.integrity &&
    (await isSafeManagedExecutable(
      finalExecutable,
      managedRoot.canonicalRoot,
    ))
  ) {
    await (dependencies.verifyExecutable ?? verifyExecutableVersion)(
      finalExecutable,
      wrapper.version,
      options.signal,
    );
    return {
      installed: true,
      executable: finalExecutable,
      version: wrapper.version,
      platformPackage: spec.packageName,
      package: WALLET_CLI_PACKAGE,
      alreadyCurrent: true,
    };
  }

  const root = managedRoot.root;
  const staging = join(root, `.staging-${process.pid}-${randomUUID()}`);
  const archive = join(staging, "wallet-cli.tgz");
  const extracted = join(staging, "package");
  try {
    await mkdir(staging, { recursive: false, mode: 0o700 });
    progress(
      `Downloading ${spec.packageName}@${wrapper.version} from registry.npmjs.org`,
    );
    await downloadArchive(
      platform.dist,
      archive,
      fetchImpl,
      options.signal,
    );
    progress("Verifying and extracting the official wallet-cli package");
    const stagedExecutable = await (
      dependencies.extractPackage ?? extractVerifiedPackage
    )(archive, extracted, spec, wrapper.version);
    await (dependencies.verifyExecutable ?? verifyExecutableVersion)(
      stagedExecutable,
      wrapper.version,
      options.signal,
    );

    const versionsDirectory = join(root, "versions");
    await validateManagedDirectory(
      managedRoot.canonicalRoot,
      versionsDirectory,
    );
    const versionDirectory = join(versionsDirectory, wrapper.version);
    await rm(versionDirectory, { recursive: true, force: true });
    await rename(extracted, versionDirectory);
    await writeCurrentRecord(agencHome, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      package: WALLET_CLI_PACKAGE,
      platformPackage: spec.packageName,
      version: wrapper.version,
      integrity: platform.dist.integrity,
      installedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    });
    progress(`Installed wallet-cli ${wrapper.version}`);
    return {
      installed: true,
      executable: finalExecutable,
      version: wrapper.version,
      platformPackage: spec.packageName,
      package: WALLET_CLI_PACKAGE,
      alreadyCurrent: false,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function installLatestWalletCli(
  options: WalletCliInstallOptions = {},
): Promise<WalletCliInstallResult> {
  const env = options.env ?? process.env;
  const agencHome = resolvedAgencHome(options.agencHome, env);
  const spec = platformSpec(
    options.dependencies?.platform,
    options.dependencies?.arch,
  );
  if (spec === null) {
    throw new Error(
      `Ledger wallet-cli does not publish a binary for ${options.dependencies?.platform ?? process.platform}/${options.dependencies?.arch ?? process.arch}`,
    );
  }
  const managedRoot = await validateManagedRoot(agencHome, true);
  if (managedRoot === null) {
    throw new Error("failed to create AgenC wallet-cli tool root");
  }
  const release = await lockfile.lock(managedRoot.root, {
    realpath: false,
    stale: 15 * 60_000,
    retries: {
      retries: 30,
      minTimeout: 100,
      maxTimeout: 1_000,
      factor: 1.2,
    },
  });
  try {
    const lockedRoot = await validateManagedRoot(agencHome, false);
    if (lockedRoot === null) {
      throw new Error("AgenC wallet-cli tool root disappeared during install");
    }
    return await installUnderLock(options, agencHome, spec, lockedRoot);
  } finally {
    await release();
  }
}
