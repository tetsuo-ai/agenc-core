import {
  defaultFetch,
  type Fetcher,
} from "./marketplace.js";
import type { RemoteAuth, RemotePluginServiceConfig } from "./remote.js";

export interface RemotePluginStatusSummary {
  readonly name: string;
  readonly marketplaceName: string;
  readonly enabled: boolean;
}

interface RemotePluginMutationResponse {
  readonly id: string;
  readonly enabled: boolean;
}

const DEFAULT_REMOTE_MARKETPLACE_NAME = "agenc-curated";

export async function fetchRemotePluginStatus(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  fetcher: Fetcher = defaultFetch,
): Promise<readonly RemotePluginStatusSummary[]> {
  const body = await remoteRequest(config, auth, "/plugins/list", "GET", fetcher);
  const parsed = JSON.parse(body) as readonly Partial<RemotePluginStatusSummary>[];
  return parsed
    .filter((plugin): plugin is { readonly name: string; readonly enabled: boolean; readonly marketplaceName?: string } =>
      typeof plugin.name === "string" && typeof plugin.enabled === "boolean",
    )
    .map((plugin) => ({
      name: plugin.name,
      marketplaceName: plugin.marketplaceName ?? DEFAULT_REMOTE_MARKETPLACE_NAME,
      enabled: plugin.enabled,
    }));
}

export async function fetchRemoteFeaturedPluginIds(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  product: string | undefined,
  fetcher: Fetcher = defaultFetch,
): Promise<readonly string[]> {
  const query = product ? `?platform=${encodeURIComponent(product)}` : "";
  const body = await remoteRequest(config, auth, `/plugins/featured${query}`, "GET", fetcher, false);
  const parsed = JSON.parse(body) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

export async function enableRemotePlugin(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  pluginId: string,
  fetcher: Fetcher = defaultFetch,
): Promise<void> {
  const response = await postRemotePluginMutation(config, auth, pluginId, "enable", fetcher);
  assertMutation(pluginId, true, response);
}

export async function uninstallRemotePluginLegacy(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  pluginId: string,
  fetcher: Fetcher = defaultFetch,
): Promise<void> {
  const response = await postRemotePluginMutation(config, auth, pluginId, "uninstall", fetcher);
  assertMutation(pluginId, false, response);
}

async function postRemotePluginMutation(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  pluginId: string,
  action: "enable" | "uninstall",
  fetcher: Fetcher,
): Promise<RemotePluginMutationResponse> {
  const body = await remoteRequest(
    config,
    auth,
    `/plugins/${encodeURIComponent(pluginId)}/${action}`,
    "POST",
    fetcher,
  );
  return JSON.parse(body) as RemotePluginMutationResponse;
}

async function remoteRequest(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  path: string,
  method: "GET" | "POST",
  fetcher: Fetcher,
  requireAuth = true,
): Promise<string> {
  if (requireAuth && auth === undefined) {
    throw new Error("authentication required for remote plugin operation");
  }
  const url = `${config.baseUrl.replace(/\/+$/u, "")}${path}`;
  const response = await fetcher(url, {
    method,
    ...(auth !== undefined ? { headers: auth.headers } : {}),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`remote plugin operation failed with status ${response.status} from ${url}: ${body}`);
  }
  return body;
}

function assertMutation(
  pluginId: string,
  expectedEnabled: boolean,
  response: RemotePluginMutationResponse,
): void {
  if (response.id !== pluginId) {
    throw new Error(`remote plugin mutation returned unexpected plugin id: expected '${pluginId}', got '${response.id}'`);
  }
  if (response.enabled !== expectedEnabled) {
    throw new Error(`remote plugin mutation returned unexpected enabled state for '${pluginId}': expected ${expectedEnabled}, got ${response.enabled}`);
  }
}
