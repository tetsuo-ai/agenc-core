import {
  defaultFetch,
  type Fetcher,
} from "./marketplace.js";
import {
  assertHttpsOrLoopbackUrl,
  fetchWithTimeout,
  readResponseErrorText,
  readResponseTextWithLimit,
  redactUrlForError,
} from "./fetchGuards.js";
import type { RemoteAuth, RemotePluginRequestOptions, RemotePluginServiceConfig } from "./remote.js";

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
const REMOTE_LEGACY_JSON_MAX_BYTES = 2 * 1024 * 1024;

export async function fetchRemotePluginStatus(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  fetcher: Fetcher = defaultFetch,
  options: RemotePluginRequestOptions = {},
): Promise<readonly RemotePluginStatusSummary[]> {
  const body = await remoteRequest(config, auth, "/plugins/list", "GET", fetcher, true, options);
  return validateRemotePluginStatusList(JSON.parse(body), "legacy remote plugin status response")
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
  options: RemotePluginRequestOptions = {},
): Promise<readonly string[]> {
  const query = product ? `?platform=${encodeURIComponent(product)}` : "";
  const body = await remoteRequest(config, auth, `/plugins/featured${query}`, "GET", fetcher, false, options);
  return validateRemoteFeaturedPluginIds(JSON.parse(body), "legacy remote featured plugin response");
}

export async function enableRemotePlugin(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  pluginId: string,
  fetcher: Fetcher = defaultFetch,
  options: RemotePluginRequestOptions = {},
): Promise<void> {
  const response = await postRemotePluginMutation(config, auth, pluginId, "enable", fetcher, options);
  assertMutation(pluginId, true, response);
}

export async function uninstallRemotePluginLegacy(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  pluginId: string,
  fetcher: Fetcher = defaultFetch,
  options: RemotePluginRequestOptions = {},
): Promise<void> {
  const response = await postRemotePluginMutation(config, auth, pluginId, "uninstall", fetcher, options);
  assertMutation(pluginId, false, response);
}

async function postRemotePluginMutation(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  pluginId: string,
  action: "enable" | "uninstall",
  fetcher: Fetcher,
  options: RemotePluginRequestOptions,
): Promise<RemotePluginMutationResponse> {
  const body = await remoteRequest(
    config,
    auth,
    `/plugins/${encodeURIComponent(pluginId)}/${action}`,
    "POST",
    fetcher,
    true,
    options,
  );
  return validateRemotePluginMutationResponse(
    JSON.parse(body),
    "legacy remote plugin mutation response",
  );
}

async function remoteRequest(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  path: string,
  method: "GET" | "POST",
  fetcher: Fetcher,
  requireAuth = true,
  options: RemotePluginRequestOptions = {},
): Promise<string> {
  if (requireAuth && auth === undefined) {
    throw new Error("authentication required for remote plugin operation");
  }
  const url = `${config.baseUrl.replace(/\/+$/u, "")}${path}`;
  assertHttpsOrLoopbackUrl(url, "legacy remote plugin API URL", {
    allowLoopbackHttp: options.allowLoopbackHttp === true,
  });
  const response = await fetchWithTimeout(
    fetcher,
    url,
    {
      method,
      ...(auth !== undefined ? { headers: auth.headers } : {}),
    },
    { label: `legacy remote plugin request to ${redactUrlForError(url)}` },
  );
  if (!response.ok) {
    const body = await readResponseErrorText(response);
    throw new Error(`remote plugin operation failed with status ${response.status} from ${redactUrlForError(url)}: ${body}`);
  }
  return readResponseTextWithLimit(
    response,
    REMOTE_LEGACY_JSON_MAX_BYTES,
    `legacy remote plugin request to ${redactUrlForError(url)}`,
  );
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

function validateRemotePluginStatusList(value: unknown, label: string): readonly RemotePluginStatusSummary[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => {
    const record = requireRecord(entry, `${label}[${index}]`);
    return {
      name: requireString(record.name, `${label}[${index}].name`),
      marketplaceName: record.marketplaceName !== undefined
        ? requireString(record.marketplaceName, `${label}[${index}].marketplaceName`)
        : DEFAULT_REMOTE_MARKETPLACE_NAME,
      enabled: requireBoolean(record.enabled, `${label}[${index}].enabled`),
    };
  });
}

function validateRemoteFeaturedPluginIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`));
}

function validateRemotePluginMutationResponse(value: unknown, label: string): RemotePluginMutationResponse {
  const record = requireRecord(value, label);
  return {
    id: requireString(record.id, `${label}.id`),
    enabled: requireBoolean(record.enabled, `${label}.enabled`),
  };
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}
