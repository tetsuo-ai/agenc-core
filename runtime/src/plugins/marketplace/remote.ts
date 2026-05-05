import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultFetch,
  type Fetcher,
} from "./marketplace.js";

export const REMOTE_GLOBAL_MARKETPLACE_NAME = "agenc-global";
export const REMOTE_WORKSPACE_MARKETPLACE_NAME = "agenc-workspace";
export const REMOTE_GLOBAL_MARKETPLACE_DISPLAY_NAME = "AgenC Plugins";
export const REMOTE_WORKSPACE_MARKETPLACE_DISPLAY_NAME = "AgenC Workspace Plugins";

const REMOTE_PLUGIN_MAX_PAGES = 100;
const REMOTE_PLUGIN_MAX_ITEMS = 10_000;

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
  const response = await sendAndDecode<RemotePluginSkillDetailResponse>(url, headers, fetcher);
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
  return sendAndDecode<RemotePluginMutationResponse>(url, headers, fetcher, "POST");
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
    const response = await sendAndDecode<RemotePluginListResponse>(url.toString(), headers, fetcher);
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
    const response = await sendAndDecode<RemotePluginInstalledResponse>(url.toString(), headers, fetcher);
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
  return sendAndDecode<RemotePluginDirectoryItem>(url.toString(), headers, fetcher);
}

async function sendAndDecode<T>(
  url: string,
  headers: Readonly<Record<string, string>>,
  fetcher: Fetcher,
  method = "GET",
): Promise<T> {
  const response = await fetcher(url, { method, headers });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`remote plugin request to ${url} failed with status ${response.status}: ${body}`);
  }
  return JSON.parse(body) as T;
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
