/**
 * Config-backed MCP server start contract.
 *
 * CF-11 anchors `mcp.server` at the runtime start boundary so both the
 * user-facing `agenc mcp serve` command and daemon autostart read the same
 * transport, host, and port defaults before opening real transports.
 */

import "../../bootstrap/node-env.js";
import type { Server } from "node:http";
import { join } from "node:path";
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
import type { ResolvedMcpServeDefaults } from "./defaults.js";
import { normalizeMcpSseLoopbackHost, resolveMcpServeWorkspace } from "./workspace.js";
export { resolveMcpServeDefaults, type ResolvedMcpServeDefaults } from "./defaults.js";
import { VERSION } from "../../version.js";
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

export {
  startMcpServerFromConfig,
  prepareMcpSseServerReconfigurationFromConfig,
} from "./configured-start.js";

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
    close: closeMcpSseHttpServer(server, transport),
    waitUntilClosed: () =>
      new Promise((resolve) => {
        server.once("close", resolve);
      }),
  };
}

function closeMcpSseHttpServer(
  server: Server,
  transport: McpHttpSseServerTransport,
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= new Promise((resolve, reject) => {
      transport.close();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      server.closeAllConnections();
    });
    return closing;
  };
}

export function formatMcpSseServeUrl(host: string, port: number): string {
  const urlHost = normalizeMcpSseLoopbackHost(host);
  const bracketedHost =
    urlHost.includes(":") && !urlHost.startsWith("[") ? `[${urlHost}]` : urlHost;
  return `http://${bracketedHost}:${port}/mcp`;
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
      skillRoots: [join(workspaceRoot, PROJECT_MEMORY_DIR, "skills")],
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
