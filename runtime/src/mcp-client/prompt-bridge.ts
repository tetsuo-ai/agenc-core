/**
 * MCP prompt bridge.
 *
 * MCP servers can expose server-side *prompts* — parameterized
 * templates the runtime materializes into a user/assistant message
 * pair (or longer chain). This module queries + renders them.
 *
 * As with tools + resources, prompt names are namespaced:
 *   `mcp.<serverName>.<promptName>`.
 *
 * @module
 */

import type { Logger } from "./_deps/logger.js";
import { silentLogger } from "./_deps/logger.js";

const DEFAULT_PROMPT_RPC_TIMEOUT_MS = 30_000;

export interface MCPPromptArgumentSpec {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface MCPPromptDescriptor {
  readonly serverName: string;
  readonly name: string;
  readonly namespacedName: string;
  readonly description?: string;
  readonly arguments?: ReadonlyArray<MCPPromptArgumentSpec>;
}

export interface MCPPromptRenderedMessage {
  readonly role: "user" | "assistant" | "system";
  /** Text payload (when the rendered message is plain text). */
  readonly text?: string;
  /** Raw upstream content blob when not plain text. */
  readonly rawContent?: unknown;
}

export interface MCPPromptRendered {
  readonly promptName: string;
  readonly description?: string;
  readonly messages: ReadonlyArray<MCPPromptRenderedMessage>;
}

export interface MCPPromptBridge {
  readonly serverName: string;
  listPrompts(): Promise<ReadonlyArray<MCPPromptDescriptor>>;
  renderPrompt(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<MCPPromptRendered>;
  dispose(): Promise<void>;
}

interface CreatePromptBridgeOpts {
  readonly rpcTimeoutMs?: number;
}

export async function createPromptBridge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  serverName: string,
  logger: Logger = silentLogger,
  opts: CreatePromptBridgeOpts = {},
): Promise<MCPPromptBridge> {
  const rpcTimeoutMs = opts.rpcTimeoutMs ?? DEFAULT_PROMPT_RPC_TIMEOUT_MS;
  let disposed = false;

  return {
    serverName,
    async listPrompts(): Promise<ReadonlyArray<MCPPromptDescriptor>> {
      if (disposed) return [];
      try {
        const response = await withDeadline<{
          prompts?: Array<{
            name: string;
            description?: string;
            arguments?: Array<{
              name: string;
              description?: string;
              required?: boolean;
            }>;
          }>;
        }>(
          `MCP server "${serverName}" listPrompts`,
          rpcTimeoutMs,
          () => client.listPrompts({}),
        );
        const raw = Array.isArray(response.prompts) ? response.prompts : [];
        return raw.map((p) => {
          const args = Array.isArray(p.arguments)
            ? p.arguments.map((a) => ({
                name: a.name,
                ...(a.description !== undefined
                  ? { description: a.description }
                  : {}),
                ...(a.required !== undefined ? { required: a.required } : {}),
              }))
            : undefined;
          return {
            serverName,
            name: p.name,
            namespacedName: `mcp.${serverName}.${p.name}`,
            ...(p.description !== undefined ? { description: p.description } : {}),
            ...(args !== undefined ? { arguments: args } : {}),
          } satisfies MCPPromptDescriptor;
        });
      } catch (err) {
        logger.warn?.(
          `MCP server "${serverName}" listPrompts failed:`,
          err,
        );
        return [];
      }
    },
    async renderPrompt(
      name: string,
      args?: Record<string, unknown>,
    ): Promise<MCPPromptRendered> {
      if (disposed) {
        throw new Error(
          `MCP prompt bridge for "${serverName}" has been disposed`,
        );
      }
      const response = await withDeadline<{
        description?: string;
        messages?: Array<{
          role: "user" | "assistant" | "system";
          content?: unknown;
        }>;
      }>(
        `MCP server "${serverName}" getPrompt("${name}")`,
        rpcTimeoutMs,
        () =>
          client.getPrompt({
            name,
            ...(args !== undefined ? { arguments: args } : {}),
          }),
      );
      const messages: MCPPromptRenderedMessage[] = (
        Array.isArray(response.messages) ? response.messages : []
      ).map((m) => projectPromptMessage(m.role, m.content));
      return {
        promptName: name,
        ...(response.description !== undefined
          ? { description: response.description }
          : {}),
        messages,
      };
    },
    async dispose(): Promise<void> {
      disposed = true;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function projectPromptMessage(
  role: "user" | "assistant" | "system",
  content: unknown,
): MCPPromptRenderedMessage {
  // MCP prompt content can be an object `{type:'text', text:'...'}` or
  // an array of such blocks. Flatten to a single text field when
  // possible; otherwise return rawContent for the caller.
  if (content == null) return { role };
  if (typeof content === "string") {
    return { role, text: content };
  }
  if (
    typeof content === "object" &&
    "type" in (content as Record<string, unknown>) &&
    (content as { type: string }).type === "text" &&
    typeof (content as { text?: unknown }).text === "string"
  ) {
    return { role, text: (content as { text: string }).text };
  }
  if (Array.isArray(content)) {
    const textParts = content
      .map((c) => {
        if (typeof c === "string") return c;
        if (
          c &&
          typeof c === "object" &&
          "type" in c &&
          (c as { type: string }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string"
        ) {
          return (c as { text: string }).text;
        }
        return null;
      })
      .filter((s): s is string => s !== null);
    if (textParts.length > 0) {
      return { role, text: textParts.join("\n") };
    }
  }
  return { role, rawContent: content };
}

function withDeadline<T>(
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
  return Promise.race([task(), timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
