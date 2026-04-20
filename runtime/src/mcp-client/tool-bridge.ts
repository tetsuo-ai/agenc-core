/**
 * MCP tool bridge for @tetsuo-ai/runtime.
 *
 * Converts MCP server tools into runtime Tool instances,
 * enabling seamless integration with the ToolRegistry and LLM system.
 *
 * @module
 */

import type { Tool, ToolResult, JSONSchema } from "../tools/types.js";
import type { MCPToolBridge } from "./types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import {
  computeMCPToolCatalogSha256,
  catalogDigestMatches,
  type MCPToolDescriptorLike,
} from "./supply-chain.js";

/**
 * Policy knobs forwarded from server config to the bridge. `allowedTools`
 * / `deniedTools` are post-list filters; `pinnedCatalogSha256` is the
 * I-74 supply-chain pin.
 */
export interface MCPToolCatalogPolicyConfig {
  readonly allowedTools?: readonly string[];
  readonly deniedTools?: readonly string[];
  readonly pinnedCatalogSha256?: string;
  readonly riskControls?: unknown;
  readonly supplyChain?: {
    readonly catalogSha256?: string;
  };
}

function filterMCPToolCatalog<T extends { name: string }>(
  config: MCPToolCatalogPolicyConfig | undefined,
  tools: readonly T[],
): readonly T[] {
  if (!config) return tools;
  const allow = config.allowedTools
    ? new Set(config.allowedTools)
    : undefined;
  const deny = config.deniedTools ? new Set(config.deniedTools) : undefined;
  return tools.filter((t) => {
    if (deny?.has(t.name)) return false;
    if (allow && !allow.has(t.name)) return false;
    return true;
  });
}

const DEFAULT_MCP_LIST_TOOLS_TIMEOUT_MS = 30_000;
const DEFAULT_MCP_CALL_TIMEOUT_MS = 45_000;

/** I-76: upper bound on a single MCP tool-call result, 5MB. */
export const MAX_MCP_CALL_RESULT_BYTES = 5 * 1024 * 1024;

interface ToolBridgeOptions {
  listToolsTimeoutMs?: number;
  callToolTimeoutMs?: number;
  serverConfig?: MCPToolCatalogPolicyConfig;
}

interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface MCPListToolsResponse {
  tools?: MCPToolDescriptor[];
}

interface MCPCallToolResponse {
  content?: unknown;
  isError?: boolean;
}

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * Truncate a string so its UTF-8 byte length is <= `maxBytes` without
 * splitting multi-byte codepoints mid-sequence.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

async function withRPCDeadline<T>(
  operation: string,
  timeoutMs: number,
  task: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Create a tool bridge from an MCP client connection.
 *
 * Queries the server for available tools via `client.listTools()`,
 * then wraps each as a runtime `Tool` with namespaced names:
 * `mcp.{serverName}.{toolName}`
 *
 * @param client - Connected MCP Client instance (from createMCPConnection)
 * @param serverName - Server name for tool namespacing
 * @param logger - Optional logger
 * @returns MCPToolBridge with adapted tools
 */
export async function createToolBridge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  serverName: string,
  logger: Logger = silentLogger,
  options: ToolBridgeOptions = {},
): Promise<MCPToolBridge> {
  const listToolsTimeoutMs = normalizeTimeoutMs(
    options.listToolsTimeoutMs,
    DEFAULT_MCP_LIST_TOOLS_TIMEOUT_MS,
  );
  const callToolTimeoutMs = normalizeTimeoutMs(
    options.callToolTimeoutMs,
    DEFAULT_MCP_CALL_TIMEOUT_MS,
  );

  const response = await withRPCDeadline<MCPListToolsResponse>(
    `MCP server "${serverName}" listTools`,
    listToolsTimeoutMs,
    () => client.listTools(),
  );
  const rawTools = (Array.isArray(response.tools)
    ? response.tools
    : []) as MCPToolDescriptorLike[];
  const mcpTools: MCPToolDescriptorLike[] = options.serverConfig
    ? (filterMCPToolCatalog(
        options.serverConfig,
        rawTools,
      ) as MCPToolDescriptorLike[])
    : rawTools;

  // I-74: supply-chain pin. Compute + compare canonical SHA-256.
  const expectedPin =
    options.serverConfig?.supplyChain?.catalogSha256 ??
    options.serverConfig?.pinnedCatalogSha256;
  if (expectedPin) {
    const { sha256: actualSha } = computeMCPToolCatalogSha256(mcpTools);
    if (!catalogDigestMatches(actualSha, expectedPin)) {
      throw new Error(
        `MCP server "${serverName}" tool catalog digest mismatch: expected ${expectedPin}, got ${actualSha}`,
      );
    }
  }

  logger.info(`MCP server "${serverName}" exposes ${mcpTools.length} tools`);

  // Track disposal to prevent use-after-close
  let disposed = false;

  const tools: Tool[] = mcpTools.map((mcpTool) => {
    const namespacedName = `mcp.${serverName}.${mcpTool.name}`;

    return {
      name: namespacedName,
      description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
      inputSchema: (mcpTool.inputSchema ?? { type: "object", properties: {} }) as JSONSchema,

      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        if (disposed) {
          return {
            content: `MCP server "${serverName}" has been disconnected`,
            isError: true,
          };
        }

        try {
          const result = await withRPCDeadline<MCPCallToolResponse>(
            `MCP tool "${mcpTool.name}" callTool`,
            callToolTimeoutMs,
            () =>
              client.callTool({
                name: mcpTool.name,
                arguments: args,
              }),
          );

          // MCP tool results contain a content array
          const rawContent = Array.isArray(result.content)
            ? result.content
                .map((c: { type: string; text?: string }) =>
                  c.type === "text" ? c.text ?? "" : JSON.stringify(c),
                )
                .join("\n")
            : typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content);

          // I-76: cap result payload at 5MB.
          const bytes = Buffer.byteLength(rawContent, "utf8");
          let content = rawContent;
          if (bytes > MAX_MCP_CALL_RESULT_BYTES) {
            content = `${truncateUtf8(rawContent, MAX_MCP_CALL_RESULT_BYTES)}\n\n…[truncated: MCP tool result exceeded ${MAX_MCP_CALL_RESULT_BYTES} bytes]`;
            logger.warn?.(
              `MCP tool "${mcpTool.name}" result exceeded I-76 cap (${bytes}B > ${MAX_MCP_CALL_RESULT_BYTES}B); truncated`,
            );
          }

          return {
            content,
            isError: result.isError === true,
          };
        } catch (error) {
          return {
            content: `MCP tool "${mcpTool.name}" failed: ${(error as Error).message}`,
            isError: true,
          };
        }
      },
    };
  });

  return {
    serverName,
    tools,
    async dispose(): Promise<void> {
      disposed = true;
      try {
        await client.close();
        logger.info(`Disconnected from MCP server "${serverName}"`);
      } catch (error) {
        logger.warn?.(
          `Error disconnecting from MCP server "${serverName}":`,
          error,
        );
      }
    },
  };
}
