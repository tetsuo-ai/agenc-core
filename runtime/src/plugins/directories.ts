import { mkdirSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveHomeContext } from "../config/home.js";
import {
  peekAgentRuntimeOptions,
  resolveAgentRuntimeOptions,
} from "../session/runtime-options.js";
import { getCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";

const PLUGINS_DIR = "plugins";

function runtimeOptions(env: NodeJS.ProcessEnv | undefined) {
  return env === undefined
    ? peekAgentRuntimeOptions() ?? resolveAgentRuntimeOptions({})
    : resolveAgentRuntimeOptions(env);
}

export function getPluginsDirectory(
  env?: NodeJS.ProcessEnv,
  platformHome = homedir(),
): string {
  const configuredRoot = runtimeOptions(env).pluginStorageRoot;
  if (configuredRoot !== undefined) {
    return configuredRoot;
  }
  const homeContext = env !== undefined
    ? resolveHomeContext(env, { platformHome })
    : getCanonicalSettingsAuthority()?.homeContext;
  if (homeContext === undefined) {
    throw new Error(
      "Canonical settings authority is required to resolve the plugin storage root",
    );
  }
  return join(homeContext.path, PLUGINS_DIR);
}

export function sanitizePluginId(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9\-_]/g, "-");
}

export function pluginDataDirPath(
  pluginId: string,
  env?: NodeJS.ProcessEnv,
  platformHome = homedir(),
): string {
  return join(
    getPluginsDirectory(env, platformHome),
    "data",
    sanitizePluginId(pluginId),
  );
}

export function getPluginDataDir(
  pluginId: string,
  env?: NodeJS.ProcessEnv,
  platformHome = homedir(),
): string {
  const dir = pluginDataDirPath(pluginId, env, platformHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function getPluginDataDirSize(
  pluginId: string,
  env?: NodeJS.ProcessEnv,
  platformHome = homedir(),
): Promise<{ bytes: number; human: string } | null> {
  const dir = pluginDataDirPath(pluginId, env, platformHome);
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
  env?: NodeJS.ProcessEnv,
  platformHome = homedir(),
): Promise<void> {
  await rm(
    pluginDataDirPath(pluginId, env, platformHome),
    {
      recursive: true,
      force: true,
    },
  );
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
