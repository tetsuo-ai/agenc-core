/**
 * Bearer token of the inbound MCP SSE server.
 *
 * The server listens on a loopback TCP port, which every local process and
 * user can reach, so the token is the only thing that keeps the workspace's
 * memory and instruction files from them. It is resolved the way the gateway
 * resolves its WebChat and hooks tokens, through the same code: an explicit
 * environment value of at least 16 characters wins; otherwise one token is
 * generated and kept in the home-bound native secure storage. It never goes
 * into config.toml, a log, a session file, or a daemon status or reload
 * payload.
 */

import type { HomeContext } from "../../config/home.js";
import {
  resolveGeneratedSurfaceToken,
  type GeneratedSurfaceTokenSlot,
} from "../../utils/secureStorage/generatedToken.js";

export const MCP_SERVER_TOKEN_ENV = "AGENC_MCP_SERVER_TOKEN";

const MCP_SERVER_TOKEN_SLOT: GeneratedSurfaceTokenSlot = {
  read: (current) => current.mcpServer?.token,
  write: (current, token) => ({
    ...current,
    mcpServer: { ...current.mcpServer, token },
  }),
  unavailableMessage:
    "native secure storage could not keep a generated token",
};

/**
 * Resolve the token an SSE server bound to this home accepts. Throws, naming
 * the environment variable, when neither source can supply one: there is no
 * unauthenticated fallback.
 */
export function resolveMcpServerToken(
  home: HomeContext,
  environmentValue: string | undefined,
): string {
  try {
    return resolveGeneratedSurfaceToken(
      home,
      MCP_SERVER_TOKEN_SLOT,
      environmentValue,
    );
  } catch (error) {
    throw new Error(
      `MCP SSE server has no bearer token: set ${MCP_SERVER_TOKEN_ENV} to at ` +
        "least 16 characters, or make native secure storage available " +
        `(${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
}
