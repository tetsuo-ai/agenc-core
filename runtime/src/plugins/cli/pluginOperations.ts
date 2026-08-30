import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveHomeContext } from "../../config/home.js";
import { loadCanonicalConfig } from "../../config/repository.js";
import type { PluginEntryConfig } from "../../config/schema.js";
import type { ConfigStore } from "../../config/store.js";
import { mutateCanonicalUserConfigSync } from "../../config/update-sync.js";
import { writeDurableAtomicFile } from "../../utils/durable-atomic-file.js";
import { isRecord } from "../../utils/record.js";
import { createPluginFromPath, loadPlugins, type LoadedPlugin } from "../loader.js";
import type { PluginManifestInterface } from "../manifest-schema.js";
import {
  findPluginManifestPath,
  loadPluginManifest,
  PLUGIN_MANIFEST_RELATIVE_PATH,
} from "../manifest.js";
import {
  CONVENTIONAL_APP_FILE,
  CONVENTIONAL_HOOKS_FILE,
  CONVENTIONAL_LSP_FILE,
  inspectPluginPackageAuthority,
  RETIRED_PLUGIN_MCP_FILE,
  RETIRED_PLUGIN_SETTINGS_FILE,
} from "../package-authority.js";
import { validateMarketplaceManifest, validatePluginManifest, type ValidationResult } from "../validation.js";
import {
  deletePluginDataDir,
  isReservedPluginStorageChildName,
  pluginDataDirPath,
  pluginFilesystemKey,
} from "../directories.js";
import {
  pluginDependencyIdentityFromSource,
  parsePluginInstallSource,
  pluginInstallSourceNeedsRedaction,
  redactPluginInstallSource,
  resolvePluginSource,
  shouldCopyPluginPayloadPath,
  type PluginInstallSource,
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
  readonly pluginStorageRoot: string;
  readonly sessionTempRoot: string;
  readonly workspaceRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configStore?: ConfigStore;
  readonly now?: () => Date;
  readonly onWarn?: (message: string) => void;
}

export interface PluginComponentRow {
  readonly name: string;
  readonly description?: string;
}

export interface InstalledPluginSummary {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly root: string;
  readonly source: string;
  /** Absolute path of the plugin's own logo, proven to sit inside root. */
  readonly logoPath?: string;
  /** Manifest surface copy (logo stripped; artwork travels as logoPath). */
  readonly interface?: Omit<PluginManifestInterface, "logo">;
  readonly commands?: readonly PluginComponentRow[];
  readonly skills?: readonly PluginComponentRow[];
}

export interface PluginListResult {
  readonly plugins: readonly InstalledPluginSummary[];
  readonly errors: readonly string[];
}

export interface InstallPluginInput extends PluginOperationOptions {
  readonly source: PluginInstallSource;
  readonly scope?: PluginScope;
  readonly name?: string;
  readonly force?: boolean;
  readonly refreshCache?: boolean;
  readonly requireSignature?: boolean;
  readonly publishersPath?: string;
  readonly runResolutionProcess?: PluginProcessRunner;
  readonly fetchResolutionBytes?: (url: string) => Promise<Uint8Array>;
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
  readonly source?: PluginInstallSource;
  readonly requireSignature?: boolean;
  readonly publishersPath?: string;
  readonly runResolutionProcess?: PluginProcessRunner;
  readonly fetchResolutionBytes?: (url: string) => Promise<Uint8Array>;
}

export interface UpdatePluginResult extends InstallPluginResult {
  readonly previousRoot: string;
  readonly source: PluginInstallSource;
}

const INSTALL_METADATA_FILE = "agenc-install.json";

function resolvePluginAgencHome(options: PluginOperationOptions): string {
  if (options.agencHome !== undefined) return resolve(options.agencHome);
  const env = options.env;
  if (env === undefined) {
    throw new Error(
      "Plugin operations require an explicit AgenC home or captured environment",
    );
  }
  return resolveHomeContext(
    env,
    env.HOME === undefined ? {} : { platformHome: env.HOME },
  ).path;
}

function resolvePluginWorkspaceRoot(options: PluginOperationOptions): string {
  if (options.workspaceRoot === undefined) {
    throw new Error("Plugin operations require an explicit workspace root");
  }
  return resolve(options.workspaceRoot);
}

function pluginScopeRoot(
  scope: PluginScope,
  options: PluginOperationOptions,
): string {
  const workspaceRoot = resolvePluginWorkspaceRoot(options);
  switch (scope) {
    case "user":
      return options.pluginStorageRoot;
    case "project":
    case "local":
      return join(workspaceRoot, ".agents", "plugins");
  }
}

function pluginConfigPath(options: PluginOperationOptions): string {
  return join(resolvePluginAgencHome(options), "config.toml");
}

async function loadPluginOperationConfig(
  options: PluginOperationOptions,
  warnings: string[],
) {
  const agencHome = resolvePluginAgencHome(options);
  const workspaceRoot = resolvePluginWorkspaceRoot(options);
  if (options.configStore !== undefined) {
    if (resolve(options.configStore.agencHome) !== agencHome) {
      throw new Error(
        "Plugin operation ConfigStore does not own the requested AgenC home",
      );
    }
    if (resolve(options.configStore.projectRoot) !== workspaceRoot) {
      throw new Error(
        "Plugin operation ConfigStore does not own the requested workspace",
      );
    }
    warnings.push(...options.configStore.warnings());
    return options.configStore.current();
  }
  if (options.env === undefined) {
    throw new Error(
      "Plugin config reads require an exact ConfigStore or captured environment",
    );
  }
  const loaded = await loadCanonicalConfig({
    home: agencHome,
    env: options.env,
    cwd: workspaceRoot,
    projectRoot: workspaceRoot,
    onWarn: (message) => {
      warnings.push(message);
      options.onWarn?.(message);
    },
  });
  return loaded.config;
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
    const manifestName = plugin.name === plugin.id
      ? ""
      : ` (manifest ${plugin.name})`;
    lines.push(`- ${plugin.id}${manifestName}${version} (${state}) ${plugin.root}`);
  }
  if (result.errors.length > 0) {
    lines.push("", formatPluginErrors(result.errors));
  }
  return lines.join("\n");
}

export async function listInstalledPlugins(
  options: PluginOperationOptions,
): Promise<PluginListResult> {
  const workspaceRoot = resolvePluginWorkspaceRoot(options);
  const warnings: string[] = [];
  const config = await loadPluginOperationConfig(options, warnings);
  const loaded = await loadPlugins({
    pluginStorageRoot: options.pluginStorageRoot,
    workspaceRoot,
    config,
  });
  const plugins = await Promise.all(
    [...loaded.enabled, ...loaded.disabled].map(async (plugin) => {
      const summary = summarizeLoadedPlugin(plugin);
      const skills = await describeSkills(plugin.skillsPaths);
      return skills.length > 0 ? { ...summary, skills } : summary;
    }),
  );
  return {
    plugins: plugins.sort(
      (a, b) => a.id.localeCompare(b.id) || a.root.localeCompare(b.root),
    ),
    errors: [
      ...warnings,
      ...loaded.errors.map((issue) => `${issue.source}: ${issue.message}`),
    ],
  };
}

export async function validatePluginPath(
  inputPath: string,
  options: {
    readonly marketplace?: boolean;
    readonly workspaceRoot?: string;
  } = {},
): Promise<ValidationResult> {
  const absolutePath = isAbsolute(inputPath)
    ? resolve(inputPath)
    : options.workspaceRoot === undefined
      ? (() => {
          throw new Error(
            "Relative plugin validation paths require an explicit workspace root",
          );
        })()
      : resolve(options.workspaceRoot, inputPath);
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
    let manifestPath: string | null;
    try {
      manifestPath = await findPluginManifestPath(absolutePath);
    } catch (error) {
      const retiredManifestPath = join(absolutePath, "plugin.json");
      return {
        success: false,
        errors: [{
          path: retiredManifestPath,
          message: error instanceof Error ? error.message : String(error),
        }],
        warnings: [],
        filePath: retiredManifestPath,
        fileType: "plugin",
      };
    }
    const parsedManifest = await loadPluginManifest(absolutePath).catch(() => null);
    const packageIssues = await inspectPluginPackageAuthority(
      absolutePath,
      parsedManifest?.manifest ?? {},
    );
    if (packageIssues.length > 0) {
      return {
        success: false,
        errors: packageIssues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
        warnings: [],
        filePath: absolutePath,
        fileType: "plugin",
      };
    }
    if (manifestPath) {
      return validatePluginManifest(manifestPath);
    }
    return {
      success: false,
      errors: [{
        path: join(absolutePath, PLUGIN_MANIFEST_RELATIVE_PATH),
        message:
          `Required plugin manifest is missing. Add ${PLUGIN_MANIFEST_RELATIVE_PATH} to the package, or reinstall the plugin.`,
      }],
      warnings: [],
      filePath: absolutePath,
      fileType: "plugin",
    };
  }
  return validatePluginManifest(absolutePath);
}

export async function installPluginOp(
  input: InstallPluginInput,
): Promise<InstallPluginResult> {
  const scope = input.scope ?? "user";
  const workspaceRoot = resolvePluginWorkspaceRoot(input);
  const localSource = typeof input.source === "string"
    ? resolvePath(input.source, workspaceRoot)
    : undefined;
  let resolved: ResolvedPluginSource | null = null;
  let source = localSource ?? "";
  let resolutionKind: PluginResolutionKind = "local";
  let signatureVerified = false;
  if (localSource === undefined || !(await pathIsDirectory(localSource))) {
    resolved = await resolvePluginSource(input.source, {
      agencHome: resolvePluginAgencHome(input),
      pluginStorageRoot: input.pluginStorageRoot,
      sessionTempRoot: input.sessionTempRoot,
      workspaceRoot,
      refreshCache: input.refreshCache,
      requireSignature: input.requireSignature,
      publishersPath: input.publishersPath,
      runProcess: input.runResolutionProcess,
      fetchBytes: input.fetchResolutionBytes,
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
    });
    if (loaded.plugin === null || loaded.errors.length > 0) {
      throw new Error(
        `plugin source failed validation: ${loaded.errors.map((issue) => issue.message).join("; ")}`,
      );
    }
    const pluginId = resolveInstallPluginId(
      input.name,
      (typeof input.source === "string"
        ? pluginDependencyIdentityFromSource(input.source)
        : undefined) ?? loaded.plugin.id,
    );
    const safeName = sanitizeInstallName(pluginId);
    const otherScope: PluginScope = scope === "user" ? "project" : "user";
    const otherScopeRoots = await resolvePluginRootsForRemoval(
      pluginId,
      otherScope,
      input,
    );
    if (otherScopeRoots.length > 0) {
      throw new Error(
        `plugin is already installed in another scope: ${pluginId}`,
      );
    }
    const installRoot = pluginScopeRoot(scope, input);
    await mkdir(installRoot, { recursive: true, mode: 0o700 });
    const existingRoots = await resolvePluginRootsForRemoval(
      pluginId,
      scope,
      input,
    );
    if (existingRoots.length > 1) {
      throw new Error(
        `plugin resolves to multiple install roots in ${scope} scope: ${pluginId}`,
      );
    }
    const destination = existingRoots[0] ?? join(installRoot, safeName);
    await copyDirectoryAtomically(source, destination, {
      force: input.force === true,
    });
    await writeInstallMetadata(destination, {
      name: loaded.plugin.name,
      dependencyIdentity: pluginId,
      source: resolutionKind === "local"
        ? source
        : redactPluginInstallSource(input.source),
      ...(resolutionKind !== "local" &&
        pluginInstallSourceNeedsRedaction(input.source)
        ? { sourceRedacted: true }
        : {}),
      sourceRoot: source,
      scope,
      resolutionKind,
      signatureVerified,
      installedAt: (input.now ?? (() => new Date()))().toISOString(),
    });
    const plugin = await createPluginFromPath(destination, {
      source: scope,
      enabled: true,
    });
    if (plugin.plugin === null || plugin.errors.length > 0) {
      throw new Error(
        `installed plugin failed validation: ${plugin.errors.map((issue) => issue.message).join("; ")}`,
      );
    }
    await writePluginConfigEntry(pluginId, { enabled: true }, input);
    return {
      plugin: summarizeLoadedPlugin({ ...plugin.plugin, id: pluginId }),
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
  const remainsInstalled = await pluginIdRemainsInstalled(input.pluginId, input);
  const removedConfig = remainsInstalled
    ? false
    : await removePluginConfigEntry(input.pluginId, input);
  let removedData = false;
  if (!remainsInstalled && input.keepData !== true) {
    const authority = {
      pluginStorageRoot: input.pluginStorageRoot,
    };
    const dataDir = pluginDataDirPath(input.pluginId, authority);
    if (await pathExists(dataDir)) {
      await deletePluginDataDir(input.pluginId, authority);
      removedData = !(await pathExists(dataDir));
    }
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
  options: PluginOperationOptions,
): Promise<DisableAllPluginsResult> {
  const listed = await listInstalledPlugins(options);
  const names = listed.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id);
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
  if (typeof source === "string") {
    const localSource = resolvePath(source, workspaceRoot);
    if (await pathExists(localSource)) {
      const sourceReal = await realpath(localSource);
      const rootReal = await realpath(previousRoot);
      if (sourceReal === rootReal || sourceReal.startsWith(`${rootReal}/`)) {
        throw new Error(
          `plugin update source cannot be the installed plugin root: ${source}`,
        );
      }
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
  await writeDurableAtomicFile(
    path,
    `${path}.tmp-${process.pid}-${randomUUID()}`,
    `${JSON.stringify(value, null, 2)}\n`,
    0o600,
  );
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

function sanitizeInstallName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("plugin ID cannot be empty");
  }
  if (isReservedPluginStorageChildName(trimmed)) {
    throw new Error(`plugin ID is reserved for AgenC internal storage: ${name}`);
  }
  return pluginFilesystemKey(trimmed);
}

function resolveInstallPluginId(
  requestedId: string | undefined,
  fallbackId: string,
): string {
  if (requestedId === undefined) return fallbackId;
  const pluginId = requestedId.trim();
  if (pluginId.length === 0) {
    throw new Error("plugin ID cannot be empty");
  }
  if (pluginDependencyIdentityFromSource(pluginId) !== pluginId) {
    throw new Error(
      `plugin ID must be a canonical name or name@marketplace identifier: ${requestedId}`,
    );
  }
  return pluginId;
}

function resolvePath(path: string, base: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function summarizeLoadedPlugin(plugin: LoadedPlugin): InstalledPluginSummary {
  // The manifest normalizer resolved declared artwork to an absolute
  // in-root path; report it so a GUI client can serve the plugin's own
  // logo instead of falling back to a generic mark. Anything outside the
  // plugin root is not this plugin's artwork and is dropped.
  const logo = plugin.manifest.interface?.logo;
  const logoPath =
    typeof logo === "string" && logo.length > 0 && isAbsolute(logo) &&
    logo.startsWith(plugin.root.endsWith(sep) ? plugin.root : plugin.root + sep)
      ? logo
      : undefined;
  const surface = plugin.manifest.interface;
  let interfaceCopy: Omit<PluginManifestInterface, "logo"> | undefined;
  if (surface !== undefined) {
    const { logo: _logo, ...rest } = surface;
    interfaceCopy = rest;
  }
  const commands = plugin.commands.map((command) => ({
    name: command.name,
    ...(command.metadata.description !== undefined
      ? { description: command.metadata.description }
      : {}),
  }));
  return {
    id: plugin.id,
    name: plugin.name,
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    ...(plugin.description !== undefined ? { description: plugin.description } : {}),
    enabled: plugin.enabled,
    root: plugin.root,
    source: plugin.source,
    ...(logoPath !== undefined ? { logoPath } : {}),
    ...(interfaceCopy !== undefined ? { interface: interfaceCopy } : {}),
    ...(commands.length > 0 ? { commands } : {}),
  };
}

/** Bounded frontmatter read: a skill listing must never slurp documents. */
const SKILL_FRONTMATTER_MAX_BYTES = 8 * 1024;

async function skillDescriptionAt(
  skillDir: string,
): Promise<string | undefined> {
  try {
    const handle = await open(join(skillDir, "SKILL.md"), "r");
    try {
      const buffer = Buffer.alloc(SKILL_FRONTMATTER_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead).toString("utf8");
      const match = /^description:\s*(.+)$/mu.exec(head);
      return match?.[1]?.trim().slice(0, 280);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function describeSkills(
  skillsPaths: readonly string[],
): Promise<readonly PluginComponentRow[]> {
  // A path is either one skill dir (SKILL.md at its top) or a
  // conventional `skills/` root whose child dirs are the skills.
  const rows: PluginComponentRow[] = [];
  const seen = new Set<string>();
  const push = (name: string, description: string | undefined): void => {
    if (name.length === 0 || seen.has(name)) return;
    seen.add(name);
    rows.push({ name, ...(description !== undefined ? { description } : {}) });
  };
  for (const skillPath of skillsPaths) {
    const direct = await skillDescriptionAt(skillPath);
    let directExists = direct !== undefined;
    if (!directExists) {
      try {
        directExists = (await stat(join(skillPath, "SKILL.md"))).isFile();
      } catch {
        directExists = false;
      }
    }
    if (directExists) {
      push(basename(skillPath), direct);
      continue;
    }
    let children: string[];
    try {
      children = await readdir(skillPath);
    } catch {
      continue;
    }
    for (const child of [...children].sort((a, b) => a.localeCompare(b))) {
      const childDir = join(skillPath, child);
      try {
        if (!(await stat(join(childDir, "SKILL.md"))).isFile()) continue;
      } catch {
        continue;
      }
      push(child, await skillDescriptionAt(childDir));
    }
  }
  return rows;
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
    CONVENTIONAL_HOOKS_FILE,
    RETIRED_PLUGIN_MCP_FILE,
    RETIRED_PLUGIN_SETTINGS_FILE,
    CONVENTIONAL_LSP_FILE,
    CONVENTIONAL_APP_FILE,
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

async function writeInstallMetadata(
  pluginRoot: string,
  metadata: {
    readonly name: string;
    readonly dependencyIdentity: string;
    readonly source: PluginInstallSource;
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
): Promise<PluginInstallSource | undefined> {
  const metadata = await readJsonFile<unknown>(
    join(pluginRoot, ".agenc-plugin", INSTALL_METADATA_FILE),
    null,
  );
  return isRecord(metadata) && metadata.sourceRedacted !== true
    ? parsePluginInstallSource(metadata.source)
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
    // The canonical-ID lookup below handles metadata-backed installs whose
    // directory name differs from the current filesystem key.
  }
  const listed = await listInstalledPlugins(options);
  for (const plugin of listed.plugins) {
    if (plugin.id !== pluginId) continue;
    if (isPathInside(plugin.root, installRoot)) {
      roots.add(await realpath(plugin.root));
    }
  }
  return [...roots].sort((a, b) => a.localeCompare(b));
}

async function pluginIdRemainsInstalled(
  pluginId: string,
  options: PluginOperationOptions,
): Promise<boolean> {
  const installRoots = new Set([
    pluginScopeRoot("user", options),
    pluginScopeRoot("project", options),
  ]);
  const installDirectoryName = sanitizeInstallName(pluginId);
  for (const installRoot of installRoots) {
    if (await pathIsDirectory(join(installRoot, installDirectoryName))) {
      return true;
    }
  }
  const listed = await listInstalledPlugins(options);
  return listed.plugins.some((plugin) => plugin.id === pluginId);
}

function isPathInside(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function writePluginConfigEntry(
  pluginId: string,
  entry: PluginEntryConfig,
  options: PluginOperationOptions,
): Promise<string> {
  const path = pluginConfigPath(options);
  mutateCanonicalUserConfigSync(path, (raw) => {
    const plugins = isRecord(raw.plugins) ? raw.plugins : {};
    if (!isRecord(raw.plugins)) raw.plugins = plugins;
    const pluginEntries = isRecord(plugins.plugins)
      ? plugins.plugins
      : {};
    if (!isRecord(plugins.plugins)) plugins.plugins = pluginEntries;
    const currentEntry = pluginEntries[pluginId];
    const current = Object.hasOwn(pluginEntries, pluginId) && isRecord(currentEntry)
      ? currentEntry
      : {};
    Object.defineProperty(pluginEntries, pluginId, {
      value: { ...current, ...entry },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    if (entry.enabled !== false) plugins.enabled = true;
  });
  await options.configStore?.reload();
  return path;
}

async function removePluginConfigEntry(
  pluginId: string,
  options: PluginOperationOptions,
): Promise<boolean> {
  const path = pluginConfigPath(options);
  let removed = false;
  mutateCanonicalUserConfigSync(path, (raw) => {
    if (!isRecord(raw.plugins) || !isRecord(raw.plugins.plugins)) return;
    if (!Object.hasOwn(raw.plugins.plugins, pluginId)) return;
    removed = true;
    delete raw.plugins.plugins[pluginId];
    if (Object.keys(raw.plugins.plugins).length === 0) {
      delete raw.plugins.plugins;
    }
  });
  await options.configStore?.reload();
  return removed;
}
