import { basename } from "node:path";
import type { ContentFilesystem } from "../../execution/content-filesystem.js";

import type { OutputStyleInput } from "../../prompts/system-prompt.js";
import {
  CanonicalAuthorityCache,
  getCanonicalSettingsAuthority,
  type CanonicalSettingsAuthority,
} from "../../utils/settings/canonicalAuthority.js";
import { isRepositoryControlledPlugin, type LoadedPlugin } from "../loader.js";
import {
  collectMarkdownFiles,
  coerceString,
  descriptionFromMarkdown,
  capturePluginRuntimeOptions,
  pluginContentFilesystem,
  resolveRuntimePlugins,
  markdownStem,
  parseBoolean,
  pathIsDirectory,
  pluginScopedIdentifier,
  readMarkdownFile,
  runtimeIdentityKey,
  type PluginRuntimeLoadOptions,
} from "./common.js";

export interface PluginOutputStyle extends OutputStyleInput {
  readonly description: string;
  readonly source: "plugin";
  readonly plugin: string;
  readonly filePath: string;
  readonly forceForPlugin?: boolean;
}

export interface PluginOutputStyleRegistrationOptions extends PluginRuntimeLoadOptions {
  readonly plugins?: readonly LoadedPlugin[];
}

async function loadStyleFile(
  plugin: LoadedPlugin,
  filePath: string,
  baseDir: string,
  loadedPaths: Set<string>,
  filesystem: ContentFilesystem,
): Promise<PluginOutputStyle | null> {
  if (loadedPaths.has(filePath)) return null;
  loadedPaths.add(filePath);
  const file = await readMarkdownFile(filePath, baseDir, filesystem);
  if (!file) return null;
  const baseName = coerceString(file.frontmatter.name) ?? markdownStem(filePath);
  const name = pluginScopedIdentifier(
    plugin.id,
    baseName.split(":").filter((part) => part.length > 0),
    "output_style",
  );
  const description =
    coerceString(file.frontmatter.description) ??
    descriptionFromMarkdown(file.markdown) ??
    `Output style from ${plugin.name} plugin`;
  return {
    name,
    description,
    prompt: file.markdown.trim(),
    source: "plugin",
    plugin: plugin.id,
    filePath,
    ...(file.frontmatter["force-for-plugin"] !== undefined
      ? { forceForPlugin: parseBoolean(file.frontmatter["force-for-plugin"]) }
      : {}),
  };
}

async function loadStylesFromPath(
  plugin: LoadedPlugin,
  path: string,
  loadedPaths: Set<string>,
  filesystem: ContentFilesystem,
): Promise<readonly PluginOutputStyle[]> {
  if (await pathIsDirectory(path, filesystem)) {
    const files = await collectMarkdownFiles(path, filesystem);
    const styles = await Promise.all(
      files.map((filePath) => loadStyleFile(plugin, filePath, path, loadedPaths, filesystem)),
    );
    return styles.filter((style): style is PluginOutputStyle => style !== null);
  }
  if (!path.toLowerCase().endsWith(".md")) return [];
  const style = await loadStyleFile(plugin, path, plugin.root, loadedPaths, filesystem);
  return style ? [style] : [];
}

async function loadStylesForPlugin(
  plugin: LoadedPlugin,
  filesystem: ContentFilesystem,
): Promise<readonly PluginOutputStyle[]> {
  const loadedPaths = new Set<string>();
  const paths = [...new Set(plugin.outputStylesPaths)];
  const groups = await Promise.all(
    paths.map((path) => loadStylesFromPath(plugin, path, loadedPaths, filesystem)),
  );
  return groups.flat();
}

async function resolvePlugins(
  options: PluginOutputStyleRegistrationOptions,
): Promise<readonly LoadedPlugin[]> {
  return resolveRuntimePlugins(options);
}

async function loadPluginOutputStylesUncached(
  options: PluginOutputStyleRegistrationOptions,
): Promise<readonly PluginOutputStyle[]> {
  const plugins = await resolvePlugins(options);
  const groups = await Promise.all(
    plugins
      .filter((plugin) => !isRepositoryControlledPlugin(plugin))
      .map((plugin) => loadStylesForPlugin(plugin, pluginContentFilesystem(plugin, options))),
  );
  return groups
    .flat()
    .sort((a, b) => a.name.localeCompare(b.name) || basename(a.filePath).localeCompare(basename(b.filePath)));
}

interface PluginOutputStyleCacheEntry {
  readonly config: PluginRuntimeLoadOptions["config"];
  readonly styles: Promise<readonly PluginOutputStyle[]>;
}

const pluginOutputStylesByAuthority =
  new CanonicalAuthorityCache<PluginOutputStyleCacheEntry>();

function usesCanonicalPluginConfig(
  options: PluginOutputStyleRegistrationOptions,
  authority: CanonicalSettingsAuthority,
): boolean {
  return options.plugins === undefined &&
    options.fresh !== true &&
    (options.extraPluginDirs?.length ?? 0) === 0 &&
    options.config === authority.current();
}

export async function loadPluginOutputStyles(
  options: PluginOutputStyleRegistrationOptions,
): Promise<readonly PluginOutputStyle[]> {
  options = capturePluginRuntimeOptions(options);
  const authority = getCanonicalSettingsAuthority();
  if (options.executionEnvironment || authority === null || !usesCanonicalPluginConfig(options, authority)) {
    return loadPluginOutputStylesUncached(options);
  }

  const key = runtimeIdentityKey({
    cwd: options.workspaceRoot ?? options.cwd,
    pluginStorageRoot: options.pluginStorageRoot,
    executionEnvironment: options.executionEnvironment,
  });
  const cached = pluginOutputStylesByAuthority.get(key, authority);
  if (cached !== undefined && cached.config === options.config) {
    return cached.styles;
  }

  const styles = loadPluginOutputStylesUncached(options);
  const entry: PluginOutputStyleCacheEntry = { config: options.config, styles };
  pluginOutputStylesByAuthority.set(key, entry, authority);
  void styles.catch(() => {
    if (pluginOutputStylesByAuthority.get(key, authority) === entry) {
      pluginOutputStylesByAuthority.delete(key, authority);
    }
  });
  return styles;
}

export function clearPluginOutputStyleCache(): void {
  const authority = getCanonicalSettingsAuthority();
  if (authority === null) pluginOutputStylesByAuthority.clear();
  else pluginOutputStylesByAuthority.clearAuthority(authority);
}
