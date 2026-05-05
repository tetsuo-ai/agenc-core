import { mkdirSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";

const PLUGINS_DIR = "plugins";

function expandTilde(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function getPluginsDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const envOverride = env.AGENC_PLUGIN_CACHE_DIR;
  if (envOverride && envOverride.trim().length > 0) {
    return resolve(expandTilde(envOverride, home));
  }
  return join(home, ".agenc", PLUGINS_DIR);
}

export function getPluginSeedDirs(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] {
  const raw = env.AGENC_PLUGIN_SEED_DIR;
  if (!raw) return [];
  return raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(expandTilde(entry, home)));
}

export function sanitizePluginId(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9\-_]/g, "-");
}

export function pluginDataDirPath(
  pluginId: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return join(getPluginsDirectory(env, home), "data", sanitizePluginId(pluginId));
}

export function getPluginDataDir(
  pluginId: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const dir = pluginDataDirPath(pluginId, env, home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function getPluginDataDirSize(
  pluginId: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<{ bytes: number; human: string } | null> {
  const dir = pluginDataDirPath(pluginId, env, home);
  let bytes = 0;
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const fullPath = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      try {
        bytes += (await stat(fullPath)).size;
      } catch {
        // Broken links or concurrent deletes should not block cleanup prompts.
      }
    }
  }
  try {
    await walk(dir);
  } catch {
    return null;
  }
  if (bytes === 0) return null;
  return { bytes, human: formatBytes(bytes) };
}

export async function deletePluginDataDir(
  pluginId: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<void> {
  await rm(pluginDataDirPath(pluginId, env, home), {
    recursive: true,
    force: true,
  });
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
