import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  getKnownMarketplacesFilePath,
  loadKnownMarketplacesConfig,
  normalizeMarketplaceName,
  removeMarketplaceInventoryEntryForRepair,
  sanitizeMarketplaceInstallName,
  updateMarketplaceInventory,
  type MarketplaceInventory,
  type MarketplaceInventoryMutationAuthority,
  type KnownMarketplace,
} from "./inventory.js";
import { ConfigParseError } from "../../utils/errors.js";
import {
  parseMarketplaceManifestText,
  type MarketplaceCatalogPluginSource,
  type MarketplacePluginAuthPolicy,
  type MarketplacePluginInstallPolicy,
  type RawMarketplaceManifest,
  type RawMarketplaceManifestPlugin,
} from "./catalog.js";
import type {
  MarketplaceSource as InventoryMarketplaceSource,
} from "../../utils/plugins/schemas.js";
import { pluginMarketplaceRootPath } from "../directories.js";
import { loadPluginManifest } from "../manifest.js";
import type { PluginManifest, PluginManifestInterface } from "../manifest-schema.js";
import {
  pluginSourceNeedsRedaction,
  redactPluginSource,
} from "../resolution.js";
import {
  assertHttpsOrLoopbackUrl,
  fetchWithTimeout as fetchWithTimeoutGuard,
  readResponseErrorText,
  readResponseTextWithLimit,
  redactUrlForError,
} from "./fetchGuards.js";
import { parseMarketplaceInput } from "./parseMarketplaceInput.js";

export type MarketplaceSourceType = "local" | "git" | "url";

/** Installable subset of the one canonical marketplace-source schema. */
export type MarketplaceSource = Exclude<
  InventoryMarketplaceSource,
  { readonly source: "hostPattern" | "pathPattern" }
>;

export interface MarketplaceRecord {
  readonly name: string;
  readonly source: string;
  readonly sourceType: MarketplaceSourceType;
  readonly sourceDescriptor: MarketplaceSource;
  readonly installedPath: string;
  readonly manifestPath: string;
  readonly ref?: string;
  readonly sparse?: string;
  readonly revision?: string;
  readonly autoUpdate?: boolean;
  readonly refreshable?: boolean;
  readonly updatedAt: string;
}

export interface MarketplaceIndex {
  readonly version: 1;
  readonly marketplaces: Readonly<Record<string, MarketplaceRecord>>;
}

export interface MarketplaceInterface {
  readonly displayName?: string;
}

export type {
  MarketplacePluginAuthPolicy,
  MarketplacePluginInstallPolicy,
  RawMarketplaceManifest,
  RawMarketplaceManifestPlugin,
} from "./catalog.js";

export interface MarketplacePluginPolicy {
  readonly installation: MarketplacePluginInstallPolicy;
  readonly authentication: MarketplacePluginAuthPolicy;
  readonly products?: readonly string[];
}

export type MarketplacePluginSource =
  | { readonly type: "local"; readonly path: string }
  | {
      readonly type: "git";
      readonly url: string;
      readonly path?: string;
      readonly ref?: string;
      readonly sha?: string;
    };

export interface ResolvedMarketplacePlugin {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly marketplaceName: string;
  readonly source: MarketplacePluginSource;
  readonly policy: MarketplacePluginPolicy;
  readonly interface?: PluginManifestInterface;
  readonly manifest?: PluginManifest;
}

export interface MarketplacePlugin {
  readonly name: string;
  readonly source: MarketplacePluginSource;
  readonly policy: MarketplacePluginPolicy;
  readonly interface?: PluginManifestInterface;
}

export interface Marketplace {
  readonly name: string;
  readonly path: string;
  readonly root: string;
  readonly interface?: MarketplaceInterface;
  readonly plugins: readonly MarketplacePlugin[];
}

export interface MarketplaceListError {
  readonly path: string;
  readonly message: string;
}

export interface MarketplaceListOutcome {
  readonly marketplaces: readonly Marketplace[];
  readonly errors: readonly MarketplaceListError[];
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly environment: Readonly<Record<string, string | undefined>>;
  },
) => Promise<ProcessResult>;

export type FetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly body?: ReadableStream<Uint8Array> | null;
  readonly text: () => Promise<string>;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
};

export type Fetcher = (
  url: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

export interface MarketplaceOperationOptions {
  readonly pluginStorageRoot: string;
  readonly workspaceRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly runProcess?: ProcessRunner;
  readonly fetcher?: Fetcher;
  readonly onProgress?: (message: string) => void;
}

export interface AddMarketplaceInput extends MarketplaceOperationOptions {
  readonly source: string | MarketplaceSource;
  readonly name?: string;
  readonly ref?: string;
  readonly sparse?: string;
  readonly force?: boolean;
  readonly autoUpdate?: boolean;
}

export interface AddMarketplaceResult {
  readonly marketplace: MarketplaceRecord;
  readonly replaced: boolean;
}

export interface RemoveMarketplaceInput extends MarketplaceOperationOptions {
  readonly name: string;
}

export interface RemoveMarketplaceResult {
  readonly marketplaceName: string;
  readonly marketplace?: MarketplaceRecord;
  readonly removedInstall: boolean;
  readonly repairedInventory: boolean;
}

export interface UpgradeMarketplaceInput extends MarketplaceOperationOptions {
  readonly name?: string;
}

export interface UpgradeMarketplaceEntryResult {
  readonly marketplace: MarketplaceRecord;
  readonly previousRevision?: string;
  readonly changed: boolean;
}

export interface SkippedMarketplaceUpgradeResult {
  readonly marketplace: MarketplaceRecord;
  readonly reason: string;
}

export interface UpgradeMarketplaceResult {
  readonly upgraded: readonly UpgradeMarketplaceEntryResult[];
  readonly skipped: readonly SkippedMarketplaceUpgradeResult[];
}

const MARKETPLACE_MANIFEST_RELATIVE_PATH = ".agenc-plugin/marketplace.json";
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_MAX_OUTPUT_BYTES = 1_048_576;
const MARKETPLACE_URL_MANIFEST_MAX_BYTES = 1 * 1024 * 1024;
const GIT_NO_HOOKS_ARGS = ["-c", "core.hooksPath=/dev/null"] as const;

export function marketplaceStoreRoot(options: MarketplaceOperationOptions): string {
  return pluginMarketplaceRootPath({
    pluginStorageRoot: options.pluginStorageRoot,
  });
}

export function marketplaceInstalledPath(
  name: string,
  options: MarketplaceOperationOptions,
): string {
  return join(marketplaceStoreRoot(options), sanitizeMarketplaceInstallName(name));
}

export function marketplaceIndexPath(options: MarketplaceOperationOptions): string {
  return getKnownMarketplacesFilePath(marketplaceInventoryAuthority(options));
}

function marketplaceInventoryAuthority(
  options: MarketplaceOperationOptions,
): MarketplaceInventoryMutationAuthority {
  return {
    pluginsDirectory: options.pluginStorageRoot,
  };
}

function marketplaceIndexFromInventory(
  inventory: MarketplaceInventory,
): MarketplaceIndex {
  return {
    version: 1,
    marketplaces: Object.fromEntries(
      Object.entries(inventory)
        .map(([name, value]) => [
          name,
          marketplaceRecordFromInventory(name, value),
        ] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

function marketplaceInventoryFromIndex(
  index: MarketplaceIndex,
): MarketplaceInventory {
  return Object.fromEntries(
    Object.entries(index.marketplaces)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, record]) => [name, marketplaceInventoryFromRecord(record)]),
  );
}

function installableMarketplaceSource(
  source: InventoryMarketplaceSource,
): MarketplaceSource {
  switch (source.source) {
    case "url":
    case "github":
    case "git":
    case "file":
    case "directory":
      return source;
    case "hostPattern":
    case "pathPattern":
      throw new Error(
        `marketplace inventory contains a policy matcher instead of an installable source: ${source.source}`,
      );
  }
}

function marketplaceSourceType(source: MarketplaceSource): MarketplaceSourceType {
  switch (source.source) {
    case "github":
    case "git":
      return "git";
    case "url":
      return "url";
    case "file":
    case "directory":
      return "local";
  }
}

function marketplaceRecordFromInventory(
  name: string,
  entry: KnownMarketplace,
): MarketplaceRecord {
  const source = persistedMarketplaceSource(installableMarketplaceSource(entry.source));
  const sparse = source.source === "github" || source.source === "git"
    ? source.path ?? source.sparsePaths?.[0]
    : undefined;
  const ref = source.source === "github" || source.source === "git"
    ? source.ref
    : undefined;
  return {
    name,
    source: displayMarketplaceSource(source),
    sourceType: marketplaceSourceType(source),
    sourceDescriptor: source,
    installedPath: entry.installLocation,
    manifestPath: entry.manifestPath,
    ...(ref !== undefined ? { ref } : {}),
    ...(sparse !== undefined ? { sparse } : {}),
    ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
    ...(entry.autoUpdate !== undefined ? { autoUpdate: entry.autoUpdate } : {}),
    ...(entry.refreshable !== undefined
      ? { refreshable: entry.refreshable }
      : {}),
    updatedAt: entry.lastUpdated,
  };
}

function marketplaceInventoryFromRecord(
  record: MarketplaceRecord,
): KnownMarketplace {
  return {
    source: record.sourceDescriptor,
    installLocation: record.installedPath,
    manifestPath: record.manifestPath,
    lastUpdated: record.updatedAt,
    ...(record.autoUpdate !== undefined
      ? { autoUpdate: record.autoUpdate }
      : {}),
    ...(record.revision !== undefined ? { revision: record.revision } : {}),
    ...(record.refreshable !== undefined
      ? { refreshable: record.refreshable }
      : {}),
  };
}

export async function readMarketplaceIndex(
  options: MarketplaceOperationOptions,
): Promise<MarketplaceIndex> {
  const inventory = await loadKnownMarketplacesConfig(
    marketplaceInventoryAuthority(options),
  );
  return marketplaceIndexFromInventory(inventory);
}

export async function addMarketplaceOp(
  input: AddMarketplaceInput,
): Promise<AddMarketplaceResult> {
  const source = await normalizeInputSource(input);
  const storeRoot = marketplaceStoreRoot(input);
  await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  const staged = await stageMarketplaceSource(source, input);
  try {
    const manifestPath = await resolveMarketplaceManifestPath(staged.root, staged.manifestHint);
    const manifest = await readMarketplaceManifest(manifestPath);
    const name = normalizeMarketplaceName(
      input.name ?? inferMarketplaceName(manifest, source),
    );
    await validateMarketplacePluginSources(manifestPath, name, manifest);
    const installedPath = marketplaceInstalledPath(name, input);
    const manifestRelativePath = relative(staged.root, manifestPath);
    const finalManifestPath = join(installedPath, manifestRelativePath);
    const persistedSource = persistedMarketplaceSource(source);
    const sparse = source.source === "git" || source.source === "github"
      ? source.path ?? source.sparsePaths?.[0]
      : undefined;
    const refreshable = marketplaceSourceIsRefreshable(source);
    const marketplace: MarketplaceRecord = {
      name,
      source: displayMarketplaceSource(persistedSource),
      sourceType: staged.sourceType,
      sourceDescriptor: persistedSource,
      installedPath,
      manifestPath: finalManifestPath,
      ...(source.source === "git" && source.ref !== undefined ? { ref: source.ref } : {}),
      ...(source.source === "github" && source.ref !== undefined ? { ref: source.ref } : {}),
      ...(sparse !== undefined ? { sparse } : {}),
      ...(staged.revision !== undefined ? { revision: staged.revision } : {}),
      ...(input.autoUpdate !== undefined ? { autoUpdate: input.autoUpdate } : {}),
      ...(refreshable === false ? { refreshable: false } : {}),
      updatedAt: (input.now ?? (() => new Date()))().toISOString(),
    };
    const replaced = await activateMarketplaceStaging(
      staged.root,
      marketplace,
      input.force === true,
      input,
    );
    return { marketplace, replaced };
  } finally {
    await rm(staged.tempDir, { recursive: true, force: true });
  }
}

export async function removeMarketplaceOp(
  input: RemoveMarketplaceInput,
): Promise<RemoveMarketplaceResult> {
  const name = normalizeMarketplaceName(input.name);
  let removal: QuarantinedMarketplaceInstall | undefined;
  let inventoryCommitted = false;
  try {
    const marketplace = await updateMarketplaceInventory(
      marketplaceInventoryAuthority(input),
      async (inventory) => {
        const index = marketplaceIndexFromInventory(inventory);
        const current = index.marketplaces[name];
        if (current === undefined) {
          throw new Error(`marketplace is not configured: ${name}`);
        }
        removal = await quarantineMarketplaceInstall(current.name, input);
        const nextMarketplaces = { ...index.marketplaces };
        delete nextMarketplaces[name];
        return {
          inventory: marketplaceInventoryFromIndex({
            version: 1,
            marketplaces: nextMarketplaces,
          }),
          result: current,
        };
      },
    );
    inventoryCommitted = true;
    await discardQuarantinedMarketplaceInstall(removal);
    return {
      marketplaceName: marketplace.name,
      marketplace,
      removedInstall: removal?.quarantined === true,
      repairedInventory: false,
    };
  } catch (error) {
    if (!inventoryCommitted) {
      await restoreQuarantinedMarketplaceInstall(removal);
    }
    if (!inventoryCommitted && error instanceof ConfigParseError) {
      return removeMarketplaceFromInvalidInventory(input, name, error);
    }
    throw error;
  }
}

interface QuarantinedMarketplaceInstall {
  readonly installedPath: string;
  readonly quarantinePath: string;
  readonly quarantined: boolean;
}

async function quarantineMarketplaceInstall(
  name: string,
  input: MarketplaceOperationOptions,
): Promise<QuarantinedMarketplaceInstall> {
  const installedPath = marketplaceInstalledPath(name, input);
  await assertMarketplaceInstallPath(installedPath, input);
  const quarantinePath = `${installedPath}.removed-${process.pid}-${randomUUID()}`;
  const quarantined = await pathExists(installedPath);
  if (quarantined) await rename(installedPath, quarantinePath);
  return { installedPath, quarantinePath, quarantined };
}

async function discardQuarantinedMarketplaceInstall(
  removal: QuarantinedMarketplaceInstall | undefined,
): Promise<void> {
  if (removal?.quarantined === true) {
    await rm(removal.quarantinePath, { recursive: true, force: true });
  }
}

async function restoreQuarantinedMarketplaceInstall(
  removal: QuarantinedMarketplaceInstall | undefined,
): Promise<void> {
  if (
    removal?.quarantined === true &&
    await pathExists(removal.quarantinePath)
  ) {
    await rename(removal.quarantinePath, removal.installedPath);
  }
}

async function removeMarketplaceFromInvalidInventory(
  input: RemoveMarketplaceInput,
  name: string,
  parseError: ConfigParseError,
): Promise<RemoveMarketplaceResult> {
  let removal: QuarantinedMarketplaceInstall | undefined;
  let inventoryRepaired = false;
  try {
    const removed = await removeMarketplaceInventoryEntryForRepair(
      marketplaceInventoryAuthority(input),
      name,
      async () => {
        removal = await quarantineMarketplaceInstall(name, input);
      },
    );
    if (!removed) throw parseError;
    inventoryRepaired = true;
    await discardQuarantinedMarketplaceInstall(removal);
    return {
      marketplaceName: name,
      removedInstall: removal?.quarantined === true,
      repairedInventory: true,
    };
  } catch (error) {
    if (!inventoryRepaired) {
      await restoreQuarantinedMarketplaceInstall(removal);
    }
    throw error;
  }
}

export async function upgradeMarketplaceOp(
  input: UpgradeMarketplaceInput,
): Promise<UpgradeMarketplaceResult> {
  const index = await readMarketplaceIndex(input);
  const names = input.name !== undefined
    ? [findRequiredMarketplaceName(index, input.name)]
    : Object.keys(index.marketplaces).sort((a, b) => a.localeCompare(b));
  const upgraded: UpgradeMarketplaceEntryResult[] = [];
  const skipped: SkippedMarketplaceUpgradeResult[] = [];
  for (const name of names) {
    const existing = index.marketplaces[name]!;
    const skipReason = marketplaceUpgradeSkipReason(existing);
    if (skipReason !== undefined) {
      skipped.push({ marketplace: existing, reason: skipReason });
      continue;
    }
    const result = await addMarketplaceOp({
      ...input,
      source: existing.sourceDescriptor,
      name: existing.name,
      force: true,
      autoUpdate: existing.autoUpdate,
    });
    upgraded.push({
      marketplace: result.marketplace,
      ...(existing.revision !== undefined ? { previousRevision: existing.revision } : {}),
      changed: existing.revision === undefined ||
        result.marketplace.revision === undefined ||
        existing.revision !== result.marketplace.revision ||
        result.marketplace.sourceType === "local",
    });
  }
  return { upgraded, skipped };
}

export async function listMarketplaces(
  roots: readonly string[],
): Promise<MarketplaceListOutcome> {
  const marketplaces: Marketplace[] = [];
  const errors: MarketplaceListError[] = [];
  const paths = await discoverMarketplacePathsFromRoots(roots);
  for (const path of paths) {
    try {
      marketplaces.push(await loadMarketplace(path));
    } catch (error) {
      errors.push({
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  marketplaces.sort((a, b) => a.name.localeCompare(b.name));
  return { marketplaces, errors };
}

export async function loadMarketplace(
  manifestPath: string,
  marketplaceNameOverride?: string,
): Promise<Marketplace> {
  const manifest = await readMarketplaceManifest(manifestPath);
  const marketplaceName = marketplaceNameForManifest(manifest, manifestPath, marketplaceNameOverride);
  const root = marketplaceRootDir(manifestPath);
  const plugins: MarketplacePlugin[] = [];
  for (const rawPlugin of manifest.plugins) {
    const resolved = await resolveMarketplacePluginEntry(
      manifestPath,
      marketplaceName,
      rawPlugin,
    );
    plugins.push({
      name: resolved.pluginName,
      source: resolved.source,
      policy: resolved.policy,
      ...(resolved.interface !== undefined ? { interface: resolved.interface } : {}),
    });
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  const displayName = manifest.interface?.displayName ?? manifest.metadata?.displayName;
  return {
    name: marketplaceName,
    path: manifestPath,
    root,
    ...(displayName !== undefined ? { interface: { displayName } } : {}),
    plugins,
  };
}

async function findMarketplacePlugin(
  marketplacePath: string,
  pluginName: string,
  marketplaceNameOverride?: string,
): Promise<ResolvedMarketplacePlugin> {
  const manifest = await readMarketplaceManifest(marketplacePath);
  const marketplaceName = marketplaceNameForManifest(manifest, marketplacePath, marketplaceNameOverride);
  for (const plugin of manifest.plugins) {
    if (plugin.name !== pluginName) continue;
    return resolveMarketplacePluginEntry(marketplacePath, marketplaceName, plugin);
  }
  throw new Error(`plugin '${pluginName}' was not found in marketplace '${marketplaceName}'`);
}

export async function findInstallableMarketplacePlugin(
  marketplacePath: string,
  pluginName: string,
  product?: string,
  marketplaceNameOverride?: string,
): Promise<ResolvedMarketplacePlugin> {
  const resolved = await findMarketplacePlugin(marketplacePath, pluginName, marketplaceNameOverride);
  const products = resolved.policy.products;
  const productAllowed = products === undefined
    ? true
    : products.length > 0 && product !== undefined && products.includes(product);
  if (resolved.policy.installation === "NOT_AVAILABLE" || !productAllowed) {
    throw new Error(`plugin '${resolved.pluginName}' is not available for install in marketplace '${resolved.marketplaceName}'`);
  }
  return resolved;
}

export function findMarketplaceManifestPath(root: string): string | undefined {
  const candidate = join(root, MARKETPLACE_MANIFEST_RELATIVE_PATH);
  try {
    if (statSyncFile(candidate)) return candidate;
  } catch {
    return undefined;
  }
  return undefined;
}

function findMarketplaceName(
  index: MarketplaceIndex,
  name: string,
): string | undefined {
  const lowered = name.toLowerCase();
  return Object.keys(index.marketplaces).find((candidate) => candidate.toLowerCase() === lowered);
}

function findMarketplaceInstallName(
  index: MarketplaceIndex,
  safeName: string,
): string | undefined {
  for (const candidate of Object.keys(index.marketplaces)) {
    try {
      if (sanitizeMarketplaceInstallName(candidate) === safeName) return candidate;
    } catch {
      // Ignore malformed historical entries.
    }
  }
  return undefined;
}

export function normalizeSparsePath(path: string): string {
  const trimmed = path.trim();
  if (
    trimmed.length === 0 ||
    isAbsolute(trimmed) ||
    trimmed.includes("\0") ||
    /^[a-zA-Z]:[\\/]/u.test(trimmed)
  ) {
    throw new Error("--sparse must be a relative marketplace path");
  }
  const parts = trimmed.split(/[\\/]+/u);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("--sparse must not contain empty, '.', or '..' path segments");
  }
  return parts.join("/");
}

export async function defaultRunProcess(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly environment: Readonly<Record<string, string | undefined>>;
  },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const configuredTimeout = Number.parseInt(
      options.environment.AGENC_PLUGIN_GIT_TIMEOUT_MS ?? "",
      10,
    );
    const timeoutMs = options.timeoutMs ??
      (Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_GIT_TIMEOUT_MS);
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...options.environment,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
      },
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timeout.unref();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const appended = appendBoundedOutput(stdout, stdoutBytes, chunk, maxOutputBytes);
      stdout = appended.text;
      stdoutBytes = appended.bytes;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: string) => {
      const appended = appendBoundedOutput(stderr, stderrBytes, chunk, maxOutputBytes);
      stderr = appended.text;
      stderrBytes = appended.bytes;
      stderrTruncated ||= appended.truncated;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (stdoutTruncated) stdout += "\n[stdout truncated]\n";
      if (stderrTruncated) stderr += "\n[stderr truncated]\n";
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const displayArgs = redactProcessArgs(args).join(" ");
      const reason = timedOut ? `timed out after ${timeoutMs}ms` : `failed with exit ${code}`;
      const detail = redactSensitiveText(stderr.trim());
      reject(new Error(`${command} ${displayArgs} ${reason}${detail ? `: ${detail}` : ""}`));
    });
  });
}

async function defaultFetch(
  url: string,
  init: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  } = {},
): Promise<FetchResponse> {
  return fetch(url, init);
}

async function stageMarketplaceSource(
  source: MarketplaceSource,
  options: MarketplaceOperationOptions,
): Promise<{
  readonly tempDir: string;
  readonly root: string;
  readonly sourceType: MarketplaceSourceType;
  readonly manifestHint?: string;
  readonly revision?: string;
}> {
  const storeRoot = marketplaceStoreRoot(options);
  const tempDir = await mkdtemp(join(storeRoot, ".stage-"));
  const root = join(tempDir, "root");
  try {
    switch (source.source) {
      case "directory": {
        const sourcePath = resolvePath(source.path, resolveMarketplaceWorkspaceRoot(options));
        const stats = await stat(sourcePath);
        if (!stats.isDirectory()) {
          throw new Error("directory marketplace source must be a directory");
        }
        await cp(sourcePath, root, { recursive: true, dereference: false });
        return { tempDir, root, sourceType: "local" };
      }
      case "file": {
        const sourcePath = resolvePath(source.path, resolveMarketplaceWorkspaceRoot(options));
        const manifestPath = join(root, MARKETPLACE_MANIFEST_RELATIVE_PATH);
        await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
        await cp(sourcePath, manifestPath, { dereference: false });
        return { tempDir, root, sourceType: "local" };
      }
      case "url": {
        const manifestPath = join(root, MARKETPLACE_MANIFEST_RELATIVE_PATH);
        await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
        assertHttpsOrLoopbackUrl(source.url, "marketplace URL", { allowLoopbackHttp: true });
        const response = await fetchWithTimeoutGuard(
          options.fetcher ?? defaultFetch,
          source.url,
          {
            headers: {
              ...(source.headers ?? {}),
              "User-Agent": "AgenC-Plugin-Manager",
            },
          },
          { label: `marketplace download from ${redactUrlForError(source.url)}` },
        );
        if (!response.ok) {
          const body = await readResponseErrorText(response);
          throw new Error(`marketplace download from ${redactUrlForError(source.url)} failed with status ${response.status}: ${body}`);
        }
        const body = await readResponseTextWithLimit(
          response,
          MARKETPLACE_URL_MANIFEST_MAX_BYTES,
          `marketplace download from ${redactUrlForError(source.url)}`,
        );
        JSON.parse(body);
        await writeFile(manifestPath, body, "utf8");
        return { tempDir, root, sourceType: "url" };
      }
      case "github":
      case "git": {
        const gitUrl = source.source === "github"
          ? `https://github.com/${source.repo.replace(/\.git$/u, "")}.git`
          : source.url;
        assertAllowedGitTransportUrl(gitUrl, "marketplace git URL");
        if (source.ref !== undefined) {
          assertSafeGitRef(source.ref, "marketplace git ref");
        }
        const ref = source.ref;
        const sparse = source.path ?? source.sparsePaths?.[0];
        const run = options.runProcess ?? defaultRunProcess;
        const processOptions = {
          environment: requireMarketplaceEnvironment(options),
        };
        if (sparse !== undefined) {
          const sparsePath = normalizeSparsePath(sparse);
          await run("git", [
            ...GIT_NO_HOOKS_ARGS,
            "clone",
            "--depth",
            "1",
            "--filter=blob:none",
            "--no-checkout",
            "--",
            gitUrl,
            root,
          ], processOptions);
          await run("git", [
            ...GIT_NO_HOOKS_ARGS,
            "sparse-checkout",
            "set",
            "--cone",
            "--",
            sparsePath,
          ], { ...processOptions, cwd: root });
          await run("git", [
            ...GIT_NO_HOOKS_ARGS,
            "checkout",
            ref ?? "HEAD",
          ], { ...processOptions, cwd: root });
        } else {
          const args = [...GIT_NO_HOOKS_ARGS, "clone", "--depth", "1"];
          if (ref !== undefined) args.push("--branch", ref);
          args.push("--", gitUrl, root);
          await run("git", args, processOptions);
        }
        const revision = (await run("git", [
          ...GIT_NO_HOOKS_ARGS,
          "rev-parse",
          "HEAD",
        ], { ...processOptions, cwd: root })).stdout.trim();
        return {
          tempDir,
          root,
          sourceType: "git",
          ...(sparse !== undefined ? { manifestHint: normalizeSparsePath(sparse) } : {}),
          ...(revision.length > 0 ? { revision } : {}),
        };
      }
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function resolveMarketplaceManifestPath(
  root: string,
  manifestHint: string | undefined,
): Promise<string> {
  const candidates = [
    join(root, MARKETPLACE_MANIFEST_RELATIVE_PATH),
    ...(manifestHint
      ? [
          join(root, manifestHint, MARKETPLACE_MANIFEST_RELATIVE_PATH),
        ]
      : []),
  ];
  const resolvedRoot = resolve(root);
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${sep}`)) {
      continue;
    }
    try {
      if ((await stat(resolved)).isFile()) return resolved;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `marketplace source must contain ${MARKETPLACE_MANIFEST_RELATIVE_PATH}`,
  );
}

async function activateMarketplaceStaging(
  stagingRoot: string,
  marketplace: MarketplaceRecord,
  allowReplace: boolean,
  options: MarketplaceOperationOptions,
): Promise<boolean> {
  const installedPath = marketplace.installedPath;
  const storeRoot = marketplaceStoreRoot(options);
  const installedRealParent = await realpath(dirname(installedPath));
  const storeReal = await realpath(storeRoot);
  if (installedRealParent !== storeReal) {
    throw new Error("marketplace install path must stay inside the marketplace store");
  }
  const backupPath = `${installedPath}.backup-${process.pid}-${Date.now()}`;
  let hadExisting = false;
  let activated = false;
  try {
    const replaced = await updateMarketplaceInventory(
      marketplaceInventoryAuthority(options),
      async (inventory) => {
        const index = marketplaceIndexFromInventory(inventory);
        const duplicate = findMarketplaceName(index, marketplace.name);
        if (duplicate !== undefined && duplicate !== marketplace.name) {
          throw new Error(
            `marketplace name differs only by case from existing marketplace: ${duplicate}`,
          );
        }
        if (duplicate !== undefined && !allowReplace) {
          throw new Error(`marketplace already exists: ${marketplace.name}`);
        }
        const safeName = sanitizeMarketplaceInstallName(marketplace.name);
        const installNameConflict = findMarketplaceInstallName(index, safeName);
        if (
          installNameConflict !== undefined &&
          installNameConflict !== marketplace.name
        ) {
          throw new Error(
            `marketplace install directory collides with existing marketplace: ${installNameConflict}`,
          );
        }
        hadExisting = await pathExists(installedPath);
        if (hadExisting) await rename(installedPath, backupPath);
        await rename(stagingRoot, installedPath);
        activated = true;
        const nextIndex: MarketplaceIndex = {
          version: 1,
          marketplaces: {
            ...index.marketplaces,
            [marketplace.name]: marketplace,
          },
        };
        return {
          inventory: marketplaceInventoryFromIndex(nextIndex),
          result: duplicate !== undefined || hadExisting,
        };
      },
    );
    if (hadExisting) {
      await rm(backupPath, { recursive: true, force: true });
    }
    return replaced;
  } catch (error) {
    if (activated) {
      await rm(installedPath, { recursive: true, force: true });
    }
    if (hadExisting && await pathExists(backupPath)) {
      await rename(backupPath, installedPath);
    }
    throw error;
  }
}

async function validateMarketplacePluginSources(
  marketplacePath: string,
  marketplaceName: string,
  manifest: RawMarketplaceManifest,
): Promise<void> {
  for (const plugin of manifest.plugins) {
    await resolveMarketplacePluginEntry(marketplacePath, marketplaceName, plugin);
  }
}

async function resolveMarketplacePluginEntry(
  marketplacePath: string,
  marketplaceName: string,
  plugin: RawMarketplaceManifestPlugin,
): Promise<ResolvedMarketplacePlugin> {
  const source = await resolvePluginSource(marketplacePath, plugin.source);
  const manifest = source.type === "local"
    ? await loadLocalMarketplacePluginManifest(source.path)
    : undefined;
  const pluginInterface = withMarketplaceCategory(manifest?.interface, plugin.category);
  return {
    pluginId: `${plugin.name}@${marketplaceName}`,
    pluginName: plugin.name,
    marketplaceName,
    source,
    policy: {
      installation: plugin.policy?.installation ?? "AVAILABLE",
      authentication: plugin.policy?.authentication ?? "ON_INSTALL",
      ...(plugin.policy?.products !== undefined ? { products: plugin.policy.products } : {}),
    },
    ...(pluginInterface !== undefined ? { interface: pluginInterface } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
  };
}

async function resolvePluginSource(
  marketplacePath: string,
  source: MarketplaceCatalogPluginSource,
): Promise<MarketplacePluginSource> {
  if (typeof source === "string") {
    return { type: "local", path: await resolveLocalPluginSourcePath(marketplacePath, source) };
  }
  if (source.source === "local") {
    return {
      type: "local",
      path: await resolveLocalPluginSourcePath(marketplacePath, source.path),
    };
  }
  if (
    source.source === "url" ||
    source.source === "git-subdir" ||
    source.source === "git"
  ) {
    const path = source.path !== undefined
      ? normalizeRemotePluginSubdir(marketplacePath, source.path)
      : undefined;
    return {
      type: "git",
      url: normalizeMarketplacePluginGitUrl(marketplacePath, source.url),
      ...(path !== undefined ? { path } : {}),
      ...(source.ref !== undefined ? { ref: source.ref } : {}),
      ...(source.sha !== undefined ? { sha: source.sha } : {}),
    };
  }
  throw new Error("unsupported marketplace plugin source");
}

async function resolveLocalPluginSourcePath(
  marketplacePath: string,
  path: string,
): Promise<string> {
  const stripped = path.startsWith("./") ? path.slice(2) : "";
  if (stripped.length === 0) {
    throw new Error("local plugin source path must start with './' and not be empty");
  }
  const parts = stripped.split(/[\\/]+/u);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("local plugin source path must stay within the marketplace root");
  }
  const root = marketplaceRootDir(marketplacePath);
  const candidate = join(root, ...parts);
  const rootReal = await realpath(root);
  const candidateReal = await realpath(candidate).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("local plugin source path must exist within the marketplace root");
    }
    throw error;
  });
  if (!pathIsInside(candidateReal, rootReal)) {
    throw new Error("local plugin source path must stay within the marketplace root");
  }
  return candidateReal;
}

async function loadLocalMarketplacePluginManifest(pluginPath: string): Promise<PluginManifest> {
  const loaded = await loadPluginManifest(pluginPath);
  if (loaded === null) {
    throw new Error("local marketplace plugin source must contain a valid plugin manifest");
  }
  return loaded.manifest;
}

function normalizeRemotePluginSubdir(
  marketplacePath: string,
  path: string,
): string {
  const stripped = path.trim().replace(/^\.\//u, "");
  if (stripped.length === 0) {
    throw new Error("git plugin source path must not be empty");
  }
  const parts = stripped.split(/[\\/]+/u);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("git plugin source path must stay within the repository root");
  }
  void marketplacePath;
  return parts.join("/");
}

function pathIsInside(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizeGitPluginSourceUrl(marketplacePath: string, url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    throw new Error("git plugin source url must not be empty");
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.startsWith("https://github.com/") && !trimmed.endsWith(".git")
      ? `${trimmed}.git`
      : trimmed;
  }
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith(".\\") || trimmed.startsWith("..\\")) {
    return normalizeRelativeGitPluginSourceUrl(marketplacePath, trimmed);
  }
  if (trimmed.startsWith("file://") || trimmed.startsWith("/") || trimmed.startsWith("ssh://") || (trimmed.startsWith("git@") && trimmed.includes(":"))) {
    return trimmed;
  }
  const shorthand = normalizeGithubShorthandUrl(trimmed);
  if (shorthand !== null) return shorthand;
  throw new Error(`invalid git plugin source url: ${trimmed}`);
}

function normalizeMarketplacePluginGitUrl(marketplacePath: string, url: string): string {
  const normalized = normalizeGitPluginSourceUrl(marketplacePath, url);
  assertAllowedGitTransportUrl(normalized, "marketplace plugin git URL");
  return normalized;
}

function assertAllowedGitTransportUrl(url: string, label: string): void {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed !== url || trimmed.includes("\0")) {
    throw new Error(`${label} must be a non-empty Git repository URL`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`${label} must not start with '-'`);
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    assertHttpsOrLoopbackUrl(trimmed, label, { allowLoopbackHttp: true });
    return;
  }
  if (trimmed.startsWith("ssh://") || trimmed.startsWith("file://")) {
    return;
  }
  if (/^[a-zA-Z]:[\\/]/u.test(trimmed)) {
    return;
  }
  if (/^[a-zA-Z0-9._-]+@[^:\s]+:[^\s]+$/u.test(trimmed)) {
    return;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(trimmed)) {
    throw new Error(`${label} uses an unsupported Git transport`);
  }
}

function assertSafeGitRef(ref: string, label: string): void {
  const trimmed = ref.trim();
  if (trimmed.length === 0 || trimmed !== ref || trimmed.includes("\0")) {
    throw new Error(`${label} must be a non-empty Git ref`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`${label} must not start with '-'`);
  }
}

function normalizeRelativeGitPluginSourceUrl(marketplacePath: string, url: string): string {
  const root = marketplaceRootDir(marketplacePath);
  const parts = url.split(/[\\/]+/u);
  const out: string[] = [];
  for (const segment of parts) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new Error("relative git plugin source url must stay within the marketplace root");
    }
    out.push(segment);
  }
  return join(root, ...out);
}

function normalizeGithubShorthandUrl(source: string): string | null {
  const segments = source.split("/");
  if (segments.length !== 2 || !segments.every(isGithubShorthandSegment)) {
    return null;
  }
  const repo = segments[1]!.replace(/\.git$/u, "");
  if (repo.length === 0) return null;
  return `https://github.com/${segments[0]}/${repo}.git`;
}

function isGithubShorthandSegment(segment: string): boolean {
  return segment.length > 0 && /^[a-zA-Z0-9._-]+$/u.test(segment);
}

async function discoverMarketplacePathsFromRoots(roots: readonly string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const root of roots) {
    const manifest = await findMarketplaceManifestPathAsync(root);
    if (manifest !== undefined && !paths.includes(manifest)) {
      paths.push(manifest);
      continue;
    }
    const gitRoot = await findGitRepoRoot(root);
    if (gitRoot !== undefined) {
      const gitManifest = await findMarketplaceManifestPathAsync(gitRoot);
      if (gitManifest !== undefined && !paths.includes(gitManifest)) {
        paths.push(gitManifest);
      }
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

async function findMarketplaceManifestPathAsync(root: string): Promise<string | undefined> {
  const candidate = join(root, MARKETPLACE_MANIFEST_RELATIVE_PATH);
  try {
    if ((await stat(candidate)).isFile()) return candidate;
  } catch {
    return undefined;
  }
  return undefined;
}

async function findGitRepoRoot(start: string): Promise<string | undefined> {
  let current = resolve(start);
  for (;;) {
    try {
      if ((await stat(join(current, ".git"))).isDirectory()) return current;
    } catch {
      // Continue walking.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function marketplaceRootDir(marketplacePath: string): string {
  const resolved = resolve(marketplacePath);
  const suffix = MARKETPLACE_MANIFEST_RELATIVE_PATH.split(/[\\/]+/u);
  const pathParts = resolved.split(/[\\/]+/u);
  if (pathParts.slice(-suffix.length).join("/") === suffix.join("/")) {
    return pathParts.slice(0, -suffix.length).join(sep) || sep;
  }
  throw new Error(
    `marketplace file must be at ${MARKETPLACE_MANIFEST_RELATIVE_PATH}`,
  );
}

async function readMarketplaceManifest(path: string): Promise<RawMarketplaceManifest> {
  const content = await readFile(path, "utf8");
  return parseMarketplaceManifestText(content);
}

function inferMarketplaceName(manifest: RawMarketplaceManifest, source: MarketplaceSource): string {
  if (manifest.metadata?.name !== undefined) return manifest.metadata.name;
  if (manifest.name !== undefined) return manifest.name;
  switch (source.source) {
    case "github":
      return basename(source.repo.replace(/\.git$/u, ""));
    case "git":
    case "url":
      return basename(source.source === "git" ? source.url : source.url, extname(source.source === "git" ? source.url : source.url)).replace(/\.git$/u, "");
    case "directory":
    case "file":
      return basename(source.path, extname(source.path));
  }
}

function marketplaceNameForManifest(
  manifest: RawMarketplaceManifest,
  manifestPath: string,
  marketplaceNameOverride: string | undefined,
): string {
  return normalizeMarketplaceName(
    marketplaceNameOverride ?? inferMarketplaceName(manifest, { source: "file", path: manifestPath }),
  );
}

async function normalizeInputSource(input: AddMarketplaceInput): Promise<MarketplaceSource> {
  if (typeof input.source !== "string") {
    return applyMarketplaceInputOverrides(input.source, input);
  }
  const parsed = await parseMarketplaceInput(input.source, {
    workspaceRoot: resolveMarketplaceWorkspaceRoot(input),
  });
  if (!parsed.ok) {
    if ("error" in parsed) throw new Error(parsed.error);
    throw new Error(`unrecognized marketplace source: ${input.source}`);
  }
  return applyMarketplaceInputOverrides(parsed.source, input);
}

function applyMarketplaceInputOverrides(
  source: MarketplaceSource,
  input: Pick<AddMarketplaceInput, "ref" | "sparse">,
): MarketplaceSource {
  let next = source;
  if (input.ref !== undefined) {
    if (next.source !== "git" && next.source !== "github") {
      throw new Error("--ref is only valid for git marketplaces");
    }
    next = { ...next, ref: input.ref };
  }
  if (input.sparse !== undefined) {
    const sparse = normalizeSparsePath(input.sparse);
    if (next.source === "git" || next.source === "github") {
      return { ...next, path: sparse, sparsePaths: [sparse] };
    }
    throw new Error("--sparse is only valid for git marketplaces");
  }
  return next;
}

function displayMarketplaceSource(source: MarketplaceSource): string {
  switch (source.source) {
    case "github":
      return source.repo;
    case "git":
    case "url":
      return redactPluginSource(source.url);
    case "directory":
    case "file":
      return source.path;
    default: {
      const exhaustive: never = source;
      throw new Error(`unhandled marketplace source: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function persistedMarketplaceSource(source: MarketplaceSource): MarketplaceSource {
  if (source.source === "url") {
    const url = pluginSourceNeedsRedaction(source.url)
      ? redactPluginSource(source.url)
      : source.url;
    if (url === source.url && source.headers === undefined) return source;
    return {
      source: "url",
      url,
    };
  }
  if (source.source === "git") {
    return pluginSourceNeedsRedaction(source.url)
      ? { ...source, url: redactPluginSource(source.url) }
      : source;
  }
  return source;
}

function marketplaceSourceIsRefreshable(
  source: MarketplaceSource,
): boolean | undefined {
  if (source.source === "url") {
    return !pluginSourceNeedsRedaction(source.url) &&
      !hasMarketplaceUrlHeaders(source);
  }
  if (source.source === "git") {
    return !pluginSourceNeedsRedaction(source.url);
  }
  return undefined;
}

function hasMarketplaceUrlHeaders(
  source: Extract<MarketplaceSource, { readonly source: "url" }>,
): boolean {
  return source.headers !== undefined && Object.keys(source.headers).length > 0;
}

function marketplaceUpgradeSkipReason(record: MarketplaceRecord): string | undefined {
  const source = record.sourceDescriptor;
  if (source.source !== "url" && source.source !== "git") return undefined;
  if (
    record.refreshable === false ||
    (source.source === "url" && hasMarketplaceUrlHeaders(source))
  ) {
    return "Marketplace source requires credentials that are not stored; re-add the marketplace with fresh credentials to refresh it";
  }
  return undefined;
}

function requireMarketplaceEnvironment(
  options: MarketplaceOperationOptions,
): Readonly<Record<string, string | undefined>> {
  if (options.env === undefined) {
    throw new Error(
      "Marketplace acquisition requires an explicit captured environment",
    );
  }
  return options.env;
}

function resolveMarketplaceWorkspaceRoot(options: MarketplaceOperationOptions): string {
  if (options.workspaceRoot === undefined) {
    throw new Error(
      "Marketplace operations require an explicit workspace root",
    );
  }
  return resolve(options.workspaceRoot);
}

function resolvePath(path: string, base: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

async function assertMarketplaceInstallPath(
  installedPath: string,
  options: MarketplaceOperationOptions,
): Promise<void> {
  const storeReal = await realpath(marketplaceStoreRoot(options));
  const normalized = resolve(installedPath);
  if (normalized === storeReal || !normalized.startsWith(`${storeReal}${sep}`)) {
    throw new Error("marketplace install path must stay inside the marketplace store");
  }
}

function findRequiredMarketplaceName(index: MarketplaceIndex, name: string): string {
  const matched = findMarketplaceName(index, name);
  if (matched === undefined) {
    throw new Error(`marketplace is not configured: ${name}`);
  }
  return matched;
}

function withMarketplaceCategory(
  pluginInterface: PluginManifestInterface | undefined,
  category: string | undefined,
): PluginManifestInterface | undefined {
  if (category === undefined) return pluginInterface;
  return {
    ...(pluginInterface ?? { capabilities: [], screenshots: [] }),
    category,
  };
}

function appendBoundedOutput(
  current: string,
  currentBytes: number,
  chunk: string,
  maxBytes: number,
): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  if (currentBytes >= maxBytes) {
    return { text: current, bytes: currentBytes + chunkBytes, truncated: chunkBytes > 0 };
  }
  const remaining = maxBytes - currentBytes;
  if (chunkBytes <= remaining) {
    return { text: current + chunk, bytes: currentBytes + chunkBytes, truncated: false };
  }
  return {
    text: current + Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8"),
    bytes: currentBytes + chunkBytes,
    truncated: true,
  };
}

function redactProcessArgs(args: readonly string[]): string[] {
  return args.map((arg) => redactPluginSource(arg));
}

function redactSensitiveText(value: string): string {
  return redactPluginSource(value);
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

function statSyncFile(path: string): boolean {
  return statSync(path).isFile();
}
