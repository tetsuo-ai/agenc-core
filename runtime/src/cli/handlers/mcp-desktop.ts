/**
 * Structured, non-interactive MCP management for AgenC Desktop.
 *
 * The renderer is deliberately given a redacted projection. Mutations come
 * back as bounded PATCH documents and are merged here, where the original
 * secret-bearing configuration is still available.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

import {
  parseFiniteJsonBytes,
  type FiniteJsonValue,
} from "../../agents/workflow-finite-json.js";
import { stableJson } from "../../config/json.js";
import { resolveAgencHome } from "../../config/env.js";
import { loadConfig } from "../../config/loader.js";
import type {
  AgenCConfig,
  McpServerConfig as RuntimePluginMcpServerConfig,
} from "../../config/schema.js";
import { pluginScopedServerIdentifier } from "../../plugins/identifier-normalization.js";
import { loadPlugins, type LoadedPlugin } from "../../plugins/loader.js";
import { loadPluginMcpServers as loadRegisteredPluginMcpServers } from "../../plugins/registration/mcp-plugin-integration.js";
import {
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getMcpConfigsByScope,
  isMcpServerDisabled,
  setMcpServerEnabled,
} from "../../services/mcp/config.js";
import type {
  McpHTTPServerConfig,
  McpServerConfig,
  McpSSEServerConfig,
  ScopedMcpServerConfig,
} from "../../services/mcp/types.js";
import { McpServerConfigSchema } from "../../services/mcp/types.js";
import { upsertUserMcpServerInToml } from "../../services/mcp/user-config-toml.js";
import { isRestrictedToPluginOnly } from "../../utils/settings/pluginOnlyPolicy.js";

const SCHEMA_VERSION = 1 as const;
export const MAX_MCP_DESKTOP_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_NAME_LENGTH = 128;
const MAX_PATH_LENGTH = 4096;
const MAX_ARGUMENT_LENGTH = 8192;
const MAX_ENV_VALUE_LENGTH = 65_536;
const MAX_ARRAY_ENTRIES = 128;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const NUL = /\u0000/u;
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MCP_OPERATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CANONICAL_PLUGIN_ID = /^(?:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9][A-Za-z0-9._-]*)(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_URL_KEY = /(?:api[_-]?key|access[_-]?token|auth|bearer|code|credential|password|secret|signature|token)/iu;
const SENSITIVE_ARGUMENT_FLAG = /^--?(?:api[_-]?key|access[_-]?token|auth|bearer|client[_-]?secret|credential|password|secret|signature|token)$/iu;
const HEADER_ARGUMENT_FLAG = /^(?:--header|--headers|-H)$/u;
const ENV_ARGUMENT_FLAG = /^(?:--env|--env-var|-e)$/u;
const TOKEN_LIKE_ARGUMENT = /^(?:Bearer\s+|Basic\s+|sk-|gh[pousr]_|xox[baprs]-|eyJ)[A-Za-z0-9._~+/=-]{6,}$/iu;
const LONG_OPAQUE_ARGUMENT = /^(?=.{20,}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9._~+/=-]+$/u;
const REDACTED_URL_VALUE = "[REDACTED]";
const INSTALLED_PLUGIN_METADATA = ".agenc-plugin/agenc-install.json";

export interface McpDesktopIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface McpDesktopEnvironmentPatch {
  readonly name: string;
  readonly configured: boolean;
  readonly value?: string;
  readonly sensitive?: boolean;
}

export interface McpDesktopUpsertRequest {
  readonly revision?: string;
  readonly originalName?: string;
  readonly name: string;
  readonly transport: "stdio" | "http" | "sse";
  readonly command?: string;
  readonly args: readonly string[];
  readonly url?: string;
  readonly env: readonly McpDesktopEnvironmentPatch[];
  readonly envPassthrough: readonly string[];
  readonly cwd?: string;
}

export interface McpDesktopServer {
  readonly name: string;
  readonly source: string;
  readonly scope: string;
  readonly pluginId?: string;
  readonly transport: "stdio" | "http" | "sse" | "unknown";
  readonly command?: string;
  readonly args: readonly string[];
  readonly url?: string;
  readonly env: readonly {
    readonly name: string;
    readonly configured: true;
    readonly sensitive: true;
  }[];
  readonly envPassthrough: readonly string[];
  readonly cwd?: string;
  readonly enabled: boolean;
  /** Compatibility mirror for older Desktop inventory parsers. */
  readonly disabled: boolean;
  readonly authenticated: boolean;
  readonly needsAuthentication: boolean;
  readonly editable: boolean;
  readonly revision: string;
}

export interface McpDesktopDependencies {
  readonly loadConfigs: () => Promise<
    Readonly<Record<string, ScopedMcpServerConfig>>
  >;
  readonly persistUserConfig: (
    originalName: string | undefined,
    name: string,
    config: McpServerConfig,
  ) => Promise<void>;
  readonly setEnabled: (name: string, enabled: boolean) => void;
  readonly isDisabled: (name: string) => boolean;
  readonly needsAuthentication: (name: string) => Promise<boolean>;
  readonly authenticate: (
    name: string,
    config: McpSSEServerConfig | McpHTTPServerConfig,
  ) => Promise<void>;
  readonly enterpriseConfigActive: () => boolean;
  readonly policyAllows: (name: string, config: McpServerConfig) => boolean;
}

export class McpDesktopCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpDesktopCommandError";
  }
}

const defaultDependencies: McpDesktopDependencies = {
  async loadConfigs() {
    // Cache-only plugin loading plus local config reads. Do not reuse the live
    // runtime merger here: it resolves user_config through secure storage and
    // may resolve MCPB sources. Config inspection must remain file-only.
    const { servers: enterprise } = getMcpConfigsByScope("enterprise");
    if (doesEnterpriseMcpConfigExist()) {
      return filterMcpServersByPolicy(enterprise).allowed;
    }

    const pluginServers = await loadInstalledPluginMcpConfigsOnly();

    const pluginOnly = isRestrictedToPluginOnly("mcp");
    const user = pluginOnly ? {} : getMcpConfigsByScope("user").servers;
    const project = pluginOnly ? {} : getMcpConfigsByScope("project").servers;
    const local = pluginOnly ? {} : getMcpConfigsByScope("local").servers;
    return filterMcpServersByPolicy({
      ...pluginServers,
      ...user,
      ...project,
      ...local,
    }).allowed;
  },
  persistUserConfig: upsertUserMcpServerInToml,
  setEnabled: setMcpServerEnabled,
  isDisabled: isMcpServerDisabled,
  async needsAuthentication(name) {
    const { isMcpAuthCached } = await import("../../services/mcp/client.js");
    return isMcpAuthCached(name);
  },
  async authenticate(name, config) {
    const { performMCPOAuthFlow } = await import(
      "../../services/mcp/auth.js"
    );
    await performMCPOAuthFlow(name, config, () => {});
    const { clearMcpAuthCache } = await import(
      "../../services/mcp/client.js"
    );
    clearMcpAuthCache();
  },
  enterpriseConfigActive: doesEnterpriseMcpConfigExist,
  policyAllows(name, config) {
    return filterMcpServersByPolicy({ [name]: config }).blocked.length === 0;
  },
};

export interface McpDesktopPluginLoadOptions {
  readonly agencHome?: string;
  readonly workspaceRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: Pick<AgenCConfig, "plugins" | "enabledPlugins">;
}

/**
 * Read installed new-stack plugins and project their MCP declarations without
 * network access, process launches, secure-storage reads, or sandbox data-dir
 * creation. This is intentionally separate from live session registration.
 */
export async function loadInstalledPluginMcpConfigsOnly(
  options: McpDesktopPluginLoadOptions = {},
): Promise<Readonly<Record<string, ScopedMcpServerConfig>>> {
  const env = options.env ?? process.env;
  const agencHome = options.agencHome ?? resolveAgencHome(env);
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const config = options.config ?? (await loadConfig({ home: agencHome })).config;
  const loaded = await loadPlugins({ agencHome, workspaceRoot, config });
  const projected: Record<string, ScopedMcpServerConfig> = {};
  for (const plugin of loaded.enabled) {
    const registered = await loadRegisteredPluginMcpServers({
      plugins: [plugin],
      configOnly: true,
      env: {},
    });
    const pluginId = await installedPluginId(plugin);
    for (const [name, server] of Object.entries(registered)) {
      const serverName = pluginServerName(plugin, name);
      const config = pluginMcpConfigForDesktop(server);
      if (config === undefined) continue;
      projected[name] = {
        ...config,
        scope: "dynamic",
        pluginSource: pluginId,
        pluginServer: {
          pluginName: plugin.name,
          serverName,
        },
      };
    }
  }
  return projected;
}

async function installedPluginId(plugin: LoadedPlugin): Promise<string> {
  try {
    const parsed = JSON.parse(
      await readFile(`${plugin.root}/${INSTALLED_PLUGIN_METADATA}`, "utf8"),
    ) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { readonly id?: unknown }).id === "string" &&
      (parsed as { readonly id: string }).id.trim().length > 0
    ) {
      return (parsed as { readonly id: string }).id;
    }
  } catch {
    // Legacy/local plugin installs predate canonical install metadata.
  }
  return plugin.name;
}

function pluginServerName(plugin: LoadedPlugin, scopedName: string): string {
  for (const serverName of Object.keys(plugin.mcpServers)) {
    if (pluginScopedServerIdentifier(plugin.name, serverName) === scopedName) {
      return serverName;
    }
  }
  return scopedName;
}

function pluginMcpConfigForDesktop(
  server: RuntimePluginMcpServerConfig,
): McpServerConfig | undefined {
  const common = {
    ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
    ...(server.required !== undefined ? { required: server.required } : {}),
    ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
    ...(server.default_tools_approval_mode !== undefined
      ? { default_tools_approval_mode: server.default_tools_approval_mode }
      : {}),
    ...(server.enabled_tools !== undefined ? { enabled_tools: [...server.enabled_tools] } : {}),
    ...(server.disabled_tools !== undefined ? { disabled_tools: [...server.disabled_tools] } : {}),
    ...(server.tools !== undefined ? { tools: server.tools } : {}),
  };
  if (server.endpoint !== undefined) {
    const type = server.transport === "sse"
      ? "sse"
      : server.transport === "websocket" || server.transport === "ws"
        ? "ws"
        : "http";
    return {
      ...common,
      type,
      url: server.endpoint,
      ...(server.headers !== undefined ? { headers: server.headers } : {}),
    } as McpServerConfig;
  }
  if (server.command === undefined) return undefined;
  return {
    ...common,
    type: "stdio",
    command: server.command,
    args: [...(server.args ?? [])],
    ...(server.env !== undefined ? { env: server.env } : {}),
    ...(server.env_vars !== undefined ? { env_vars: [...server.env_vars] } : {}),
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
  } as McpServerConfig;
}

function jsonEnvelope(result: unknown): string {
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: true, result })}\n`;
}

export function writeMcpDesktopErrorEnvelope(
  io: Pick<McpDesktopIo, "stdout">,
  error: unknown,
): void {
  const safe =
    error instanceof McpDesktopCommandError
      ? error
      : new McpDesktopCommandError(
          "MCP_COMMAND_FAILED",
          "The MCP management command failed",
        );
  io.stdout.write(
    `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      error: { code: safe.code, message: safe.message },
    })}\n`,
  );
}

function transportOf(
  config: McpServerConfig,
): McpDesktopServer["transport"] {
  switch (config.type) {
    case undefined:
    case "stdio":
      return "stdio";
    case "http":
    case "sse":
      return config.type;
    default:
      return "unknown";
  }
}

function redactMcpUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username.length > 0) parsed.username = REDACTED_URL_VALUE;
    if (parsed.password.length > 0) parsed.password = REDACTED_URL_VALUE;
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_URL_KEY.test(key)) {
        parsed.searchParams.set(key, REDACTED_URL_VALUE);
      }
    }
    if (parsed.hash.length > 0) parsed.hash = `#${REDACTED_URL_VALUE}`;
    return parsed.toString();
  } catch {
    // Invalid URLs cannot be created by the validated user config schema, but
    // managed/internal definitions may be more permissive. Never echo one.
    return REDACTED_URL_VALUE;
  }
}

function isRedactedUrlValue(value: string): boolean {
  if (value === REDACTED_URL_VALUE) return true;
  try {
    return decodeURIComponent(value) === REDACTED_URL_VALUE;
  } catch {
    return false;
  }
}

function restoreRedactedMcpUrl(
  existingValue: string,
  requestedValue: string,
): string {
  if (requestedValue === redactMcpUrl(existingValue)) return existingValue;
  try {
    const existing = new URL(existingValue);
    const requested = new URL(requestedValue);
    // Never carry a credential to another authority.
    if (existing.origin !== requested.origin) return requestedValue;
    if (isRedactedUrlValue(requested.username)) {
      requested.username = existing.username;
    }
    if (isRedactedUrlValue(requested.password)) {
      requested.password = existing.password;
    }
    for (const key of [...requested.searchParams.keys()]) {
      if (!SENSITIVE_URL_KEY.test(key)) continue;
      const values = requested.searchParams.getAll(key);
      if (!values.every(isRedactedUrlValue)) continue;
      const originals = existing.searchParams.getAll(key);
      requested.searchParams.delete(key);
      for (const original of originals) requested.searchParams.append(key, original);
    }
    if (
      requested.hash.length > 0 &&
      isRedactedUrlValue(requested.hash.slice(1))
    ) {
      requested.hash = existing.hash;
    }
    return requested.toString();
  } catch {
    return requestedValue;
  }
}

function redactMcpArguments(values: readonly string[]): readonly string[] {
  let nextValue: "secret" | "header" | "env" | undefined;
  return values.map((value) => {
    if (nextValue !== undefined) {
      const mode = nextValue;
      nextValue = undefined;
      return mode === "header"
        ? redactHeaderArgument(value)
        : mode === "env"
          ? redactEnvironmentArgument(value)
          : REDACTED_URL_VALUE;
    }
    const separator = value.indexOf("=");
    const flag = separator === -1 ? value : value.slice(0, separator);
    if (SENSITIVE_ARGUMENT_FLAG.test(flag)) {
      if (separator !== -1) {
        return `${flag}=${REDACTED_URL_VALUE}`;
      }
      nextValue = "secret";
      return value;
    }
    if (HEADER_ARGUMENT_FLAG.test(flag)) {
      if (separator !== -1) {
        return `${flag}=${redactHeaderArgument(value.slice(separator + 1))}`;
      }
      nextValue = "header";
      return value;
    }
    if (ENV_ARGUMENT_FLAG.test(flag)) {
      if (separator !== -1) {
        return `${flag}=${redactEnvironmentArgument(value.slice(separator + 1))}`;
      }
      nextValue = "env";
      return value;
    }
    if (value.startsWith("-H") && value.length > 2) {
      return `-H${redactHeaderArgument(value.slice(2))}`;
    }
    if (value.startsWith("-e") && value.length > 2 && value.slice(2).includes("=")) {
      return `-e${redactEnvironmentArgument(value.slice(2))}`;
    }
    const url = redactArgumentUrl(value);
    if (url !== undefined) return url;
    if (looksLikeEnvironmentAssignment(value)) {
      return redactEnvironmentArgument(value);
    }
    if (TOKEN_LIKE_ARGUMENT.test(value) || LONG_OPAQUE_ARGUMENT.test(value)) {
      return REDACTED_URL_VALUE;
    }
    return value;
  });
}

function redactHeaderArgument(value: string): string {
  const separator = value.indexOf(":");
  if (separator > 0) {
    const name = value.slice(0, separator).trim();
    if (/^[A-Za-z0-9-]+$/u.test(name)) {
      return `${name}: ${REDACTED_URL_VALUE}`;
    }
  }
  return REDACTED_URL_VALUE;
}

function redactEnvironmentArgument(value: string): string {
  const separator = value.indexOf("=");
  if (separator > 0) {
    const name = value.slice(0, separator);
    if (ENV_NAME.test(name)) {
      return `${name}=${REDACTED_URL_VALUE}`;
    }
  }
  return REDACTED_URL_VALUE;
}

function looksLikeEnvironmentAssignment(value: string): boolean {
  const separator = value.indexOf("=");
  return separator > 0 && ENV_NAME.test(value.slice(0, separator));
}

function redactArgumentUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return value.includes("://") ? REDACTED_URL_VALUE : undefined;
    }
    return `${parsed.protocol}//${parsed.host}/${REDACTED_URL_VALUE}`;
  } catch {
    return value.includes("://") ? REDACTED_URL_VALUE : undefined;
  }
}

function restoreRedactedMcpArguments(
  existing: readonly string[],
  requested: readonly string[],
): readonly string[] {
  const redactedExisting = redactMcpArguments(existing);
  const restored = requested.map((value, index) =>
    value.includes(REDACTED_URL_VALUE) && value === redactedExisting[index]
      ? existing[index]!
      : value,
  );
  if (restored.some((value) => value.includes(REDACTED_URL_VALUE))) {
    throw invalidRequest(
      "redacted argument has no stored value to preserve; refresh and try again",
    );
  }
  return restored;
}

function pluginIdentity(config: ScopedMcpServerConfig): string | undefined {
  const source = config.pluginSource;
  if (
    typeof source === "string" &&
    source.length <= MAX_PATH_LENGTH &&
    CANONICAL_PLUGIN_ID.test(source)
  ) {
    return source;
  }
  const pluginName = config.pluginServer?.pluginName;
  return typeof pluginName === "string" && CANONICAL_PLUGIN_ID.test(pluginName)
    ? pluginName
    : undefined;
}

function withoutRuntimeMetadata(
  config: ScopedMcpServerConfig | McpServerConfig,
): McpServerConfig {
  const raw = { ...(config as ScopedMcpServerConfig) } as Record<
    string,
    unknown
  >;
  delete raw.scope;
  delete raw.pluginSource;
  delete raw.pluginServer;
  return raw as McpServerConfig;
}

export function computeMcpDesktopRevision(
  name: string,
  scope: string,
  config: ScopedMcpServerConfig | McpServerConfig,
): string {
  return createHash("sha256")
    .update(
      stableJson({
        name,
        scope,
        config: withoutRuntimeMetadata(config),
      }),
    )
    .digest("hex");
}

function isEditableConfig(config: ScopedMcpServerConfig): boolean {
  return (
    config.scope === "user" &&
    config.pluginSource === undefined &&
    config.pluginServer === undefined &&
    transportOf(config) !== "unknown"
  );
}

export async function toMcpDesktopServer(
  name: string,
  config: ScopedMcpServerConfig,
  dependencies: McpDesktopDependencies = defaultDependencies,
): Promise<McpDesktopServer> {
  const transport = transportOf(config);
  const pluginId = pluginIdentity(config);
  const stdioConfig =
    transport === "stdio"
      ? (config as ScopedMcpServerConfig & {
          readonly env?: Readonly<Record<string, string>>;
        })
      : undefined;
  const env =
    stdioConfig?.env
      ? Object.keys(stdioConfig.env)
          .sort((left, right) => left.localeCompare(right))
          .map((entryName) => ({
            name: entryName,
            configured: true as const,
            sensitive: true as const,
          }))
      : [];
  const remote = transport === "http" || transport === "sse";
  let needsAuthentication = false;
  if (remote) {
    try {
      needsAuthentication = await dependencies.needsAuthentication(name);
    } catch {
      // Authentication state is advisory in a config-only snapshot. Failure to
      // read its local cache must not turn inspection into a live auth check.
      needsAuthentication = false;
    }
  }
  const enabled =
    (config as McpServerConfig & { enabled?: boolean }).enabled !== false &&
    !dependencies.isDisabled(name);

  return {
    name,
    source: pluginId ? `plugin:${pluginId}` : `${config.scope} config`,
    scope: config.scope,
    ...(pluginId === undefined ? {} : { pluginId }),
    transport,
    ...(transport === "stdio" && "command" in config
      ? { command: config.command }
      : {}),
    args:
      transport === "stdio" && "args" in config && Array.isArray(config.args)
        ? redactMcpArguments(config.args)
        : [],
    ...(remote && "url" in config ? { url: redactMcpUrl(config.url) } : {}),
    env,
    envPassthrough:
      transport === "stdio" &&
      "env_vars" in config &&
      Array.isArray(config.env_vars)
        ? config.env_vars
        : [],
    ...(transport === "stdio" && "cwd" in config && config.cwd !== undefined
      ? { cwd: config.cwd }
      : {}),
    enabled,
    disabled: !enabled,
    // Config-only mode must not touch Keychain or other process-backed secure
    // storage. A positive needs-auth cache is safe to report; authenticated
    // state is left conservative until a live session establishes it.
    authenticated: false,
    needsAuthentication,
    editable: isEditableConfig(config),
    revision: computeMcpDesktopRevision(name, config.scope, config),
  };
}

async function loadDesktopServers(
  dependencies: McpDesktopDependencies,
): Promise<{
  readonly configs: Readonly<Record<string, ScopedMcpServerConfig>>;
  readonly servers: readonly McpDesktopServer[];
}> {
  const configs = await loadConfigSnapshot(dependencies);
  const servers = await Promise.all(
    Object.entries(configs).map(([name, config]) =>
      toMcpDesktopServer(name, config, dependencies),
    ),
  );
  servers.sort((left, right) => left.name.localeCompare(right.name));
  return { configs, servers };
}

async function loadConfigSnapshot(
  dependencies: McpDesktopDependencies,
): Promise<Readonly<Record<string, ScopedMcpServerConfig>>> {
  try {
    return await dependencies.loadConfigs();
  } catch {
    throw new McpDesktopCommandError(
      "MCP_CONFIG_READ_FAILED",
      "Unable to read MCP server configuration",
    );
  }
}

export async function mcpDesktopListHandler(
  io: McpDesktopIo,
  dependencies: McpDesktopDependencies = defaultDependencies,
): Promise<void> {
  const { servers } = await loadDesktopServers(dependencies);
  io.stdout.write(jsonEnvelope({ servers }));
}

export async function mcpDesktopGetHandler(
  name: string,
  io: McpDesktopIo,
  dependencies: McpDesktopDependencies = defaultDependencies,
): Promise<void> {
  assertMcpOperationName(name, "name");
  const { servers } = await loadDesktopServers(dependencies);
  const server = servers.find((candidate) => candidate.name === name);
  if (server === undefined) {
    throw new McpDesktopCommandError(
      "MCP_NOT_FOUND",
      `No MCP server found with name: ${name}`,
    );
  }
  io.stdout.write(jsonEnvelope({ servers: [server] }));
}

async function readBoundedInput(stdin: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_MCP_DESKTOP_REQUEST_BYTES) {
      throw new McpDesktopCommandError(
        "MCP_REQUEST_TOO_LARGE",
        "MCP server request exceeds the maximum size",
      );
    }
    chunks.push(bytes);
  }
  if (total === 0) {
    throw new McpDesktopCommandError(
      "MCP_INVALID_REQUEST",
      "MCP server request is empty",
    );
  }
  return Buffer.concat(chunks, total);
}

function asRecord(
  value: FiniteJsonValue,
  field: string,
): Readonly<Record<string, FiniteJsonValue>> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw invalidRequest(`${field} must be an object`);
  }
  return value as Readonly<Record<string, FiniteJsonValue>>;
}

function assertExactFields(
  value: Readonly<Record<string, FiniteJsonValue>>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidRequest(`${field} contains an unknown field`);
  }
}

function requiredString(
  value: FiniteJsonValue | undefined,
  field: string,
  maximumLength: number,
  options: { allowControlCharacters?: boolean; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw invalidRequest(`${field} must be a string`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw invalidRequest(`${field} cannot be empty`);
  }
  if (value.length > maximumLength) {
    throw invalidRequest(`${field} is too long`);
  }
  if (
    options.allowControlCharacters === true
      ? NUL.test(value)
      : CONTROL_CHARACTERS.test(value)
  ) {
    throw invalidRequest(`${field} contains invalid control characters`);
  }
  return value;
}

function optionalString(
  value: FiniteJsonValue | undefined,
  field: string,
  maximumLength: number,
  options?: { allowControlCharacters?: boolean; allowEmpty?: boolean },
): string | undefined {
  return value === undefined
    ? undefined
    : requiredString(value, field, maximumLength, options);
}

function requiredBoolean(
  value: FiniteJsonValue | undefined,
  field: string,
): boolean {
  if (typeof value !== "boolean") {
    throw invalidRequest(`${field} must be a boolean`);
  }
  return value;
}

function requiredStringArray(
  value: FiniteJsonValue | undefined,
  field: string,
  maximumLength: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ENTRIES) {
    throw invalidRequest(`${field} must be a bounded string array`);
  }
  return value.map((entry, index) =>
    requiredString(entry, `${field}[${index}]`, maximumLength, {
      allowEmpty: true,
    }),
  );
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw invalidRequest(`${field} contains duplicates`);
  }
}

function assertMcpName(value: string, field: string): void {
  if (
    value.length > MAX_NAME_LENGTH ||
    !MCP_NAME.test(value) ||
    RESERVED_KEYS.has(value)
  ) {
    throw invalidRequest(`${field} is not a valid MCP server name`);
  }
}

function assertMcpOperationName(value: string, field: string): void {
  if (
    value.length > MAX_NAME_LENGTH ||
    !MCP_OPERATION_NAME.test(value) ||
    RESERVED_KEYS.has(value)
  ) {
    throw invalidRequest(`${field} is not a valid MCP server name`);
  }
}

function assertEnvName(value: string, field: string): void {
  if (
    value.length > MAX_NAME_LENGTH ||
    !ENV_NAME.test(value) ||
    RESERVED_KEYS.has(value)
  ) {
    throw invalidRequest(`${field} is not a valid environment variable name`);
  }
}

function invalidRequest(message: string): McpDesktopCommandError {
  return new McpDesktopCommandError("MCP_INVALID_REQUEST", message);
}

export function parseMcpDesktopUpsertValue(
  value: FiniteJsonValue,
): McpDesktopUpsertRequest {
  const record = asRecord(value, "request");
  assertExactFields(
    record,
    new Set([
      "revision",
      "originalName",
      "name",
      "transport",
      "command",
      "args",
      "url",
      "env",
      "envPassthrough",
      "cwd",
    ]),
    "request",
  );

  const name = requiredString(record.name, "name", MAX_NAME_LENGTH);
  assertMcpName(name, "name");
  const originalName = optionalString(
    record.originalName,
    "originalName",
    MAX_NAME_LENGTH,
  );
  if (originalName !== undefined) assertMcpName(originalName, "originalName");
  const revision = optionalString(record.revision, "revision", 64);
  if (revision !== undefined && !REVISION.test(revision)) {
    throw invalidRequest("revision is invalid");
  }
  const transport = requiredString(record.transport, "transport", 8);
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    throw invalidRequest("transport must be stdio, http, or sse");
  }
  const command = optionalString(record.command, "command", MAX_PATH_LENGTH);
  const url = optionalString(record.url, "url", MAX_PATH_LENGTH);
  if (transport === "stdio" && command === undefined) {
    throw invalidRequest("stdio servers require command");
  }
  if (transport !== "stdio") {
    if (url === undefined) throw invalidRequest("remote servers require url");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw invalidRequest("url must be a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw invalidRequest("url must use http or https");
    }
  }

  const args = requiredStringArray(
    record.args,
    "args",
    MAX_ARGUMENT_LENGTH,
  );
  if (!Array.isArray(record.env) || record.env.length > MAX_ARRAY_ENTRIES) {
    throw invalidRequest("env must be a bounded array");
  }
  const env = record.env.map((entry, index): McpDesktopEnvironmentPatch => {
    const environment = asRecord(entry, `env[${index}]`);
    assertExactFields(
      environment,
      new Set(["name", "configured", "value", "sensitive"]),
      `env[${index}]`,
    );
    const entryName = requiredString(
      environment.name,
      `env[${index}].name`,
      MAX_NAME_LENGTH,
    );
    assertEnvName(entryName, `env[${index}].name`);
    const configured = requiredBoolean(
      environment.configured,
      `env[${index}].configured`,
    );
    const entryValue = optionalString(
      environment.value,
      `env[${index}].value`,
      MAX_ENV_VALUE_LENGTH,
      { allowEmpty: true },
    );
    if (!configured && entryValue !== undefined) {
      throw invalidRequest(
        `env[${index}] cannot provide a value when configured is false`,
      );
    }
    const sensitive =
      environment.sensitive === undefined
        ? undefined
        : requiredBoolean(environment.sensitive, `env[${index}].sensitive`);
    return {
      name: entryName,
      configured,
      ...(entryValue === undefined ? {} : { value: entryValue }),
      ...(sensitive === undefined ? {} : { sensitive }),
    };
  });
  assertUnique(
    env.map((entry) => entry.name),
    "env",
  );

  const envPassthrough = requiredStringArray(
    record.envPassthrough,
    "envPassthrough",
    MAX_NAME_LENGTH,
  );
  for (const [index, entry] of envPassthrough.entries()) {
    assertEnvName(entry, `envPassthrough[${index}]`);
  }
  assertUnique(envPassthrough, "envPassthrough");
  const envNames = new Set(env.map((entry) => entry.name));
  if (envPassthrough.some((entry) => envNames.has(entry))) {
    throw invalidRequest("env and envPassthrough cannot contain the same name");
  }

  const cwd = optionalString(record.cwd, "cwd", MAX_PATH_LENGTH);
  return {
    ...(revision === undefined ? {} : { revision }),
    ...(originalName === undefined ? {} : { originalName }),
    name,
    transport,
    ...(command === undefined ? {} : { command }),
    args,
    ...(url === undefined ? {} : { url }),
    env,
    envPassthrough,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

export async function readMcpDesktopUpsertRequest(
  stdin: Readable,
): Promise<McpDesktopUpsertRequest> {
  const bytes = await readBoundedInput(stdin);
  let parsed: FiniteJsonValue;
  try {
    parsed = parseFiniteJsonBytes(bytes, "MCP server request", {
      maximumBytes: MAX_MCP_DESKTOP_REQUEST_BYTES,
      maximumDepth: 8,
      maximumNodes: 1_024,
      maximumKeyUtf8Bytes: 128,
      maximumStringUtf8Bytes: MAX_ENV_VALUE_LENGTH,
      maximumTotalStringUtf8Bytes: MAX_MCP_DESKTOP_REQUEST_BYTES,
    });
  } catch (error) {
    if (error instanceof McpDesktopCommandError) throw error;
    throw invalidRequest("MCP server request is not valid strict JSON");
  }
  return parseMcpDesktopUpsertValue(parsed);
}

function deleteFields(
  target: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) delete target[field];
}

function mergeEnvironment(
  current: Readonly<Record<string, string>> | undefined,
  patches: readonly McpDesktopEnvironmentPatch[],
): Record<string, string> | undefined {
  const next: Record<string, string> = { ...(current ?? {}) };
  for (const patch of patches) {
    if (!patch.configured && patch.value === undefined) {
      delete next[patch.name];
      continue;
    }
    if (patch.value !== undefined) {
      next[patch.name] = patch.value;
      continue;
    }
    if (!(patch.name in next)) {
      throw invalidRequest(
        `env entry ${patch.name} has no stored value to preserve`,
      );
    }
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

export function mergeMcpDesktopPatch(
  current: McpServerConfig | undefined,
  request: McpDesktopUpsertRequest,
): McpServerConfig {
  const previousTransport = current === undefined ? undefined : transportOf(current);
  const next = { ...(current ?? {}) } as Record<string, unknown>;
  next.type = request.transport;

  if (request.transport === "stdio") {
    deleteFields(next, [
      "url",
      "headers",
      "headersHelper",
      "oauth",
      "ideName",
      "ideRunningInWindows",
      "authToken",
      "id",
      "name",
    ]);
    next.command = request.command;
    const existingArguments =
      previousTransport === "stdio" &&
      current &&
      "args" in current &&
      Array.isArray(current.args)
        ? current.args
        : undefined;
    next.args =
      existingArguments === undefined
        ? [...request.args]
        : restoreRedactedMcpArguments(existingArguments, request.args);
    const existingEnvironment =
      previousTransport === "stdio" && current && "env" in current
        ? current.env
        : undefined;
    const environment = mergeEnvironment(existingEnvironment, request.env);
    if (environment === undefined) delete next.env;
    else next.env = environment;
    if (request.envPassthrough.length === 0) delete next.env_vars;
    else next.env_vars = [...request.envPassthrough];
    if (request.cwd === undefined) delete next.cwd;
    else next.cwd = request.cwd;
  } else {
    deleteFields(next, [
      "command",
      "args",
      "env",
      "env_vars",
      "cwd",
      "pluginSandbox",
      "ideName",
      "ideRunningInWindows",
      "authToken",
      "id",
      "name",
    ]);
    const existingUrl =
      previousTransport !== "stdio" &&
      previousTransport !== undefined &&
      current &&
      "url" in current
        ? current.url
        : undefined;
    // If Desktop returns the redacted projection unchanged, keep the opaque
    // URL from Core. A genuinely edited URL replaces it.
    next.url =
      existingUrl !== undefined
        ? restoreRedactedMcpUrl(existingUrl, request.url!)
        : request.url;
    // headers, OAuth, and tool-policy fields are compatible with both remote
    // transports and remain untouched even when switching http <-> sse.
  }

  const validated = McpServerConfigSchema().safeParse(next);
  if (!validated.success) {
    throw invalidRequest("MCP server configuration is invalid");
  }
  return validated.data;
}

export async function mcpDesktopUpsertHandler(
  io: McpDesktopIo,
  dependencies: McpDesktopDependencies = defaultDependencies,
): Promise<void> {
  const request = await readMcpDesktopUpsertRequest(io.stdin);
  if (dependencies.enterpriseConfigActive()) {
    throw new McpDesktopCommandError(
      "MCP_NOT_EDITABLE",
      "Enterprise MCP configuration is active",
    );
  }

  const configs = await loadConfigSnapshot(dependencies);
  const originalName = request.originalName;
  const existing =
    originalName === undefined ? undefined : configs[originalName];
  if (originalName !== undefined && existing === undefined) {
    throw new McpDesktopCommandError(
      "MCP_NOT_FOUND",
      `No MCP server found with name: ${originalName}`,
    );
  }
  if (existing !== undefined) {
    if (!isEditableConfig(existing)) {
      throw new McpDesktopCommandError(
        "MCP_NOT_EDITABLE",
        `MCP server ${originalName} is managed and cannot be edited`,
      );
    }
    if (request.revision === undefined) {
      throw new McpDesktopCommandError(
        "MCP_REVISION_REQUIRED",
        "An MCP revision is required when updating a server",
      );
    }
    const actualRevision = computeMcpDesktopRevision(
      originalName!,
      existing.scope,
      existing,
    );
    if (request.revision !== actualRevision) {
      throw new McpDesktopCommandError(
        "MCP_REVISION_CONFLICT",
        "The MCP server changed since it was loaded; refresh and try again",
      );
    }
  } else if (request.revision !== undefined) {
    throw new McpDesktopCommandError(
      "MCP_REVISION_CONFLICT",
      "A new MCP server cannot include an existing revision",
    );
  }

  const conflicting = configs[request.name];
  if (
    conflicting !== undefined &&
    (originalName === undefined || request.name !== originalName)
  ) {
    throw new McpDesktopCommandError(
      "MCP_NAME_CONFLICT",
      `An MCP server named ${request.name} already exists`,
    );
  }

  const next = mergeMcpDesktopPatch(
    existing === undefined ? undefined : withoutRuntimeMetadata(existing),
    request,
  );
  if (!dependencies.policyAllows(request.name, next)) {
    throw new McpDesktopCommandError(
      "MCP_POLICY_BLOCKED",
      "The MCP server is blocked by managed policy",
    );
  }

  const wasEnabled =
    originalName === undefined ? true : !dependencies.isDisabled(originalName);
  try {
    await dependencies.persistUserConfig(originalName, request.name, next);
  } catch {
    throw new McpDesktopCommandError(
      "MCP_SAVE_FAILED",
      "Unable to save MCP server configuration",
    );
  }
  if (originalName !== undefined && originalName !== request.name) {
    dependencies.setEnabled(originalName, true);
    dependencies.setEnabled(request.name, wasEnabled);
  }

  const scoped: ScopedMcpServerConfig = { ...next, scope: "user" };
  const server = await toMcpDesktopServer(
    request.name,
    scoped,
    dependencies,
  );
  io.stdout.write(jsonEnvelope({ servers: [server] }));
}

export async function mcpDesktopSetEnabledHandler(
  name: string,
  enabled: boolean,
  io: McpDesktopIo,
  dependencies: McpDesktopDependencies = defaultDependencies,
): Promise<void> {
  assertMcpOperationName(name, "name");
  const configs = await loadConfigSnapshot(dependencies);
  if (configs[name] === undefined) {
    throw new McpDesktopCommandError(
      "MCP_NOT_FOUND",
      `No MCP server found with name: ${name}`,
    );
  }
  try {
    dependencies.setEnabled(name, enabled);
  } catch {
    throw new McpDesktopCommandError(
      "MCP_ENABLE_FAILED",
      `Unable to ${enabled ? "enable" : "disable"} MCP server ${name}`,
    );
  }
  io.stdout.write(`${enabled ? "Enabled" : "Disabled"} MCP server ${name}\n`);
}

export async function mcpDesktopAuthenticateHandler(
  name: string,
  io: McpDesktopIo,
  dependencies: McpDesktopDependencies = defaultDependencies,
): Promise<void> {
  assertMcpOperationName(name, "name");
  const configs = await loadConfigSnapshot(dependencies);
  const config = configs[name];
  if (config === undefined) {
    throw new McpDesktopCommandError(
      "MCP_NOT_FOUND",
      `No MCP server found with name: ${name}`,
    );
  }
  if (!isEditableConfig(config)) {
    throw new McpDesktopCommandError(
      "MCP_AUTH_UNSUPPORTED",
      `MCP server ${name} is managed by another source`,
    );
  }
  if (config.type !== "http" && config.type !== "sse") {
    throw new McpDesktopCommandError(
      "MCP_AUTH_UNSUPPORTED",
      `MCP server ${name} does not use an OAuth-capable transport`,
    );
  }
  try {
    await dependencies.authenticate(name, config);
  } catch {
    throw new McpDesktopCommandError(
      "MCP_AUTH_FAILED",
      `Authentication failed for MCP server ${name}`,
    );
  }
  io.stdout.write(`Authenticated MCP server ${name}\n`);
}
