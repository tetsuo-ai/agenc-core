import type { McpServerModeConfig } from "../../config/schema.js";
import { mcpServerOriginValidationIssue } from "../../mcp-server/origin.js";

/** Pure configuration defaults; safe for daemon clients without server imports. */
export interface ResolvedMcpServeDefaults {
  readonly enabled: boolean;
  readonly transport: "stdio" | "sse";
  readonly host: string;
  readonly port: number;
  readonly workspace?: string;
  /**
   * Exact origins the SSE transport admits besides clients that send no
   * Origin header. Absent when none is configured, which is the default.
   */
  readonly allowedOrigins?: readonly string[];
}

export function resolveMcpServeDefaults(
  config: McpServerModeConfig | undefined,
): ResolvedMcpServeDefaults {
  const workspace = readMcpServeWorkspace(config?.workspace);
  const allowedOrigins = readMcpServeAllowedOrigins(config?.allowed_origins);
  return {
    enabled: config?.enabled === true,
    transport: config?.transport === "sse" ? "sse" : "stdio",
    host: readMcpServeHost(config?.host),
    port: readMcpServePort(config?.port),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
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

function readMcpServeAllowedOrigins(
  origins: unknown,
): readonly string[] | undefined {
  if (!Array.isArray(origins)) return undefined;
  // A malformed raw entry is dropped, never widened: fewer origins is the
  // safe fallback for an allowlist.
  const valid = new Set(
    origins.filter(
      (origin): origin is string =>
        mcpServerOriginValidationIssue(origin) === undefined,
    ),
  );
  return valid.size > 0 ? Object.freeze([...valid]) : undefined;
}
