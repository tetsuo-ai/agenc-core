/**
 * Plugin registration shared helpers.
 *
 * Projects local plugin-surface registration behavior onto AgenC's PK-01/PK-02
 * loader shape. This module is
 * intentionally runtime-owned: it consumes already-normalized `LoadedPlugin`
 * records and never imports from the compatibility scaffolding tree.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { load as loadYaml } from "js-yaml";

import { parseArguments } from "../../tui/slash/argument-substitution.js";
import { loadPlugins, type LoadedPlugin, type PluginLoaderOptions } from "../loader.js";
import { getPluginDataDir } from "../directories.js";
import { isRecord } from "../manifest-schema.js";

const MAX_PLUGIN_REGISTRATION_MARKDOWN_FILES = 512;
const MAX_PLUGIN_REGISTRATION_SCAN_DEPTH = 8;

export interface PluginRuntimeLoadOptions {
  readonly cwd?: string;
  readonly workspaceRoot?: string;
  readonly agencHome?: string;
  readonly config?: PluginLoaderOptions["config"];
  readonly extraPluginDirs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export interface PluginRuntimeIdentityOptions {
  readonly cwd?: string;
  readonly agencHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ParsedMarkdownFile {
  readonly filePath: string;
  readonly baseDir: string;
  readonly frontmatter: Record<string, unknown>;
  readonly markdown: string;
}

export function toPluginLoaderOptions(
  options: PluginRuntimeLoadOptions = {},
): PluginLoaderOptions {
  const env = options.env ?? process.env;
  const workspaceRoot = resolve(options.workspaceRoot ?? options.cwd ?? process.cwd());
  const agencHome = resolve(
    options.agencHome ??
      env.AGENC_HOME ??
      join(homedir(), ".agenc"),
  );
  return {
    agencHome,
    workspaceRoot,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.extraPluginDirs !== undefined ? { extraPluginDirs: options.extraPluginDirs } : {}),
  };
}

export async function loadRuntimePlugins(
  options: PluginRuntimeLoadOptions = {},
): Promise<readonly LoadedPlugin[]> {
  const loaderOptions = toPluginLoaderOptions(options);
  if (hasExplicitPluginDiscoveryInput(options)) {
    const result = await loadPlugins(loaderOptions);
    return result.enabled;
  }
  const key = `${loaderOptions.workspaceRoot}\0${loaderOptions.agencHome}`;
  const cached = runtimePluginLoadCache.get(key);
  if (cached !== undefined) return cached;
  const loaded = loadPlugins(loaderOptions)
    .then((result) => result.enabled)
    .catch((error: unknown) => {
      runtimePluginLoadCache.delete(key);
      throw error;
    });
  runtimePluginLoadCache.set(key, loaded);
  return loaded;
}

const runtimePluginLoadCache = new Map<string, Promise<readonly LoadedPlugin[]>>();

export function clearRuntimePluginLoadCache(): void {
  runtimePluginLoadCache.clear();
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

export function normalizePluginIdentifierSegment(
  value: string,
  fallback: string,
): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  const segment = normalized.length > 0 ? normalized : fallback;
  return /^[a-z]/u.test(segment) ? segment : `cmd_${segment}`;
}

export function normalizePluginIdentifierName(
  parts: readonly string[],
  finalFallback: string,
): string {
  return parts
    .map((part, index) =>
      normalizePluginIdentifierSegment(
        part,
        index === parts.length - 1 ? finalFallback : "namespace",
      )
    )
    .join(":");
}

export function pluginScopedIdentifier(
  pluginName: string,
  parts: readonly string[],
  finalFallback: string,
): string {
  return normalizePluginIdentifierName([pluginName, ...parts], finalFallback);
}

export function pluginSettingValue(
  plugin: LoadedPlugin,
  key: string,
  options: { readonly exposeSensitive?: boolean } = {},
): string | undefined {
  const settings = isRecord(plugin.settings?.options)
    ? plugin.settings.options
    : isRecord(plugin.settings)
      ? plugin.settings
      : undefined;
  const manifestOption = plugin.manifest.userConfig?.[key];
  const exposeSensitive = options.exposeSensitive === true;
  if (manifestOption?.sensitive === true && !exposeSensitive) {
    return `[configured:${key}]`;
  }
  const configured = settings?.[key];
  const configuredValue = stringifySettingValue(configured);
  if (configuredValue !== undefined) return configuredValue;
  const defaultValue = manifestOption?.default;
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
  options: { readonly sessionId?: string; readonly exposeSensitive?: boolean } = {},
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
  options: { readonly sessionId?: string; readonly exposeSensitive?: boolean } = {},
): PluginTemplateResolution {
  const missingUserConfig: string[] = [];
  let pluginDataDir: string | undefined;
  const dataDir = (): string => {
    pluginDataDir ??= formatTemplatePath(getPluginDataDir(plugin.source));
    return pluginDataDir;
  };
  let out = value
    .replace(/\$\{AGENC_PLUGIN_ROOT\}/g, () => formatTemplatePath(plugin.root))
    .replace(/\$\{AGENC_PLUGIN_DATA\}/g, () => dataDir())
    .replace(/\$\{AGENC_SESSION_ID\}/g, () => options.sessionId ?? "");
  out = out.replace(/\$\{user_config\.([A-Za-z_][\w.-]*)\}/g, (_match, key: string) => {
    const value = pluginSettingValue(plugin, key, {
      exposeSensitive: options.exposeSensitive,
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
  env: NodeJS.ProcessEnv = process.env,
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
  } = {},
): PluginServerTemplateResolution {
  const pluginResult = resolvePluginTemplate(value, plugin, {
    sessionId: options.sessionId,
    exposeSensitive: true,
  });
  const envResult = expandEnvTemplate(pluginResult.value, options.env);
  return {
    value: envResult.value,
    missingUserConfig: pluginResult.missingUserConfig,
    missingEnv: envResult.missingEnv,
  };
}

export function runtimeIdentityKey(
  options: PluginRuntimeIdentityOptions = {},
): string {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const agencHome = resolve(
    options.agencHome ??
      env.AGENC_HOME ??
      join(homedir(), ".agenc"),
  );
  return `${cwd}\0${agencHome}`;
}

export function cwdOnlyRuntimeIdentityKey(cwd: string | undefined): string {
  return resolve(cwd ?? process.cwd());
}

export function isPluginRuntimeSimpleMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolean(env.AGENC_SIMPLE) || parseBoolean(env.AGENC_BARE);
}

export function hasExplicitPluginDiscoveryInput(
  options: Pick<PluginRuntimeLoadOptions, "config" | "extraPluginDirs"> & {
    readonly plugins?: readonly unknown[];
  },
): boolean {
  if (options.plugins !== undefined) return true;
  if ((options.extraPluginDirs?.length ?? 0) > 0) return true;
  const plugins = options.config?.plugins;
  if (isRecord(options.config?.enabledPlugins)) return true;
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
