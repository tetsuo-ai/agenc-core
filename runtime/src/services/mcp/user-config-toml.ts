import { AgenCConfigEditsBuilder } from "../../config/edit.js";
import { mergeConfigLayerSnapshots } from "../../config/repository.js";
import type { CanonicalSettingsAuthority } from "../../utils/settings/canonicalAuthority.js";
import type {
  McpServerConfig,
  ScopedMcpServerConfig,
} from "./types.js";
import { McpServerConfigSchema } from "./types.js";
import type { ValidationError } from "../../utils/settings/validation.js";

function omitUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function serviceMcpServerToCanonicalConfig(
  config: McpServerConfig,
): Record<string, unknown> {
  const raw = { ...(config as Record<string, unknown>) };
  const type = raw.type;
  delete raw.type;

  switch (type) {
    case undefined:
    case "stdio":
      return omitUndefined({
        ...raw,
        transport: "stdio",
      });
    case "sse":
    case "http":
    case "ws": {
      const url = raw.url;
      delete raw.url;
      return omitUndefined({
        ...raw,
        transport: type === "ws" ? "websocket" : type,
        endpoint: url,
      });
    }
    default:
      throw new Error(
        `Cannot persist MCP server type "${String(type)}" in user config.toml`,
      );
  }
}

export function canonicalMcpServerToServiceConfig(
  config: unknown,
): McpServerConfig {
  const raw = isPlainRecord(config) ? { ...config } : {};
  const transport = raw.transport;

  if (
    transport === "sse" ||
    transport === "http" ||
    transport === "websocket"
  ) {
    const endpoint = raw.endpoint;
    delete raw.transport;
    delete raw.endpoint;
    return omitUndefined({
      ...raw,
      type: transport === "websocket" ? "ws" : transport,
      url: endpoint,
    }) as McpServerConfig;
  }

  delete raw.transport;
  return omitUndefined({
    ...raw,
    type: "stdio",
  }) as McpServerConfig;
}

function userMcpConfig(
  authority: CanonicalSettingsAuthority,
): Readonly<Record<string, unknown>> {
  return mergeConfigLayerSnapshots(authority.sources("user"))?.mcp_servers ?? {};
}

export function getUserMcpConfigsFromToml(
  authority: CanonicalSettingsAuthority,
): {
  servers: Record<string, ScopedMcpServerConfig>;
  errors: ValidationError[];
} {
  const filePath = authority.homeContext.configTomlPath;
  const rawServers = userMcpConfig(authority);

  const servers: Record<string, ScopedMcpServerConfig> = {};
  const errors: ValidationError[] = [];
  for (const [name, config] of Object.entries(rawServers)) {
    const parsed = McpServerConfigSchema().safeParse(
      canonicalMcpServerToServiceConfig(config),
    );
    if (!parsed.success) {
      errors.push({
        file: filePath,
        path: `mcp_servers.${name}`,
        message: "Does not adhere to MCP server configuration schema",
        mcpErrorMetadata: {
          scope: "user",
          serverName: name,
          severity: "fatal",
        },
      });
      continue;
    }
    servers[name] = { ...parsed.data, scope: "user" };
  }
  return { servers, errors };
}

export async function getUserMcpServersFromToml(
  authority: CanonicalSettingsAuthority,
): Promise<
  Readonly<Record<string, unknown>>
> {
  return userMcpConfig(authority);
}

export async function addUserMcpServerToToml(
  name: string,
  config: McpServerConfig,
  authority: CanonicalSettingsAuthority,
): Promise<void> {
  await new AgenCConfigEditsBuilder(authority.homeContext.path)
    .setMcpServer(name, serviceMcpServerToCanonicalConfig(config))
    .apply();
  await authority.reload();
}

export async function removeUserMcpServerFromToml(
  name: string,
  authority: CanonicalSettingsAuthority,
): Promise<void> {
  await new AgenCConfigEditsBuilder(authority.homeContext.path)
    .removeMcpServer(name)
    .apply();
  await authority.reload();
}
