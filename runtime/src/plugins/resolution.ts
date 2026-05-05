import { spawn } from "node:child_process";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createHash,
  createPublicKey,
  verify as verifySignatureBytes,
} from "node:crypto";
import { pathToFileURL } from "node:url";
import { findPluginManifestPath, loadPluginManifest } from "./manifest.js";
import { sanitizePluginId } from "./directories.js";
import type { LoadedPlugin } from "./loader.js";

export type PluginResolutionKind =
  | "local"
  | "npm"
  | "git"
  | "tarball"
  | "mcpb";

export type PluginFetchOutcome = "success" | "failure" | "cache_hit";

export interface PluginProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type PluginProcessRunner = (
  command: string,
  args: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  },
) => Promise<PluginProcessResult>;

export interface PluginFetchTelemetry {
  readonly kind: PluginResolutionKind;
  readonly source: string;
  readonly host: string;
  readonly outcome: PluginFetchOutcome;
  readonly durationMs: number;
  readonly errorKind?: string;
}

export interface PluginResolverOptions {
  readonly agencHome: string;
  readonly workspaceRoot?: string;
  readonly cache?: boolean;
  readonly refreshCache?: boolean;
  readonly requireSignature?: boolean;
  readonly publishersPath?: string;
  readonly runProcess?: PluginProcessRunner;
  readonly fetchBytes?: (url: string) => Promise<Uint8Array>;
  readonly maxDownloadBytes?: number;
  readonly downloadTimeoutMs?: number;
  readonly maxExtractedBytes?: number;
  readonly maxExtractedFiles?: number;
  readonly maxExtractDepth?: number;
  readonly onTelemetry?: (event: PluginFetchTelemetry) => void;
}

export interface ResolvedPluginSource {
  readonly kind: PluginResolutionKind;
  readonly requestedSource: string;
  readonly pluginRoot: string;
  readonly cacheRoot?: string;
  readonly signature?: PluginSignatureVerification;
  readonly cleanup: () => Promise<void>;
}

export interface PluginSignatureVerification {
  readonly required: boolean;
  readonly present: boolean;
  readonly verified: boolean;
  readonly publisher?: string;
  readonly payloadFileCount?: number;
  readonly reason?: string;
}

export interface ParsedPluginIdentifier {
  readonly name: string;
  readonly marketplace?: string;
}

export interface PluginDependencyLookupResult {
  readonly dependencies?: readonly string[];
}

export type PluginDependencyResolutionResult =
  | { readonly ok: true; readonly closure: readonly string[] }
  | { readonly ok: false; readonly reason: "cycle"; readonly chain: readonly string[] }
  | { readonly ok: false; readonly reason: "not-found"; readonly missing: string; readonly requiredBy: string }
  | {
    readonly ok: false;
    readonly reason: "cross-marketplace";
    readonly dependency: string;
    readonly requiredBy: string;
  };

export interface PluginDependencyIssue {
  readonly source: string;
  readonly plugin: string;
  readonly dependency: string;
  readonly reason: "ambiguous" | "cross-marketplace" | "cycle" | "not-enabled" | "not-found";
}

interface SignatureFile {
  readonly publisher: string;
  readonly signature: string;
  readonly files: Readonly<Record<string, string>>;
}

interface PublisherKeyring {
  readonly publishers?: Readonly<Record<string, string | { readonly publicKey?: string }>>;
}

const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
const DEFAULT_PROCESS_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_EXTRACTED_FILES = 4096;
const DEFAULT_MAX_EXTRACT_DEPTH = 32;
const DEFAULT_CACHE_LOCK_TIMEOUT_MS = 60_000;
const KNOWN_PUBLIC_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "gist.githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "dev.azure.com",
  "ssh.dev.azure.com",
  "registry.npmjs.org",
  "npm.pkg.github.com",
  "agenc.tech",
]);
const KNOWN_GIT_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "dev.azure.com",
]);

export async function resolvePluginSource(
  source: string,
  options: PluginResolverOptions,
): Promise<ResolvedPluginSource> {
  const startedAt = Date.now();
  const kind = await classifyPluginSource(source, options.workspaceRoot ?? process.cwd());
  const telemetrySource = source;
  let tempRoot: string | undefined;
  try {
    const cacheRoot = pluginSourceCacheRoot(options.agencHome, source);
    const materializeFresh = async (): Promise<ResolvedPluginSource> => {
      tempRoot = await mkdtemp(join(tmpdir(), "agenc-plugin-resolve-"));
      const resolvedRoot = await materializePluginSource(source, kind, tempRoot, options);
      const signature = await verifyResolvedPluginSignature(resolvedRoot, options);
      const pluginRoot = options.cache === false || kind === "local"
        ? resolvedRoot
        : await activatePluginCache(resolvedRoot, cacheRoot);
      const cleanupRoot = tempRoot;
      if (cleanupRoot === undefined) throw new Error("plugin resolver temp root was not initialized");
      tempRoot = undefined;
      emitTelemetry(options, {
        kind,
        source: telemetrySource,
        host: telemetryHost(source),
        outcome: "success",
        durationMs: Date.now() - startedAt,
      });
      return {
        kind,
        requestedSource: source,
        pluginRoot,
        ...(options.cache !== false && kind !== "local" ? { cacheRoot } : {}),
        signature,
        cleanup: async () => {
          await rm(cleanupRoot, { recursive: true, force: true });
        },
      };
    };
    if (options.cache === false || kind === "local") return await materializeFresh();
    return await withPluginCacheLock(cacheRoot, async () => {
      if (options.refreshCache !== true && await pathIsDirectory(cacheRoot)) {
        const signature = await verifyResolvedPluginSignature(cacheRoot, options);
        emitTelemetry(options, {
          kind,
          source: telemetrySource,
          host: telemetryHost(source),
          outcome: "cache_hit",
          durationMs: Date.now() - startedAt,
        });
        return {
          kind,
          requestedSource: source,
          pluginRoot: cacheRoot,
          cacheRoot,
          signature,
          cleanup: async () => {},
        };
      }
      return await materializeFresh();
    });
  } catch (error) {
    if (tempRoot !== undefined) {
      await rm(tempRoot, { recursive: true, force: true });
    }
    emitTelemetry(options, {
      kind,
      source: telemetrySource,
      host: telemetryHost(source),
      outcome: "failure",
      durationMs: Date.now() - startedAt,
      errorKind: classifyPluginFetchError(error),
    });
    throw error;
  }
}

export async function classifyPluginSource(
  source: string,
  workspaceRoot = process.cwd(),
): Promise<PluginResolutionKind> {
  const localPath = resolve(workspaceRoot, source);
  if (await pathIsDirectory(localPath)) return "local";
  if (isGitSource(source)) return "git";
  if (isTarballSource(source)) return "tarball";
  if (isMcpbSource(source)) return "mcpb";
  return "npm";
}

export function parsePluginIdentifier(plugin: string): ParsedPluginIdentifier {
  const marker = plugin.indexOf("@", 1);
  if (marker === -1) return { name: plugin };
  return {
    name: plugin.slice(0, marker),
    marketplace: plugin.slice(marker + 1) || undefined,
  };
}

export function buildPluginIdentifier(name: string, marketplace?: string): string {
  return marketplace ? `${name}@${marketplace}` : name;
}

export function qualifyPluginDependency(dep: string, declaringPluginId: string): string {
  if (parsePluginIdentifier(dep).marketplace) return dep;
  const marketplace = parsePluginIdentifier(declaringPluginId).marketplace;
  if (!marketplace || marketplace === "inline") return dep;
  return buildPluginIdentifier(dep, marketplace);
}

export async function resolvePluginDependencyClosure(
  rootId: string,
  lookup: (id: string) => Promise<PluginDependencyLookupResult | null>,
  alreadyEnabled: ReadonlySet<string> = new Set(),
  allowedCrossMarketplaces: ReadonlySet<string> = new Set(),
): Promise<PluginDependencyResolutionResult> {
  const rootMarketplace = parsePluginIdentifier(rootId).marketplace;
  const closure: string[] = [];
  const visited = new Set<string>();
  const stack: string[] = [];

  async function walk(id: string, requiredBy: string): Promise<PluginDependencyResolutionResult | null> {
    const marketplace = parsePluginIdentifier(id).marketplace;
    if (
      marketplace !== rootMarketplace &&
      !(marketplace && allowedCrossMarketplaces.has(marketplace))
    ) {
      return {
        ok: false,
        reason: "cross-marketplace",
        dependency: id,
        requiredBy,
      };
    }
    if (id !== rootId && alreadyEnabled.has(id)) return null;
    if (stack.includes(id)) return { ok: false, reason: "cycle", chain: [...stack, id] };
    if (visited.has(id)) return null;
    visited.add(id);

    const entry = await lookup(id);
    if (!entry) return { ok: false, reason: "not-found", missing: id, requiredBy };

    stack.push(id);
    for (const rawDep of entry.dependencies ?? []) {
      const dep = qualifyPluginDependency(rawDep, id);
      const error = await walk(dep, id);
      if (error) return error;
    }
    stack.pop();
    closure.push(id);
    return null;
  }

  const error = await walk(rootId, rootId);
  if (error) return error;
  return { ok: true, closure };
}

export function verifyPluginDependencyState(plugins: readonly LoadedPlugin[]): {
  readonly demoted: ReadonlySet<string>;
  readonly errors: readonly PluginDependencyIssue[];
} {
  const idBySource = new Map(plugins.map((plugin) => [plugin.source, pluginDependencyIdentifier(plugin)] as const));
  const known = new Set(idBySource.values());
  const enabled = new Set(plugins.filter((plugin) => plugin.enabled).map((plugin) => idBySource.get(plugin.source)!));
  const knownByName = pluginIdsByName(plugins, idBySource, () => true);
  const enabledByName = pluginIdsByName(plugins, idBySource, (plugin) => plugin.enabled);

  const errors: PluginDependencyIssue[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const plugin of plugins) {
      const pluginId = idBySource.get(plugin.source)!;
      if (!enabled.has(pluginId)) continue;
      for (const rawDep of plugin.manifest.dependencies ?? []) {
        const dep = qualifyPluginDependency(rawDep, pluginId);
        if (isCrossMarketplaceDependency(pluginId, dep)) {
          demotePluginForDependency({
            enabled,
            enabledByName,
            errors,
            plugin,
            pluginId,
            dep,
            reason: "cross-marketplace",
          });
          changed = true;
          break;
        }
        const dependencyState = dependencySatisfactionState(dep, enabled, enabledByName, knownByName, known);
        if (dependencyState.ok) continue;

        demotePluginForDependency({
          enabled,
          enabledByName,
          errors,
          plugin,
          pluginId,
          dep,
          reason: dependencyState.reason,
        });
        changed = true;
        break;
      }
    }
  }

  const pluginById = new Map(
    plugins
      .filter((plugin) => enabled.has(idBySource.get(plugin.source)!))
      .map((plugin) => [idBySource.get(plugin.source)!, plugin] as const),
  );
  const dependencyIdsById = new Map<string, string[]>();
  for (const [id, plugin] of pluginById) {
    const deps: string[] = [];
    for (const rawDep of plugin.manifest.dependencies ?? []) {
      const dep = qualifyPluginDependency(rawDep, id);
      if (isCrossMarketplaceDependency(id, dep)) continue;
      const parsed = parsePluginIdentifier(dep);
      if (parsed.marketplace !== undefined) {
        if (enabled.has(dep)) deps.push(dep);
        continue;
      }
      const matchingEnabled = [...(enabledByName.get(dep) ?? [])];
      if (matchingEnabled.length === 1) deps.push(matchingEnabled[0]!);
    }
    dependencyIdsById.set(id, deps);
  }
  const cyclic = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(id: string): void {
    if (cyclic.has(id) || visited.has(id)) return;
    const activeIndex = stack.indexOf(id);
    if (activeIndex !== -1) {
      for (const cycleId of stack.slice(activeIndex)) cyclic.add(cycleId);
      cyclic.add(id);
      return;
    }
    if (visiting.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dep of dependencyIdsById.get(id) ?? []) visit(dep);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of dependencyIdsById.keys()) visit(id);
  for (const id of cyclic) {
    if (!enabled.delete(id)) continue;
    const plugin = pluginById.get(id);
    if (!plugin) continue;
    const byName = enabledByName.get(plugin.name);
    byName?.delete(id);
    if (byName?.size === 0) enabledByName.delete(plugin.name);
    errors.push({
      source: plugin.source,
      plugin: plugin.name,
      dependency: id,
      reason: "cycle",
    });
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const plugin of plugins) {
      const pluginId = idBySource.get(plugin.source)!;
      if (!enabled.has(pluginId)) continue;
      for (const rawDep of plugin.manifest.dependencies ?? []) {
        const dep = qualifyPluginDependency(rawDep, pluginId);
        if (isCrossMarketplaceDependency(pluginId, dep)) {
          demotePluginForDependency({
            enabled,
            enabledByName,
            errors,
            plugin,
            pluginId,
            dep,
            reason: "cross-marketplace",
          });
          changed = true;
          break;
        }
        const dependencyState = dependencySatisfactionState(dep, enabled, enabledByName, knownByName, known);
        if (dependencyState.ok) continue;

        demotePluginForDependency({
          enabled,
          enabledByName,
          errors,
          plugin,
          pluginId,
          dep,
          reason: dependencyState.reason,
        });
        changed = true;
        break;
      }
    }
  }

  return {
    demoted: new Set(plugins.filter((plugin) => {
      const pluginId = idBySource.get(plugin.source)!;
      return plugin.enabled && !enabled.has(pluginId);
    }).map((plugin) => plugin.source)),
    errors,
  };
}

function isCrossMarketplaceDependency(pluginId: string, dependencyId: string): boolean {
  const pluginMarketplace = parsePluginIdentifier(pluginId).marketplace;
  const dependencyMarketplace = parsePluginIdentifier(dependencyId).marketplace;
  return dependencyMarketplace !== undefined && dependencyMarketplace !== pluginMarketplace;
}

function demotePluginForDependency(options: {
  readonly enabled: Set<string>;
  readonly enabledByName: Map<string, Set<string>>;
  readonly errors: PluginDependencyIssue[];
  readonly plugin: LoadedPlugin;
  readonly pluginId: string;
  readonly dep: string;
  readonly reason: PluginDependencyIssue["reason"];
}): void {
  if (!options.enabled.delete(options.pluginId)) return;
  const byName = options.enabledByName.get(options.plugin.name);
  byName?.delete(options.pluginId);
  if (byName?.size === 0) options.enabledByName.delete(options.plugin.name);
  options.errors.push({
    source: options.plugin.source,
    plugin: options.plugin.name,
    dependency: options.dep,
    reason: options.reason,
  });
}

function pluginIdsByName(
  plugins: readonly LoadedPlugin[],
  idBySource: ReadonlyMap<string, string>,
  include: (plugin: LoadedPlugin) => boolean,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const plugin of plugins) {
    if (!include(plugin)) continue;
    const id = idBySource.get(plugin.source);
    if (!id) continue;
    const ids = out.get(plugin.name) ?? new Set<string>();
    ids.add(id);
    out.set(plugin.name, ids);
  }
  return out;
}

function dependencySatisfactionState(
  dependencyId: string,
  enabled: ReadonlySet<string>,
  enabledByName: ReadonlyMap<string, ReadonlySet<string>>,
  knownByName: ReadonlyMap<string, ReadonlySet<string>>,
  known: ReadonlySet<string>,
): { readonly ok: true } | { readonly ok: false; readonly reason: PluginDependencyIssue["reason"] } {
  if (parsePluginIdentifier(dependencyId).marketplace !== undefined) {
    return enabled.has(dependencyId)
      ? { ok: true }
      : { ok: false, reason: known.has(dependencyId) ? "not-enabled" : "not-found" };
  }
  const enabledMatches = enabledByName.get(dependencyId)?.size ?? 0;
  if (enabledMatches === 1) return { ok: true };
  if (enabledMatches > 1) return { ok: false, reason: "ambiguous" };
  return {
    ok: false,
    reason: knownByName.has(dependencyId) ? "not-enabled" : "not-found",
  };
}

export function pluginDependencyIdentifier(plugin: LoadedPlugin): string {
  return plugin.source || plugin.name;
}

export function findPluginReverseDependents(
  pluginId: string,
  plugins: readonly LoadedPlugin[],
): readonly string[] {
  const targetName = parsePluginIdentifier(pluginId).name;
  return plugins
    .filter((plugin) => {
      const sourceId = pluginDependencyIdentifier(plugin);
      return plugin.enabled &&
        sourceId !== pluginId &&
        (plugin.manifest.dependencies ?? []).some((rawDep) => {
          const qualified = qualifyPluginDependency(rawDep, sourceId);
          return parsePluginIdentifier(qualified).marketplace
            ? qualified === pluginId
            : qualified === targetName;
        });
    })
    .map((plugin) => plugin.name);
}

export async function verifyResolvedPluginSignature(
  pluginRoot: string,
  options: Pick<PluginResolverOptions, "publishersPath" | "requireSignature">,
): Promise<PluginSignatureVerification> {
  const signaturePath = join(pluginRoot, ".agenc-plugin", "signature.json");
  let signature: SignatureFile;
  try {
    signature = parseSignatureFile(await readFile(signaturePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (options.requireSignature === true) {
        throw new Error("plugin signature is required but .agenc-plugin/signature.json is missing");
      }
      return {
        required: false,
        present: false,
        verified: false,
        reason: "missing",
      };
    }
    throw error;
  }
  const publishersPath = options.publishersPath ?? defaultPublishersPath();
  const publicKey = await readPublisherPublicKey(publishersPath, signature.publisher);
  const manifestPath = await findPluginManifestPath(pluginRoot);
  if (!manifestPath) throw new Error("cannot verify plugin signature without plugin.json");
  const manifestBytes = await readFile(manifestPath);
  const actualFiles = await collectPluginPayloadDigests(pluginRoot, manifestPath, signaturePath);
  assertSignedPayloadMatches(signature.files, actualFiles);
  const payload = pluginSignaturePayloadBytes(manifestBytes, signature.files);
  const verified = verifyEd25519Signature({
    publicKey,
    payload,
    signature: signature.signature,
  });
  if (!verified) throw new Error(`plugin signature verification failed for publisher ${signature.publisher}`);
  return {
    required: options.requireSignature === true,
    present: true,
    verified: true,
    publisher: signature.publisher,
    payloadFileCount: Object.keys(signature.files).length,
  };
}

export function pluginSignaturePayloadBytes(
  manifestBytes: Uint8Array,
  files: Readonly<Record<string, string>>,
): Uint8Array {
  const normalizedFiles = Object.fromEntries(
    Object.entries(files)
      .map(([path, digest]) => [path, normalizeSha256Digest(digest)] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return Buffer.from(JSON.stringify({
    manifestSha256: sha256Hex(manifestBytes),
    files: normalizedFiles,
  }));
}

export function verifyEd25519Signature(input: {
  readonly publicKey: string;
  readonly payload: Uint8Array;
  readonly signature: string;
}): boolean {
  const key = createPublicKey({
    key: Buffer.from(input.publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  return verifySignatureBytes(
    null,
    Buffer.from(input.payload),
    key,
    Buffer.from(input.signature, "base64"),
  );
}

export function pluginSourceCacheRoot(agencHome: string, source: string): string {
  return join(
    agencHome,
    "plugins",
    "cache",
    sanitizePluginId(cacheKeyForSource(source)),
  );
}

export function classifyPluginFetchError(error: unknown): string {
  const msg = String((error as { message?: unknown })?.message ?? error);
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|Could not resolve host|Connection refused/iu.test(msg)) {
    return "dns_or_refused";
  }
  if (/ETIMEDOUT|timed out|timeout/iu.test(msg)) return "timeout";
  if (/ECONNRESET|socket hang up|Connection reset by peer|remote end hung up/iu.test(msg)) {
    return "conn_reset";
  }
  if (/403|401|authentication|permission denied/iu.test(msg)) return "auth";
  if (/404|not found|repository not found/iu.test(msg)) return "not_found";
  if (/certificate|SSL|TLS|unable to get local issuer/iu.test(msg)) return "tls";
  if (/Invalid response format|Invalid marketplace schema|invalid JSON/iu.test(msg)) {
    return "invalid_schema";
  }
  return "other";
}

async function materializePluginSource(
  source: string,
  kind: PluginResolutionKind,
  tempRoot: string,
  options: PluginResolverOptions,
): Promise<string> {
  switch (kind) {
    case "local":
      return resolve(options.workspaceRoot ?? process.cwd(), source);
    case "npm":
      return materializeNpmPackage(source, tempRoot, options);
    case "git":
      return materializeGitSource(source, tempRoot, options);
    case "tarball":
      return materializeTarballSource(source, tempRoot, options);
    case "mcpb":
      return materializeMcpbSource(source, tempRoot, options);
  }
}

async function materializeNpmPackage(
  source: string,
  tempRoot: string,
  options: PluginResolverOptions,
): Promise<string> {
  assertSafeNpmPackageSource(source);
  const packDir = join(tempRoot, "npm");
  await mkdir(packDir, { recursive: true, mode: 0o700 });
  const packed = await runProcess(options, "npm", [
    "pack",
    "--json",
    "--pack-destination",
    packDir,
    "--",
    source,
  ]);
  const tarballPath = parseNpmPackTarballPath(packed.stdout, packDir);
  return extractTarball(tarballPath, join(tempRoot, "npm-extract"), options);
}

async function materializeGitSource(
  source: string,
  tempRoot: string,
  options: PluginResolverOptions,
): Promise<string> {
  assertSafeGitSource(source);
  const target = join(tempRoot, "git");
  await runProcess(options, "git", ["clone", "--depth", "1", "--", source, target]);
  return target;
}

async function materializeTarballSource(
  source: string,
  tempRoot: string,
  options: PluginResolverOptions,
): Promise<string> {
  const tarballPath = join(tempRoot, `plugin${tarballExtension(source)}`);
  const data = await fetchBytes(source, options);
  await writeFile(tarballPath, data);
  return extractTarball(tarballPath, join(tempRoot, "tarball-extract"), options);
}

async function materializeMcpbSource(
  source: string,
  tempRoot: string,
  options: PluginResolverOptions,
): Promise<string> {
  const bundlePath = await materializeMcpbBundle(source, tempRoot, options);
  const extractDir = join(tempRoot, "mcpb");
  await mkdir(extractDir, { recursive: true, mode: 0o700 });
  await assertZipSafe(bundlePath, options);
  await runProcess(options, "unzip", ["-q", bundlePath, "-d", extractDir]);
  await assertExtractedTreeContained(extractDir, options);
  return findExtractedPluginRoot(extractDir);
}

async function materializeMcpbBundle(
  source: string,
  tempRoot: string,
  options: PluginResolverOptions,
): Promise<string> {
  if (isHttpUrl(source)) {
    const bundlePath = join(tempRoot, "plugin.mcpb");
    await writeFile(bundlePath, await fetchBytes(source, options));
    return bundlePath;
  }
  const bundlePath = resolve(options.workspaceRoot ?? process.cwd(), source);
  await access(bundlePath);
  return bundlePath;
}

async function extractTarball(
  tarballPath: string,
  extractRoot: string,
  options: PluginResolverOptions,
): Promise<string> {
  await assertTarballSafe(tarballPath, options);
  await mkdir(extractRoot, { recursive: true, mode: 0o700 });
  await runProcess(options, "tar", [...tarExtractArgs(tarballPath), "-C", extractRoot]);
  await assertExtractedTreeContained(extractRoot, options);
  return findExtractedPluginRoot(extractRoot);
}

async function assertZipSafe(
  bundlePath: string,
  options: PluginResolverOptions,
): Promise<void> {
  const listing = await runProcess(options, "unzip", ["-Z1", bundlePath]);
  assertArchiveListingSafe(listing.stdout, options);
  const verbose = await runProcess(options, "unzip", ["-Z", "-v", bundlePath]);
  assertZipMetadataSafe(verbose.stdout, options);
}

async function assertTarballSafe(
  tarballPath: string,
  options: PluginResolverOptions,
): Promise<void> {
  const listing = await runProcess(options, "tar", tarListArgs(tarballPath));
  assertArchiveListingSafe(listing.stdout, options);
  const verbose = await runProcess(options, "tar", tarVerboseListArgs(tarballPath));
  assertTarMetadataSafe(verbose.stdout, options);
}

function assertTarMetadataSafe(
  verboseListing: string,
  options: Pick<PluginResolverOptions, "maxExtractDepth" | "maxExtractedBytes" | "maxExtractedFiles">,
): void {
  const entries: ArchivePreflightEntry[] = [];
  for (const line of verboseListing.split("\n")) {
    if (/^[lh]/u.test(line)) {
      throw new Error("plugin archive contains a symlink or hardlink entry");
    }
    const parsed = parseTarVerboseLine(line);
    if (parsed) entries.push(parsed);
  }
  assertArchivePreExtractionQuotas(entries, options);
}

function assertZipMetadataSafe(
  verboseListing: string,
  options: Pick<PluginResolverOptions, "maxExtractedBytes">,
): void {
  let byteCount = 0;
  for (const match of verboseListing.matchAll(/Unix file attributes \(([0-7]+) octal\):\s*(\S+)/gu)) {
    const mode = Number.parseInt(match[1]!, 8);
    const kind = mode & 0o170000;
    if (kind !== 0 && kind !== 0o040000 && kind !== 0o100000) {
      throw new Error(`plugin archive contains an unsafe zip entry type: ${match[2]}`);
    }
  }
  for (const match of verboseListing.matchAll(/uncompressed size:\s*([0-9]+)\s+bytes/giu)) {
    byteCount += Number.parseInt(match[1]!, 10);
  }
  const maxBytes = options.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;
  if (byteCount > maxBytes) throw new Error(`plugin archive exceeds maximum extracted size: ${byteCount} > ${maxBytes}`);
}

interface ArchivePreflightEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly size?: number;
}

function assertArchiveListingSafe(
  listing: string,
  options: Pick<PluginResolverOptions, "maxExtractDepth" | "maxExtractedFiles">,
): void {
  const entries: ArchivePreflightEntry[] = [];
  for (const entry of listing.split("\n")) {
    assertArchiveEntryPathSafe(entry);
    const path = entry.trim();
    if (!path) continue;
    entries.push({
      path,
      kind: path.endsWith("/") ? "directory" : "file",
    });
  }
  assertArchivePreExtractionQuotas(entries, options);
}

function assertArchivePreExtractionQuotas(
  entries: readonly ArchivePreflightEntry[],
  options: Pick<PluginResolverOptions, "maxExtractDepth" | "maxExtractedBytes" | "maxExtractedFiles">,
): void {
  const maxDepth = options.maxExtractDepth ?? DEFAULT_MAX_EXTRACT_DEPTH;
  const maxFiles = options.maxExtractedFiles ?? DEFAULT_MAX_EXTRACTED_FILES;
  const maxBytes = options.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;
  let fileCount = 0;
  let byteCount = 0;
  for (const entry of entries) {
    const depth = archiveEntryDepth(entry.path);
    if (depth > maxDepth) throw new Error(`plugin archive exceeds maximum extraction depth: ${depth} > ${maxDepth}`);
    if (entry.kind === "directory") continue;
    fileCount += 1;
    if (entry.size !== undefined) byteCount += entry.size;
    if (fileCount > maxFiles) throw new Error(`plugin archive exceeds maximum extracted file count: ${fileCount} > ${maxFiles}`);
    if (byteCount > maxBytes) throw new Error(`plugin archive exceeds maximum extracted size: ${byteCount} > ${maxBytes}`);
  }
}

function parseTarVerboseLine(line: string): ArchivePreflightEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const match = /^([d-])\S*\s+\S+\s+([0-9]+)\s+\S+\s+\S+\s+(.+)$/u.exec(trimmed);
  if (!match) return null;
  return {
    kind: match[1] === "d" ? "directory" : "file",
    path: match[3]!,
    size: Number.parseInt(match[2]!, 10),
  };
}

function archiveEntryDepth(path: string): number {
  return path.trim().replace(/\\/g, "/").split("/").filter(Boolean).length;
}

function tarListArgs(tarballPath: string): string[] {
  return [tarUsesGzip(tarballPath) ? "-tzf" : "-tf", tarballPath];
}

function tarVerboseListArgs(tarballPath: string): string[] {
  return [tarUsesGzip(tarballPath) ? "-tvzf" : "-tvf", tarballPath];
}

function tarExtractArgs(tarballPath: string): string[] {
  return [tarUsesGzip(tarballPath) ? "-xzf" : "-xf", tarballPath];
}

function tarUsesGzip(tarballPath: string): boolean {
  return !tarballPath.endsWith(".tar");
}

function assertArchiveEntryPathSafe(entry: string): void {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return;
  if (trimmed.includes("\0")) throw new Error("plugin archive entry contains a null byte");
  if (/^(?:\/|[a-zA-Z]:[\\/])/u.test(trimmed)) {
    throw new Error(`plugin archive entry escapes extraction root: ${trimmed}`);
  }
  const parts = trimmed.split(/[\\/]+/u).filter((part) => part.length > 0);
  if (parts.some((part) => part === "..")) {
    throw new Error(`plugin archive entry escapes extraction root: ${trimmed}`);
  }
}

async function assertExtractedTreeContained(
  root: string,
  options: Pick<PluginResolverOptions, "maxExtractDepth" | "maxExtractedBytes" | "maxExtractedFiles">,
): Promise<void> {
  const rootReal = await realpath(root);
  const maxDepth = options.maxExtractDepth ?? DEFAULT_MAX_EXTRACT_DEPTH;
  const maxFiles = options.maxExtractedFiles ?? DEFAULT_MAX_EXTRACTED_FILES;
  const maxBytes = options.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;
  let fileCount = 0;
  let byteCount = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) throw new Error(`plugin archive exceeds maximum extraction depth: ${depth} > ${maxDepth}`);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(dir, entry.name);
      const childStat = await lstat(child);
      if (childStat.isSymbolicLink()) {
        const target = resolve(dirname(child), await readlink(child));
        if (!isPathInside(resolve(target), rootReal)) {
          throw new Error(`plugin archive symlink escapes extraction root: ${entry.name}`);
        }
        throw new Error(`plugin archive symlinks are not supported: ${entry.name}`);
      }
      if (childStat.isFile() && childStat.nlink > 1) {
        throw new Error(`plugin archive hardlinks are not supported: ${entry.name}`);
      }
      const childReal = await realpath(child);
      if (!isPathInside(childReal, rootReal)) {
        throw new Error(`plugin archive entry escapes extraction root: ${entry.name}`);
      }
      if (childStat.isDirectory()) {
        await walk(child, depth + 1);
      } else if (childStat.isFile()) {
        fileCount += 1;
        byteCount += childStat.size;
        if (fileCount > maxFiles) throw new Error(`plugin archive exceeds maximum extracted file count: ${fileCount} > ${maxFiles}`);
        if (byteCount > maxBytes) throw new Error(`plugin archive exceeds maximum extracted size: ${byteCount} > ${maxBytes}`);
      }
    }
  }
  await walk(root, 0);
}

async function findExtractedPluginRoot(extractRoot: string): Promise<string> {
  if (await findPluginManifestPath(extractRoot)) return extractRoot;
  const entries = await import("node:fs/promises").then((fs) =>
    fs.readdir(extractRoot, { withFileTypes: true })
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(extractRoot, entry.name);
    if (await findPluginManifestPath(candidate)) return candidate;
  }
  const packageRoot = join(extractRoot, "package");
  if (await pathIsDirectory(packageRoot)) return packageRoot;
  return extractRoot;
}

async function activatePluginCache(sourceRoot: string, cacheRoot: string): Promise<string> {
  if (!(await loadPluginManifest(sourceRoot))) {
    throw new Error(`plugin source has no manifest: ${sourceRoot}`);
  }
  const parent = dirname(cacheRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(parent, `.${basename(cacheRoot)}-`));
  const staging = join(tempDir, "root");
  try {
    await cp(sourceRoot, staging, { recursive: true, dereference: false });
    await rm(cacheRoot, { recursive: true, force: true });
    await rename(staging, cacheRoot);
    return cacheRoot;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function withPluginCacheLock<T>(
  cacheRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = `${cacheRoot}.lock`;
  const startedAt = Date.now();
  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false, mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await removeStaleCacheLock(lockDir)) continue;
      if (Date.now() - startedAt > DEFAULT_CACHE_LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for plugin cache lock: ${cacheRoot}`);
      }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function removeStaleCacheLock(lockDir: string): Promise<boolean> {
  let lockStat;
  try {
    lockStat = await stat(lockDir);
  } catch {
    return true;
  }
  if (Date.now() - lockStat.mtimeMs <= DEFAULT_CACHE_LOCK_TIMEOUT_MS) return false;
  await rm(lockDir, { recursive: true, force: true });
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function runProcess(
  options: PluginResolverOptions,
  command: string,
  args: readonly string[],
): Promise<PluginProcessResult> {
  const runner = options.runProcess ?? defaultPluginProcessRunner;
  return runner(command, args, {
    timeoutMs: DEFAULT_PROCESS_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
  });
}

export async function defaultPluginProcessRunner(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  } = {},
): Promise<PluginProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_PROCESS_MAX_OUTPUT_BYTES;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let killTimeout: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimeout.unref();
    }, timeoutMs);
    timeout.unref();
    const clearProcessTimers = () => {
      clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const appended = appendBounded(stdout, stdoutBytes, chunk, maxOutputBytes);
      stdout = appended.text;
      stdoutBytes = appended.bytes;
    });
    child.stderr.on("data", (chunk) => {
      const appended = appendBounded(stderr, stderrBytes, chunk, maxOutputBytes);
      stderr = appended.text;
      stderrBytes = appended.bytes;
    });
    child.on("error", (error) => {
      clearProcessTimers();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearProcessTimers();
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} failed (${code ?? signal}): ${stderr || stdout}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function fetchBytes(
  source: string,
  options: PluginResolverOptions,
): Promise<Uint8Array> {
  const maxBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  if (options.fetchBytes) {
    const data = await options.fetchBytes(source);
    if (data.byteLength > maxBytes) {
      throw new Error(`plugin archive exceeds maximum download size: ${data.byteLength} > ${maxBytes}`);
    }
    return data;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`failed to fetch plugin archive: ${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`plugin archive exceeds maximum download size: ${contentLength} > ${maxBytes}`);
    }
    const body = response.body;
    if (!body) {
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength > maxBytes) throw new Error(`plugin archive exceeds maximum download size: ${data.byteLength} > ${maxBytes}`);
      return data;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("plugin archive exceeded maximum download size").catch(() => {});
        throw new Error(`plugin archive exceeds maximum download size: ${total} > ${maxBytes}`);
      }
      chunks.push(chunk.value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

function appendBounded(
  current: string,
  currentBytes: number,
  chunk: string,
  maxBytes: number,
): { text: string; bytes: number } {
  const nextBytes = currentBytes + Buffer.byteLength(chunk);
  if (nextBytes <= maxBytes) {
    return { text: current + chunk, bytes: nextBytes };
  }
  return { text: current, bytes: currentBytes };
}

function parseNpmPackTarballPath(stdout: string, packDir: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`npm pack returned invalid JSON: ${stdout}`);
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(entry)) throw new Error("npm pack returned no package entry");
  const filename = typeof entry.filename === "string"
    ? entry.filename
    : typeof entry.name === "string" && typeof entry.version === "string"
      ? `${entry.name}-${entry.version}.tgz`
      : undefined;
  if (!filename) throw new Error("npm pack output did not include a tarball filename");
  return resolve(packDir, basename(filename));
}

function parseSignatureFile(text: string): SignatureFile {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error("plugin signature file must be an object");
  if (typeof parsed.publisher !== "string" || parsed.publisher.trim().length === 0) {
    throw new Error("plugin signature file requires a publisher");
  }
  if (typeof parsed.signature !== "string" || parsed.signature.trim().length === 0) {
    throw new Error("plugin signature file requires a signature");
  }
  if (!isRecord(parsed.files)) {
    throw new Error("plugin signature file requires signed payload file digests");
  }
  const files: Record<string, string> = {};
  for (const [path, digest] of Object.entries(parsed.files)) {
    assertArchiveEntryPathSafe(path);
    if (typeof digest !== "string") {
      throw new Error(`plugin signature file digest must be a string: ${path}`);
    }
    files[path] = normalizeSha256Digest(digest);
  }
  return {
    publisher: parsed.publisher,
    signature: parsed.signature,
    files,
  };
}

async function collectPluginPayloadDigests(
  pluginRoot: string,
  manifestPath: string,
  signaturePath: string,
): Promise<Readonly<Record<string, string>>> {
  const rootReal = await realpath(pluginRoot);
  const manifestReal = await realpath(manifestPath);
  const signatureReal = await realpath(signaturePath);
  const out: Record<string, string> = {};

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(dir, entry.name);
      const childStat = await lstat(child);
      if (childStat.isSymbolicLink()) {
        throw new Error(`plugin signature cannot cover symlink payloads: ${entry.name}`);
      }
      const childReal = await realpath(child);
      if (!isPathInside(childReal, rootReal)) {
        throw new Error(`plugin payload escapes plugin root: ${entry.name}`);
      }
      if (childStat.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!childStat.isFile()) continue;
      if (childReal === manifestReal || childReal === signatureReal) continue;
      const relPath = relative(pluginRoot, child).replace(/\\/g, "/");
      out[relPath] = `sha256:${sha256Hex(await readFile(child))}`;
    }
  }

  await walk(pluginRoot);
  return out;
}

function assertSignedPayloadMatches(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): void {
  const expectedEntries = Object.entries(expected).sort(([a], [b]) => a.localeCompare(b));
  const actualEntries = Object.entries(actual).sort(([a], [b]) => a.localeCompare(b));
  if (expectedEntries.length !== actualEntries.length) {
    throw new Error("plugin signature payload digest set does not match extracted files");
  }
  for (let index = 0; index < expectedEntries.length; index += 1) {
    const [expectedPath, expectedDigest] = expectedEntries[index]!;
    const [actualPath, actualDigest] = actualEntries[index]!;
    if (expectedPath !== actualPath || normalizeSha256Digest(expectedDigest) !== normalizeSha256Digest(actualDigest)) {
      throw new Error(`plugin signature payload digest mismatch: ${expectedPath}`);
    }
  }
}

function normalizeSha256Digest(digest: string): string {
  const value = digest.trim().toLowerCase();
  const hex = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[a-f0-9]{64}$/u.test(hex)) throw new Error("plugin signature file requires sha256 payload digests");
  return `sha256:${hex}`;
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function readPublisherPublicKey(path: string, publisher: string): Promise<string> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as PublisherKeyring;
  const entry = parsed.publishers?.[publisher];
  const publicKey = typeof entry === "string" ? entry : entry?.publicKey;
  if (!publicKey) throw new Error(`plugin publisher is not trusted: ${publisher}`);
  return publicKey;
}

function defaultPublishersPath(): string {
  const home = process.env.HOME ?? process.cwd();
  return join(home, ".agenc", "plugin-publishers.json");
}

function cacheKeyForSource(source: string): string {
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return `${source.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 48)}-${hash}`;
}

function assertSafeNpmPackageSource(source: string): void {
  assertNotOptionLikeSource(source, "npm package");
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[\w.^~>=<*|-]+)?$/iu.test(source)) {
    throw new Error(`invalid npm plugin package source: ${source}`);
  }
}

function assertSafeGitSource(source: string): void {
  assertNotOptionLikeSource(source, "git repository");
  if (!isGitSource(source)) throw new Error(`invalid git plugin source: ${source}`);
  if (source.startsWith("git@")) {
    if (!/^git@[a-z0-9.-]+:[^\s]+$/iu.test(source)) {
      throw new Error(`invalid git plugin source: ${source}`);
    }
    return;
  }
  const urlSource = source.startsWith("git+") ? source.slice("git+".length) : source;
  try {
    const url = new URL(urlSource);
    if (!["https:", "ssh:", "git:"].includes(url.protocol) || url.hostname.length === 0) {
      throw new Error("unsupported protocol");
    }
    if (/\s/u.test(url.pathname)) throw new Error("whitespace in path");
  } catch {
    throw new Error(`invalid git plugin source: ${source}`);
  }
}

function assertNotOptionLikeSource(source: string, label: string): void {
  const trimmed = source.trim();
  if (trimmed.length === 0) throw new Error(`invalid ${label} source: empty`);
  if (trimmed.startsWith("-")) throw new Error(`invalid ${label} source: leading dashes are not allowed`);
  if (trimmed.includes("\0")) throw new Error(`invalid ${label} source: null bytes are not allowed`);
}

function isGitSource(source: string): boolean {
  if (source.startsWith("git+") ||
    source.startsWith("git@") ||
    source.startsWith("ssh://") ||
    source.endsWith(".git")) {
    return true;
  }
  try {
    const url = new URL(source);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (isTarballSource(source) || isMcpbSource(source)) return false;
    if (!KNOWN_GIT_HOSTS.has(url.hostname.toLowerCase())) return false;
    return url.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

function isTarballSource(source: string): boolean {
  try {
    const url = new URL(source);
    return ["http:", "https:"].includes(url.protocol) &&
      [".tgz", ".gz", ".tar"].some((suffix) => url.pathname.endsWith(suffix));
  } catch {
    return false;
  }
}

function isMcpbSource(source: string): boolean {
  if (source.endsWith(".mcpb")) return true;
  try {
    const url = new URL(source);
    return ["http:", "https:"].includes(url.protocol) && url.pathname.endsWith(".mcpb");
  } catch {
    return false;
  }
}

function isHttpUrl(source: string): boolean {
  try {
    const url = new URL(source);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function tarballExtension(source: string): string {
  const extension = extname(new URL(source).pathname);
  return extension === ".tar" ? ".tar" : ".tgz";
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function telemetryHost(source: string): string {
  if (isGitSource(source)) {
    const scp = /^[^@/]+@([^:/]+):/u.exec(source);
    if (scp) return knownOrOtherHost(scp[1]!);
  }
  try {
    return knownOrOtherHost(new URL(source).hostname);
  } catch {
    return "unknown";
  }
}

function knownOrOtherHost(host: string): string {
  const normalized = host.toLowerCase();
  return KNOWN_PUBLIC_HOSTS.has(normalized) ? normalized : "other";
}

function emitTelemetry(
  options: PluginResolverOptions,
  event: PluginFetchTelemetry,
): void {
  options.onTelemetry?.(event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fileUrlForPluginRoot(path: string): string {
  return pathToFileURL(resolve(path)).toString();
}
