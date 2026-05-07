import { join } from "node:path";

import { AgenCConfigEditsBuilder } from "../../config/edit.js";
import { resolveAgencHome } from "../../config/env.js";
import { loadConfig, parseToml } from "../../config/loader.js";
import { getErrnoCode } from "../../utils/errors.js";
import { getFsImplementation } from "../../utils/fsOperations.js";
import { stripBOM } from "../../utils/jsonRead.js";
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

export function toCanonicalMcpServerConfig(
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
        transport: type,
        endpoint: url,
      });
    }
    default:
      throw new Error(
        `Cannot persist MCP server type "${String(type)}" in user config.toml`,
      );
  }
}

function toServiceMcpServerConfig(config: unknown): McpServerConfig {
  const raw = isPlainRecord(config) ? { ...config } : {};
  const transport = raw.transport;

  if (
    transport === "sse" ||
    transport === "http" ||
    transport === "ws" ||
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

export function getUserMcpConfigTomlPath(): string {
  return join(resolveAgencHome(process.env), "config.toml");
}

export function getUserMcpConfigsFromToml(): {
  servers: Record<string, ScopedMcpServerConfig>;
  errors: ValidationError[];
} {
  const filePath = getUserMcpConfigTomlPath();
  let text: string;
  try {
    text = getFsImplementation().readFileSync(filePath, { encoding: "utf8" });
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") {
      return { servers: {}, errors: [] };
    }
    return {
      servers: {},
      errors: [
        {
          file: filePath,
          path: "mcp_servers",
          message: `Failed to read config.toml: ${error}`,
          mcpErrorMetadata: {
            scope: "user",
            severity: "fatal",
          },
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseToml(stripBOM(text));
  } catch (error) {
    return {
      servers: {},
      errors: [
        {
          file: filePath,
          path: "mcp_servers",
          message: `Invalid config.toml: ${error}`,
          mcpErrorMetadata: {
            scope: "user",
            severity: "fatal",
          },
        },
      ],
    };
  }

  const rawServers = isPlainRecord(parsed) ? parsed.mcp_servers : undefined;
  if (!isPlainRecord(rawServers)) {
    return { servers: {}, errors: [] };
  }

  const servers: Record<string, ScopedMcpServerConfig> = {};
  const errors: ValidationError[] = [];
  for (const [name, config] of Object.entries(rawServers)) {
    const parsed = McpServerConfigSchema().safeParse(
      toServiceMcpServerConfig(config),
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

export async function getUserMcpServersFromToml(): Promise<
  Readonly<Record<string, unknown>>
> {
  const { config } = await loadConfig({
    home: resolveAgencHome(process.env),
    onWarn: () => {},
  });
  return config.mcp_servers ?? {};
}

export async function addUserMcpServerToToml(
  name: string,
  config: McpServerConfig,
): Promise<void> {
  await new AgenCConfigEditsBuilder(resolveAgencHome(process.env))
    .setMcpServer(name, toCanonicalMcpServerConfig(config))
    .apply();
}

export async function removeUserMcpServerFromToml(
  name: string,
): Promise<void> {
  await new AgenCConfigEditsBuilder(resolveAgencHome(process.env))
    .removeMcpServer(name)
    .apply();
}
