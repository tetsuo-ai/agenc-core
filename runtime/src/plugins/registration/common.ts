/**
 * Plugin registration shared helpers.
 *
 * Projects local plugin-surface registration behavior onto AgenC's PK-01/PK-02
 * loader shape. This module is
 * intentionally runtime-owned: it consumes already-normalized `LoadedPlugin`
 * records and never imports from the upstream mirror.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { load as loadYaml } from "js-yaml";

import { loadPlugins, type LoadedPlugin, type PluginLoaderOptions } from "../loader.js";
import { getPluginDataDir } from "../directories.js";
import { isRecord } from "../manifest-schema.js";

export const MAX_PLUGIN_REGISTRATION_MARKDOWN_FILES = 512;
export const MAX_PLUGIN_REGISTRATION_SCAN_DEPTH = 8;

export interface PluginRuntimeLoadOptions {
  readonly cwd?: string;
  readonly workspaceRoot?: string;
  readonly agencHome?: string;
  readonly config?: PluginLoaderOptions["config"];
  readonly extraPluginDirs?: readonly string[];
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
  const result = await loadPlugins(toPluginLoaderOptions(options));
  return result.enabled;
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

export function pluginSettingValue(
  plugin: LoadedPlugin,
  key: string,
): string | undefined {
  const options = isRecord(plugin.settings?.options)
    ? plugin.settings.options
    : isRecord(plugin.settings)
      ? plugin.settings
      : undefined;
  const configured = options?.[key];
  if (
    typeof configured === "string" ||
    typeof configured === "number" ||
    typeof configured === "boolean"
  ) {
    return String(configured);
  }
  const manifestOption = plugin.manifest.userConfig?.[key];
  if (manifestOption?.sensitive === true) {
    return `[configured:${key}]`;
  }
  const defaultValue = manifestOption?.default;
  if (
    typeof defaultValue === "string" ||
    typeof defaultValue === "number" ||
    typeof defaultValue === "boolean"
  ) {
    return String(defaultValue);
  }
  return undefined;
}

export function substitutePluginTemplate(
  value: string,
  plugin: LoadedPlugin,
  options: { readonly sessionId?: string } = {},
): string {
  let out = value
    .replace(/\$\{AGENC_PLUGIN_ROOT\}/g, plugin.root)
    .replace(/\$\{AGENC_PLUGIN_DATA\}/g, getPluginDataDir(plugin.source))
    .replace(/\$\{AGENC_SESSION_ID\}/g, options.sessionId ?? "");
  out = out.replace(/\$\{user_config\.([A-Za-z_][\w.-]*)\}/g, (_match, key: string) => {
    return pluginSettingValue(plugin, key) ?? "";
  });
  return out;
}

export function substituteArguments(
  value: string,
  args: string,
  argNames: readonly string[] = [],
): string {
  let out = value.replace(/\$ARGUMENTS/g, args);
  const pieces = args.trim().length > 0 ? args.trim().split(/\s+/u) : [];
  for (const [index, name] of argNames.entries()) {
    const replacement = pieces[index] ?? "";
    out = out.replace(new RegExp(`\\$\\{${escapeRegExp(name)}\\}`, "gu"), replacement);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
