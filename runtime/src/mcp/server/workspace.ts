/** Shared validation for configured startup, foreground serving and reload. */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export async function resolveMcpServeWorkspace(workspace: string): Promise<string> {
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

export function normalizeMcpSseLoopbackHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed === "127.0.0.1" || trimmed === "localhost" || trimmed === "::1") {
    return trimmed;
  }
  throw new Error("AgenC MCP SSE transport only binds to loopback hosts");
}

