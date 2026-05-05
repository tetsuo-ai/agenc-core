import { resolveAgencHome } from "../../config/index.js";
import { clearPluginRegistrationCaches } from "../registration/manager.js";
import {
  clearMarketplacesCache,
  registerSeedMarketplaces,
  type KnownMarketplace,
} from "./marketplaceManager.js";
import {
  readCuratedPluginsSha,
  syncCuratedPluginsRepo,
  type StartupSyncOptions,
} from "./startup_sync.js";
import {
  startStartupRemotePluginSyncOnce,
  type StartupRemotePluginSyncResult,
} from "./startup_remote_sync.js";
import type { RemoteAuth, RemotePluginServiceConfig } from "./remote.js";
import type { Fetcher } from "./marketplace.js";

interface StartupAppState {
  readonly plugins: {
    readonly needsRefresh: boolean;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

type SetAppState = (f: (prevState: StartupAppState) => StartupAppState) => void;

export interface PerformStartupMarketplaceChecksOptions extends StartupSyncOptions {
  readonly seedMarketplaces?: Readonly<Record<string, KnownMarketplace>>;
  readonly remotePluginServiceConfig?: RemotePluginServiceConfig;
  readonly remoteAuth?: RemoteAuth;
  readonly remoteFetcher?: Fetcher;
  readonly allowLoopbackHttp?: boolean;
  readonly prerequisiteTimeoutMs?: number;
  readonly pollMs?: number;
  readonly onWarn?: (message: string) => void;
}

export async function performStartupChecks(
  setAppState: SetAppState,
  options: PerformStartupMarketplaceChecksOptions = {},
): Promise<void> {
  const agencHome = options.agencHome ?? resolveAgencHome(options.env);
  try {
    const seedChanged = await registerSeedMarketplaces(
      options.seedMarketplaces ?? {},
      { ...options, agencHome },
    );
    const curatedChanged = await syncCuratedSnapshot(agencHome, options);
    const remoteResult = await maybeSyncRemoteInstalledPlugins(agencHome, options);
    if (
      seedChanged ||
      curatedChanged ||
      remoteResultChangedLocalCache(remoteResult)
    ) {
      markPluginsNeedRefresh(setAppState);
    }
  } catch (error) {
    options.onWarn?.(`startup plugin checks failed: ${message(error)}`);
  }
}

async function syncCuratedSnapshot(
  agencHome: string,
  options: PerformStartupMarketplaceChecksOptions,
): Promise<boolean> {
  const before = await readCuratedPluginsSha(agencHome).catch(() => null);
  const after = await syncCuratedPluginsRepo(agencHome, { ...options, agencHome });
  return before !== after;
}

async function maybeSyncRemoteInstalledPlugins(
  agencHome: string,
  options: PerformStartupMarketplaceChecksOptions,
): Promise<StartupRemotePluginSyncResult | null> {
  if (options.remotePluginServiceConfig === undefined || options.remoteAuth === undefined) {
    return null;
  }
  return startStartupRemotePluginSyncOnce({
    agencHome,
    remotePluginServiceConfig: options.remotePluginServiceConfig,
    remoteAuth: options.remoteAuth,
    ...(options.remoteFetcher !== undefined ? { fetcher: options.remoteFetcher } : {}),
    ...(options.allowLoopbackHttp !== undefined ? { allowLoopbackHttp: options.allowLoopbackHttp } : {}),
    ...(options.prerequisiteTimeoutMs !== undefined ? { prerequisiteTimeoutMs: options.prerequisiteTimeoutMs } : {}),
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

function remoteResultChangedLocalCache(result: StartupRemotePluginSyncResult | null): boolean {
  return result !== null && (
    result.installedPluginIds.length > 0 ||
    result.uninstalledPluginIds.length > 0
  );
}

function markPluginsNeedRefresh(setAppState: SetAppState): void {
  clearMarketplacesCache();
  clearPluginRegistrationCaches();
  setAppState((prev) => {
    if (prev.plugins.needsRefresh) return prev;
    return {
      ...prev,
      plugins: {
        ...prev.plugins,
        needsRefresh: true,
      },
    };
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
