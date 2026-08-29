/**
 * Plugin registration shared helpers.
 *
 * Projects local plugin-surface registration behavior onto AgenC's PK-01/PK-02
 * loader shape. This module is
 * intentionally runtime-owned: it consumes already-normalized `LoadedPlugin`
 * records and never imports from the compatibility scaffolding tree.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { load as loadYaml } from "js-yaml";

import { parseArguments } from "../../tui/slash/argument-substitution.js";
import {
  isRepositoryControlledPlugin,
  loadPlugins,
  type LoadedPlugin,
  type PluginLoadIssue,
  type PluginLoadResult,
  type PluginLoaderOptions,
} from "../loader.js";
import type { PluginUserConfigOption } from "../manifest-schema.js";
import {
  getPluginDataDir,
  resolvePluginStorageAuthority,
} from "../directories.js";
import { isRecord } from "../manifest-schema.js";
import { isBareMode } from "../../utils/envUtils.js";
import {
  loadPluginOptions,
  type PluginOptionSchema,
} from "../../utils/plugins/pluginOptionsStorage.js";
import {
  CanonicalAuthorityCache,
  getCanonicalSettingsAuthority,
} from "../../utils/settings/canonicalAuthority.js";
import type {
  PluginConfigStoredValue,
} from "../../utils/plugins/pluginConfigAuthority.js";

type PluginRuntimeOptionSchema = Readonly<
  Record<string, PluginUserConfigOption>
>;

const MAX_PLUGIN_REGISTRATION_MARKDOWN_FILES = 512;
const MAX_PLUGIN_REGISTRATION_SCAN_DEPTH = 8;

export interface PluginRuntimeLoadOptions {
  readonly cwd?: string;
  readonly workspaceRoot?: string;
  readonly pluginStorageRoot: string;
  readonly config?: PluginLoaderOptions["config"];
  readonly extraPluginDirs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly errors?: PluginLoadIssue[];
  /** Bypass process-local discovery snapshots and re-read plugin sources. */
  readonly fresh?: boolean;
}

export interface PluginRuntimeIdentityOptions {
  readonly cwd?: string;
  readonly pluginStorageRoot: string;
}

export interface ParsedMarkdownFile {
  readonly filePath: string;
  readonly baseDir: string;
  readonly frontmatter: Record<string, unknown>;
  readonly markdown: string;
}

export function toPluginLoaderOptions(
  options: PluginRuntimeLoadOptions,
): PluginLoaderOptions {
  const authority = getCanonicalSettingsAuthority();
  const workspaceValue =
    options.workspaceRoot ?? options.cwd ?? authority?.projectRoot;
  if (workspaceValue === undefined) {
    throw new Error(
      "Plugin loading requires an explicit workspace root or session ConfigStore authority",
    );
  }
  const workspaceRoot = resolve(workspaceValue);
  const pluginStorageRoot = resolvePluginStorageAuthority(
    options.pluginStorageRoot,
  ).pluginStorageRoot;
  return {
    pluginStorageRoot,
    workspaceRoot,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.extraPluginDirs !== undefined ? { extraPluginDirs: options.extraPluginDirs } : {}),
  };
}

export async function loadRuntimePlugins(
  options: PluginRuntimeLoadOptions,
): Promise<readonly LoadedPlugin[]> {
  const loaderOptions = toPluginLoaderOptions(options);
  const projectResult = (result: PluginLoadResult): readonly LoadedPlugin[] => {
    options.errors?.push(...result.errors);
    return result.enabled;
  };
  if (options.fresh === true || hasExplicitPluginDiscoveryInput(options)) {
    const result = await loadPlugins(loaderOptions);
    return projectResult(result);
  }
  const authority = getCanonicalSettingsAuthority();
  if (authority === null) {
    const result = await loadPlugins(loaderOptions);
    return projectResult(result);
  }
  const key = `${loaderOptions.workspaceRoot}\0${loaderOptions.pluginStorageRoot}`;
  const cached = runtimePluginLoadCache.get(key, authority);
  if (cached !== undefined) return projectResult(await cached);
  const loaded = loadPlugins(loaderOptions).catch((error: unknown) => {
    runtimePluginLoadCache.delete(key, authority);
    throw error;
  });
  runtimePluginLoadCache.set(key, loaded, authority);
  return projectResult(await loaded);
}

const runtimePluginLoadCache = new CanonicalAuthorityCache<Promise<PluginLoadResult>>();

export function clearRuntimePluginLoadCache(): void {
  const authority = getCanonicalSettingsAuthority();
  if (authority === null) runtimePluginLoadCache.clear();
  else runtimePluginLoadCache.clearAuthority(authority);
}

export function splitFrontmatter(raw: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly markdown: string;
} {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, markdown: raw };
  }
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/u.exec(raw);
  if (!match) return { frontmatter: {}, markdown: raw };
  try {
    const parsed = loadYaml(match[1] ?? "");
    return {
      frontmatter: isRecord(parsed) ? parsed : {},
      markdown: match[2] ?? "",
    };
  } catch {
    return { frontmatter: {}, markdown: match[2] ?? raw };
  }
}

export async function readMarkdownFile(
  filePath: string,
  baseDir: string,
): Promise<ParsedMarkdownFile | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = splitFrontmatter(raw);
    return {
      filePath,
      baseDir,
      frontmatter: parsed.frontmatter,
      markdown: parsed.markdown,
    };
  } catch {
    return null;
  }
}

export async function collectMarkdownFiles(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  const queue: Array<{ readonly path: string; readonly depth: number }> = [
    { path: root, depth: 0 },
  ];
  const visited = new Set<string>();
  while (queue.length > 0) {
    if (out.length >= MAX_PLUGIN_REGISTRATION_MARKDOWN_FILES) break;
    const current = queue.shift()!;
    if (current.depth > MAX_PLUGIN_REGISTRATION_SCAN_DEPTH) continue;
    const identity = await maybeRealpath(current.path);
    if (visited.has(identity)) continue;
    visited.add(identity);
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= MAX_PLUGIN_REGISTRATION_MARKDOWN_FILES) break;
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

async function maybeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function namespaceFromPath(filePath: string, baseDir: string): readonly string[] {
  const rel = relative(baseDir, dirname(filePath));
  if (!rel || rel === ".") return [];
  if (rel.startsWith("..") || isAbsolute(rel)) return [];
  return rel.split(sep).filter((part) => part.length > 0);
}

export function markdownStem(filePath: string): string {
  return basename(filePath).replace(/\.md$/iu, "");
}

export function coerceString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export function parseBoolean(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(coerceString)
      .filter((entry): entry is string => entry !== undefined);
  }
  const raw = coerceString(value);
  if (!raw) return [];
  return raw
    .split(/[\n,]/u)
    .flatMap((part) => part.trim().split(/\s+/u))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function descriptionFromMarkdown(raw: string): string | undefined {
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
      continue;
    }
    return trimmed.slice(0, 240);
  }
  return undefined;
}

export {
  canonicalPluginRuntimeNamespace,
  normalizePluginIdentifierName,
  normalizePluginIdentifierSegment,
  pluginScopedIdentifier,
} from "../identifier-normalization.js";

export function pluginSettingValue(
  plugin: LoadedPlugin,
  key: string,
  options: {
    readonly exposeSensitive?: boolean;
    readonly schemaOwnedValues?: Readonly<
      Record<string, PluginConfigStoredValue>
    >;
    readonly schema?: PluginRuntimeOptionSchema;
  } = {},
): string | undefined {
  if (isRepositoryControlledPlugin(plugin)) return undefined;
  const settings = isRecord(plugin.settings?.options)
    ? plugin.settings.options
    : isRecord(plugin.settings)
      ? plugin.settings
      : undefined;
  const manifestOption = plugin.manifest.userConfig?.[key];
  const schemaOption = options.schema?.[key];
  const sensitive =
    schemaOption?.sensitive === true ||
    manifestOption?.sensitive === true;
  const exposeSensitive = options.exposeSensitive === true;
  const schemaOwned = options.schemaOwnedValues ?? (
    plugin.manifest.userConfig !== undefined &&
        getCanonicalSettingsAuthority() !== null
      ? loadPluginOptions(
          plugin.id,
          plugin.manifest.userConfig as unknown as PluginOptionSchema,
        )
      : undefined
  );
  if (sensitive && !exposeSensitive) {
    return `[configured:${key}]`;
  }
  const schemaOwnedValue = stringifySettingValue(schemaOwned?.[key]);
  if (schemaOwnedValue !== undefined) return schemaOwnedValue;
  if (sensitive) return undefined;
  const configured = settings?.[key];
  const configuredValue = stringifySettingValue(configured);
  if (configuredValue !== undefined) return configuredValue;
  const defaultValue = schemaOption?.default ?? manifestOption?.default;
  return stringifySettingValue(defaultValue);
}

function stringifySettingValue(value: unknown): string | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) =>
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean"
          ? String(entry)
          : undefined,
      )
      .filter((entry): entry is string => entry !== undefined);
    return entries.length > 0 ? entries.join(",") : undefined;
  }
  return undefined;
}

export function substitutePluginTemplate(
  value: string,
  plugin: LoadedPlugin,
  options: {
    readonly sessionId?: string;
    readonly exposeSensitive?: boolean;
    readonly pluginStorageRoot?: string;
  } = {},
): string {
  return resolvePluginTemplate(value, plugin, options).value;
}

export interface PluginTemplateResolution {
  readonly value: string;
  readonly missingUserConfig: readonly string[];
}

function resolvePluginTemplate(
  value: string,
  plugin: LoadedPlugin,
  options: {
    readonly sessionId?: string;
    readonly exposeSensitive?: boolean;
    readonly schemaOwnedValues?: Readonly<
      Record<string, PluginConfigStoredValue>
    >;
    readonly schema?: PluginRuntimeOptionSchema;
    readonly pluginStorageRoot?: string;
  } = {},
): PluginTemplateResolution {
  const missingUserConfig: string[] = [];
  let pluginDataDir: string | undefined;
  const dataDir = (): string => {
    pluginDataDir ??= formatTemplatePath(
      getPluginDataDir(plugin.id, options.pluginStorageRoot),
    );
    return pluginDataDir;
  };
  let out = value
    .replace(/\$\{AGENC_PLUGIN_ROOT\}/g, () =>
      formatTemplatePath(plugin.root),
    )
    .replace(/\$\{AGENC_PLUGIN_DATA\}/g, () => dataDir())
    .replace(/\$\{AGENC_SESSION_ID\}/g, () => options.sessionId ?? "");
  out = out.replace(/\$\{user_config\.([A-Za-z_][\w.-]*)\}/g, (_match, key: string) => {
    const value = pluginSettingValue(plugin, key, {
      exposeSensitive: options.exposeSensitive,
      schemaOwnedValues: options.schemaOwnedValues,
      schema: options.schema,
    });
    if (value === undefined) {
      missingUserConfig.push(key);
      return "";
    }
    return value;
  });
  return { value: out, missingUserConfig: [...new Set(missingUserConfig)] };
}

function formatTemplatePath(path: string): string {
  return process.platform === "win32" ? path.replace(/\\/g, "/") : path;
}

export interface EnvTemplateResolution {
  readonly value: string;
  readonly missingEnv: readonly string[];
}

function expandEnvTemplate(
  value: string,
  env: NodeJS.ProcessEnv = {},
): EnvTemplateResolution {
  const missingEnv: string[] = [];
  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, rawName: string) => {
    const [name, defaultValue] = rawName.split(":-", 2);
    const envValue = env[name ?? ""];
    if (envValue !== undefined) return envValue;
    if (defaultValue !== undefined) return defaultValue;
    missingEnv.push(name ?? rawName);
    return match;
  });
  return { value: expanded, missingEnv: [...new Set(missingEnv)] };
}

export interface PluginServerTemplateResolution {
  readonly value: string;
  readonly missingUserConfig: readonly string[];
  readonly missingEnv: readonly string[];
}

export function resolvePluginServerTemplate(
  value: string,
  plugin: LoadedPlugin,
  options: {
    readonly sessionId?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly pluginStorageRoot?: string;
    readonly schemaOwnedValues?: Readonly<
      Record<string, PluginConfigStoredValue>
    >;
    readonly schema?: PluginRuntimeOptionSchema;
  } = {},
): PluginServerTemplateResolution {
  const pluginResult = resolvePluginTemplate(value, plugin, {
    sessionId: options.sessionId,
    exposeSensitive: true,
    schemaOwnedValues: options.schemaOwnedValues,
    schema: options.schema,
    ...(options.pluginStorageRoot !== undefined
      ? { pluginStorageRoot: options.pluginStorageRoot }
      : {}),
  });
  const envResult = expandEnvTemplate(pluginResult.value, options.env);
  return {
    value: envResult.value,
    missingUserConfig: pluginResult.missingUserConfig,
    missingEnv: envResult.missingEnv,
  };
}

export function runtimeIdentityKey(
  options: PluginRuntimeIdentityOptions,
): string {
  const authority = getCanonicalSettingsAuthority();
  const cwdValue = options.cwd ?? authority?.projectRoot;
  if (cwdValue === undefined) {
    throw new Error(
      "Plugin runtime identity requires an explicit cwd or session ConfigStore authority",
    );
  }
  const cwd = resolve(cwdValue);
  const pluginStorageRoot = resolvePluginStorageAuthority(
    options.pluginStorageRoot,
  ).pluginStorageRoot;
  return `${cwd}\0${pluginStorageRoot}`;
}

export function isPluginRuntimeSimpleMode(): boolean {
  return isBareMode();
}

export function hasExplicitPluginDiscoveryInput(
  options: Pick<PluginRuntimeLoadOptions, "config" | "extraPluginDirs"> & {
    readonly plugins?: readonly unknown[];
  },
): boolean {
  if (options.plugins !== undefined) return true;
  if ((options.extraPluginDirs?.length ?? 0) > 0) return true;
  const plugins = options.config?.plugins;
  return isRecord(plugins);
}

export function substituteArguments(
  value: string,
  args: string,
  argNames: readonly string[] = [],
): string {
  let out = value;
  const original = value;
  const pieces = parseArguments(args);
  for (const [index, name] of argNames.entries()) {
    const replacement = pieces[index] ?? "";
    out = out
      .replace(
        new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, "gu"),
        () => replacement,
      )
      .replace(new RegExp(`\\$\\{${escapeRegExp(name)}\\}`, "gu"), () => replacement);
  }
  out = out.replace(/\$ARGUMENTS\[(\d+)\]/gu, (_match, index: string) => {
    return pieces[Number.parseInt(index, 10)] ?? "";
  });
  out = out.replace(/\$(\d+)(?!\w)/gu, (_match, index: string) => {
    return pieces[Number.parseInt(index, 10)] ?? "";
  });
  out = out.replace(/\$ARGUMENTS/gu, () => args);
  if (out === original && args.trim().length > 0) {
    return `${out}\n\nARGUMENTS: ${args}`;
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
