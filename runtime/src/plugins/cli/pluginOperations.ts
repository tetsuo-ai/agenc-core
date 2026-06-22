import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolveAgencHome } from "../../config/env.js";
import { loadConfig } from "../../config/loader.js";
import type { PluginEntryConfig } from "../../config/schema.js";
import { isRecord } from "../../utils/record.js";
import { createPluginFromPath, loadPlugins, type LoadedPlugin } from "../loader.js";
import { findPluginManifestPath } from "../manifest.js";
import { validateMarketplaceManifest, validatePluginManifest, type ValidationResult } from "../validation.js";
import { deletePluginDataDir, sanitizePluginId } from "../directories.js";
import {
  pluginDependencyIdentityFromSource,
  pluginSourceNeedsRedaction,
  redactPluginSource,
  resolvePluginSource,
  shouldCopyPluginPayloadPath,
  type PluginFetchTelemetry,
  type PluginProcessRunner,
  type PluginResolutionKind,
  type ResolvedPluginSource,
} from "../resolution.js";

export type PluginScope = "user" | "project" | "local";

export interface PluginCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface PluginOperationOptions {
  readonly agencHome?: string;
  readonly workspaceRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly onWarn?: (message: string) => void;
}

export interface InstalledPluginSummary {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly root: string;
  readonly source: string;
}

export interface PluginListResult {
  readonly plugins: readonly InstalledPluginSummary[];
  readonly errors: readonly string[];
}

export interface InstallPluginInput extends PluginOperationOptions {
  readonly source: string;
  readonly scope?: PluginScope;
  readonly name?: string;
  readonly force?: boolean;
  readonly refreshCache?: boolean;
  readonly requireSignature?: boolean;
  readonly publishersPath?: string;
  readonly runResolutionProcess?: PluginProcessRunner;
  readonly fetchResolutionBytes?: (url: string) => Promise<Uint8Array>;
  readonly onPluginFetchTelemetry?: (event: PluginFetchTelemetry) => void;
}

export interface InstallPluginResult {
  readonly plugin: InstalledPluginSummary;
  readonly destination: string;
  readonly scope: PluginScope;
  readonly resolutionKind: PluginResolutionKind;
  readonly signatureVerified: boolean;
}

export interface UninstallPluginInput extends PluginOperationOptions {
  readonly pluginId: string;
  readonly scope?: PluginScope;
  readonly keepData?: boolean;
}

export interface UninstallPluginResult {
  readonly pluginId: string;
  readonly removedRoots: readonly string[];
  readonly removedConfig: boolean;
  readonly removedData: boolean;
}

export interface SetPluginEnabledInput extends PluginOperationOptions {
  readonly pluginId: string;
  readonly enabled: boolean;
  readonly path?: string;
}

export interface SetPluginEnabledResult {
  readonly pluginId: string;
  readonly enabled: boolean;
  readonly configPath: string;
}

export interface DisableAllPluginsResult {
  readonly disabled: readonly string[];
  readonly configPath: string;
}

export interface UpdatePluginInput extends PluginOperationOptions {
  readonly pluginId: string;
  readonly scope?: PluginScope;
  readonly source?: string;
  readonly requireSignature?: boolean;
  readonly publishersPath?: string;
  readonly runResolutionProcess?: PluginProcessRunner;
  readonly fetchResolutionBytes?: (url: string) => Promise<Uint8Array>;
  readonly onPluginFetchTelemetry?: (event: PluginFetchTelemetry) => void;
}

export interface UpdatePluginResult extends InstallPluginResult {
  readonly previousRoot: string;
  readonly source: string;
}

const MANAGED_CONFIG_PREFIX = "# BEGIN agenc plugin";
const MANAGED_CONFIG_SUFFIX = "# END agenc plugin";
const INSTALL_METADATA_FILE = "agenc-install.json";
const RESERVED_INSTALL_NAMES = new Set(["cache", "data"]);

function resolvePluginAgencHome(options: PluginOperationOptions = {}): string {
  return options.agencHome ?? resolveAgencHome(options.env);
}

function resolvePluginWorkspaceRoot(options: PluginOperationOptions = {}): string {
  return options.workspaceRoot ?? process.cwd();
}

function pluginScopeRoot(
  scope: PluginScope,
  options: PluginOperationOptions = {},
): string {
  const agencHome = resolvePluginAgencHome(options);
  const workspaceRoot = resolvePluginWorkspaceRoot(options);
  switch (scope) {
    case "user":
      return join(agencHome, "plugins");
    case "project":
    case "local":
      return join(workspaceRoot, ".agents", "plugins");
  }
}

function pluginConfigPath(options: PluginOperationOptions = {}): string {
  return join(resolvePluginAgencHome(options), "config.toml");
}

export function formatPluginList(result: PluginListResult): string {
  if (result.plugins.length === 0) {
    return result.errors.length === 0
      ? "No AgenC plugins installed."
      : `No AgenC plugins installed.\n${formatPluginErrors(result.errors)}`;
  }
  const lines = ["AgenC plugins:"];
  for (const plugin of result.plugins) {
    const version = plugin.version ? ` v${plugin.version}` : "";
    const state = plugin.enabled ? "enabled" : "disabled";
    lines.push(`- ${plugin.name}${version} (${state}) ${plugin.root}`);
  }
  if (result.errors.length > 0) {
    lines.push("", formatPluginErrors(result.errors));
  }
  return lines.join("\n");
}

export async function listInstalledPlugins(
  options: PluginOperationOptions = {},
): Promise<PluginListResult> {
  const agencHome = resolvePluginAgencHome(options);
  const workspaceRoot = resolvePluginWorkspaceRoot(options);
  const warnings: string[] = [];
  const loadedConfig = await loadConfig({
    home: agencHome,
    onWarn: (message) => {
      warnings.push(message);
      options.onWarn?.(message);
    },
  });
  const loaded = await loadPlugins({
    agencHome,
    workspaceRoot,
    config: loadedConfig.config,
  });
  return {
    plugins: [...loaded.enabled, ...loaded.disabled]
      .map(summarizeLoadedPlugin)
      .sort((a, b) => a.name.localeCompare(b.name)),
    errors: [
      ...warnings,
      ...loaded.errors.map((issue) => `${issue.source}: ${issue.message}`),
    ],
  };
}

export async function validatePluginPath(
  inputPath: string,
  options: { readonly marketplace?: boolean } = {},
): Promise<ValidationResult> {
  const absolutePath = resolve(inputPath);
  if (options.marketplace || basename(absolutePath) === "marketplace.json") {
    return validateMarketplaceManifest(absolutePath);
  }
  let stats;
  try {
    stats = await stat(absolutePath);
  } catch {
    return validatePluginManifest(absolutePath);
  }
  if (stats.isDirectory()) {
    const manifestPath = await findPluginManifestPath(absolutePath);
    if (manifestPath) {
      return validatePluginManifest(manifestPath);
    }
    if (await hasComponentOnlyPluginShape(absolutePath)) {
      return {
        success: true,
        errors: [],
        warnings: [{
          path: absolutePath,
          message: "Plugin has no manifest; AgenC will infer a minimal manifest from component directories.",
        }],
        filePath: absolutePath,
        fileType: "plugin",
      };
    }
  }
  return validatePluginManifest(absolutePath);
}

export async function installPluginOp(
  input: InstallPluginInput,
): Promise<InstallPluginResult> {
  const scope = input.scope ?? "user";
  const workspaceRoot = resolvePluginWorkspaceRoot(input);
  const localSource = resolvePath(input.source, workspaceRoot);
  let resolved: ResolvedPluginSource | null = null;
  let source = localSource;
  let resolutionKind: PluginResolutionKind = "local";
  let signatureVerified = false;
  if (!(await pathIsDirectory(localSource))) {
    resolved = await resolvePluginSource(input.source, {
      agencHome: resolvePluginAgencHome(input),
      workspaceRoot,
      refreshCache: input.refreshCache,
      requireSignature: input.requireSignature ?? true,
      publishersPath: input.publishersPath,
      runProcess: input.runResolutionProcess,
      fetchBytes: input.fetchResolutionBytes,
      onTelemetry: input.onPluginFetchTelemetry,
    });
    source = resolved.pluginRoot;
    resolutionKind = resolved.kind;
    signatureVerified = resolved.signature?.verified === true;
  }
  try {
    await requireDirectory(source, "plugin source");
    if (!(await hasInstallablePluginShape(source))) {
      throw new Error(`plugin source has no ${".agenc-plugin/plugin.json"} or component directories: ${source}`);
    }
    const loaded = await createPluginFromPath(source, {
      source,
      enabled: true,
      fallbackName: basename(source),
    });
    if (loaded.errors.length > 0) {
      throw new Error(
        `plugin source failed validation: ${loaded.errors.map((issue) => issue.message).join("; ")}`,
      );
    }
    const pluginName = input.name?.trim() || loaded.plugin.name || basename(source);
    const safeName = sanitizeInstallName(pluginName);
    const installRoot = pluginScopeRoot(scope, input);
    await mkdir(installRoot, { recursive: true, mode: 0o700 });
    const destination = join(installRoot, safeName);
    await copyDirectoryAtomically(source, destination, {
      force: input.force === true,
    });
    await writeInstallMetadata(destination, {
      name: pluginName,
      source: resolutionKind === "local" ? source : redactPluginSource(input.source),
      ...(resolutionKind !== "local" ? dependencyIdentityMetadata(input.source) : {}),
      ...(resolutionKind !== "local" && pluginSourceNeedsRedaction(input.source) ? { sourceRedacted: true } : {}),
      sourceRoot: source,
      scope,
      resolutionKind,
      signatureVerified,
      installedAt: (input.now ?? (() => new Date()))().toISOString(),
    });
    const plugin = await createPluginFromPath(destination, {
      source: scope,
      enabled: true,
      fallbackName: safeName,
    });
    await writePluginConfigEntry(pluginName, { enabled: true }, input);
    return {
      plugin: summarizeLoadedPlugin(plugin.plugin),
      destination,
      scope,
      resolutionKind,
      signatureVerified,
    };
  } finally {
    await resolved?.cleanup();
  }
}

export async function uninstallPluginOp(
  input: UninstallPluginInput,
): Promise<UninstallPluginResult> {
  const scope = input.scope ?? "user";
  const targetRoots = await resolvePluginRootsForRemoval(input.pluginId, scope, input);
  if (targetRoots.length === 0) {
    throw new Error(`plugin is not installed in ${scope} scope: ${input.pluginId}`);
  }
  for (const root of targetRoots) {
    await rm(root, { recursive: true, force: true });
  }
  const removedConfig = await removePluginConfigEntry(input.pluginId, input);
  let removedData = false;
  if (input.keepData !== true) {
    await deletePluginDataDir(input.pluginId, input.env, homedir());
    await rm(join(resolvePluginAgencHome(input), "plugins", "data", sanitizePluginId(input.pluginId)), {
      recursive: true,
      force: true,
    });
    removedData = true;
  }
  return {
    pluginId: input.pluginId,
    removedRoots: targetRoots,
    removedConfig,
    removedData,
  };
}

export async function setPluginEnabledOp(
  input: SetPluginEnabledInput,
): Promise<SetPluginEnabledResult> {
  const entry: PluginEntryConfig = {
    enabled: input.enabled,
    ...(input.path ? { path: resolvePath(input.path, resolvePluginWorkspaceRoot(input)) } : {}),
  };
  const configPath = await writePluginConfigEntry(input.pluginId, entry, input);
  return {
    pluginId: input.pluginId,
    enabled: input.enabled,
    configPath,
  };
}

export async function disableAllPluginsOp(
  options: PluginOperationOptions = {},
): Promise<DisableAllPluginsResult> {
  const listed = await listInstalledPlugins(options);
  const names = listed.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.name);
  let configPath = pluginConfigPath(options);
  for (const name of names) {
    configPath = await writePluginConfigEntry(name, { enabled: false }, options);
  }
  return {
    disabled: names,
    configPath,
  };
}

export async function updatePluginOp(
  input: UpdatePluginInput,
): Promise<UpdatePluginResult> {
  const scope = input.scope ?? "user";
  const workspaceRoot = resolvePluginWorkspaceRoot(input);
  const roots = await resolvePluginRootsForRemoval(input.pluginId, scope, input);
  if (roots.length === 0) {
    throw new Error(`plugin is not installed in ${scope} scope: ${input.pluginId}`);
  }
  if (roots.length > 1) {
    throw new Error(`plugin resolves to multiple install roots in ${scope} scope: ${input.pluginId}`);
  }
  const previousRoot = roots[0]!;
  const source = input.source !== undefined
    ? input.source
    : await readInstalledPluginSource(previousRoot);
  if (source === undefined) {
    throw new Error(
      `plugin ${input.pluginId} has no recorded source; rerun with --source <path>`,
    );
  }
  const localSource = resolvePath(source, workspaceRoot);
  if (await pathExists(localSource)) {
    const sourceReal = await realpath(localSource);
    const rootReal = await realpath(previousRoot);
    if (sourceReal === rootReal || sourceReal.startsWith(`${rootReal}/`)) {
      throw new Error(`plugin update source cannot be the installed plugin root: ${source}`);
    }
  }
  const installed = await installPluginOp({
    ...input,
    source,
    name: input.pluginId,
    scope,
    force: true,
    refreshCache: true,
  });
  return {
    ...installed,
    previousRoot,
    source,
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

async function readJsonFile<T>(
  path: string,
  fallback: T,
): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeTextAtomic(
  path: string,
  text: string,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(dirname(path), ".tmp-"));
  const tempPath = join(tempDir, basename(path));
  try {
    await writeFile(tempPath, text, { mode });
    await rename(tempPath, path);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function sanitizeInstallName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("plugin name cannot be empty");
  }
  const safeName = sanitizePluginId(trimmed);
  if (safeName.length === 0 || safeName === "." || safeName === "..") {
    throw new Error(`plugin name cannot be used as an install directory: ${name}`);
  }
  if (RESERVED_INSTALL_NAMES.has(safeName.toLowerCase())) {
    throw new Error(`plugin name is reserved for AgenC internal storage: ${name}`);
  }
  return safeName;
}

function resolvePath(path: string, base: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function summarizeLoadedPlugin(plugin: LoadedPlugin): InstalledPluginSummary {
  return {
    name: plugin.name,
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    ...(plugin.description !== undefined ? { description: plugin.description } : {}),
    enabled: plugin.enabled,
    root: plugin.root,
    source: plugin.source,
  };
}

function formatPluginErrors(errors: readonly string[]): string {
  return ["Plugin load issues:", ...errors.map((error) => `- ${error}`)].join("\n");
}

async function requireDirectory(path: string, label: string): Promise<void> {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    throw new Error(`${label} not found: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} must be a directory: ${path}`);
  }
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hasInstallablePluginShape(path: string): Promise<boolean> {
  return (await findPluginManifestPath(path)) !== null ||
    await hasComponentOnlyPluginShape(path);
}

async function hasComponentOnlyPluginShape(path: string): Promise<boolean> {
  const checks = [
    "commands",
    "agents",
    "skills",
    "output-styles",
    "hooks/hooks.json",
    ".mcp.json",
    ".lsp.json",
    ".app.json",
  ];
  for (const relative of checks) {
    try {
      await stat(join(path, relative));
      return true;
    } catch {
      // Keep scanning the remaining supported component locations.
    }
  }
  return false;
}

async function copyDirectoryAtomically(
  source: string,
  destination: string,
  options: { readonly force: boolean },
): Promise<void> {
  let existing = false;
  try {
    await stat(destination);
    existing = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    const sourceReal = await realpath(source);
    const destinationReal = await realpath(destination);
    if (sourceReal === destinationReal || sourceReal.startsWith(`${destinationReal}/`)) {
      throw new Error(`plugin source cannot be the installed plugin root: ${source}`);
    }
  }
  if (existing && !options.force) {
    throw new Error(`plugin destination already exists: ${destination}`);
  }
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(parent, `.${basename(destination)}-`));
  const staging = join(tempDir, "root");
  try {
    await cp(source, staging, {
      recursive: true,
      dereference: false,
      filter: (sourcePath) => shouldCopyPluginPayloadPath(source, sourcePath),
    });
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function dependencyIdentityMetadata(source: string): { readonly dependencyIdentity?: string } {
  const dependencyIdentity = pluginDependencyIdentityFromSource(source);
  return dependencyIdentity === undefined ? {} : { dependencyIdentity };
}

async function writeInstallMetadata(
  pluginRoot: string,
  metadata: {
    readonly name: string;
    readonly source: string;
    readonly sourceRedacted?: boolean;
    readonly sourceRoot?: string;
    readonly scope: PluginScope;
    readonly resolutionKind?: PluginResolutionKind;
    readonly signatureVerified?: boolean;
    readonly installedAt: string;
  },
): Promise<void> {
  await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(join(pluginRoot, ".agenc-plugin", INSTALL_METADATA_FILE), metadata);
}

async function readInstalledPluginSource(
  pluginRoot: string,
): Promise<string | undefined> {
  const metadata = await readJsonFile<unknown>(
    join(pluginRoot, ".agenc-plugin", INSTALL_METADATA_FILE),
    null,
  );
  return isRecord(metadata) && typeof metadata.source === "string" && metadata.sourceRedacted !== true
    ? metadata.source
    : undefined;
}

async function resolvePluginRootsForRemoval(
  pluginId: string,
  scope: PluginScope,
  options: PluginOperationOptions,
): Promise<string[]> {
  const roots = new Set<string>();
  const installRoot = pluginScopeRoot(scope, options);
  const directRoot = join(installRoot, sanitizeInstallName(pluginId));
  try {
    if ((await stat(directRoot)).isDirectory()) {
      roots.add(await realpath(directRoot));
    }
  } catch {
    // Manifest-name lookup below handles installs whose directory name differs.
  }
  const listed = await listInstalledPlugins(options);
  for (const plugin of listed.plugins) {
    if (plugin.name !== pluginId && basename(plugin.root) !== pluginId) continue;
    if (isPathInside(plugin.root, installRoot)) {
      roots.add(await realpath(plugin.root));
    }
  }
  return [...roots].sort((a, b) => a.localeCompare(b));
}

function isPathInside(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

async function writePluginConfigEntry(
  pluginId: string,
  entry: PluginEntryConfig,
  options: PluginOperationOptions,
): Promise<string> {
  const path = pluginConfigPath(options);
  const marker = managedMarker(pluginId);
  const block = renderManagedPluginBlock(pluginId, entry, marker);
  const text = await readOptionalText(path);
  const base = removeManagedBlock(text, marker);
  const next = appendManagedBlock(
    entry.enabled === false ? base : ensurePluginsFeatureEnabled(base),
    block,
  );
  await writeTextAtomic(path, next);
  return path;
}

async function removePluginConfigEntry(
  pluginId: string,
  options: PluginOperationOptions,
): Promise<boolean> {
  const path = pluginConfigPath(options);
  const marker = managedMarker(pluginId);
  const text = await readOptionalText(path);
  const next = removeManagedBlock(text, marker);
  if (next === text) return false;
  await writeTextAtomic(path, next);
  return true;
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function managedMarker(pluginId: string): string {
  return Buffer.from(pluginId, "utf8").toString("base64url");
}

function removeManagedBlock(text: string, marker: string): string {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const re = new RegExp(
    `\\n?${MANAGED_CONFIG_PREFIX} ${escaped}\\n[\\s\\S]*?${MANAGED_CONFIG_SUFFIX} ${escaped}\\n?`,
    "gu",
  );
  return text.replace(re, "\n").trimEnd();
}

function appendManagedBlock(text: string, block: string): string {
  const trimmed = text.trimEnd();
  return `${trimmed}${trimmed.length > 0 ? "\n\n" : ""}${block}\n`;
}

function ensurePluginsFeatureEnabled(text: string): string {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  let pluginsHeaderIndex = -1;
  let enabledIndex = -1;
  let inPluginsTable = false;
  for (const [index, line] of lines.entries()) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u)?.[1]?.trim();
    if (table !== undefined) {
      inPluginsTable = table === "plugins";
      if (inPluginsTable && pluginsHeaderIndex === -1) {
        pluginsHeaderIndex = index;
      }
      continue;
    }
    if (inPluginsTable && /^\s*enabled\s*=/u.test(line)) {
      enabledIndex = index;
      break;
    }
  }
  if (enabledIndex !== -1) {
    lines[enabledIndex] = "enabled = true";
    return lines.join("\n").trimEnd();
  }
  if (pluginsHeaderIndex !== -1) {
    lines.splice(pluginsHeaderIndex + 1, 0, "enabled = true");
    return lines.join("\n").trimEnd();
  }
  const trimmed = text.trimEnd();
  return `${trimmed}${trimmed.length > 0 ? "\n\n" : ""}[plugins]\nenabled = true`;
}

function renderManagedPluginBlock(
  pluginId: string,
  entry: PluginEntryConfig,
  marker: string,
): string {
  const lines = [
    `${MANAGED_CONFIG_PREFIX} ${marker}`,
    `[plugins.plugins.${tomlString(pluginId)}]`,
    `enabled = ${entry.enabled === false ? "false" : "true"}`,
  ];
  if (entry.path !== undefined) lines.push(`path = ${tomlString(entry.path)}`);
  if (entry.source !== undefined) lines.push(`source = ${tomlString(entry.source)}`);
  if (entry.version !== undefined) lines.push(`version = ${tomlString(entry.version)}`);
  if (entry.required !== undefined) lines.push(`required = ${entry.required ? "true" : "false"}`);
  lines.push(`${MANAGED_CONFIG_SUFFIX} ${marker}`);
  return lines.join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
