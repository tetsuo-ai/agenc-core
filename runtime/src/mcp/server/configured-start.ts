/** Configured daemon decisions without loading unused MCP implementations. */
import "../../bootstrap/node-env.js";
import type { AgenCConfig } from "../../config/schema.js";
import { resolveMcpServeDefaults } from "./defaults.js";
import { normalizeMcpSseLoopbackHost, resolveMcpServeWorkspace } from "./workspace.js";
import type {
  ConfiguredMcpServerStartResult,
  McpServerStartOptions,
  PreparedMcpSseServerReconfiguration,
  StartedMcpSseServer,
} from "./start.js";

export async function startMcpServerFromConfig(
  config: Pick<AgenCConfig, "mcp"> | undefined,
  options: McpServerStartOptions = {},
): Promise<ConfiguredMcpServerStartResult> {
  const defaults = resolveMcpServeDefaults(config?.mcp?.server);
  if (!defaults.enabled) {
    return { kind: "disabled", defaults };
  }
  if (defaults.transport === "stdio") {
    return {
      kind: "unsupported",
      defaults,
      reason: "MCP stdio transport requires foreground `agenc mcp serve`",
    };
  }

  if (defaults.workspace === undefined) {
    return {
      kind: "unsupported",
      defaults,
      reason:
        "daemon MCP autostart requires an explicit absolute mcp.server.workspace; " +
        "use foreground `agenc mcp serve` from the target workspace otherwise",
    };
  }

  const workspace = await resolveMcpServeWorkspace(defaults.workspace);
  // Preserve the original options snapshot point, before the import yields.
  const pinnedOptions = { ...options, cwd: workspace };
  const { startMcpSseServe } = await import("./start.js");
  const server = await startMcpSseServe(defaults, pinnedOptions);
  return { kind: "started", defaults, server };
}

export async function prepareMcpSseServerReconfigurationFromConfig(
  server: StartedMcpSseServer,
  config: Pick<AgenCConfig, "mcp"> | undefined,
): Promise<PreparedMcpSseServerReconfiguration> {
  const defaults = resolveMcpServeDefaults(config?.mcp?.server);
  if (!defaults.enabled || defaults.transport !== "sse") {
    throw new Error(
      "MCP SSE listener reconfiguration requires enabled SSE config",
    );
  }
  const host = normalizeMcpSseLoopbackHost(defaults.host);
  if (
    host !== server.configuredHost ||
    defaults.port !== server.configuredPort
  ) {
    throw new Error("MCP SSE listener binding changed and cannot be reused");
  }
  if (defaults.workspace === undefined) {
    throw new Error(
      "daemon MCP autostart requires an explicit absolute mcp.server.workspace",
    );
  }

  const workspace = await resolveMcpServeWorkspace(defaults.workspace);
  const apply = server.prepareContextReplacement(workspace);
  return { defaults, apply };
}

