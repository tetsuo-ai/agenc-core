import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { isPlainRecord, stableJson, duplicateJsonObjectPaths, type JsonRecord } from "../../config/json.js";
import { mergeConfigLayerSnapshots } from "../../config/repository.js";
import { validateMcpServersConfig } from "../../config/schema.js";
import { validateMcpOAuthConfig } from "../../config/mcp-oauth.js";
import { mutateCanonicalUserConfigSync } from "../../config/update-sync.js";
import type { ProviderEnvironment } from "../../llm/provider-options.js";
import type { CanonicalSettingsAuthority } from "../../utils/settings/canonicalAuthority.js";
import { AgenCAuthProvider, clearMcpClientConfig } from "./auth.js";
import { getAllMcpConfigs, hasManagedMcpAuthority } from "./config.js";
import { authenticateMcp, McpAuthenticationError, mcpOAuthAuthenticated } from "./interactive-auth.js";
import type { ScopedMcpServerConfig } from "./types.js";

export const MCP_DESKTOP_CAPABILITIES = Object.freeze({
  schemaVersion: 1,
  capabilities: { inventory: true, upsert: true, setEnabled: true, authenticate: true, logout: true, oauth: true },
  transports: ["stdio", "http", "sse", "websocket"],
});

export class McpManagementError extends Error {
  constructor(message: string) { super(message); this.name = "McpManagementError"; }
}

interface ManagementContext {
  readonly authority: CanonicalSettingsAuthority;
  readonly environment: ProviderEnvironment;
  readonly pluginStorageRoot: string;
}

function revision(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function userServers(authority: CanonicalSettingsAuthority): Record<string, unknown> {
  return { ...mergeConfigLayerSnapshots(authority.sources("user"))?.mcp_servers };
}
async function resolveServers(context: ManagementContext) {
  const result = await getAllMcpConfigs(context.authority, { pluginStorageRoot: context.pluginStorageRoot, readOnly: true }, context.environment);
  return result;
}
function oauthRemote(config: ScopedMcpServerConfig) {
  return (config.type === "http" || config.type === "sse") && config.oauth !== undefined && config.oauth.xaa !== true;
}
function requireWritable(context: ManagementContext): void {
  if (hasManagedMcpAuthority(context.authority)) throw new McpManagementError("MCP configuration is managed and cannot be edited here.");
}

export async function mcpDesktopInventory(context: ManagementContext) {
  const result = await resolveServers(context);
  const raw = userServers(context.authority);
  const servers = Object.entries(result.servers).map(([name, config]) => {
    const authenticationSupported = oauthRemote(config);
    let authenticated = false;
    let authenticationUnavailable = false;
    if (authenticationSupported && (config.type === "http" || config.type === "sse")) {
      try { authenticated = mcpOAuthAuthenticated(context.authority.homeContext, name, config); }
      catch { authenticationUnavailable = true; }
    }
    const editable = config.scope === "user" && raw[name] !== undefined && !hasManagedMcpAuthority(context.authority);
    return {
      name, source: config.pluginSource ?? config.scope,
      ...(config.pluginServer === undefined ? {} : { pluginId: config.pluginServer.pluginName }),
      transport: config.type === undefined ? "stdio" : config.type,
      ...(config.type === undefined || config.type === "stdio" ? { command: config.command, args: config.args ?? [], env: Object.keys(config.env ?? {}).sort((left, right) => left.localeCompare(right, "en")).map((name) => ({ name, configured: true, sensitive: true })), envPassthrough: config.env_vars ?? [], ...(config.cwd ? { cwd: config.cwd } : {}) } : { ...("url" in config ? { url: config.url } : {}), args: [], env: [], envPassthrough: [] }),
      enabled: !("enabled" in config && config.enabled === false), editable,
      authenticationSupported, authenticated, needsAuthentication: authenticationSupported && !authenticated,
      ...(authenticationUnavailable ? { authenticationUnavailable: true } : {}),
      ...((config.type === "http" || config.type === "sse") && config.oauth !== undefined ? { oauth: config.oauth } : {}),
      ...(editable ? { revision: revision(raw[name]) } : {}),
    };
  });
  const loadErrors = result.errors.filter(error => error.type !== "mcp-server-suppressed-duplicate");
  return { schemaVersion: 1, servers, errors: loadErrors.length ? ["Some MCP definitions could not be loaded. Run MCP doctor for details."] : [] };
}

const PATCH_KEYS = new Set(["revision", "originalName", "name", "transport", "command", "args", "url", "env", "envPassthrough", "cwd", "oauth"]);
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 1024 && value.every((entry) => typeof entry === "string" && entry.length <= 32768 && !entry.includes("\0")); }
function safeName(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value) && !["__proto__", "prototype", "constructor"].includes(value); }
export function parseMcpDesktopPatch(text: string): JsonRecord {
  let raw: unknown;
  try { if (Buffer.byteLength(text) > 1024 * 1024 || duplicateJsonObjectPaths(text).length > 0) throw new Error(); raw = JSON.parse(text); }
  catch { throw new McpManagementError("MCP update must contain valid, bounded JSON without duplicate keys."); }
  if (!isPlainRecord(raw) || Object.keys(raw).some((key) => !PATCH_KEYS.has(key))) throw new McpManagementError("MCP update contains unsupported fields.");
  if (!safeName(raw.name) || (raw.originalName !== undefined && !safeName(raw.originalName))) throw new McpManagementError("MCP server name is invalid.");
  if (raw.revision !== undefined && (typeof raw.revision !== "string" || !/^[a-f0-9]{64}$/u.test(raw.revision))) throw new McpManagementError("MCP configuration revision is invalid.");
  if (!["stdio", "http", "sse"].includes(String(raw.transport)) || !strings(raw.args) || !strings(raw.envPassthrough) || !Array.isArray(raw.env) || raw.env.length > 1024) throw new McpManagementError("MCP update has invalid transport, arguments or environment.");
  for (const key of ["command", "url", "cwd"] as const) if (raw[key] !== undefined && (typeof raw[key] !== "string" || raw[key].length > 32768 || raw[key].includes("\0"))) throw new McpManagementError("MCP update contains an invalid text field.");
  const seen = new Set<string>();
  for (const entry of raw.env) {
    if (!isPlainRecord(entry) || Object.keys(entry).some((key) => !["name", "configured", "sensitive", "value"].includes(key)) || typeof entry.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.name) || seen.has(entry.name) || (entry.value !== undefined && (typeof entry.value !== "string" || entry.value.length > 32768 || entry.value.includes("\0")))) throw new McpManagementError("MCP update contains an invalid environment entry.");
    seen.add(entry.name);
    if (["__proto__", "prototype", "constructor"].includes(entry.name) || typeof entry.configured !== "boolean" || (entry.sensitive !== undefined && typeof entry.sensitive !== "boolean")) throw new McpManagementError("MCP update contains an invalid environment entry.");
  }
  if (raw.oauth !== undefined && raw.oauth !== null) validateMcpOAuthConfig(raw.oauth);
  return raw;
}

export async function readMcpDesktopPatch(input: Readable): Promise<JsonRecord> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 1024 * 1024) throw new McpManagementError("MCP update exceeds the size limit.");
    chunks.push(bytes);
  }
  return parseMcpDesktopPatch(Buffer.concat(chunks).toString("utf8"));
}

export async function upsertMcpDesktop(context: ManagementContext, patch: JsonRecord): Promise<void> {
  requireWritable(context);
  const name = patch.name as string;
  const originalName = (patch.originalName ?? name) as string;
  const resolved = await resolveServers(context);
  const existing = resolved.servers[originalName];
  if (existing && existing.scope !== "user") throw new McpManagementError("This MCP definition is read-only. Edit its owning configuration.");
  if (name !== originalName && resolved.servers[name]) throw new McpManagementError("An MCP server with that name already exists.");
  mutateCanonicalUserConfigSync(context.authority.homeContext.configTomlPath, (raw) => {
    const servers = isPlainRecord(raw.mcp_servers) ? { ...raw.mcp_servers } : {};
    const previous = isPlainRecord(servers[originalName]) ? servers[originalName] : undefined;
    if (previous ? patch.revision !== revision(previous) : patch.revision !== undefined || patch.originalName !== undefined) throw new McpManagementError("MCP configuration changed. Refresh and try again.");
    if (name !== originalName && servers[name] !== undefined) throw new McpManagementError("An MCP server with that name already exists.");
    const next: JsonRecord = { ...previous, transport: patch.transport };
    if (patch.transport === "stdio") {
      if (typeof patch.command !== "string" || !patch.command.trim()) throw new McpManagementError("A command is required for a stdio MCP server.");
      next.command = patch.command; next.args = patch.args; next.env_vars = patch.envPassthrough;
      const oldEnv = isPlainRecord(previous?.env) ? previous.env : {};
      next.env = Object.fromEntries((patch.env as JsonRecord[]).flatMap((entry) => {
        if (entry.configured === false) return [];
        const value = entry.value ?? oldEnv[entry.name as string];
        return value === undefined ? [] : [[entry.name, value]];
      }));
      if (patch.cwd) next.cwd = patch.cwd; else delete next.cwd;
      delete next.endpoint; delete next.headers; delete next.oauth;
    } else {
      if (typeof patch.url !== "string" || !patch.url.trim()) throw new McpManagementError("A URL is required for a remote MCP server.");
      const url = new URL(patch.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new McpManagementError("MCP URL must use HTTP or HTTPS without embedded credentials.");
      next.endpoint = patch.url;
      for (const key of ["command", "args", "env", "env_vars", "cwd"]) delete next[key];
      if (patch.oauth === null) delete next.oauth;
      else if (patch.oauth !== undefined) next.oauth = { ...patch.oauth as JsonRecord };
    }
    validateMcpServersConfig({ [name]: next });
    delete servers[originalName]; servers[name] = next; raw.mcp_servers = servers;
  });
  await context.authority.reload();
}

export async function setMcpDesktopEnabled(context: ManagementContext, name: string, enabled: boolean): Promise<void> {
  requireWritable(context);
  const server = (await resolveServers(context)).servers[name];
  if (!server) throw new McpManagementError("MCP server was not found.");
  if (server.scope !== "user" && server.pluginServer === undefined) throw new McpManagementError("This MCP definition is read-only.");
  const before = server.scope === "user" ? userServers(context.authority)[name] : undefined;
  mutateCanonicalUserConfigSync(context.authority.homeContext.configTomlPath, (raw) => {
    if (server.pluginServer) {
      const plugins = isPlainRecord(raw.plugins) ? { ...raw.plugins } : {};
      const entries = isPlainRecord(plugins.plugins) ? { ...plugins.plugins } : {};
      const previousPlugin = entries[server.pluginServer.pluginName];
      const plugin = isPlainRecord(previousPlugin) ? { ...previousPlugin } : {};
      const configs = isPlainRecord(plugin.mcp_servers) ? { ...plugin.mcp_servers } : {};
      const previousConfig = configs[server.pluginServer.serverName];
      configs[server.pluginServer.serverName] = { ...(isPlainRecord(previousConfig) ? previousConfig : {}), enabled };
      plugin.mcp_servers = configs; entries[server.pluginServer.pluginName] = plugin; plugins.plugins = entries; raw.plugins = plugins;
    } else {
      const servers = isPlainRecord(raw.mcp_servers) ? { ...raw.mcp_servers } : {};
      if (!isPlainRecord(servers[name]) || revision(servers[name]) !== revision(before)) throw new McpManagementError("MCP configuration changed. Refresh and try again.");
      servers[name] = { ...servers[name], enabled }; raw.mcp_servers = servers;
    }
  });
  await context.authority.reload();
}

export async function authenticateMcpDesktop(context: ManagementContext, name: string, signal?: AbortSignal): Promise<void> {
  const server = (await resolveServers(context)).servers[name];
  if (!server || !oauthRemote(server) || (server.type !== "http" && server.type !== "sse")) throw new McpManagementError("This MCP server does not support OAuth authentication.");
  await authenticateMcp({ home: context.authority.homeContext, name, config: server, environment: context.environment, signal });
}

export async function logoutMcpDesktop(context: ManagementContext, name: string): Promise<void> {
  const server = (await resolveServers(context)).servers[name];
  if (!server || (server.type !== "http" && server.type !== "sse") || server.oauth === undefined) throw new McpManagementError("This MCP server does not have an OAuth connection.");
  await new AgenCAuthProvider(context.authority.homeContext, name, server, context.environment).invalidateCredentials("all");
  clearMcpClientConfig(context.authority.homeContext, name, server);
}

export function safeMcpManagementError(error: unknown): string {
  return error instanceof McpManagementError || error instanceof McpAuthenticationError ? error.message : "MCP operation failed. Check the configuration and try again.";
}
