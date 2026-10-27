/** A human attestation, separate from ordinary permission to invoke a tool. */
export interface McpFilesystemApprovalScope {
  readonly serverName: string;
  readonly toolName: string;
  /** Minted per installed tool object, so replacement cannot reuse consent. */
  readonly toolIdentity: string;
}

export function mcpFilesystemApprovalReason(scope: McpFilesystemApprovalScope): string {
  // The TUI's compact note may truncate this reason. Put the authority the
  // human is granting first, before potentially long server/tool names.
  return "Approve only if you trust this tool to perform no filesystem writes. " +
    `AgenC cannot determine write targets for MCP tool ${JSON.stringify(scope.toolName)} ` +
    `on server ${JSON.stringify(scope.serverName)}. Allow once approves this call; allow for session approves this tool's ` +
    "calls for this session. The current filesystem and network sandbox stays enabled.";
}

/** Pre-dispatch failure: retrying arguments cannot supply trusted authority. */
export class McpFilesystemApprovalRequiredError extends Error {
  constructor(readonly scope: McpFilesystemApprovalScope) {
    super(`MCP tool ${JSON.stringify(scope.toolName)} on server ${JSON.stringify(scope.serverName)} ` +
      "requires a trusted no-filesystem-write declaration or interactive approval. " +
      "No MCP call was sent. In your user config ($AGENC_HOME/config.toml, normally ~/.agenc/config.toml), " +
      "add or update this server table only after auditing the tool:\n" +
      `[mcp_servers.${JSON.stringify(scope.serverName)}]\n` +
      `virtual_no_fs_write_tools = [${JSON.stringify(scope.toolName)}]\n` +
      "Merge this tool into any existing list. Project, plugin, server annotations and model-supplied " +
      "settings cannot grant this authority. Or rerun interactively to approve the tool. " +
      "Do not retry equivalent MCP calls or work around this with shell or filesystem tools.");
    this.name = "McpFilesystemApprovalRequiredError";
  }
}
