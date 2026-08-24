import { access, lstat, readFile, stat } from "node:fs/promises";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  normalizePluginManifest,
  PluginManifestError,
  type PluginManifest,
} from "./manifest-schema.js";

export const PLUGIN_MANIFEST_DIR = ".agenc-plugin";
export const PLUGIN_MANIFEST_FILE = "plugin.json";
export const PLUGIN_MANIFEST_RELATIVE_PATH = `${PLUGIN_MANIFEST_DIR}/${PLUGIN_MANIFEST_FILE}`;
const MAX_PLUGIN_JSON_BYTES = 1_048_576;

export interface ParsedPluginManifest {
  readonly manifest: PluginManifest;
  readonly manifestPath: string;
}

export function retiredRootPluginManifestPath(pluginRoot: string): string {
  return join(pluginRoot, PLUGIN_MANIFEST_FILE);
}

export async function assertNoRetiredRootPluginManifest(
  pluginRoot: string,
): Promise<void> {
  const retiredPath = retiredRootPluginManifestPath(pluginRoot);
  try {
    await lstat(retiredPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new PluginManifestError(
    `Retired root plugin manifest detected at ${retiredPath}. AgenC only loads ${PLUGIN_MANIFEST_RELATIVE_PATH}; move the manifest there and remove the root file, or reinstall the plugin.`,
    [{
      path: retiredPath,
      message: `Move this manifest to ${PLUGIN_MANIFEST_RELATIVE_PATH} and remove the root file, or reinstall the plugin.`,
    }],
  );
}

export async function findPluginManifestPath(
  pluginRoot: string,
): Promise<string | null> {
  await assertNoRetiredRootPluginManifest(pluginRoot);
  const candidate = join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH);
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export async function loadPluginManifest(
  pluginRoot: string,
): Promise<ParsedPluginManifest | null> {
  const manifestPath = await findPluginManifestPath(pluginRoot);
  if (!manifestPath) return null;
  const raw = await readJsonText(manifestPath);
  return parsePluginManifestText(raw, pluginRoot, manifestPath);
}

function parsePluginManifestText(
  raw: string,
  pluginRoot: string,
  manifestPath: string,
): ParsedPluginManifest {
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
    manifest: normalizePluginManifest(parsed, pluginRoot),
    manifestPath,
  };
}

export async function loadRequiredPluginManifest(
  pluginRoot: string,
): Promise<ParsedPluginManifest> {
  const parsed = await loadPluginManifest(pluginRoot);
  if (parsed) return parsed;
  throw missingRequiredPluginManifest(pluginRoot);
}

export function loadRequiredPluginManifestSync(
  pluginRoot: string,
): ParsedPluginManifest {
  const retiredPath = retiredRootPluginManifestPath(pluginRoot);
  try {
    lstatSync(retiredPath);
    throw new PluginManifestError(
      `Retired root plugin manifest detected at ${retiredPath}. AgenC only loads ${PLUGIN_MANIFEST_RELATIVE_PATH}; move the manifest there and remove the root file, or reinstall the plugin.`,
      [{
        path: retiredPath,
        message: `Move this manifest to ${PLUGIN_MANIFEST_RELATIVE_PATH} and remove the root file, or reinstall the plugin.`,
      }],
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const manifestPath = join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH);
  let stats;
  try {
    stats = statSync(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw missingRequiredPluginManifest(pluginRoot);
    }
    throw error;
  }
  if (stats.size > MAX_PLUGIN_JSON_BYTES) {
    throw new PluginManifestError("Plugin JSON file is too large", [
      { path: manifestPath, message: `JSON files must be at most ${MAX_PLUGIN_JSON_BYTES} bytes` },
    ]);
  }
  return parsePluginManifestText(
    readFileSync(manifestPath, "utf8"),
    pluginRoot,
    manifestPath,
  );
}

function missingRequiredPluginManifest(pluginRoot: string): PluginManifestError {
  const manifestPath = join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH);
  return new PluginManifestError(
    `Required plugin manifest is missing at ${manifestPath}. Add ${PLUGIN_MANIFEST_RELATIVE_PATH} to the package, or reinstall the plugin. Component directories and marketplace metadata cannot replace the manifest.`,
    [{
      path: manifestPath,
      message: `Add the canonical ${PLUGIN_MANIFEST_RELATIVE_PATH} manifest, or reinstall the plugin.`,
    }],
  );
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
