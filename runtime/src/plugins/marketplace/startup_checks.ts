import { resolveAgencHome } from "../../config/index.js";
import { resolveRemoteAuthHeaders, type RemoteAuthBackendOptions } from "../../auth/index.js";
import { clearPluginRegistrationCaches } from "../registration/manager.js";
import {
  clearMarketplacesCache,
  registerSeedMarketplaces,
  reconcileMarketplaces,
  type DeclaredMarketplace,
  type KnownMarketplace,
  type MarketplaceReconcileResult,
} from "./marketplaceManager.js";
import {
  AGENC_OFFICIAL_MARKETPLACE_NAME,
  AGENC_OFFICIAL_MARKETPLACE_SOURCE,
} from "./officialMarketplace.js";
import {
  hasLocalCuratedPluginsSnapshot,
  readCuratedPluginsSha,
  syncCuratedPluginsRepo,
  type StartupSyncOptions,
} from "./startup_sync.js";
import {
  startStartupRemotePluginSyncOnce,
  type StartupRemotePluginSyncOptions,
  type StartupRemotePluginSyncResult,
} from "./startup_remote_sync.js";
import type { RemoteAuth, RemotePluginServiceConfig } from "./remote.js";
import type { Fetcher, MarketplaceSource } from "./marketplace.js";

export const REMOTE_PLUGIN_SERVICE_URL_ENV = "AGENC_REMOTE_PLUGIN_SERVICE_URL" as const;
export const DEFAULT_REMOTE_PLUGIN_SERVICE_BASE_URL = "https://agenc.tech" as const;

interface StartupAppState {
  readonly plugins: {
    readonly needsRefresh: boolean;
    readonly installationStatus?: {
      readonly marketplaces?: readonly StartupMarketplaceInstallStatus[];
      readonly plugins?: readonly unknown[];
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

type SetAppState = (f: (prevState: StartupAppState) => StartupAppState) => void;
type StartupTrustPredicate = boolean | (() => boolean);

interface StartupMarketplaceInstallStatus {
  readonly name: string;
  readonly status: "pending" | "installing" | "installed" | "failed";
  readonly error?: string;
}

export interface StartupMarketplaceConfig {
  readonly extraKnownMarketplaces?: Readonly<Record<string, unknown>>;
  readonly enabledPlugins?: Readonly<Record<string, unknown>>;
  readonly plugins?: {
    readonly enabled?: Readonly<Record<string, unknown>>;
  };
}

export interface PerformStartupMarketplaceChecksOptions extends StartupSyncOptions {
  readonly trustAccepted?: StartupTrustPredicate;
  readonly config?: StartupMarketplaceConfig;
  readonly seedMarketplaces?: Readonly<Record<string, KnownMarketplace>>;
  readonly declaredMarketplaces?: Readonly<Record<string, DeclaredMarketplace>>;
  readonly remotePluginServiceConfig?: RemotePluginServiceConfig;
  readonly remoteAuth?: RemoteAuth;
  readonly remoteAuthOptions?: RemoteAuthBackendOptions;
  readonly remoteFetcher?: Fetcher;
  readonly allowLoopbackHttp?: boolean;
  readonly prerequisiteTimeoutMs?: number;
  readonly pollMs?: number;
  readonly syncPluginsFromRemote?: StartupRemotePluginSyncOptions["syncPluginsFromRemote"];
  readonly onWarn?: (message: string) => void;
}

export async function performStartupChecks(
  setAppState: SetAppState,
  options: PerformStartupMarketplaceChecksOptions = {},
): Promise<void> {
  const agencHome = options.agencHome ?? resolveAgencHome(options.env);
  if (!startupTrustAccepted(options.trustAccepted)) return;
  let changedLocalCache = false;
  try {
    const seedChanged = await registerSeedMarketplaces(
      options.seedMarketplaces,
      { ...options, agencHome },
    );
    changedLocalCache ||= seedChanged;
    const marketplaceResult = await reconcileDeclaredMarketplaces(
      agencHome,
      setAppState,
      options,
    );
    changedLocalCache ||= marketplaceResultChangedLocalCache(marketplaceResult);
    const curatedChanged = await syncCuratedSnapshot(agencHome, options);
    changedLocalCache ||= curatedChanged;
    const remoteResult = await maybeSyncRemoteInstalledPlugins(agencHome, options);
    changedLocalCache ||= remoteResultChangedLocalCache(remoteResult);
  } catch (error) {
    options.onWarn?.(`startup plugin checks failed: ${message(error)}`);
  } finally {
    if (changedLocalCache) {
      markPluginsNeedRefresh(setAppState);
    }
  }
}

async function reconcileDeclaredMarketplaces(
  agencHome: string,
  setAppState: SetAppState,
  options: PerformStartupMarketplaceChecksOptions,
): Promise<MarketplaceReconcileResult> {
  const declaredMarketplaces = options.declaredMarketplaces ??
    declaredMarketplacesFromConfig(options.config);
  return reconcileMarketplaces({
    ...options,
    agencHome,
    declaredMarketplaces,
    onMarketplaceProgress: (event) => {
      if (event.type === "failed") {
        updateMarketplaceInstallStatus(setAppState, event.name, "failed", event.error);
      } else {
        updateMarketplaceInstallStatus(setAppState, event.name, event.type);
      }
    },
  });
}

async function syncCuratedSnapshot(
  agencHome: string,
  options: PerformStartupMarketplaceChecksOptions,
): Promise<boolean> {
  const beforeSha = await readCuratedPluginsSha(agencHome).catch(() => null);
  const hadSnapshot = await hasLocalCuratedPluginsSnapshot(agencHome);
  const after = await syncCuratedPluginsRepo(agencHome, { ...options, agencHome });
  const hasSnapshot = await hasLocalCuratedPluginsSnapshot(agencHome);
  return beforeSha !== after || hadSnapshot !== hasSnapshot;
}

async function maybeSyncRemoteInstalledPlugins(
  agencHome: string,
  options: PerformStartupMarketplaceChecksOptions,
): Promise<StartupRemotePluginSyncResult | null> {
  const remoteAuth = options.remoteAuth ??
    (options.syncPluginsFromRemote === undefined
      ? await remoteAuthFromAuthLayer(agencHome, options)
      : null);
  if (remoteAuth === null && options.syncPluginsFromRemote === undefined) {
    return null;
  }
  const remotePluginServiceConfig = options.remotePluginServiceConfig ??
    startupRemotePluginServiceConfig(options.env);
  return startStartupRemotePluginSyncOnce({
    agencHome,
    remotePluginServiceConfig,
    ...(remoteAuth !== null ? { remoteAuth } : {}),
    ...(options.syncPluginsFromRemote !== undefined ? { syncPluginsFromRemote: options.syncPluginsFromRemote } : {}),
    ...(options.remoteFetcher !== undefined ? { fetcher: options.remoteFetcher } : {}),
    ...(options.allowLoopbackHttp !== undefined ? { allowLoopbackHttp: options.allowLoopbackHttp } : {}),
    ...(options.prerequisiteTimeoutMs !== undefined ? { prerequisiteTimeoutMs: options.prerequisiteTimeoutMs } : {}),
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

async function remoteAuthFromAuthLayer(
  agencHome: string,
  options: PerformStartupMarketplaceChecksOptions,
): Promise<RemoteAuth | null> {
  const headers = await resolveRemoteAuthHeaders({
    agencHome,
    env: options.env,
    ...(options.remoteAuthOptions ?? {}),
  });
  return headers === null ? null : { headers };
}

function startupRemotePluginServiceConfig(
  env: NodeJS.ProcessEnv | undefined,
): RemotePluginServiceConfig {
  return {
    baseUrl: trimNonEmpty(env?.[REMOTE_PLUGIN_SERVICE_URL_ENV]) ??
      DEFAULT_REMOTE_PLUGIN_SERVICE_BASE_URL,
  };
}

function marketplaceResultChangedLocalCache(result: MarketplaceReconcileResult): boolean {
  return result.installed.length > 0 || result.updated.length > 0;
}

function remoteResultChangedLocalCache(result: StartupRemotePluginSyncResult | null): boolean {
  return result !== null && (
    result.installedPluginIds.length > 0 ||
    result.enabledPluginIds.length > 0 ||
    result.disabledPluginIds.length > 0 ||
    result.uninstalledPluginIds.length > 0
  );
}

function startupTrustAccepted(trustAccepted: StartupTrustPredicate | undefined): boolean {
  if (trustAccepted === undefined) return false;
  try {
    return typeof trustAccepted === "function" ? trustAccepted() : trustAccepted;
  } catch {
    return false;
  }
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

function updateMarketplaceInstallStatus(
  setAppState: SetAppState,
  name: string,
  status: StartupMarketplaceInstallStatus["status"],
  error?: string,
): void {
  setAppState((prev) => {
    const current = prev.plugins.installationStatus?.marketplaces ?? [];
    const next = current.map((entry) =>
      entry.name === name
        ? {
          name,
          status,
          ...(error !== undefined ? { error } : {}),
        }
        : entry,
    );
    return {
      ...prev,
      plugins: {
        ...prev.plugins,
        installationStatus: {
          ...(prev.plugins.installationStatus ?? {}),
          marketplaces: next.some((entry) => entry.name === name)
            ? next
            : [...next, { name, status, ...(error !== undefined ? { error } : {}) }],
          plugins: prev.plugins.installationStatus?.plugins ?? [],
        },
      },
    };
  });
}

function declaredMarketplacesFromConfig(
  config: StartupMarketplaceConfig | undefined,
): Readonly<Record<string, DeclaredMarketplace>> {
  const declared: Record<string, DeclaredMarketplace> = {};
  for (const [name, value] of Object.entries(config?.extraKnownMarketplaces ?? {})) {
    const marketplace = normalizeDeclaredMarketplace(value);
    if (marketplace !== null) declared[name] = marketplace;
  }
  if (
    referencesOfficialMarketplace(config?.enabledPlugins) ||
    referencesOfficialMarketplace(config?.plugins?.enabled)
  ) {
    declared[AGENC_OFFICIAL_MARKETPLACE_NAME] ??= {
      source: AGENC_OFFICIAL_MARKETPLACE_SOURCE,
      sourceIsFallback: true,
    };
  }
  return declared;
}

function normalizeDeclaredMarketplace(value: unknown): DeclaredMarketplace | null {
  if (!isRecord(value)) return null;
  const source = value.source;
  if (typeof source !== "string" && !isMarketplaceSource(source)) return null;
  const autoUpdate = typeof value.autoUpdate === "boolean" ? value.autoUpdate : undefined;
  const sourceIsFallback = typeof value.sourceIsFallback === "boolean" ? value.sourceIsFallback : undefined;
  return {
    source,
    ...(autoUpdate !== undefined ? { autoUpdate } : {}),
    ...(sourceIsFallback !== undefined ? { sourceIsFallback } : {}),
  };
}

function referencesOfficialMarketplace(enabledPlugins: Readonly<Record<string, unknown>> | undefined): boolean {
  if (enabledPlugins === undefined) return false;
  return Object.entries(enabledPlugins).some(([pluginId, enabled]) => {
    const at = pluginId.lastIndexOf("@");
    return pluginEntryEnabled(enabled) &&
      at > 0 &&
      pluginId.slice(at + 1) === AGENC_OFFICIAL_MARKETPLACE_NAME;
  });
}

function pluginEntryEnabled(value: unknown): boolean {
  if (value === false || value === null || value === undefined) return false;
  if (isRecord(value) && value.enabled === false) return false;
  return true;
}

function isMarketplaceSource(value: unknown): value is MarketplaceSource {
  if (!isRecord(value) || typeof value.source !== "string") return false;
  return ["local", "file", "directory", "git", "github", "url", "settings"].includes(value.source);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimNonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
