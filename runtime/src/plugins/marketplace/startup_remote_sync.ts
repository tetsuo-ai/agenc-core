import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasLocalCuratedPluginsSnapshot } from "./startup_sync.js";

export interface StartupRemotePluginSyncResult {
  readonly installedPluginIds: readonly string[];
  readonly enabledPluginIds: readonly string[];
  readonly disabledPluginIds: readonly string[];
  readonly uninstalledPluginIds: readonly string[];
}

export interface StartupRemotePluginSyncOptions {
  readonly agencHome: string;
  readonly syncPluginsFromRemote: (additiveOnly: boolean) => Promise<StartupRemotePluginSyncResult>;
  readonly prerequisiteTimeoutMs?: number;
  readonly pollMs?: number;
  readonly now?: () => Date;
}

const STARTUP_REMOTE_PLUGIN_SYNC_MARKER_FILE = "plugins/.app-server-remote-plugin-sync-v1";
const STARTUP_REMOTE_PLUGIN_SYNC_PREREQUISITE_TIMEOUT_MS = 10_000;

export function startupRemotePluginSyncMarkerPath(agencHome: string): string {
  return join(agencHome, STARTUP_REMOTE_PLUGIN_SYNC_MARKER_FILE);
}

export async function hasStartupRemotePluginSyncMarker(agencHome: string): Promise<boolean> {
  return readFile(startupRemotePluginSyncMarkerPath(agencHome), "utf8")
    .then((value) => value.trim().length > 0, () => false);
}

export async function startStartupRemotePluginSyncOnce(
  options: StartupRemotePluginSyncOptions,
): Promise<StartupRemotePluginSyncResult | null> {
  if (await hasStartupRemotePluginSyncMarker(options.agencHome)) {
    return null;
  }
  const ready = await waitForStartupRemotePluginSyncPrerequisites(
    options.agencHome,
    options.prerequisiteTimeoutMs ?? STARTUP_REMOTE_PLUGIN_SYNC_PREREQUISITE_TIMEOUT_MS,
    options.pollMs ?? 50,
  );
  if (!ready) return null;
  const result = await options.syncPluginsFromRemote(true);
  await writeStartupRemotePluginSyncMarker(options.agencHome, options.now?.() ?? new Date());
  return result;
}

export async function waitForStartupRemotePluginSyncPrerequisites(
  agencHome: string,
  timeoutMs = STARTUP_REMOTE_PLUGIN_SYNC_PREREQUISITE_TIMEOUT_MS,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await hasLocalCuratedPluginsSnapshot(agencHome)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function writeStartupRemotePluginSyncMarker(
  agencHome: string,
  at: Date = new Date(),
): Promise<void> {
  const path = startupRemotePluginSyncMarkerPath(agencHome);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${at.toISOString()}\n`, { mode: 0o600 });
}
