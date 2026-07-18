/**
 * Config-backed MCP server start contract.
 *
 * CF-11 anchors `mcp.server` at the runtime start boundary so both the
 * user-facing `agenc mcp serve` command and daemon autostart read the same
 * transport, host, and port defaults before opening real transports.
 */

import type { Server } from "node:http";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { cwd as processCwd } from "node:process";
import type { Readable, Writable } from "node:stream";
import {
  MEMORY_DIRNAME,
  PROJECT_INSTRUCTION_FILE,
  PROJECT_MEMORY_DIR,
} from "../../memory/index.js";
import {
  createMemoryResourceProvider,
  createSkillPromptProvider,
} from "./content-providers.js";
import type { AgenCConfig, McpServerModeConfig } from "../../config/schema.js";
import { VERSION } from "../../index.js";
import { McpServerFramework } from "../../mcp-server/framework.js";
import { McpHttpSseServerTransport } from "../../mcp-server/http-sse.js";
import { McpStdioServerTransport } from "../../mcp-server/stdio.js";
import type {
  McpCallToolResult,
  McpToolCallContext,
  McpToolCallParams,
  McpToolDefinition,
  McpToolProvider,
} from "../../mcp-server/types.js";
import type { ToolRegistry } from "../../tool-registry.js";

export const MCP_INBOUND_TOOL_ADMISSION_REQUIRED_CODE =
  "ADMISSION_IDENTITY_REQUIRED";
export const MCP_INBOUND_TOOL_ADMISSION_REQUIRED_REASON =
  "mcp_session_admission_identity_missing";
export const MCP_INBOUND_TOOL_ADMISSION_REQUIRED_MESSAGE =
  "Inbound MCP tool execution requires a daemon session-bound admission identity; this server exposes prompts and resources only.";

export interface McpServerStartIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface McpServerStartOptions {
  readonly cwd?: string;
  readonly io?: McpServerStartIo;
  /**
   * Retained for source compatibility. It is never materialized until inbound
   * MCP can bind requests to a daemon session-owned admission identity.
   */
  readonly toolRegistry?: ToolRegistry;
}

export interface McpServerStartCommand {
  readonly transport: "stdio" | "sse";
  readonly host: string;
  readonly port: number;
}

export interface StartedMcpSseServer {
  readonly server: Server;
  readonly url: string;
  readonly configuredHost: string;
  readonly configuredPort: number;
  /** Prepare without applying; the returned synchronous swap cannot fail. */
  prepareContextReplacement(cwd: string): () => number;
  close(): Promise<void>;
  waitUntilClosed(): Promise<void>;
}

export interface ResolvedMcpServeDefaults {
  readonly enabled: boolean;
  readonly transport: "stdio" | "sse";
  readonly host: string;
  readonly port: number;
  readonly workspace?: string;
}

export interface PreparedMcpSseServerReconfiguration {
  readonly defaults: ResolvedMcpServeDefaults;
  /** Applies the validated context and returns the number of revoked sessions. */
  apply(): number;
}

export type ConfiguredMcpServerStartResult =
  | {
      readonly kind: "disabled";
      readonly defaults: ResolvedMcpServeDefaults;
    }
  | {
      readonly kind: "unsupported";
      readonly defaults: ResolvedMcpServeDefaults;
      readonly reason: string;
    }
  | {
      readonly kind: "started";
      readonly defaults: ResolvedMcpServeDefaults;
      readonly server: StartedMcpSseServer;
    };

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
  const server = await startMcpSseServe(defaults, {
    ...options,
    cwd: workspace,
  });
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

export async function runMcpStdioServe(
  io: McpServerStartIo,
  options: McpServerStartOptions = {},
): Promise<void> {
  const pinnedOptions = await pinMcpServerStartOptions(options);
  const server = createMcpFramework(pinnedOptions.cwd);
  await new Promise<void>((resolve, reject) => {
    const transport = new McpStdioServerTransport({
      input: io.stdin,
      output: io.stdout,
      server,
      onClose: resolve,
      onError: reject,
    });
    transport.start();
  });
}

export async function startMcpSseServe(
  command: McpServerStartCommand,
  options: McpServerStartOptions = {},
): Promise<StartedMcpSseServer> {
  const pinnedOptions = await pinMcpServerStartOptions(options);
  const host = normalizeMcpSseLoopbackHost(command.host);
  const transport = new McpHttpSseServerTransport({
    serverFactory: createMcpFrameworkFactory(pinnedOptions),
  });
  const server = transport.createNodeServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(command.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : command.port;
  const url = formatMcpSseServeUrl(host, port);
  return {
    server,
    url,
    configuredHost: host,
    configuredPort: command.port,
    prepareContextReplacement(cwd) {
      const replacementFactory = createMcpFrameworkFactory({
        ...pinnedOptions,
        cwd,
      });
      return () => transport.replaceServerFactory(replacementFactory);
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    waitUntilClosed: () =>
      new Promise((resolve) => {
        server.once("close", resolve);
      }),
  };
}

export function formatMcpSseServeUrl(host: string, port: number): string {
  const urlHost = normalizeMcpSseLoopbackHost(host);
  const bracketedHost =
    urlHost.includes(":") && !urlHost.startsWith("[") ? `[${urlHost}]` : urlHost;
  return `http://${bracketedHost}:${port}/mcp`;
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

async function resolveMcpServeWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) {
    throw new Error("mcp.server.workspace must be an absolute filesystem path");
  }
  const canonical = await realpath(workspace).catch((error: unknown) => {
    throw new Error(
      `mcp.server.workspace cannot be resolved: ${formatMcpWorkspaceError(error)}`,
    );
  });
  const workspaceStat = await stat(canonical).catch((error: unknown) => {
    throw new Error(
      `mcp.server.workspace cannot be inspected: ${formatMcpWorkspaceError(error)}`,
    );
  });
  if (!workspaceStat.isDirectory()) {
    throw new Error("mcp.server.workspace must resolve to a directory");
  }
  return canonical;
}

function formatMcpWorkspaceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pinMcpServerStartOptions(
  options: McpServerStartOptions,
): Promise<McpServerStartOptions & { readonly cwd: string }> {
  // Capture before the first await so process.chdir() cannot change the scope
  // between transport startup and provider/session creation.
  const requestedCwd = options.cwd ?? processCwd();
  const cwd = await resolveMcpServeWorkspace(requestedCwd);
  return { ...options, cwd };
}

function normalizeMcpSseLoopbackHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed === "127.0.0.1" || trimmed === "localhost" || trimmed === "::1") {
    return trimmed;
  }
  throw new Error("AgenC MCP SSE transport only binds to loopback hosts");
}

function createMcpFrameworkFactory(
  options: McpServerStartOptions,
): () => McpServerFramework {
  return () => createMcpFramework(options.cwd);
}

const UNADMITTED_MCP_TOOL_PROVIDER: McpToolProvider = {
  // An empty catalog prevents clients from planning executable MCP calls. A
  // direct tools/call still receives the same explicit denial instead of
  // being misreported as an unknown tool.
  listTools(): readonly McpToolDefinition[] {
    return [];
  },
  async callTool(
    _params: McpToolCallParams,
    _context: McpToolCallContext,
  ): Promise<McpCallToolResult> {
    return {
      content: [
        {
          type: "text",
          text: MCP_INBOUND_TOOL_ADMISSION_REQUIRED_MESSAGE,
        },
      ],
      structuredContent: {
        code: MCP_INBOUND_TOOL_ADMISSION_REQUIRED_CODE,
        reason: MCP_INBOUND_TOOL_ADMISSION_REQUIRED_REASON,
      },
      isError: true,
    };
  },
};

function createMcpFramework(cwd?: string): McpServerFramework {
  const workspaceRoot = cwd ?? processCwd();
  return new McpServerFramework({
    serverInfo: { version: VERSION },
    // No tools capability is advertised without a session-bound admission
    // identity. The provider remains installed solely to give callers that
    // send tools/call anyway a stable machine-readable denial.
    capabilities: {
      prompts: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
    },
    toolProvider: UNADMITTED_MCP_TOOL_PROVIDER,
    promptProvider: createSkillPromptProvider({
      scopeRoot: workspaceRoot,
      skillRoots: [
        join(workspaceRoot, PROJECT_MEMORY_DIR, "skills"),
        join(workspaceRoot, PROJECT_MEMORY_DIR, "commands"),
      ],
    }),
    resourceProvider: createMemoryResourceProvider({
      scopeRoot: workspaceRoot,
      memoryDirs: [
        join(workspaceRoot, PROJECT_MEMORY_DIR, MEMORY_DIRNAME),
      ],
      instructionFiles: [
        join(workspaceRoot, PROJECT_INSTRUCTION_FILE),
      ],
    }),
  });
}
