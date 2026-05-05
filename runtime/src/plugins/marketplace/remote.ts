import { rm } from "node:fs/promises";
import { join } from "node:path";
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

export const REMOTE_GLOBAL_MARKETPLACE_NAME = "agenc-global";
export const REMOTE_WORKSPACE_MARKETPLACE_NAME = "agenc-workspace";
export const REMOTE_GLOBAL_MARKETPLACE_DISPLAY_NAME = "AgenC Plugins";
export const REMOTE_WORKSPACE_MARKETPLACE_DISPLAY_NAME = "AgenC Workspace Plugins";

const REMOTE_PLUGIN_MAX_PAGES = 100;
const REMOTE_PLUGIN_MAX_ITEMS = 10_000;
const REMOTE_PLUGIN_JSON_MAX_BYTES = 2 * 1024 * 1024;

export interface RemotePluginServiceConfig {
  readonly baseUrl: string;
}

export interface RemoteAuth {
  readonly headers: Readonly<Record<string, string>>;
}

export interface RemoteMarketplace {
  readonly name: string;
  readonly displayName: string;
  readonly plugins: readonly RemotePluginSummary[];
}

export interface RemoteInstalledPlugin {
  readonly marketplaceName: string;
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}

export interface RemotePluginSummary {
  readonly id: string;
  readonly name: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly installPolicy: string;
  readonly authPolicy: string;
  readonly availability: string;
  readonly interface?: RemotePluginInterface;
}

export interface RemotePluginInterface {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly developerName?: string;
  readonly category?: string;
  readonly capabilities: readonly string[];
  readonly websiteUrl?: string;
  readonly privacyPolicyUrl?: string;
  readonly termsOfServiceUrl?: string;
  readonly defaultPrompt?: readonly string[];
  readonly brandColor?: string;
  readonly composerIconUrl?: string;
  readonly logoUrl?: string;
  readonly screenshotUrls: readonly string[];
}

export interface RemotePluginDetail {
  readonly marketplaceName: string;
  readonly marketplaceDisplayName: string;
  readonly summary: RemotePluginSummary;
  readonly description?: string;
  readonly releaseVersion?: string;
  readonly bundleDownloadUrl?: string;
  readonly skills: readonly RemotePluginSkill[];
  readonly appIds: readonly string[];
}

export interface RemotePluginSkill {
  readonly name: string;
  readonly description: string;
  readonly shortDescription?: string;
  readonly interface?: RemotePluginSkillInterface;
  readonly enabled: boolean;
}

export interface RemotePluginSkillInterface {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly brandColor?: string;
  readonly defaultPrompt?: string;
}

export interface RemotePluginSkillDetail {
  readonly contents?: string;
}

export function isValidRemotePluginId(pluginId: string): boolean {
  return pluginId.length > 0 &&
    [...pluginId].every((ch) => /[a-zA-Z0-9_\-~]/u.test(ch));
}

export function validateRemotePluginId(pluginId: string): void {
  if (!isValidRemotePluginId(pluginId)) {
    throw new Error("invalid remote plugin id: only ASCII letters, digits, `_`, `-`, and `~` are allowed");
  }
}

export async function fetchRemoteMarketplaces(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  fetcher: Fetcher = defaultFetch,
): Promise<readonly RemoteMarketplace[]> {
  const headers = requireRemoteAuth(auth);
  const byScope = await Promise.all(
    remoteScopes().map(async (scope) => {
      const [directory, installed] = await Promise.all([
        fetchDirectoryPluginsForScope(config, headers, scope, fetcher),
        fetchInstalledPluginsForScope(config, headers, scope, false, fetcher),
      ]);
      return { scope, directory, installed };
    }),
  );
  const marketplaces: RemoteMarketplace[] = [];
  for (const entry of byScope) {
    const directoryById = new Map(entry.directory.map((plugin) => [plugin.id, plugin]));
    const installedById = new Map(entry.installed.map((plugin) => [plugin.plugin.id, plugin]));
    const pluginIds = [...new Set([...directoryById.keys(), ...installedById.keys()])].sort();
    if (pluginIds.length === 0) continue;
    const plugins = pluginIds
      .map((pluginId) => {
        const directoryPlugin = directoryById.get(pluginId);
        const installedPlugin = installedById.get(pluginId);
        const plugin = directoryPlugin ?? installedPlugin?.plugin;
        return plugin ? buildRemotePluginSummary(plugin, installedPlugin) : null;
      })
      .filter((plugin): plugin is RemotePluginSummary => plugin !== null)
      .sort((a, b) =>
        remotePluginDisplayName(a)
          .toLowerCase()
          .localeCompare(remotePluginDisplayName(b).toLowerCase()) ||
        remotePluginDisplayName(a).localeCompare(remotePluginDisplayName(b)) ||
        a.id.localeCompare(b.id),
      );
    marketplaces.push({
      name: entry.scope.marketplaceName,
      displayName: entry.scope.displayName,
      plugins,
    });
  }
  return marketplaces;
}

export async function fetchRemoteInstalledPlugins(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  fetcher: Fetcher = defaultFetch,
): Promise<readonly RemoteInstalledPlugin[]> {
  const headers = requireRemoteAuth(auth);
  const results = await Promise.all(
    remoteScopes().map(async (scope) => ({
      scope,
      installed: await fetchInstalledPluginsForScope(config, headers, scope, false, fetcher),
    })),
  );
  return results
    .flatMap(({ scope, installed }) =>
      installed.map((plugin) => remoteInstalledPluginToInfo(scope, plugin)),
    )
    .sort((a, b) => a.marketplaceName.localeCompare(b.marketplaceName) || a.id.localeCompare(b.id));
}

export async function fetchRemotePluginDetail(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  marketplaceName: string,
  pluginId: string,
  fetcher: Fetcher = defaultFetch,
): Promise<RemotePluginDetail> {
  return fetchRemotePluginDetailWithDownloadUrls(config, auth, marketplaceName, pluginId, false, fetcher);
}

export async function fetchRemotePluginDetailWithDownloadUrls(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  marketplaceName: string,
  pluginId: string,
  includeDownloadUrls = true,
  fetcher: Fetcher = defaultFetch,
): Promise<RemotePluginDetail> {
  const headers = requireRemoteAuth(auth);
  const plugin = await fetchPluginDetail(config, headers, pluginId, includeDownloadUrls, fetcher);
  const scope = scopeFromMarketplaceName(plugin.scope) ?? scopeFromMarketplaceName(marketplaceName) ?? remoteScopes()[0]!;
  const installed = await fetchInstalledPluginsForScope(config, headers, scope, false, fetcher);
  const installedPlugin = installed.find((candidate) => candidate.plugin.id === pluginId);
  const disabledSkills = new Set(installedPlugin?.disabled_skill_names ?? []);
  return {
    marketplaceName: scope.marketplaceName,
    marketplaceDisplayName: scope.displayName,
    summary: buildRemotePluginSummary(plugin, installedPlugin),
    ...(nonEmptyString(plugin.release.description) !== undefined ? { description: nonEmptyString(plugin.release.description) } : {}),
    ...(nonEmptyString(plugin.release.version) !== undefined ? { releaseVersion: nonEmptyString(plugin.release.version) } : {}),
    ...(nonEmptyString(plugin.release.bundle_download_url) !== undefined ? { bundleDownloadUrl: nonEmptyString(plugin.release.bundle_download_url) } : {}),
    skills: plugin.release.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      ...(skill.interface?.short_description !== undefined ? { shortDescription: skill.interface.short_description } : {}),
      ...(remoteSkillInterfaceToInfo(skill.interface) !== undefined ? { interface: remoteSkillInterfaceToInfo(skill.interface) } : {}),
      enabled: !disabledSkills.has(skill.name),
    })),
    appIds: plugin.release.app_ids ?? [],
  };
}

export async function fetchRemotePluginSkillDetail(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  marketplaceName: string,
  pluginId: string,
  skillName: string,
  fetcher: Fetcher = defaultFetch,
): Promise<RemotePluginSkillDetail> {
  requireKnownMarketplace(marketplaceName);
  const headers = requireRemoteAuth(auth);
  const url = remotePluginSkillDetailUrl(config, pluginId, skillName);
  const response = validateRemotePluginSkillDetailResponse(
    await sendAndDecode(url, headers, fetcher),
    "remote plugin skill response",
  );
  if (response.plugin_id !== pluginId) {
    throw new Error(`remote plugin skill response returned unexpected plugin id: expected '${pluginId}', got '${response.plugin_id}'`);
  }
  if (response.name !== skillName) {
    throw new Error(`remote plugin skill response returned unexpected skill name: expected '${skillName}', got '${response.name}'`);
  }
  return {
    ...(response.skill_md_contents !== undefined ? { contents: response.skill_md_contents } : {}),
  };
}

export async function installRemotePlugin(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  pluginId: string,
  fetcher: Fetcher = defaultFetch,
): Promise<void> {
  const response = await postRemotePluginMutation(config, auth, pluginId, "install", fetcher);
  assertMutation(pluginId, true, response);
}

export async function uninstallRemotePlugin(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  agencHome: string,
  pluginId: string,
  fetcher: Fetcher = defaultFetch,
): Promise<void> {
  const detail = await fetchPluginDetail(config, requireRemoteAuth(auth), pluginId, false, fetcher);
  const response = await postRemotePluginMutation(config, auth, pluginId, "uninstall", fetcher);
  assertMutation(pluginId, false, response);
  await removeRemotePluginCache(agencHome, scopeFromMarketplaceName(detail.scope)?.marketplaceName ?? REMOTE_GLOBAL_MARKETPLACE_NAME, detail.name, pluginId);
}

async function postRemotePluginMutation(
  config: RemotePluginServiceConfig,
  auth: RemoteAuth | undefined,
  pluginId: string,
  action: "install" | "uninstall",
  fetcher: Fetcher,
): Promise<RemotePluginMutationResponse> {
  validateRemotePluginId(pluginId);
  const headers = requireRemoteAuth(auth);
  const url = `${config.baseUrl.replace(/\/+$/u, "")}/ps/plugins/${encodeURIComponent(pluginId)}/${action}`;
  return validateRemotePluginMutationResponse(
    await sendAndDecode(url, headers, fetcher, "POST"),
    "remote plugin mutation response",
  );
}

async function removeRemotePluginCache(
  agencHome: string,
  marketplaceName: string,
  pluginName: string,
  remotePluginId: string,
): Promise<void> {
  const candidates = [
    join(agencHome, "plugins", "cache", marketplaceName, pluginName),
    join(agencHome, "plugins", "cache", marketplaceName, remotePluginId),
  ];
  for (const candidate of candidates) {
    await rm(candidate, { recursive: true, force: true });
  }
}

async function fetchDirectoryPluginsForScope(
  config: RemotePluginServiceConfig,
  headers: Readonly<Record<string, string>>,
  scope: RemoteScope,
  fetcher: Fetcher,
): Promise<RemotePluginDirectoryItem[]> {
  const plugins: RemotePluginDirectoryItem[] = [];
  let pageToken: string | undefined;
  const seenTokens = new Set<string>();
  let pages = 0;
  do {
    pages += 1;
    if (pages > REMOTE_PLUGIN_MAX_PAGES) {
      throw new Error(`remote plugin directory pagination exceeded ${REMOTE_PLUGIN_MAX_PAGES} pages for ${scope.apiValue}`);
    }
    if (pageToken !== undefined) {
      if (seenTokens.has(pageToken)) {
        throw new Error(`remote plugin directory pagination repeated token '${pageToken}' for ${scope.apiValue}`);
      }
      seenTokens.add(pageToken);
    }
    const url = new URL(`${config.baseUrl.replace(/\/+$/u, "")}/ps/plugins/list`);
    url.searchParams.set("scope", scope.apiValue);
    url.searchParams.set("limit", "200");
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const response = validateRemotePluginListResponse(
      await sendAndDecode(url.toString(), headers, fetcher),
      "remote plugin directory response",
    );
    plugins.push(...response.plugins);
    if (plugins.length > REMOTE_PLUGIN_MAX_ITEMS) {
      throw new Error(`remote plugin directory exceeded ${REMOTE_PLUGIN_MAX_ITEMS} items for ${scope.apiValue}`);
    }
    pageToken = response.pagination.next_page_token;
  } while (pageToken !== undefined);
  return plugins;
}

async function fetchInstalledPluginsForScope(
  config: RemotePluginServiceConfig,
  headers: Readonly<Record<string, string>>,
  scope: RemoteScope,
  includeDownloadUrls: boolean,
  fetcher: Fetcher,
): Promise<RemotePluginInstalledItem[]> {
  const plugins: RemotePluginInstalledItem[] = [];
  let pageToken: string | undefined;
  const seenTokens = new Set<string>();
  let pages = 0;
  do {
    pages += 1;
    if (pages > REMOTE_PLUGIN_MAX_PAGES) {
      throw new Error(`remote installed plugin pagination exceeded ${REMOTE_PLUGIN_MAX_PAGES} pages for ${scope.apiValue}`);
    }
    if (pageToken !== undefined) {
      if (seenTokens.has(pageToken)) {
        throw new Error(`remote installed plugin pagination repeated token '${pageToken}' for ${scope.apiValue}`);
      }
      seenTokens.add(pageToken);
    }
    const url = new URL(`${config.baseUrl.replace(/\/+$/u, "")}/ps/plugins/installed`);
    url.searchParams.set("scope", scope.apiValue);
    if (includeDownloadUrls) url.searchParams.set("includeDownloadUrls", "true");
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const response = validateRemotePluginInstalledResponse(
      await sendAndDecode(url.toString(), headers, fetcher),
      "remote installed plugin response",
    );
    plugins.push(...response.plugins);
    if (plugins.length > REMOTE_PLUGIN_MAX_ITEMS) {
      throw new Error(`remote installed plugin list exceeded ${REMOTE_PLUGIN_MAX_ITEMS} items for ${scope.apiValue}`);
    }
    pageToken = response.pagination.next_page_token;
  } while (pageToken !== undefined);
  return plugins;
}

async function fetchPluginDetail(
  config: RemotePluginServiceConfig,
  headers: Readonly<Record<string, string>>,
  pluginId: string,
  includeDownloadUrls: boolean,
  fetcher: Fetcher,
): Promise<RemotePluginDirectoryItem> {
  validateRemotePluginId(pluginId);
  const url = new URL(`${config.baseUrl.replace(/\/+$/u, "")}/ps/plugins/${encodeURIComponent(pluginId)}`);
  if (includeDownloadUrls) url.searchParams.set("includeDownloadUrls", "true");
  return validateRemotePluginDirectoryItem(
    await sendAndDecode(url.toString(), headers, fetcher),
    "remote plugin detail response",
  );
}

async function sendAndDecode(
  url: string,
  headers: Readonly<Record<string, string>>,
  fetcher: Fetcher,
  method = "GET",
): Promise<unknown> {
  assertHttpsOrLoopbackUrl(url, "remote plugin API URL", { allowLoopbackHttp: true });
  const response = await fetchWithTimeout(
    fetcher,
    url,
    { method, headers },
    { label: `remote plugin request to ${redactUrlForError(url)}` },
  );
  if (!response.ok) {
    const body = await readResponseErrorText(response);
    throw new Error(`remote plugin request to ${redactUrlForError(url)} failed with status ${response.status}: ${body}`);
  }
  const body = await readResponseTextWithLimit(
    response,
    REMOTE_PLUGIN_JSON_MAX_BYTES,
    `remote plugin request to ${redactUrlForError(url)}`,
  );
  return JSON.parse(body);
}

function requireRemoteAuth(auth: RemoteAuth | undefined): Readonly<Record<string, string>> {
  if (auth === undefined) {
    throw new Error("authentication required for remote plugin catalog");
  }
  return auth.headers;
}

function requireKnownMarketplace(marketplaceName: string): void {
  if (scopeFromMarketplaceName(marketplaceName) === undefined) {
    throw new Error(`remote marketplace '${marketplaceName}' is not supported`);
  }
}

function assertMutation(pluginId: string, expectedEnabled: boolean, response: RemotePluginMutationResponse): void {
  if (response.id !== pluginId) {
    throw new Error(`remote plugin mutation returned unexpected plugin id: expected '${pluginId}', got '${response.id}'`);
  }
  if (response.enabled !== expectedEnabled) {
    throw new Error(`remote plugin mutation returned unexpected enabled state for '${pluginId}': expected ${expectedEnabled}, got ${response.enabled}`);
  }
}

function validateRemotePluginListResponse(value: unknown, label: string): RemotePluginListResponse {
  const record = requireRecord(value, label);
  if (!Array.isArray(record.plugins)) {
    throw new Error(`${label}.plugins must be an array`);
  }
  return {
    plugins: record.plugins.map((plugin, index) =>
      validateRemotePluginDirectoryItem(plugin, `${label}.plugins[${index}]`)),
    pagination: validateRemotePluginPagination(record.pagination, `${label}.pagination`),
  };
}

function validateRemotePluginInstalledResponse(value: unknown, label: string): RemotePluginInstalledResponse {
  const record = requireRecord(value, label);
  if (!Array.isArray(record.plugins)) {
    throw new Error(`${label}.plugins must be an array`);
  }
  return {
    plugins: record.plugins.map((plugin, index) =>
      validateRemotePluginInstalledItem(plugin, `${label}.plugins[${index}]`)),
    pagination: validateRemotePluginPagination(record.pagination, `${label}.pagination`),
  };
}

function validateRemotePluginDirectoryItem(value: unknown, label: string): RemotePluginDirectoryItem {
  const record = requireRecord(value, label);
  const scope = requireString(record.scope, `${label}.scope`);
  if (scope !== "GLOBAL" && scope !== "WORKSPACE") {
    throw new Error(`${label}.scope must be GLOBAL or WORKSPACE`);
  }
  return {
    id: requireString(record.id, `${label}.id`),
    name: requireString(record.name, `${label}.name`),
    scope,
    installation_policy: requireString(record.installation_policy, `${label}.installation_policy`),
    authentication_policy: requireString(record.authentication_policy, `${label}.authentication_policy`),
    ...(record.status !== undefined ? { status: requireString(record.status, `${label}.status`) } : {}),
    release: validateRemotePluginRelease(record.release, `${label}.release`),
  };
}

function validateRemotePluginInstalledItem(value: unknown, label: string): RemotePluginInstalledItem {
  const record = requireRecord(value, label);
  return {
    plugin: validateRemotePluginDirectoryItem(record.plugin, `${label}.plugin`),
    enabled: requireBoolean(record.enabled, `${label}.enabled`),
    ...(record.disabled_skill_names !== undefined
      ? { disabled_skill_names: requireStringArray(record.disabled_skill_names, `${label}.disabled_skill_names`) }
      : {}),
  };
}

function validateRemotePluginRelease(value: unknown, label: string): RemotePluginReleaseResponse {
  const record = requireRecord(value, label);
  return {
    ...(record.version !== undefined ? { version: requireString(record.version, `${label}.version`) } : {}),
    display_name: requireString(record.display_name, `${label}.display_name`),
    description: requireString(record.description, `${label}.description`),
    ...(record.bundle_download_url !== undefined
      ? { bundle_download_url: requireString(record.bundle_download_url, `${label}.bundle_download_url`) }
      : {}),
    ...(record.app_ids !== undefined ? { app_ids: requireStringArray(record.app_ids, `${label}.app_ids`) } : {}),
    interface: validateRemotePluginReleaseInterface(record.interface, `${label}.interface`),
    skills: validateRemotePluginSkills(record.skills, `${label}.skills`),
  };
}

function validateRemotePluginReleaseInterface(value: unknown, label: string): RemotePluginReleaseInterfaceResponse {
  const record = requireRecord(value, label);
  return {
    ...(record.short_description !== undefined ? { short_description: requireString(record.short_description, `${label}.short_description`) } : {}),
    ...(record.long_description !== undefined ? { long_description: requireString(record.long_description, `${label}.long_description`) } : {}),
    ...(record.developer_name !== undefined ? { developer_name: requireString(record.developer_name, `${label}.developer_name`) } : {}),
    ...(record.category !== undefined ? { category: requireString(record.category, `${label}.category`) } : {}),
    ...(record.capabilities !== undefined ? { capabilities: requireStringArray(record.capabilities, `${label}.capabilities`) } : {}),
    ...(record.website_url !== undefined ? { website_url: requireString(record.website_url, `${label}.website_url`) } : {}),
    ...(record.privacy_policy_url !== undefined ? { privacy_policy_url: requireString(record.privacy_policy_url, `${label}.privacy_policy_url`) } : {}),
    ...(record.terms_of_service_url !== undefined ? { terms_of_service_url: requireString(record.terms_of_service_url, `${label}.terms_of_service_url`) } : {}),
    ...(record.brand_color !== undefined ? { brand_color: requireString(record.brand_color, `${label}.brand_color`) } : {}),
    ...(record.default_prompt !== undefined ? { default_prompt: requireString(record.default_prompt, `${label}.default_prompt`) } : {}),
    ...(record.composer_icon_url !== undefined ? { composer_icon_url: requireString(record.composer_icon_url, `${label}.composer_icon_url`) } : {}),
    ...(record.logo_url !== undefined ? { logo_url: requireString(record.logo_url, `${label}.logo_url`) } : {}),
    ...(record.screenshot_urls !== undefined ? { screenshot_urls: requireStringArray(record.screenshot_urls, `${label}.screenshot_urls`) } : {}),
  };
}

function validateRemotePluginSkills(value: unknown, label: string): readonly RemotePluginSkillResponse[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((skill, index) => {
    const record = requireRecord(skill, `${label}[${index}]`);
    return {
      name: requireString(record.name, `${label}[${index}].name`),
      description: requireString(record.description, `${label}[${index}].description`),
      ...(record.interface !== undefined
        ? { interface: validateRemotePluginSkillInterface(record.interface, `${label}[${index}].interface`) }
        : {}),
    };
  });
}

function validateRemotePluginSkillInterface(value: unknown, label: string): RemotePluginSkillInterfaceResponse {
  const record = requireRecord(value, label);
  return {
    ...(record.display_name !== undefined ? { display_name: requireString(record.display_name, `${label}.display_name`) } : {}),
    ...(record.short_description !== undefined ? { short_description: requireString(record.short_description, `${label}.short_description`) } : {}),
    ...(record.brand_color !== undefined ? { brand_color: requireString(record.brand_color, `${label}.brand_color`) } : {}),
    ...(record.default_prompt !== undefined ? { default_prompt: requireString(record.default_prompt, `${label}.default_prompt`) } : {}),
  };
}

function validateRemotePluginPagination(value: unknown, label: string): RemotePluginPagination {
  const record = requireRecord(value, label);
  return {
    ...(record.next_page_token !== undefined
      ? { next_page_token: requireString(record.next_page_token, `${label}.next_page_token`) }
      : {}),
  };
}

function validateRemotePluginSkillDetailResponse(value: unknown, label: string): RemotePluginSkillDetailResponse {
  const record = requireRecord(value, label);
  return {
    plugin_id: requireString(record.plugin_id, `${label}.plugin_id`),
    name: requireString(record.name, `${label}.name`),
    ...(record.skill_md_contents !== undefined
      ? { skill_md_contents: requireString(record.skill_md_contents, `${label}.skill_md_contents`) }
      : {}),
  };
}

function validateRemotePluginMutationResponse(value: unknown, label: string): RemotePluginMutationResponse {
  const record = requireRecord(value, label);
  return {
    id: requireString(record.id, `${label}.id`),
    enabled: requireBoolean(record.enabled, `${label}.enabled`),
  };
}

function buildRemotePluginSummary(
  plugin: RemotePluginDirectoryItem,
  installedPlugin: RemotePluginInstalledItem | undefined,
): RemotePluginSummary {
  return {
    id: plugin.id,
    name: plugin.name,
    installed: installedPlugin !== undefined,
    enabled: installedPlugin?.enabled === true,
    installPolicy: plugin.installation_policy,
    authPolicy: plugin.authentication_policy,
    availability: plugin.status ?? "AVAILABLE",
    ...(remotePluginInterfaceToInfo(plugin) !== undefined ? { interface: remotePluginInterfaceToInfo(plugin) } : {}),
  };
}

function remoteInstalledPluginToInfo(
  scope: RemoteScope,
  installedPlugin: RemotePluginInstalledItem,
): RemoteInstalledPlugin {
  return {
    marketplaceName: scope.marketplaceName,
    id: installedPlugin.plugin.id,
    name: installedPlugin.plugin.name,
    enabled: installedPlugin.enabled,
  };
}

function remotePluginInterfaceToInfo(plugin: RemotePluginDirectoryItem): RemotePluginInterface | undefined {
  const iface = plugin.release.interface;
  const defaultPrompt = normalizeRemoteDefaultPrompt(iface.default_prompt);
  const result: RemotePluginInterface = {
    capabilities: iface.capabilities ?? [],
    screenshotUrls: iface.screenshot_urls ?? [],
    ...(nonEmptyString(plugin.release.display_name) !== undefined ? { displayName: nonEmptyString(plugin.release.display_name) } : {}),
    ...(nonEmptyString(iface.short_description) !== undefined ? { shortDescription: nonEmptyString(iface.short_description) } : {}),
    ...(nonEmptyString(iface.long_description) !== undefined ? { longDescription: nonEmptyString(iface.long_description) } : {}),
    ...(nonEmptyString(iface.developer_name) !== undefined ? { developerName: nonEmptyString(iface.developer_name) } : {}),
    ...(nonEmptyString(iface.category) !== undefined ? { category: nonEmptyString(iface.category) } : {}),
    ...(nonEmptyString(iface.website_url) !== undefined ? { websiteUrl: nonEmptyString(iface.website_url) } : {}),
    ...(nonEmptyString(iface.privacy_policy_url) !== undefined ? { privacyPolicyUrl: nonEmptyString(iface.privacy_policy_url) } : {}),
    ...(nonEmptyString(iface.terms_of_service_url) !== undefined ? { termsOfServiceUrl: nonEmptyString(iface.terms_of_service_url) } : {}),
    ...(defaultPrompt !== undefined ? { defaultPrompt } : {}),
    ...(nonEmptyString(iface.brand_color) !== undefined ? { brandColor: nonEmptyString(iface.brand_color) } : {}),
    ...(nonEmptyString(iface.composer_icon_url) !== undefined ? { composerIconUrl: nonEmptyString(iface.composer_icon_url) } : {}),
    ...(nonEmptyString(iface.logo_url) !== undefined ? { logoUrl: nonEmptyString(iface.logo_url) } : {}),
  };
  const hasFields = result.displayName !== undefined ||
    result.shortDescription !== undefined ||
    result.longDescription !== undefined ||
    result.developerName !== undefined ||
    result.category !== undefined ||
    result.capabilities.length > 0 ||
    result.websiteUrl !== undefined ||
    result.privacyPolicyUrl !== undefined ||
    result.termsOfServiceUrl !== undefined ||
    result.defaultPrompt !== undefined ||
    result.brandColor !== undefined ||
    result.composerIconUrl !== undefined ||
    result.logoUrl !== undefined ||
    result.screenshotUrls.length > 0;
  return hasFields ? result : undefined;
}

function remoteSkillInterfaceToInfo(
  iface: RemotePluginSkillInterfaceResponse | undefined,
): RemotePluginSkillInterface | undefined {
  if (iface === undefined) return undefined;
  const result: RemotePluginSkillInterface = {
    ...(nonEmptyString(iface.display_name) !== undefined ? { displayName: nonEmptyString(iface.display_name) } : {}),
    ...(nonEmptyString(iface.short_description) !== undefined ? { shortDescription: nonEmptyString(iface.short_description) } : {}),
    ...(nonEmptyString(iface.brand_color) !== undefined ? { brandColor: nonEmptyString(iface.brand_color) } : {}),
    ...(nonEmptyString(iface.default_prompt) !== undefined ? { defaultPrompt: nonEmptyString(iface.default_prompt) } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function remotePluginDisplayName(plugin: RemotePluginSummary): string {
  return plugin.interface?.displayName ?? plugin.name;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRemoteDefaultPrompt(prompt: string | undefined): readonly string[] | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed || [...trimmed].length > 128) return undefined;
  return [trimmed];
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

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function remotePluginSkillDetailUrl(
  config: RemotePluginServiceConfig,
  pluginId: string,
  skillName: string,
): string {
  const url = new URL(config.baseUrl.replace(/\/+$/u, ""));
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/ps/plugins/${encodeURIComponent(pluginId)}/skills/${encodeURIComponent(skillName)}`;
  return url.toString();
}

function remoteScopes(): readonly RemoteScope[] {
  return [
    {
      apiValue: "GLOBAL",
      marketplaceName: REMOTE_GLOBAL_MARKETPLACE_NAME,
      displayName: REMOTE_GLOBAL_MARKETPLACE_DISPLAY_NAME,
    },
    {
      apiValue: "WORKSPACE",
      marketplaceName: REMOTE_WORKSPACE_MARKETPLACE_NAME,
      displayName: REMOTE_WORKSPACE_MARKETPLACE_DISPLAY_NAME,
    },
  ];
}

function scopeFromMarketplaceName(name: string): RemoteScope | undefined {
  return remoteScopes().find((scope) => scope.marketplaceName === name || scope.apiValue === name);
}

interface RemoteScope {
  readonly apiValue: "GLOBAL" | "WORKSPACE";
  readonly marketplaceName: string;
  readonly displayName: string;
}

interface RemotePluginPagination {
  readonly next_page_token?: string;
}

interface RemotePluginSkillInterfaceResponse {
  readonly display_name?: string;
  readonly short_description?: string;
  readonly brand_color?: string;
  readonly default_prompt?: string;
}

interface RemotePluginSkillResponse {
  readonly name: string;
  readonly description: string;
  readonly interface?: RemotePluginSkillInterfaceResponse;
}

interface RemotePluginSkillDetailResponse {
  readonly plugin_id: string;
  readonly name: string;
  readonly skill_md_contents?: string;
}

interface RemotePluginReleaseInterfaceResponse {
  readonly short_description?: string;
  readonly long_description?: string;
  readonly developer_name?: string;
  readonly category?: string;
  readonly capabilities?: readonly string[];
  readonly website_url?: string;
  readonly privacy_policy_url?: string;
  readonly terms_of_service_url?: string;
  readonly brand_color?: string;
  readonly default_prompt?: string;
  readonly composer_icon_url?: string;
  readonly logo_url?: string;
  readonly screenshot_urls?: readonly string[];
}

interface RemotePluginReleaseResponse {
  readonly version?: string;
  readonly display_name: string;
  readonly description: string;
  readonly bundle_download_url?: string;
  readonly app_ids?: readonly string[];
  readonly interface: RemotePluginReleaseInterfaceResponse;
  readonly skills: readonly RemotePluginSkillResponse[];
}

interface RemotePluginDirectoryItem {
  readonly id: string;
  readonly name: string;
  readonly scope: "GLOBAL" | "WORKSPACE";
  readonly installation_policy: string;
  readonly authentication_policy: string;
  readonly status?: string;
  readonly release: RemotePluginReleaseResponse;
}

interface RemotePluginInstalledItem {
  readonly plugin: RemotePluginDirectoryItem;
  readonly enabled: boolean;
  readonly disabled_skill_names?: readonly string[];
}

interface RemotePluginListResponse {
  readonly plugins: readonly RemotePluginDirectoryItem[];
  readonly pagination: RemotePluginPagination;
}

interface RemotePluginInstalledResponse {
  readonly plugins: readonly RemotePluginInstalledItem[];
  readonly pagination: RemotePluginPagination;
}

interface RemotePluginMutationResponse {
  readonly id: string;
  readonly enabled: boolean;
}
