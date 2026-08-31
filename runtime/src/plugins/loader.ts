import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isValidPermissionDefaultMode, validateHooksConfig } from "../config/schema.js";
import type {
  AgenCConfig,
  HooksMap,
  LspServerConfigInput,
  McpTransport,
  McpServerConfig,
  PerToolConfig,
  PluginEntryConfig,
  PluginMcpServerConfig,
} from "../config/schema.js";
import { pluginDependencyIdentityFromSource, verifyPluginDependencyState } from "./resolution.js";
import {
  createPluginStorageAuthority,
  isReservedPluginStorageChildName,
  migrateLegacyPluginDataDirectories,
} from "./directories.js";
import { pluginScopedServerIdentifier } from "./identifier-normalization.js";
import {
  assertNoRetiredRootPluginManifest,
  findPluginManifestPath,
  loadRequiredPluginManifest,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_RELATIVE_PATH,
  readJsonText,
} from "./manifest.js";
import {
  isRecord,
  resolveManifestRelativePath,
  type PluginCommandDeclaration,
  type PluginCommandMetadata,
  type PluginComponentKind,
  type PluginManifest,
  type PluginPathDeclaration,
  type PluginServerDeclaration,
} from "./manifest-schema.js";
import {
  CONVENTIONAL_APP_FILE,
  CONVENTIONAL_HOOKS_FILE,
  CONVENTIONAL_LSP_FILE,
  inspectPluginPackageAuthority,
  RETIRED_PLUGIN_MCP_FILE,
  RETIRED_PLUGIN_SETTINGS_FILE,
} from "./package-authority.js";

const INSTALL_METADATA_FILE = "agenc-install.json";
const MAX_PLUGIN_MARKDOWN_FILES = 512;
const MAX_PLUGIN_SCAN_DEPTH = 8;
const LSP_SERVER_KEYS = new Set([
  "command",
  "args",
  "env",
  "workspaceFolder",
  "extensionToLanguage",
  "initializationOptions",
  "startupTimeout",
  "maxRestarts",
]);
const PLUGIN_SETTINGS_KEYS = new Set([
  "permissions",
  "env",
  "mcpServers",
  "lspServers",
  "hooks",
  "commands",
  "agents",
  "skills",
  "outputStyles",
  "apps",
  "options",
  "metadata",
]);
const DEFAULT_COMPONENT_DIRS = {
  commands: "commands",
  agents: "agents",
  skills: "skills",
  outputStyles: "output-styles",
} as const;
const SKIP_PLUGIN_ROOTS = new Set([
  ".git",
  ".cache",
]);

export type PluginLoadIssueType =
  | "manifest"
  | "path-not-found"
  | "hooks"
  | "mcp"
  | "lsp"
  | "dependency"
  | "settings";

export interface PluginLoadIssue {
  readonly type: PluginLoadIssueType;
  readonly plugin?: string;
  readonly source: string;
  readonly path?: string;
  readonly component?: PluginComponentKind;
  readonly message: string;
}

export interface LoadedPluginCommand {
  readonly name: string;
  readonly path?: string;
  readonly content?: string;
  readonly metadata: PluginCommandMetadata;
  readonly manifestName?: string;
}

export interface PluginHookSource {
  readonly pluginName: string;
  readonly pluginRoot: string;
  readonly sourcePath: string;
  readonly sourceRelativePath: string;
  readonly hooks: HooksMap;
}

export type PluginContentProvenance = "authority-controlled" | "repository-controlled";

export interface LoadedPlugin {
  /** Stable config, option, secret, and data identity. Never a filesystem path. */
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly root: string;
  readonly source: string;
  /**
   * Whether the loaded bytes come from an operator-controlled install root or
   * from the mutable workspace. Repository-controlled plugins are guidance
   * only and cannot register execution capabilities.
   */
  readonly contentProvenance: PluginContentProvenance;
  readonly enabled: boolean;
  readonly manifest: PluginManifest;
  readonly manifestPath?: string;
  readonly commandsPath?: string;
  readonly commandsPaths: readonly string[];
  readonly commands: readonly LoadedPluginCommand[];
  readonly agentsPath?: string;
  readonly agentsPaths: readonly string[];
  readonly skillsPath?: string;
  readonly skillsPaths: readonly string[];
  readonly outputStylesPath?: string;
  readonly outputStylesPaths: readonly string[];
  readonly hookSources: readonly PluginHookSource[];
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly lspServers: Readonly<Record<string, LspServerConfigInput>>;
  readonly appConnectorIds: readonly string[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly errors: readonly PluginLoadIssue[];
}

function canonicalLoadedPluginId(source: string, manifestName: string): string {
  return pluginDependencyIdentityFromSource(source) ?? manifestName;
}

export interface PluginLoadResult {
  readonly enabled: readonly LoadedPlugin[];
  readonly disabled: readonly LoadedPlugin[];
  readonly errors: readonly PluginLoadIssue[];
}

export interface PluginLoaderOptions {
  readonly pluginStorageRoot: string;
  readonly workspaceRoot: string;
  readonly config?: Pick<AgenCConfig, "plugins"> | undefined;
  readonly extraPluginDirs?: readonly string[];
}

interface DiscoveredPluginRoot {
  readonly path: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly contentProvenance: PluginContentProvenance;
  readonly key?: string;
  readonly featureGated?: boolean;
}

export function isRepositoryControlledPlugin(
  plugin: Pick<LoadedPlugin, "contentProvenance">,
): boolean {
  return plugin.contentProvenance === "repository-controlled";
}

function configuredPluginEntries(
  config: Pick<AgenCConfig, "plugins"> | undefined,
): Readonly<Record<string, PluginEntryConfig>> {
  const plugins = config?.plugins;
  return {
    ...(isRecord(plugins) && isRecord(plugins.plugins)
      ? plugins.plugins as Readonly<Record<string, PluginEntryConfig>>
      : {}),
  };
}

function pluginAutoDiscoveryEnabled(
  config: Pick<AgenCConfig, "plugins"> | undefined,
): boolean {
  const plugins = config?.plugins;
  return isRecord(plugins) &&
    (plugins.enabled === true || isRecord(plugins.plugins));
}

function pluginFeatureEnabled(
  config: Pick<AgenCConfig, "plugins"> | undefined,
): boolean {
  const plugins = config?.plugins;
  return isRecord(plugins) && plugins.enabled === true;
}

function configuredPluginAllowlist(
  config: Pick<AgenCConfig, "plugins"> | undefined,
): ReadonlySet<string> | null {
  const plugins = config?.plugins;
  if (!isRecord(plugins) || !Array.isArray(plugins.allowlist)) return null;
  const allowlist = plugins.allowlist
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return allowlist.length > 0 ? new Set(allowlist) : null;
}

function configuredPluginDirs(
  config: Pick<AgenCConfig, "plugins"> | undefined,
): readonly string[] {
  const plugins = config?.plugins;
  if (!isRecord(plugins) || !Array.isArray(plugins.dirs)) return [];
  return plugins.dirs
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pluginAllowedByAllowlist(
  pluginIds: readonly string[],
  allowlist: ReadonlySet<string> | null,
): boolean {
  if (allowlist === null) return true;
  return pluginIds.some((pluginId) => {
    const marketplaceSeparator = pluginId.lastIndexOf("@");
    const pluginName = marketplaceSeparator > 0
      ? pluginId.slice(0, marketplaceSeparator)
      : pluginId;
    return allowlist.has(pluginId) || allowlist.has(pluginName);
  });
}

function configuredValueForRoot(
  root: DiscoveredPluginRoot,
  configured: Readonly<Record<string, PluginEntryConfig>>,
): PluginEntryConfig | undefined {
  return (root.key ? configured[root.key] : undefined) ??
    configured[root.source] ??
    configured[basename(root.path)];
}

function configuredValueForPlugin(
  root: DiscoveredPluginRoot,
  configured: Readonly<Record<string, PluginEntryConfig>>,
  manifestName: string,
): PluginEntryConfig | undefined {
  return (root.key ? configured[root.key] : undefined) ??
    configured[root.source] ??
    configured[manifestName] ??
    configured[basename(root.path)];
}

function resolvePath(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

function configEntryEnabled(value: PluginEntryConfig | undefined): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return true;
  return value.enabled !== false;
}

function configEntryPath(value: PluginEntryConfig | undefined): string | undefined {
  return isRecord(value) && typeof value.path === "string"
    ? value.path
    : undefined;
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function maybeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function hasPluginManifest(path: string): Promise<boolean> {
  try {
    return (await findPluginManifestPath(path)) !== null;
  } catch {
    // A retired root manifest is still a plugin-shaped input. Keep the root
    // in discovery so createPluginFromPath can disable it with the actionable
    // manifest diagnostic instead of silently ignoring it.
    return true;
  }
}

async function hasPluginShape(path: string): Promise<boolean> {
  if (await hasPluginManifest(path)) return true;
  return Promise.all([
    pathIsDirectory(join(path, DEFAULT_COMPONENT_DIRS.commands)),
    pathIsDirectory(join(path, DEFAULT_COMPONENT_DIRS.agents)),
    pathIsDirectory(join(path, DEFAULT_COMPONENT_DIRS.skills)),
    pathIsDirectory(join(path, DEFAULT_COMPONENT_DIRS.outputStyles)),
    pathIsFile(join(path, CONVENTIONAL_HOOKS_FILE)),
    pathIsFile(join(path, RETIRED_PLUGIN_MCP_FILE)),
    pathIsFile(join(path, RETIRED_PLUGIN_SETTINGS_FILE)),
    pathIsFile(join(path, CONVENTIONAL_LSP_FILE)),
    pathIsFile(join(path, CONVENTIONAL_APP_FILE)),
  ]).then((checks) => checks.some(Boolean));
}

async function discoverRootsUnder(
  baseDir: string,
  contentProvenance: PluginContentProvenance,
  options: { readonly allowBasePlugin?: boolean } = {},
): Promise<DiscoveredPluginRoot[]> {
  if (!(await pathIsDirectory(baseDir))) return [];
  if (options.allowBasePlugin !== false && await hasPluginManifest(baseDir)) {
    return [{
      path: await maybeRealpath(baseDir),
      source: await installedPluginDependencyIdentity(baseDir) ?? baseDir,
      enabled: true,
      contentProvenance,
    }];
  }
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots: DiscoveredPluginRoot[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      SKIP_PLUGIN_ROOTS.has(entry.name) ||
      isReservedPluginStorageChildName(entry.name)
    ) continue;
    const candidate = join(baseDir, entry.name);
    if (await hasPluginShape(candidate)) {
      roots.push({
        path: await maybeRealpath(candidate),
        source: await installedPluginDependencyIdentity(candidate) ?? candidate,
        enabled: true,
        contentProvenance,
      });
    }
  }
  return roots.sort((a, b) => a.path.localeCompare(b.path));
}

function contentProvenanceForPath(
  candidate: string,
  canonicalCandidate: string,
  workspaceRoot: string,
  pluginStorageRoot: string,
): PluginContentProvenance {
  const isWithin = (path: string, root: string): boolean => {
    const pathRelative = relative(resolve(root), resolve(path));
    return pathRelative === "" ||
      (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
  };
  if (
    isWithin(candidate, pluginStorageRoot) &&
    isWithin(canonicalCandidate, pluginStorageRoot)
  ) {
    return "authority-controlled";
  }
  return isWithin(candidate, workspaceRoot) ||
      isWithin(canonicalCandidate, workspaceRoot)
    ? "repository-controlled"
    : "authority-controlled";
}

async function installedPluginDependencyIdentity(pluginRoot: string): Promise<string | undefined> {
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(join(pluginRoot, ".agenc-plugin", INSTALL_METADATA_FILE), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
  if (!isRecord(metadata)) return undefined;
  if (typeof metadata.dependencyIdentity === "string") {
    return pluginDependencyIdentityFromSource(metadata.dependencyIdentity);
  }
  if (metadata.sourceRedacted === true || typeof metadata.source !== "string") return undefined;
  return pluginDependencyIdentityFromSource(metadata.source);
}

async function findGitRepoRoot(start: string): Promise<string | undefined> {
  let current = resolve(start);
  for (;;) {
    try {
      // In worktrees `.git` is a file, in regular checkouts it is a directory.
      // Either way, its presence marks the project root for plugin discovery.
      await stat(join(current, ".git"));
      return current;
    } catch {
      // Continue walking.
    }
    const parent = resolve(current, "..");
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function discoverPluginRoots(
  options: PluginLoaderOptions,
): Promise<readonly DiscoveredPluginRoot[]> {
  const pluginStorageRoot = createPluginStorageAuthority(
    options.pluginStorageRoot,
  ).pluginStorageRoot;
  const configured = configuredPluginEntries(options.config);
  const autoDiscoveryEnabled = pluginAutoDiscoveryEnabled(options.config);
  const featureEnabled = pluginFeatureEnabled(options.config);
  const roots: DiscoveredPluginRoot[] = [];
  const gitRoot = await findGitRepoRoot(options.workspaceRoot);
  const workspacePluginDirs = [join(options.workspaceRoot, "plugins")];
  if (gitRoot !== undefined && gitRoot !== options.workspaceRoot) {
    workspacePluginDirs.push(join(gitRoot, "plugins"));
  }
  roots.push(
    ...(await discoverRootsUnder(
      pluginStorageRoot,
      "authority-controlled",
      { allowBasePlugin: false },
    )).map((root) => ({
      ...root,
      enabled: root.enabled && autoDiscoveryEnabled,
    })),
    ...(await discoverRootsUnder(
      join(options.workspaceRoot, ".agents", "plugins"),
      "repository-controlled",
      { allowBasePlugin: false },
    )).map((root) => ({
      ...root,
      enabled: root.enabled && autoDiscoveryEnabled,
    })),
  );
  for (const workspacePluginDir of workspacePluginDirs) {
    roots.push(
      ...(await discoverRootsUnder(
        workspacePluginDir,
        "repository-controlled",
        { allowBasePlugin: false },
      )).map((root) => ({
        ...root,
        enabled: root.enabled && autoDiscoveryEnabled,
      })),
    );
  }

  for (const [key, value] of Object.entries(configured).sort(([a], [b]) => a.localeCompare(b))) {
    const path = configEntryPath(value);
    if (path === undefined) continue;
    const resolvedPath = resolvePath(options.workspaceRoot, path);
    const canonicalPath = await maybeRealpath(resolvedPath);
    roots.push({
      path: canonicalPath,
      source: key,
      key,
      enabled: featureEnabled && configEntryEnabled(value),
      contentProvenance: contentProvenanceForPath(
        resolvedPath,
        canonicalPath,
        options.workspaceRoot,
        pluginStorageRoot,
      ),
    });
  }
  for (const path of configuredPluginDirs(options.config)) {
    const resolvedPath = resolvePath(options.workspaceRoot, path);
    const canonicalPath = await maybeRealpath(resolvedPath);
    roots.push(
      ...(await discoverRootsUnder(
        resolvedPath,
        contentProvenanceForPath(
          resolvedPath,
          canonicalPath,
          options.workspaceRoot,
          pluginStorageRoot,
        ),
        { allowBasePlugin: false },
      )).map((root) => ({
        ...root,
        enabled: root.enabled && featureEnabled,
      })),
    );
  }
  for (const path of options.extraPluginDirs ?? []) {
    const resolvedPath = resolvePath(options.workspaceRoot, path);
    const canonicalPath = await maybeRealpath(resolvedPath);
    roots.push(
      ...(await discoverRootsUnder(
        resolvedPath,
        contentProvenanceForPath(
          resolvedPath,
          canonicalPath,
          options.workspaceRoot,
          pluginStorageRoot,
        ),
      )).map((root) => ({
        ...root,
        featureGated: false,
      })),
    );
  }

  const deduped = new Map<string, DiscoveredPluginRoot>();
  for (const root of roots) {
    const configValue = configuredValueForRoot(root, configured);
    const gateEnabled = root.featureGated === false ? true : featureEnabled;
    const entryEnabled = configValue === undefined
      ? root.enabled
      : configEntryEnabled(configValue);
    deduped.set(root.path, {
      ...root,
      enabled: gateEnabled && entryEnabled,
    });
  }
  return [...deduped.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function loadPlugins(
  options: PluginLoaderOptions,
): Promise<PluginLoadResult> {
  const roots = await discoverPluginRoots(options);
  const configured = configuredPluginEntries(options.config);
  const allowlist = configuredPluginAllowlist(options.config);
  const loaded = await Promise.all(
    roots.map((root) => {
      const configEntry = (manifestName: string) =>
        configuredValueForPlugin(root, configured, manifestName);
      return createPluginFromPath(root.path, {
        source: root.source,
        enabled: root.enabled,
        contentProvenance: root.contentProvenance,
        configEntry,
        isEnabled: (manifestName) => configEntryEnabled(configEntry(manifestName)) &&
          pluginAllowedByAllowlist(
            [root.key, root.source, manifestName, basename(root.path)]
              .filter((entry): entry is string => typeof entry === "string"),
            allowlist,
          ),
      });
    }),
  );
  const plugins = loaded.flatMap((entry) =>
    entry.plugin === null ? [] : [entry.plugin]
  );
  const pluginsById = new Map<string, LoadedPlugin[]>();
  for (const plugin of plugins) {
    pluginsById.set(plugin.id, [
      ...(pluginsById.get(plugin.id) ?? []),
      plugin,
    ]);
  }
  const collidingIds = new Set<string>();
  const identityErrors: PluginLoadIssue[] = [];
  const identityErrorsByRoot = new Map<string, PluginLoadIssue[]>();
  for (const [pluginId, candidates] of pluginsById) {
    if (candidates.length < 2) continue;
    collidingIds.add(pluginId);
    const roots = candidates.map((candidate) => candidate.root).sort();
    const message =
      `Duplicate canonical plugin ID ${JSON.stringify(pluginId)} resolves to multiple roots: ${roots.join(", ")}. No copy was activated.`;
    for (const candidate of candidates) {
      const issue: PluginLoadIssue = {
        type: "manifest",
        source: candidate.source,
        plugin: candidate.name,
        path: candidate.root,
        message,
      };
      identityErrors.push(issue);
      identityErrorsByRoot.set(candidate.root, [
        ...(identityErrorsByRoot.get(candidate.root) ?? []),
        issue,
      ]);
    }
  }
  const dataMigrationIssues = await migrateLegacyPluginDataDirectories(
    plugins.map((plugin) => plugin.id),
    { pluginStorageRoot: options.pluginStorageRoot },
  );
  const dataMigrationIds = new Set(
    dataMigrationIssues.flatMap((issue) => issue.pluginIds),
  );
  const dataMigrationErrors: PluginLoadIssue[] = [];
  const dataMigrationErrorsByRoot = new Map<string, PluginLoadIssue[]>();
  for (const issue of dataMigrationIssues) {
    for (const pluginId of issue.pluginIds) {
      for (const candidate of pluginsById.get(pluginId) ?? []) {
        const loadIssue: PluginLoadIssue = {
          type: "settings",
          source: candidate.source,
          plugin: candidate.name,
          path: issue.legacyPath,
          message: issue.message,
        };
        dataMigrationErrors.push(loadIssue);
        dataMigrationErrorsByRoot.set(candidate.root, [
          ...(dataMigrationErrorsByRoot.get(candidate.root) ?? []),
          loadIssue,
        ]);
      }
    }
  }
  const dependencyState = verifyPluginDependencyState(
    plugins.filter((plugin) =>
      !collidingIds.has(plugin.id) && !dataMigrationIds.has(plugin.id)
    ),
  );
  const dependencyErrors: PluginLoadIssue[] = dependencyState.errors.map((issue) => ({
    type: "dependency",
    source: issue.source,
    plugin: issue.plugin,
    message: `Plugin dependency ${issue.dependency} is ${issue.reason}`,
  }));
  const dependencyErrorsBySource = new Map<string, PluginLoadIssue[]>();
  for (const issue of dependencyErrors) {
    dependencyErrorsBySource.set(issue.source, [
      ...(dependencyErrorsBySource.get(issue.source) ?? []),
      issue,
    ]);
  }
  const finalPlugins = plugins.map((plugin) =>
    collidingIds.has(plugin.id) || dataMigrationIds.has(plugin.id) ||
        dependencyState.demoted.has(plugin.source)
      ? {
          ...plugin,
          enabled: false,
          errors: [
            ...plugin.errors,
            ...(identityErrorsByRoot.get(plugin.root) ?? []),
            ...(dataMigrationErrorsByRoot.get(plugin.root) ?? []),
            ...(dependencyErrorsBySource.get(plugin.source) ?? []),
          ],
        }
      : plugin
  );
  return {
    enabled: finalPlugins.filter((plugin) => plugin.enabled),
    disabled: finalPlugins.filter((plugin) => !plugin.enabled),
    errors: [
      ...loaded.flatMap((entry) => entry.errors),
      ...identityErrors,
      ...dataMigrationErrors,
      ...dependencyErrors,
    ],
  };
}

export async function discoverPluginSkillRoots(
  options: PluginLoaderOptions,
): Promise<readonly string[]> {
  return (await discoverPluginSkillRootsWithProvenance(options)).map(
    (root) => root.path,
  );
}

export interface PluginSkillRoot {
  readonly path: string;
  readonly contentProvenance: PluginContentProvenance;
  /** Root of the plugin that ships this skill dir; substitution target. */
  readonly pluginRoot: string;
}

export async function discoverPluginSkillRootsWithProvenance(
  options: PluginLoaderOptions,
): Promise<readonly PluginSkillRoot[]> {
  const result = await loadPlugins(options);
  const roots = new Map<
    string,
    { provenance: PluginContentProvenance; pluginRoot: string }
  >();
  for (const plugin of result.enabled) {
    for (const path of plugin.skillsPaths) {
      const current = roots.get(path);
      roots.set(path, {
        provenance:
          current?.provenance === "repository-controlled" ||
            plugin.contentProvenance === "repository-controlled"
            ? "repository-controlled"
            : "authority-controlled",
        pluginRoot: current?.pluginRoot ?? plugin.root,
      });
    }
  }
  return [...roots]
    .map(([path, entry]) => ({
      path,
      contentProvenance: entry.provenance,
      pluginRoot: entry.pluginRoot,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function loadPluginMcpServers(
  options: PluginLoaderOptions,
): Promise<Readonly<Record<string, McpServerConfig>>> {
  const result = await loadPlugins(options);
  const servers: Record<string, McpServerConfig> = {};
  for (const plugin of result.enabled) {
    if (isRepositoryControlledPlugin(plugin)) continue;
    for (const [serverName, server] of Object.entries(plugin.mcpServers)) {
      servers[pluginScopedServerIdentifier(plugin.id, serverName)] = server;
    }
  }
  return servers;
}

export async function loadPluginLspServers(
  options: PluginLoaderOptions,
): Promise<Readonly<Record<string, LspServerConfigInput>>> {
  const result = await loadPlugins(options);
  const servers: Record<string, LspServerConfigInput> = {};
  for (const plugin of result.enabled) {
    if (isRepositoryControlledPlugin(plugin)) continue;
    for (const [serverName, server] of Object.entries(plugin.lspServers)) {
      servers[pluginScopedServerIdentifier(plugin.id, serverName)] = server;
    }
  }
  return servers;
}

export async function createPluginFromPath(
  pluginPath: string,
  opts: {
    readonly source: string;
    readonly enabled: boolean;
    readonly contentProvenance?: PluginContentProvenance;
    readonly configEntry?: (manifestName: string) => PluginEntryConfig | undefined;
    readonly isEnabled?: (manifestName: string) => boolean;
  },
): Promise<{ plugin: LoadedPlugin | null; errors: readonly PluginLoadIssue[] }> {
  const errors: PluginLoadIssue[] = [];
  const diagnosticName = basename(pluginPath);
  // Direct construction is used by the operator-driven install/validation
  // path. Runtime discovery always supplies explicit provenance.
  const contentProvenance = opts.contentProvenance ?? "authority-controlled";
  if (!(await pathIsDirectory(pluginPath))) {
    errors.push({
      type: "path-not-found",
      source: opts.source,
      plugin: diagnosticName,
      path: pluginPath,
      message: `Plugin root not found: ${pluginPath}`,
    });
    return { plugin: null, errors };
  }
  try {
    await assertNoRetiredRootPluginManifest(pluginPath);
  } catch (error) {
    errors.push({
      type: "manifest",
      source: opts.source,
      plugin: diagnosticName,
      path: join(pluginPath, PLUGIN_MANIFEST_FILE),
      message: error instanceof Error ? error.message : String(error),
    });
    return { plugin: null, errors };
  }
  let manifest: PluginManifest;
  let manifestPath: string | undefined;
  try {
    const parsed = await loadRequiredPluginManifest(pluginPath);
    manifest = parsed.manifest;
    manifestPath = parsed.manifestPath;
  } catch (error) {
    const retiredManifestPath = join(pluginPath, PLUGIN_MANIFEST_FILE);
    const attemptedManifestPath = await pathIsFile(retiredManifestPath)
      ? retiredManifestPath
      : join(pluginPath, PLUGIN_MANIFEST_RELATIVE_PATH);
    errors.push({
      type: "manifest",
      source: opts.source,
      plugin: diagnosticName,
      path: attemptedManifestPath ?? join(pluginPath, PLUGIN_MANIFEST_RELATIVE_PATH),
      message: error instanceof Error ? error.message : String(error),
    });
    return { plugin: null, errors };
  }
  const packageAuthorityIssues = await inspectPluginPackageAuthority(
    pluginPath,
    manifest,
  );
  if (packageAuthorityIssues.length > 0) {
    errors.push(...packageAuthorityIssues.map((issue): PluginLoadIssue => ({
      type: issue.field === "mcpServers"
        ? "mcp"
        : issue.field === "lspServers"
        ? "lsp"
        : issue.field === "hooks"
        ? "hooks"
        : "manifest",
      source: opts.source,
      plugin: manifest.name,
      path: issue.path,
      message: issue.message,
    })));
    return {
      plugin: emptyPlugin(pluginPath, opts.source, false, manifest, contentProvenance),
      errors,
    };
  }
  if (!opts.enabled || opts.isEnabled?.(manifest.name) === false) {
    return {
      plugin: emptyPlugin(pluginPath, opts.source, false, manifest, contentProvenance),
      errors,
    };
  }

  const commands = await loadCommands(pluginPath, manifest, opts.source, errors);
  const agentsPaths = await loadComponentPaths("agents", pluginPath, manifest.agents, errors, opts.source, manifest.name);
  const skillsPaths = await loadComponentPaths("skills", pluginPath, manifest.skills, errors, opts.source, manifest.name);
  const outputStylesPaths = await loadComponentPaths(
    "output-styles",
    pluginPath,
    manifest.outputStyles,
    errors,
    opts.source,
    manifest.name,
  );
  const repositoryControlled = contentProvenance === "repository-controlled";
  const hookSources = repositoryControlled
    ? []
    : await loadHooks(pluginPath, manifest, manifestPath, opts.source, errors);
  const mcpServers = repositoryControlled
    ? nullProtoRecord<McpServerConfig>()
    : await loadServers<McpServerConfig>(
        "mcp",
        pluginPath,
        manifest.mcpServers,
        undefined,
        "mcpServers",
        normalizeMcpServer,
        errors,
        opts.source,
        manifest.name,
      );
  const configuredMcpServers = applyPluginMcpServerConfig(
    mcpServers,
    opts.configEntry?.(manifest.name),
  );
  const lspServers = repositoryControlled
    ? nullProtoRecord<LspServerConfigInput>()
    : await loadServers<LspServerConfigInput>(
        "lsp",
        pluginPath,
        manifest.lspServers,
        undefined,
        "lspServers",
        normalizeLspServer,
        errors,
        opts.source,
        manifest.name,
      );
  const appConnectorIds = repositoryControlled
    ? []
    : await loadAppConnectorIds(pluginPath, manifest, errors, opts.source, manifest.name);
  const settings = repositoryControlled
    ? undefined
    : loadPluginSettings(
        pluginPath,
        manifest,
        manifestPath,
        errors,
        opts.source,
        manifest.name,
      );
  const { settings: _unfilteredSettings, ...manifestWithoutSettings } = manifest;
  const loadedManifest: PluginManifest = settings === undefined
    ? manifestWithoutSettings
    : { ...manifestWithoutSettings, settings };

  const plugin: LoadedPlugin = {
    id: canonicalLoadedPluginId(opts.source, manifest.name),
    name: manifest.name,
    ...(manifest.version !== undefined ? { version: manifest.version } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    root: pluginPath,
    source: opts.source,
    contentProvenance,
    enabled: opts.enabled,
    manifest: loadedManifest,
    ...(manifestPath !== undefined ? { manifestPath } : {}),
    ...(await pathIsDirectory(join(pluginPath, DEFAULT_COMPONENT_DIRS.commands))
      ? { commandsPath: join(pluginPath, DEFAULT_COMPONENT_DIRS.commands) }
      : {}),
    commandsPaths: commands.flatMap((command) => command.path ? [command.path] : []),
    commands,
    ...(await pathIsDirectory(join(pluginPath, DEFAULT_COMPONENT_DIRS.agents))
      ? { agentsPath: join(pluginPath, DEFAULT_COMPONENT_DIRS.agents) }
      : {}),
    agentsPaths,
    ...(await pathIsDirectory(join(pluginPath, DEFAULT_COMPONENT_DIRS.skills))
      ? { skillsPath: join(pluginPath, DEFAULT_COMPONENT_DIRS.skills) }
      : {}),
    skillsPaths,
    ...(await pathIsDirectory(join(pluginPath, DEFAULT_COMPONENT_DIRS.outputStyles))
      ? { outputStylesPath: join(pluginPath, DEFAULT_COMPONENT_DIRS.outputStyles) }
      : {}),
    outputStylesPaths,
    hookSources,
    mcpServers: configuredMcpServers,
    lspServers,
    appConnectorIds,
    ...(settings !== undefined ? { settings } : {}),
    errors,
  };
  return { plugin, errors };
}

function emptyPlugin(
  pluginPath: string,
  source: string,
  enabled: boolean,
  manifest: PluginManifest,
  contentProvenance: PluginContentProvenance,
): LoadedPlugin {
  return {
    id: canonicalLoadedPluginId(source, manifest.name),
    name: manifest.name,
    ...(manifest.version !== undefined ? { version: manifest.version } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    root: pluginPath,
    source,
    contentProvenance,
    enabled,
    manifest,
    commandsPaths: [],
    commands: [],
    agentsPaths: [],
    skillsPaths: [],
    outputStylesPaths: [],
    hookSources: [],
    mcpServers: nullProtoRecord<McpServerConfig>(),
    lspServers: nullProtoRecord<LspServerConfigInput>(),
    appConnectorIds: [],
    errors: [],
  };
}

async function loadCommands(
  pluginRoot: string,
  manifest: PluginManifest,
  source: string,
  errors: PluginLoadIssue[],
): Promise<LoadedPluginCommand[]> {
  const commands: LoadedPluginCommand[] = [];
  const defaultCommandsDir = join(pluginRoot, DEFAULT_COMPONENT_DIRS.commands);
  if (manifest.commands === undefined && await pathIsDirectory(defaultCommandsDir)) {
    commands.push(
      ...(await collectMarkdownFiles(defaultCommandsDir)).map((path) => ({
        name: basename(path).replace(/\.md$/iu, ""),
        path,
        metadata: { source: path },
      })),
    );
  }
  if (manifest.commands !== undefined) {
    commands.push(
      ...(await commandDeclarationsToCommands(
        pluginRoot,
        manifest.commands,
        source,
        manifest.name,
        errors,
      )),
    );
  }
  return dedupeCommands(commands);
}

async function commandDeclarationsToCommands(
  pluginRoot: string,
  declaration: PluginCommandDeclaration,
  source: string,
  pluginName: string,
  errors: PluginLoadIssue[],
): Promise<LoadedPluginCommand[]> {
  if (typeof declaration === "string" || Array.isArray(declaration)) {
    const paths = await resolveExistingPaths(
      pluginRoot,
      "commands",
      declaration,
      source,
      pluginName,
      errors,
    );
    return paths.map((path) => ({
      name: basename(path).replace(/\.md$/iu, ""),
      path,
      metadata: { source: path },
    }));
  }
  const out: LoadedPluginCommand[] = [];
  for (const [name, metadata] of Object.entries(declaration)) {
    if (metadata.content !== undefined) {
      out.push({ name, content: metadata.content, metadata, manifestName: name });
      continue;
    }
    if (metadata.source === undefined) continue;
    const paths = await resolveExistingPaths(
      pluginRoot,
      `commands.${name}.source`,
      metadata.source,
      source,
      pluginName,
      errors,
    );
    out.push(...paths.map((path) => ({ name, path, metadata, manifestName: name })));
  }
  return out;
}

function dedupeCommands(commands: readonly LoadedPluginCommand[]): LoadedPluginCommand[] {
  const seen = new Set<string>();
  const out: LoadedPluginCommand[] = [];
  for (const command of commands) {
    const key = `${command.name}:${command.path ?? command.content ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(command);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadComponentPaths(
  component: PluginComponentKind,
  pluginRoot: string,
  declaration: PluginPathDeclaration | undefined,
  errors: PluginLoadIssue[],
  source: string,
  pluginName: string,
): Promise<readonly string[]> {
  const defaultDir = defaultDirForComponent(pluginRoot, component);
  const paths = declaration === undefined && defaultDir !== null && await pathIsDirectory(defaultDir)
    ? [defaultDir]
    : await resolveExistingPaths(pluginRoot, component, declaration, source, pluginName, errors);
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

function defaultDirForComponent(
  pluginRoot: string,
  component: PluginComponentKind,
): string | null {
  switch (component) {
    case "commands":
      return join(pluginRoot, DEFAULT_COMPONENT_DIRS.commands);
    case "agents":
      return join(pluginRoot, DEFAULT_COMPONENT_DIRS.agents);
    case "skills":
      return join(pluginRoot, DEFAULT_COMPONENT_DIRS.skills);
    case "output-styles":
      return join(pluginRoot, DEFAULT_COMPONENT_DIRS.outputStyles);
    default:
      return null;
  }
}

async function resolveExistingPaths(
  pluginRoot: string,
  field: string,
  declaration: PluginPathDeclaration | undefined,
  source: string,
  pluginName: string,
  errors: PluginLoadIssue[],
): Promise<string[]> {
  if (declaration === undefined) return [];
  const declarations = Array.isArray(declaration) ? declaration : [declaration];
  const out: string[] = [];
  for (const entry of declarations) {
    try {
      const resolved = resolveManifestRelativePath(pluginRoot, field, entry);
      if (await pathIsFile(resolved) || await pathIsDirectory(resolved)) {
        out.push(resolved);
      } else {
        errors.push({
          type: "path-not-found",
          source,
          plugin: pluginName,
          path: resolved,
          component: componentFromField(field),
          message: `Plugin component path not found: ${entry}`,
        });
      }
    } catch (error) {
      errors.push({
        type: "manifest",
        source,
        plugin: pluginName,
        component: componentFromField(field),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

function componentFromField(field: string): PluginComponentKind | undefined {
  if (field.startsWith("commands")) return "commands";
  if (field.startsWith("agents")) return "agents";
  if (field.startsWith("skills")) return "skills";
  if (field.startsWith("hooks")) return "hooks";
  if (field.startsWith("mcp")) return "mcp";
  if (field.startsWith("lsp")) return "lsp";
  if (field.startsWith("apps")) return "apps";
  if (field.startsWith("output")) return "output-styles";
  return undefined;
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue: Array<{ readonly path: string; readonly depth: number }> = [
    { path: root, depth: 0 },
  ];
  const visitedDirs = new Set<string>();
  while (queue.length > 0) {
    if (out.length >= MAX_PLUGIN_MARKDOWN_FILES) break;
    const current = queue.shift()!;
    if (current.depth > MAX_PLUGIN_SCAN_DEPTH) continue;
    const identity = await maybeRealpath(current.path);
    if (visitedDirs.has(identity)) continue;
    visitedDirs.add(identity);
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= MAX_PLUGIN_MARKDOWN_FILES) break;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        queue.push({ path, depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(path);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function loadHooks(
  pluginRoot: string,
  manifest: PluginManifest,
  manifestPath: string | undefined,
  source: string,
  errors: PluginLoadIssue[],
): Promise<readonly PluginHookSource[]> {
  const sources: PluginHookSource[] = [];
  if (manifest.hooks === undefined) return sources;
  const declarations = Array.isArray(manifest.hooks)
    ? manifest.hooks
    : [manifest.hooks];
  let inlineIndex = 0;
  const loadedPaths = new Set<string>();
  for (const declaration of declarations) {
    if (typeof declaration === "string") {
      let resolved: string;
      try {
        resolved = resolveManifestRelativePath(pluginRoot, "hooks", declaration);
      } catch (error) {
        errors.push({
          type: "hooks",
          source,
          plugin: manifest.name,
          component: "hooks",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const identity = await maybeRealpath(resolved);
      if (loadedPaths.has(identity)) continue;
      loadedPaths.add(identity);
      await appendHookFile(resolved, pluginRoot, manifest.name, source, sources, errors);
      continue;
    }
    const hooks = normalizeHooksMap(declaration);
    if (hooks === null) {
      errors.push({
        type: "hooks",
        source,
        plugin: manifest.name,
        component: "hooks",
        message: "Inline hooks must be a hooks map or an object with a hooks map",
      });
      continue;
    }
    sources.push({
      pluginName: manifest.name,
      pluginRoot,
      sourcePath: manifestPath ?? join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH),
      sourceRelativePath: `${relativePluginPath(
        pluginRoot,
        manifestPath ?? join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH),
      )}#hooks[${inlineIndex}]`,
      hooks,
    });
    inlineIndex += 1;
  }
  return sources;
}

async function appendHookFile(
  path: string,
  pluginRoot: string,
  pluginName: string,
  source: string,
  sources: PluginHookSource[],
  errors: PluginLoadIssue[],
): Promise<void> {
  try {
    const parsed = JSON.parse(await readJsonText(path));
    const hooks = normalizeHooksMap(parsed);
    if (hooks === null) {
      errors.push({
        type: "hooks",
        source,
        plugin: pluginName,
        path,
        component: "hooks",
        message: "Hook map contains an unsafe key or invalid matcher list",
      });
      return;
    }
    if (Object.keys(hooks).length === 0) return;
    sources.push({
      pluginName,
      pluginRoot,
      sourcePath: path,
      sourceRelativePath: relativePluginPath(pluginRoot, path),
      hooks,
    });
  } catch (error) {
    errors.push({
      type: "hooks",
      source,
      plugin: pluginName,
      path,
      component: "hooks",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeHooksMap(value: unknown): HooksMap | null {
  const hooks = isRecord(value) && isRecord(value.hooks) ? value.hooks : value;
  if (!isRecord(hooks)) return null;
  const out = nullProtoRecord<unknown>();
  for (const [event, matchers] of Object.entries(hooks)) {
    if (isUnsafeObjectKey(event)) return null;
    out[event] = matchers;
  }
  try {
    return validateHooksConfig(out) ?? null;
  } catch {
    return null;
  }
}

async function loadServers<T>(
  component: "mcp" | "lsp",
  pluginRoot: string,
  declaration: PluginServerDeclaration | undefined,
  defaultFile: string | undefined,
  wrapperKey: "mcpServers" | "lspServers",
  normalizeServer: (name: string, value: unknown, pluginRoot: string) => T | null,
  errors: PluginLoadIssue[],
  source: string,
  pluginName: string,
): Promise<Readonly<Record<string, T>>> {
  const declarations = declaration === undefined
    ? defaultFile !== undefined && await pathIsFile(join(pluginRoot, defaultFile))
      ? [defaultFile]
      : []
    : Array.isArray(declaration)
      ? declaration
      : [declaration];
  const out = nullProtoRecord<T>();
  for (const entry of declarations) {
    if (typeof entry === "string") {
      let resolved: string;
      try {
        resolved = declaration === undefined
          ? join(pluginRoot, entry)
          : entry.startsWith("./")
          ? resolveManifestRelativePath(pluginRoot, wrapperKey, entry)
          : invalidManifestServerPath(wrapperKey, entry);
      } catch (error) {
        errors.push({
          type: component,
          source,
          plugin: pluginName,
          component,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      Object.assign(
        out,
        await readServerFile(component, resolved, wrapperKey, normalizeServer, pluginRoot, errors, source, pluginName),
      );
      continue;
    }
    Object.assign(out, normalizeServerMap(entry, normalizeServer, pluginRoot, component, errors, source, pluginName));
  }
  return out;
}

function invalidManifestServerPath(field: string, value: string): never {
  throw new Error(`${field} path must start with ./: ${value}`);
}

async function readServerFile<T>(
  component: "mcp" | "lsp",
  path: string,
  wrapperKey: "mcpServers" | "lspServers",
  normalizeServer: (name: string, value: unknown, pluginRoot: string) => T | null,
  pluginRoot: string,
  errors: PluginLoadIssue[],
  source: string,
  pluginName: string,
): Promise<Readonly<Record<string, T>>> {
  try {
    const parsed = JSON.parse(await readJsonText(path));
    const map = isRecord(parsed) && isRecord(parsed[wrapperKey])
      ? parsed[wrapperKey]
      : parsed;
    return normalizeServerMap(map, normalizeServer, pluginRoot, component, errors, source, pluginName);
  } catch (error) {
    errors.push({
      type: component,
      source,
      plugin: pluginName,
      path,
      component,
      message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function normalizeServerMap<T>(
  value: unknown,
  normalizeServer: (name: string, value: unknown, pluginRoot: string) => T | null,
  pluginRoot: string,
  component: "mcp" | "lsp",
  errors: PluginLoadIssue[],
  source: string,
  pluginName: string,
): Readonly<Record<string, T>> {
  if (!isRecord(value)) return {};
  const out = nullProtoRecord<T>();
  for (const [name, server] of Object.entries(value)) {
    if (isUnsafeObjectKey(name)) {
      errors.push({
        type: component,
        source,
        plugin: pluginName,
        component,
        message: `Unsafe ${component} server key "${name}"`,
      });
      continue;
    }
    let normalized: T | null;
    try {
      normalized = normalizeServer(name, server, pluginRoot);
    } catch (error) {
      errors.push({
        type: component,
        source,
        plugin: pluginName,
        component,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (normalized === null) {
      errors.push({
        type: component,
        source,
        plugin: pluginName,
        component,
        message: `Invalid ${component} server "${name}"`,
      });
      continue;
    }
    out[name] = normalized;
  }
  return out;
}

function applyPluginMcpServerConfig(
  servers: Readonly<Record<string, McpServerConfig>>,
  entry: PluginEntryConfig | undefined,
): Readonly<Record<string, McpServerConfig>> {
  if (typeof entry !== "object" || entry === null || !isRecord(entry.mcp_servers)) {
    return servers;
  }
  const out = nullProtoRecord<McpServerConfig>();
  for (const [serverName, server] of Object.entries(servers)) {
    const overlay = entry.mcp_servers[serverName];
    if (!isPluginMcpServerConfig(overlay)) {
      out[serverName] = server;
      continue;
    }
    if (overlay.enabled === false) continue;
    out[serverName] = {
      ...server,
      ...(overlay.enabled !== undefined ? { enabled: overlay.enabled } : {}),
      ...(isValidPermissionDefaultMode(overlay.default_tools_approval_mode)
        ? { default_tools_approval_mode: overlay.default_tools_approval_mode }
        : {}),
      ...(stringArray(overlay.enabled_tools) !== undefined
        ? { enabled_tools: stringArray(overlay.enabled_tools) }
        : {}),
      ...(stringArray(overlay.disabled_tools) !== undefined
        ? { disabled_tools: stringArray(overlay.disabled_tools) }
        : {}),
      ...(perToolConfigRecord(overlay.tools) !== undefined
        ? { tools: perToolConfigRecord(overlay.tools) }
        : {}),
    };
  }
  return out;
}

function isPluginMcpServerConfig(value: unknown): value is PluginMcpServerConfig {
  return isRecord(value);
}

function nullProtoRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function normalizeMcpServer(
  _name: string,
  value: unknown,
  pluginRoot: string,
): McpServerConfig | null {
  if (!isRecord(value)) return null;
  const endpoint = stringValue(value.endpoint) ?? stringValue(value.url);
  const transport = normalizeMcpTransport(
    stringValue(value.transport) ?? stringValue(value.type),
    endpoint,
    stringValue(value.command),
  );
  const command = stringValue(value.command);
  const cwd = stringValue(value.cwd);
  const rawArgs = Array.isArray(value.args)
    ? value.args.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const env = stringRecord(value.env);
  const headers = stringRecord(value.headers);
  const server: McpServerConfig = {
    ...(transport === "http" ||
      transport === "sse" ||
      transport === "stdio" ||
      transport === "websocket"
      ? { transport }
      : {}),
    ...(command !== undefined ? { command } : {}),
    ...(rawArgs !== undefined ? { args: rawArgs } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(cwd !== undefined
      ? { cwd: resolveServerWorkingDir(pluginRoot, "mcpServers.cwd", cwd) }
      : {}),
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(typeof value.timeout === "number" ? { timeout: value.timeout } : {}),
  };
  return server.command !== undefined || server.endpoint !== undefined ? server : null;
}

function normalizeMcpTransport(
  value: string | undefined,
  endpoint: string | undefined,
  command: string | undefined,
): McpTransport | undefined {
  if (
    value === "http" ||
    value === "sse" ||
    value === "stdio" ||
    value === "websocket"
  ) {
    return value;
  }
  if (value === "ws") return "websocket";
  if (value !== undefined || endpoint === undefined || command !== undefined) {
    return undefined;
  }
  return endpoint.startsWith("ws://") || endpoint.startsWith("wss://")
    ? "websocket"
    : "http";
}

function normalizeLspServer(
  _name: string,
  value: unknown,
  pluginRoot: string,
): LspServerConfigInput | null {
  if (!isRecord(value) || typeof value.command !== "string") return null;
  if (Object.keys(value).some((key) => !LSP_SERVER_KEYS.has(key))) return null;
  if (value.command.trim().length === 0) return null;
  if (value.command.includes(" ") && !value.command.startsWith("/")) return null;
  const extensionToLanguage = isRecord(value.extensionToLanguage)
    ? stringRecord(value.extensionToLanguage)
    : undefined;
  if (extensionToLanguage === undefined) return null;
  return {
    command: value.command,
    ...(Array.isArray(value.args)
      ? { args: value.args.filter((entry): entry is string => typeof entry === "string") }
      : {}),
    ...(stringRecord(value.env) !== undefined ? { env: stringRecord(value.env) } : {}),
    ...(typeof value.workspaceFolder === "string"
      ? {
          workspaceFolder: resolveServerWorkingDir(
            pluginRoot,
            "lspServers.workspaceFolder",
            value.workspaceFolder,
          ),
        }
      : {}),
    extensionToLanguage,
    ...(value.initializationOptions !== undefined
      ? { initializationOptions: value.initializationOptions }
      : {}),
    ...(typeof value.startupTimeout === "number"
      ? { startupTimeout: value.startupTimeout }
      : {}),
    ...(typeof value.maxRestarts === "number"
      ? { maxRestarts: value.maxRestarts }
      : {}),
  };
}

async function loadAppConnectorIds(
  pluginRoot: string,
  manifest: PluginManifest,
  errors: PluginLoadIssue[],
  source: string,
  pluginName: string,
): Promise<readonly string[]> {
  const paths = manifest.apps === undefined
    ? []
    : await resolveExistingPaths(
        pluginRoot,
        "apps",
        manifest.apps,
        source,
        pluginName,
        errors,
      );
  const ids = new Set<string>();
  for (const path of paths) {
    for (const id of await loadAppConnectorIdsFromFile(path, errors, source, pluginName)) {
      ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

async function loadAppConnectorIdsFromFile(
  path: string,
  errors: PluginLoadIssue[],
  source: string,
  pluginName: string,
): Promise<readonly string[]> {
  try {
    const parsed = JSON.parse(await readJsonText(path));
    if (!isRecord(parsed) || !isRecord(parsed.apps)) return [];
    return Object.values(parsed.apps)
      .map((entry) => isRecord(entry) && typeof entry.id === "string" ? entry.id : null)
      .filter((entry): entry is string => entry !== null && entry.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    errors.push({
      type: "manifest",
      source,
      plugin: pluginName,
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function loadPluginSettings(
  pluginRoot: string,
  manifest: PluginManifest,
  manifestPath: string | undefined,
  errors: PluginLoadIssue[],
  source: string,
  pluginName: string,
): Readonly<Record<string, unknown>> | undefined {
  const settingsPath = manifestPath ??
    join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH);
  return manifest.settings === undefined
    ? undefined
    : filterPluginSettingsForManifest(
        manifest.settings,
        manifest,
        errors,
        source,
        pluginName,
        settingsPath,
      );
}

function filterPluginSettingsForManifest(
  settings: Readonly<Record<string, unknown>>,
  manifest: PluginManifest,
  errors: PluginLoadIssue[],
  source: string,
  pluginName: string,
  settingsPath: string,
): Readonly<Record<string, unknown>> | undefined {
  const filtered = filterPluginSettings(settings);
  if (filtered === undefined || !isRecord(filtered.options)) return filtered;

  const sensitiveKeys = [
    ...Object.entries(manifest.userConfig ?? {}),
    ...(manifest.channels ?? []).flatMap(channel =>
      Object.entries(channel.userConfig ?? {})
    ),
  ]
    .filter(
      ([key, option]) =>
        option.sensitive === true && Object.hasOwn(filtered.options!, key),
    )
    .map(([key]) => key)
    .filter((key, index, all) => all.indexOf(key) === index)
    .sort();
  if (sensitiveKeys.length === 0) return filtered;

  const options = { ...filtered.options };
  for (const key of sensitiveKeys) delete options[key];
  errors.push({
    type: "settings",
    source,
    plugin: pluginName,
    path: settingsPath,
    message:
      `Sensitive plugin option(s) ${sensitiveKeys.join(", ")} were ignored in manifest.settings. ` +
      "Configure them through AgenC so the native secure storage is their sole owner.",
  });

  const next = { ...filtered };
  if (Object.keys(options).length === 0) delete next.options;
  else next.options = options;
  return Object.keys(next).length > 0 ? next : undefined;
}

function filterPluginSettings(
  settings: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const out = nullProtoRecord<unknown>();
  for (const [key, value] of Object.entries(settings)) {
    if (isUnsafeObjectKey(key) || !PLUGIN_SETTINGS_KEYS.has(key)) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((entry): entry is string => typeof entry === "string");
  return out;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out = nullProtoRecord<string>();
  for (const [key, entry] of Object.entries(value)) {
    if (isUnsafeObjectKey(key)) continue;
    if (typeof entry === "string") out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function perToolConfigRecord(
  value: unknown,
): Readonly<Record<string, PerToolConfig>> | undefined {
  if (!isRecord(value)) return undefined;
  const out = nullProtoRecord<PerToolConfig>();
  for (const [key, entry] of Object.entries(value)) {
    if (isUnsafeObjectKey(key) || !isRecord(entry)) continue;
    out[key] = entry as PerToolConfig;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function resolveServerWorkingDir(
  pluginRoot: string,
  field: string,
  value: string,
): string {
  if (value === "." || value === "./") return pluginRoot;
  if (isAbsolute(value)) {
    throw new Error(`${field} path must be relative to the plugin root`);
  }
  const relativeValue = value.startsWith("./") ? value : `./${value}`;
  return resolveManifestRelativePath(pluginRoot, field, relativeValue);
}

function relativePluginPath(pluginRoot: string, path: string): string {
  const relativePath = path.startsWith(pluginRoot)
    ? path.slice(pluginRoot.length).replace(/^[/\\]/u, "")
    : path;
  return relativePath.replace(/\\/g, "/");
}
