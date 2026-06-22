import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveAgencHome } from "../../config/env.js";
import { isRecord } from "../../utils/record.js";
import { sanitizePluginId } from "../directories.js";
import { loadPluginManifest } from "../manifest.js";
import type { PluginManifest, PluginManifestInterface } from "../manifest-schema.js";
import { validateMarketplaceManifest } from "../validation.js";
import {
  assertHttpsOrLoopbackUrl,
  fetchWithTimeout as fetchWithTimeoutGuard,
  readResponseErrorText,
  readResponseTextWithLimit,
  redactUrlForError,
} from "./fetchGuards.js";
import { parseMarketplaceInput } from "./parseMarketplaceInput.js";

export type MarketplaceSourceType = "local" | "git" | "url" | "settings";

export type MarketplaceSource =
  | { readonly source: "local"; readonly path: string }
  | { readonly source: "file"; readonly path: string }
  | { readonly source: "directory"; readonly path: string }
  | { readonly source: "git"; readonly url: string; readonly ref?: string; readonly sparse?: string }
  | { readonly source: "github"; readonly repo: string; readonly ref?: string; readonly path?: string; readonly sparsePaths?: readonly string[] }
  | {
      readonly source: "url";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly refreshable?: boolean;
    }
  | { readonly source: "settings"; readonly name: string; readonly plugins: readonly RawMarketplaceManifestPlugin[] };

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
  readonly updatedAt: string;
}

export interface MarketplaceIndex {
  readonly version: 1;
  readonly marketplaces: Readonly<Record<string, MarketplaceRecord>>;
}

export interface MarketplaceInterface {
  readonly displayName?: string;
}

export type MarketplacePluginInstallPolicy =
  | "NOT_AVAILABLE"
  | "AVAILABLE"
  | "INSTALLED_BY_DEFAULT";

export type MarketplacePluginAuthPolicy = "ON_INSTALL" | "ON_USE";

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
  options?: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
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
  readonly agencHome?: string;
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
  readonly marketplace: MarketplaceRecord;
  readonly removedInstall: boolean;
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

export interface RawMarketplaceManifest {
  readonly name?: string;
  readonly metadata?: {
    readonly name?: string;
    readonly displayName?: string;
  };
  readonly interface?: {
    readonly displayName?: string;
  };
  readonly plugins: readonly RawMarketplaceManifestPlugin[];
}

export interface RawMarketplaceManifestPlugin {
  readonly name: string;
  readonly source: unknown;
  readonly policy?: {
    readonly installation?: MarketplacePluginInstallPolicy;
    readonly authentication?: MarketplacePluginAuthPolicy;
    readonly products?: readonly string[];
  };
  readonly category?: string;
}

const MARKETPLACE_INDEX_FILE = "marketplaces.json";
const MARKETPLACE_MANIFEST_FILE = "marketplace.json";
const MARKETPLACE_MANIFEST_RELATIVE_PATHS = [
  "marketplace.json",
  ".agents/plugins/marketplace.json",
  ".agenc-plugin/marketplace.json",
] as const;
const RESERVED_MARKETPLACE_NAMES = new Set(["agenc", "builtin", "curated"]);
const MARKETPLACE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_MAX_OUTPUT_BYTES = 1_048_576;
const MARKETPLACE_URL_MANIFEST_MAX_BYTES = 1 * 1024 * 1024;

export function marketplaceStoreRoot(options: MarketplaceOperationOptions = {}): string {
  return join(resolveMarketplaceAgencHome(options), "plugins", "marketplaces");
}

export function marketplaceInstalledPath(
  name: string,
  options: MarketplaceOperationOptions = {},
): string {
  return join(marketplaceStoreRoot(options), sanitizeMarketplaceInstallName(name));
}

export function marketplaceIndexPath(options: MarketplaceOperationOptions = {}): string {
  return join(marketplaceStoreRoot(options), MARKETPLACE_INDEX_FILE);
}

export async function readMarketplaceIndex(
  options: MarketplaceOperationOptions = {},
): Promise<MarketplaceIndex> {
  const parsed = await readJsonFile<MarketplaceIndex>(
    marketplaceIndexPath(options),
    { version: 1, marketplaces: {} },
  );
  return {
    version: 1,
    marketplaces: Object.fromEntries(
      Object.entries(parsed.marketplaces ?? {})
        .filter(([, value]) => isMarketplaceRecord(value))
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

export async function writeMarketplaceIndex(
  index: MarketplaceIndex,
  options: MarketplaceOperationOptions = {},
): Promise<void> {
  await writeJsonAtomic(marketplaceIndexPath(options), {
    version: 1,
    marketplaces: Object.fromEntries(
      Object.entries(index.marketplaces).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
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
    const validation = await validateMarketplaceManifest(manifestPath);
    if (!validation.success) {
      throw new Error(
        `marketplace manifest failed validation: ${validation.errors.map((error) => error.message).join("; ")}`,
      );
    }
    const manifest = await readMarketplaceManifest(manifestPath);
    const name = normalizeMarketplaceName(
      input.name ?? inferMarketplaceName(manifest, source),
    );
    await validateMarketplacePluginSources(manifestPath, name, manifest);
    const index = await readMarketplaceIndex(input);
    const duplicate = findMarketplaceName(index, name);
    if (duplicate !== undefined && duplicate !== name) {
      throw new Error(`marketplace name differs only by case from existing marketplace: ${duplicate}`);
    }
    if (duplicate !== undefined && input.force !== true) {
      throw new Error(`marketplace already exists: ${name}`);
    }
    const safeName = sanitizeMarketplaceInstallName(name);
    const installNameConflict = findMarketplaceInstallName(index, safeName);
    if (installNameConflict !== undefined && installNameConflict !== name) {
      throw new Error(
        `marketplace install directory collides with existing marketplace: ${installNameConflict}`,
      );
    }
    const installedPath = marketplaceInstalledPath(name, input);
    const replaced = duplicate !== undefined || await pathExists(installedPath);
    const manifestRelativePath = relative(staged.root, manifestPath);
    const finalManifestPath = join(installedPath, manifestRelativePath);
    const persistedSource = persistedMarketplaceSource(source);
    const marketplace: MarketplaceRecord = {
      name,
      source: displayMarketplaceSource(persistedSource),
      sourceType: staged.sourceType,
      sourceDescriptor: persistedSource,
      installedPath,
      manifestPath: finalManifestPath,
      ...(source.source === "git" && source.ref !== undefined ? { ref: source.ref } : {}),
      ...(source.source === "git" && source.sparse !== undefined ? { sparse: source.sparse } : {}),
      ...(source.source === "github" && source.ref !== undefined ? { ref: source.ref } : {}),
      ...(source.source === "github" && source.path !== undefined ? { sparse: source.path } : {}),
      ...(staged.revision !== undefined ? { revision: staged.revision } : {}),
      ...(input.autoUpdate !== undefined ? { autoUpdate: input.autoUpdate } : {}),
      updatedAt: (input.now ?? (() => new Date()))().toISOString(),
    };
    const nextIndex: MarketplaceIndex = {
      version: 1,
      marketplaces: {
        ...index.marketplaces,
        [name]: marketplace,
      },
    };
    await activateMarketplaceStaging(staged.root, installedPath, nextIndex, input);
    return { marketplace, replaced };
  } finally {
    await rm(staged.tempDir, { recursive: true, force: true });
  }
}

export async function removeMarketplaceOp(
  input: RemoveMarketplaceInput,
): Promise<RemoveMarketplaceResult> {
  const index = await readMarketplaceIndex(input);
  const matchedName = findMarketplaceName(index, input.name);
  if (matchedName === undefined) {
    throw new Error(`marketplace is not configured: ${input.name}`);
  }
  const marketplace = index.marketplaces[matchedName]!;
  const nextMarketplaces = { ...index.marketplaces };
  delete nextMarketplaces[matchedName];
  let removedInstall = false;
  const installedPath = marketplaceInstalledPath(marketplace.name, input);
  await assertMarketplaceInstallPath(installedPath, input);
  try {
    await stat(installedPath);
    await rm(installedPath, { recursive: true, force: true });
    removedInstall = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeMarketplaceIndex({ version: 1, marketplaces: nextMarketplaces }, input);
  return { marketplace, removedInstall };
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
  for (const relativePath of MARKETPLACE_MANIFEST_RELATIVE_PATHS) {
    const candidate = join(root, relativePath);
    try {
      if (statSyncFile(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function normalizeMarketplaceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("marketplace name cannot be empty");
  }
  if (!MARKETPLACE_NAME_RE.test(trimmed)) {
    throw new Error(
      "marketplace name must be an alphanumeric segment with only '.', '_', or '-' separators",
    );
  }
  if (RESERVED_MARKETPLACE_NAMES.has(trimmed.toLowerCase())) {
    throw new Error(`marketplace name is reserved: ${trimmed}`);
  }
  return trimmed;
}

function sanitizeMarketplaceInstallName(name: string): string {
  return sanitizePluginId(normalizeMarketplaceName(name));
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
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
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
      case "local":
      case "directory": {
        const sourcePath = resolvePath(source.path, resolveMarketplaceWorkspaceRoot(options));
        const stats = await stat(sourcePath);
        if (stats.isDirectory()) {
          await cp(sourcePath, root, { recursive: true, dereference: false });
        } else {
          await mkdir(root, { recursive: true, mode: 0o700 });
          await cp(sourcePath, join(root, MARKETPLACE_MANIFEST_FILE), { dereference: false });
        }
        return { tempDir, root, sourceType: "local" };
      }
      case "file": {
        const sourcePath = resolvePath(source.path, resolveMarketplaceWorkspaceRoot(options));
        await mkdir(root, { recursive: true, mode: 0o700 });
        await cp(sourcePath, join(root, MARKETPLACE_MANIFEST_FILE), { dereference: false });
        return { tempDir, root, sourceType: "local" };
      }
      case "settings": {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await writeJsonAtomic(join(root, MARKETPLACE_MANIFEST_FILE), {
          name: source.name,
          metadata: { name: source.name },
          plugins: source.plugins,
        });
        return { tempDir, root, sourceType: "settings" };
      }
      case "url": {
        await mkdir(root, { recursive: true, mode: 0o700 });
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
        await writeFile(join(root, MARKETPLACE_MANIFEST_FILE), body, "utf8");
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
        const sparse = source.source === "github"
          ? source.path ?? source.sparsePaths?.[0]
          : source.sparse;
        const run = options.runProcess ?? defaultRunProcess;
        if (sparse !== undefined) {
          const sparsePath = normalizeSparsePath(sparse);
          await run("git", [
            "clone",
            "--depth",
            "1",
            "--filter=blob:none",
            "--no-checkout",
            "--",
            gitUrl,
            root,
          ], {});
          await run("git", ["sparse-checkout", "set", "--cone", "--", sparsePath], { cwd: root });
          await run("git", ["checkout", ref ?? "HEAD"], { cwd: root });
        } else {
          const args = ["clone", "--depth", "1"];
          if (ref !== undefined) args.push("--branch", ref);
          args.push("--", gitUrl, root);
          await run("git", args, {});
        }
        const revision = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
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
    ...MARKETPLACE_MANIFEST_RELATIVE_PATHS.map((relativePath) => join(root, relativePath)),
    ...(manifestHint ? MARKETPLACE_MANIFEST_RELATIVE_PATHS.map((relativePath) => join(root, manifestHint, relativePath)) : []),
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
  throw new Error(`marketplace source must contain ${MARKETPLACE_MANIFEST_FILE}`);
}

async function activateMarketplaceStaging(
  stagingRoot: string,
  installedPath: string,
  nextIndex: MarketplaceIndex,
  options: MarketplaceOperationOptions,
): Promise<void> {
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
    if (await pathExists(installedPath)) {
      await rename(installedPath, backupPath);
      hadExisting = true;
    }
    await rename(stagingRoot, installedPath);
    activated = true;
    await writeMarketplaceIndex(nextIndex, options);
    if (hadExisting) {
      await rm(backupPath, { recursive: true, force: true });
    }
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
  source: unknown,
): Promise<MarketplacePluginSource> {
  if (typeof source === "string") {
    return { type: "local", path: await resolveLocalPluginSourcePath(marketplacePath, source) };
  }
  if (!isRecord(source)) {
    throw new Error("marketplace plugin source must be a string or object");
  }
  if (source.source === "local" && typeof source.path === "string") {
    return { type: "local", path: await resolveLocalPluginSourcePath(marketplacePath, source.path) };
  }
  if (source.source === "local") {
    throw new Error("local marketplace plugin source must include a string path");
  }
  if (
    (source.source === "url" || source.source === "git-subdir" || source.source === "git") &&
    typeof source.url === "string"
  ) {
    const path = typeof source.path === "string"
      ? normalizeRemotePluginSubdir(marketplacePath, source.path)
      : undefined;
    if (source.source === "git-subdir" && path === undefined) {
      throw new Error("git-subdir marketplace plugin source must include a path");
    }
    return {
      type: "git",
      url: normalizeMarketplacePluginGitUrl(marketplacePath, source.url),
      ...(path !== undefined ? { path } : {}),
      ...(typeof source.ref === "string" && source.ref.trim() ? { ref: source.ref.trim() } : {}),
      ...(typeof source.sha === "string" && source.sha.trim() ? { sha: source.sha.trim() } : {}),
    };
  }
  if (source.source === "git-subdir") {
    throw new Error("git-subdir marketplace plugin source must include a string url and path");
  }
  if (source.source === "git" || source.source === "url") {
    throw new Error("git marketplace plugin source must include a string url");
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
  for (const relativePath of MARKETPLACE_MANIFEST_RELATIVE_PATHS) {
    const candidate = join(root, relativePath);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      continue;
    }
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

function marketplaceRootDir(marketplacePath: string): string {
  const resolved = resolve(marketplacePath);
  for (const relativePath of MARKETPLACE_MANIFEST_RELATIVE_PATHS) {
    const suffix = relativePath.split(/[\\/]+/u);
    const pathParts = resolved.split(/[\\/]+/u);
    if (pathParts.slice(-suffix.length).join("/") === suffix.join("/")) {
      return pathParts.slice(0, -suffix.length).join(sep) || sep;
    }
  }
  throw new Error("marketplace file is not in a supported location");
}

async function readMarketplaceManifest(path: string): Promise<RawMarketplaceManifest> {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    throw new Error("marketplace manifest must define a plugins array");
  }
  const plugins = parsed.plugins.map((entry, index) => normalizeRawMarketplacePlugin(entry, index));
  assertNoDuplicateMarketplacePlugins(plugins);
  return {
    ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
    ...(isRecord(parsed.metadata) ? { metadata: parsed.metadata as RawMarketplaceManifest["metadata"] } : {}),
    ...(isRecord(parsed.interface) ? { interface: parsed.interface as RawMarketplaceManifest["interface"] } : {}),
    plugins,
  };
}

function normalizeRawMarketplacePlugin(entry: unknown, index: number): RawMarketplaceManifestPlugin {
  if (!isRecord(entry)) {
    throw new Error(`marketplace manifest plugin at index ${index} must be an object`);
  }
  if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
    throw new Error(`marketplace manifest plugin at index ${index} must define a non-empty name`);
  }
  if (!("source" in entry)) {
    throw new Error(`marketplace manifest plugin '${entry.name}' must define source`);
  }
  return {
    name: entry.name,
    source: entry.source,
    ...(isRecord(entry.policy) ? { policy: normalizeRawMarketplacePluginPolicy(entry.name, entry.policy) } : {}),
    ...(typeof entry.category === "string" ? { category: entry.category } : {}),
  };
}

function normalizeRawMarketplacePluginPolicy(
  pluginName: string,
  policy: Readonly<Record<string, unknown>>,
): RawMarketplaceManifestPlugin["policy"] {
  if (
    policy.installation !== undefined &&
    policy.installation !== "NOT_AVAILABLE" &&
    policy.installation !== "AVAILABLE" &&
    policy.installation !== "INSTALLED_BY_DEFAULT"
  ) {
    throw new Error(`marketplace manifest plugin '${pluginName}' has invalid installation policy`);
  }
  if (
    policy.authentication !== undefined &&
    policy.authentication !== "ON_INSTALL" &&
    policy.authentication !== "ON_USE"
  ) {
    throw new Error(`marketplace manifest plugin '${pluginName}' has invalid authentication policy`);
  }
  if (policy.products !== undefined && !isStringArray(policy.products)) {
    throw new Error(`marketplace manifest plugin '${pluginName}' products policy must be an array of strings`);
  }
  return {
    ...(policy.installation !== undefined ? { installation: policy.installation } : {}),
    ...(policy.authentication !== undefined ? { authentication: policy.authentication } : {}),
    ...(policy.products !== undefined ? { products: policy.products } : {}),
  };
}

function assertNoDuplicateMarketplacePlugins(plugins: readonly RawMarketplaceManifestPlugin[]): void {
  const seen = new Map<string, string>();
  for (const plugin of plugins) {
    const key = sanitizePluginId(plugin.name).toLowerCase();
    const existing = seen.get(key);
    if (existing !== undefined) {
      throw new Error(`marketplace manifest has duplicate plugin names: '${existing}' and '${plugin.name}'`);
    }
    seen.set(key, plugin.name);
  }
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
    case "settings":
      return source.name;
    case "local":
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
    if (next.source === "git") return { ...next, sparse };
    if (next.source === "github") return { ...next, path: sparse };
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
      return source.url;
    case "local":
    case "directory":
    case "file":
      return source.path;
    case "settings":
      return `settings:${source.name}`;
  }
}

function persistedMarketplaceSource(source: MarketplaceSource): MarketplaceSource {
  if (source.source !== "url") return source;
  const url = redactSensitiveText(source.url);
  const refreshable = url === source.url && !hasMarketplaceUrlHeaders(source);
  return {
    source: "url",
    url,
    ...(refreshable ? {} : { refreshable: false }),
  };
}

function hasMarketplaceUrlHeaders(
  source: Extract<MarketplaceSource, { readonly source: "url" }>,
): boolean {
  return source.headers !== undefined && Object.keys(source.headers).length > 0;
}

function marketplaceUpgradeSkipReason(record: MarketplaceRecord): string | undefined {
  const source = record.sourceDescriptor;
  if (source.source !== "url") return undefined;
  if (source.refreshable === false || source.url.includes("<redacted>") || hasMarketplaceUrlHeaders(source)) {
    return "URL marketplace source requires credentials that are not stored; re-add the marketplace with fresh credentials to refresh it";
  }
  return undefined;
}

function resolveMarketplaceAgencHome(options: MarketplaceOperationOptions = {}): string {
  return options.agencHome ?? resolveAgencHome(options.env);
}

function resolveMarketplaceWorkspaceRoot(options: MarketplaceOperationOptions = {}): string {
  return options.workspaceRoot ?? process.cwd();
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

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
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
  return args.map((arg) => redactSensitiveText(arg));
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/giu, "$1<redacted>@")
    .replace(/([?&](?:token|access_token|password|apikey|api_key)=)[^&\s]+/giu, "$1<redacted>")
    .replace(/((?:token|access_token|password|apikey|api_key)=)[^&\s]+/giu, "$1<redacted>");
}

function isMarketplaceRecord(value: unknown): value is MarketplaceRecord {
  return isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.source === "string" &&
    (value.sourceType === "local" || value.sourceType === "git" || value.sourceType === "url" || value.sourceType === "settings") &&
    isRecord(value.sourceDescriptor) &&
    typeof value.installedPath === "string" &&
    typeof value.manifestPath === "string" &&
    typeof value.updatedAt === "string";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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
