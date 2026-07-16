import { basename } from "node:path";

import type { OutputStyleInput } from "../../prompts/system-prompt.js";
import { isRepositoryControlledPlugin, type LoadedPlugin } from "../loader.js";
import {
  collectMarkdownFiles,
  coerceString,
  descriptionFromMarkdown,
  loadRuntimePlugins,
  markdownStem,
  parseBoolean,
  pathIsDirectory,
  pluginScopedIdentifier,
  readMarkdownFile,
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
): Promise<PluginOutputStyle | null> {
  if (loadedPaths.has(filePath)) return null;
  loadedPaths.add(filePath);
  const file = await readMarkdownFile(filePath, baseDir);
  if (!file) return null;
  const baseName = coerceString(file.frontmatter.name) ?? markdownStem(filePath);
  const name = pluginScopedIdentifier(
    plugin.name,
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
    plugin: plugin.name,
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
): Promise<readonly PluginOutputStyle[]> {
  if (await pathIsDirectory(path)) {
    const files = await collectMarkdownFiles(path);
    const styles = await Promise.all(
      files.map((filePath) => loadStyleFile(plugin, filePath, path, loadedPaths)),
    );
    return styles.filter((style): style is PluginOutputStyle => style !== null);
  }
  if (!path.toLowerCase().endsWith(".md")) return [];
  const style = await loadStyleFile(plugin, path, plugin.root, loadedPaths);
  return style ? [style] : [];
}

async function loadStylesForPlugin(
  plugin: LoadedPlugin,
): Promise<readonly PluginOutputStyle[]> {
  const loadedPaths = new Set<string>();
  const paths = [...new Set(plugin.outputStylesPaths)];
  const groups = await Promise.all(
    paths.map((path) => loadStylesFromPath(plugin, path, loadedPaths)),
  );
  return groups.flat();
}

async function resolvePlugins(
  options: PluginOutputStyleRegistrationOptions,
): Promise<readonly LoadedPlugin[]> {
  return options.plugins ?? await loadRuntimePlugins(options);
}

export async function loadPluginOutputStyles(
  options: PluginOutputStyleRegistrationOptions = {},
): Promise<readonly PluginOutputStyle[]> {
  const plugins = await resolvePlugins(options);
  const groups = await Promise.all(
    plugins
      .filter((plugin) => !isRepositoryControlledPlugin(plugin))
      .map(loadStylesForPlugin),
  );
  return groups
    .flat()
    .sort((a, b) => a.name.localeCompare(b.name) || basename(a.filePath).localeCompare(basename(b.filePath)));
}

export function clearPluginOutputStyleCache(): void {
  // Output style loading is uncached; this keeps the registration cache API uniform.
}
