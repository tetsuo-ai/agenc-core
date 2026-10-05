import type { McpServerModeConfig } from "../../config/schema.js";

/** Pure configuration defaults; safe for daemon clients without server imports. */
export interface ResolvedMcpServeDefaults {
  readonly enabled: boolean;
  readonly transport: "stdio" | "sse";
  readonly host: string;
  readonly port: number;
  readonly workspace?: string;
}

export function resolveMcpServeDefaults(
  config: McpServerModeConfig | undefined,
): ResolvedMcpServeDefaults {
  const workspace = readMcpServeWorkspace(config?.workspace);
  return {
    enabled: config?.enabled === true,
    transport: config?.transport === "sse" ? "sse" : "stdio",
    host: readMcpServeHost(config?.host),
    port: readMcpServePort(config?.port),
    ...(workspace !== undefined ? { workspace } : {}),
  };
}

function readMcpServeHost(host: unknown): string {
  return typeof host === "string" && host.trim().length > 0
    ? host.trim()
    : "127.0.0.1";
}

function readMcpServePort(port: unknown): number {
  const valid =
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= 0 &&
    port <= 65_535;
  return valid ? port : 3334;
}

function readMcpServeWorkspace(workspace: unknown): string | undefined {
  return typeof workspace === "string" && workspace.trim().length > 0
    ? workspace.trim()
    : undefined;
}
