/**
 * Ports OC `src/utils/plugins/mcpPluginIntegration.ts` and CX
 * `core-plugins/src/manager.rs` plugin MCP spawn-path behavior onto
 * AgenC's plugin registration model.
 *
 * Why this lives here:
 *   - Plugin MCP stdio servers are the only plugin surface that spawns
 *     child processes. Keeping cwd containment, reserved env injection,
 *     and isolation metadata in one module makes registration enforce the
 *     same sandbox contract for every plugin server.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Marketplace install, remote sync, and admission policy surfaces are
 *     owned by the plugin marketplace subsystem.
 *   - OS-level seccomp/seatbelt execution is owned by runtime/src/sandbox.
 */

import fs from "node:fs";
import path from "node:path";

import type {
  McpServerConfig,
  PluginMcpSandboxMetadata,
} from "../config/schema.js";
import { getPluginDataDir } from "./directories.js";
import type { LoadedPlugin } from "./loader.js";

export const PLUGIN_MCP_SANDBOX_MODE = "stdio-child-process" as const;

export const RESERVED_PLUGIN_MCP_SANDBOX_ENV_KEYS = Object.freeze([
  "AGENC_PLUGIN_ROOT",
  "AGENC_PLUGIN_DATA",
  "AGENC_PLUGIN_NAME",
  "AGENC_PLUGIN_MCP_SERVER",
  "AGENC_PLUGIN_SANDBOX",
] as const);

export type PluginMcpSandboxIssueCode =
  | "cwd-outside-plugin-root"
  | "cwd-realpath-failed";

export interface PluginMcpSandboxIssue {
  readonly code: PluginMcpSandboxIssueCode;
  readonly message: string;
}

export type PluginMcpSandboxResult =
  | { readonly server: McpServerConfig }
  | { readonly issue: PluginMcpSandboxIssue };

interface RealpathResult {
  readonly status: "ok" | "missing" | "failed";
  readonly path?: string;
  readonly message?: string;
}

function sandboxPath(value: string): string {
  const resolved = path.resolve(value);
  const trimmed = resolved.length > 1 && resolved.endsWith(path.sep)
    ? resolved.slice(0, -1)
    : resolved;
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

export function pathInsideOrEqual(root: string, candidate: string): boolean {
  const normalizedRoot = sandboxPath(root);
  const normalizedCandidate = sandboxPath(candidate);
  return normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function tryRealpath(value: string): RealpathResult {
  try {
    return { status: "ok", path: fs.realpathSync.native(value) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "missing" };
    }
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function realpathContainmentIssue(
  pluginRoot: string,
  cwd: string,
): PluginMcpSandboxIssue | null {
  const realRoot = tryRealpath(pluginRoot);
  if (realRoot.status !== "ok" || realRoot.path === undefined) {
    return {
      code: "cwd-realpath-failed",
      message: `Could not resolve plugin root for sandbox containment: ${realRoot.message ?? pluginRoot}`,
    };
  }

  const realCwd = tryRealpath(cwd);
  if (realCwd.status === "missing") return null;
  if (realCwd.status === "failed" || realCwd.path === undefined) {
    return {
      code: "cwd-realpath-failed",
      message: `Could not resolve plugin MCP working directory for sandbox containment: ${realCwd.message ?? cwd}`,
    };
  }
  if (!pathInsideOrEqual(realRoot.path, realCwd.path)) {
    return {
      code: "cwd-outside-plugin-root",
      message: `Plugin MCP working directory escapes plugin root: ${cwd}`,
    };
  }
  return null;
}

export function isPluginMcpRemoteTransport(
  server: Pick<McpServerConfig, "transport" | "endpoint" | "command">,
): boolean {
  return server.transport === "http" ||
    server.transport === "sse" ||
    server.transport === "websocket" ||
    server.transport === "ws" ||
    (server.command === undefined && server.endpoint !== undefined);
}

export function isPluginMcpStdioChildProcess(
  server: Pick<McpServerConfig, "transport" | "command">,
): boolean {
  return (server.transport === undefined || server.transport === "stdio") &&
    server.command !== undefined;
}

export function pluginMcpSandboxEnvironment(
  plugin: Pick<LoadedPlugin, "name" | "root" | "source">,
  serverName: string,
  dataDir = getPluginDataDir(plugin.source),
): Readonly<Record<(typeof RESERVED_PLUGIN_MCP_SANDBOX_ENV_KEYS)[number], string>> {
  return {
    AGENC_PLUGIN_ROOT: plugin.root,
    AGENC_PLUGIN_DATA: dataDir,
    AGENC_PLUGIN_NAME: plugin.name,
    AGENC_PLUGIN_MCP_SERVER: serverName,
    AGENC_PLUGIN_SANDBOX: PLUGIN_MCP_SANDBOX_MODE,
  };
}

export function createPluginMcpSandboxMetadata(
  plugin: Pick<LoadedPlugin, "name" | "root" | "source">,
  serverName: string,
  scopedServerName: string,
  dataDir = getPluginDataDir(plugin.source),
): PluginMcpSandboxMetadata {
  return {
    mode: PLUGIN_MCP_SANDBOX_MODE,
    pluginName: plugin.name,
    pluginRoot: plugin.root,
    pluginDataDir: dataDir,
    serverName,
    scopedServerName,
  };
}

export function resolvePluginMcpSandboxedServer(
  plugin: Pick<LoadedPlugin, "name" | "root" | "source">,
  serverName: string,
  server: McpServerConfig,
  options: {
    readonly scopedServerName?: string;
    readonly dataDir?: string;
  } = {},
): PluginMcpSandboxResult {
  if (isPluginMcpRemoteTransport(server) || !isPluginMcpStdioChildProcess(server)) {
    return { server: { ...server } };
  }

  const dataDir = options.dataDir ?? getPluginDataDir(plugin.source);
  const scopedServerName = options.scopedServerName ?? `plugin:${plugin.name}:${serverName}`;
  const cwd = path.resolve(server.cwd ?? plugin.root);
  if (!pathInsideOrEqual(plugin.root, cwd)) {
    return {
      issue: {
        code: "cwd-outside-plugin-root",
        message: `Plugin MCP working directory escapes plugin root: ${cwd}`,
      },
    };
  }
  const realpathIssue = realpathContainmentIssue(plugin.root, cwd);
  if (realpathIssue !== null) return { issue: realpathIssue };

  return {
    server: {
      ...server,
      cwd,
      env: {
        ...(server.env ?? {}),
        ...pluginMcpSandboxEnvironment(plugin, serverName, dataDir),
      },
      pluginSandbox: createPluginMcpSandboxMetadata(
        plugin,
        serverName,
        scopedServerName,
        dataDir,
      ),
    },
  };
}
