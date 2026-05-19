import { access, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  normalizePluginManifest,
  PluginManifestError,
  type PluginManifest,
} from "./manifest-schema.js";

export const PLUGIN_MANIFEST_DIR = ".agenc-plugin";
export const PLUGIN_MANIFEST_FILE = "plugin.json";
export const PLUGIN_MANIFEST_RELATIVE_PATH = `${PLUGIN_MANIFEST_DIR}/${PLUGIN_MANIFEST_FILE}`;
const ROOT_PLUGIN_MANIFEST_RELATIVE_PATH = PLUGIN_MANIFEST_FILE;
export const MAX_PLUGIN_JSON_BYTES = 1_048_576;

export interface ParsedPluginManifest {
  readonly manifest: PluginManifest;
  readonly manifestPath: string;
}

export async function findPluginManifestPath(
  pluginRoot: string,
): Promise<string | null> {
  for (const relativePath of [
    PLUGIN_MANIFEST_RELATIVE_PATH,
    ROOT_PLUGIN_MANIFEST_RELATIVE_PATH,
  ]) {
    const candidate = join(pluginRoot, relativePath);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported location.
    }
  }
  return null;
}

export async function loadPluginManifest(
  pluginRoot: string,
  fallbackName = basename(pluginRoot),
): Promise<ParsedPluginManifest | null> {
  const manifestPath = await findPluginManifestPath(pluginRoot);
  if (!manifestPath) return null;
  const raw = await readJsonText(manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PluginManifestError(
      `Plugin manifest has invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      [{ path: "json", message: "Invalid JSON syntax" }],
    );
  }
  return {
    manifest: normalizePluginManifest(parsed, pluginRoot, fallbackName),
    manifestPath,
  };
}

export async function readJsonText(path: string): Promise<string> {
  const stats = await stat(path);
  if (stats.size > MAX_PLUGIN_JSON_BYTES) {
    throw new PluginManifestError("Plugin JSON file is too large", [
      { path, message: `JSON files must be at most ${MAX_PLUGIN_JSON_BYTES} bytes` },
    ]);
  }
  return readFile(path, "utf8");
}
