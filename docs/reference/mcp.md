# MCP (Model Context Protocol)

AgenC speaks MCP in **both directions**:

| Direction | Location | Role |
| --- | --- | --- |
| **Client** (outbound) | `runtime/src/mcp-client/` | Connect to external MCP servers; bridge tools, resources, and prompts into the live registry |
| **Server** (inbound) | `runtime/src/mcp-server/` | Host AgenC as an MCP server for editors / other hosts |

Deep client notes: [`runtime/src/mcp-client/README.md`](../../runtime/src/mcp-client/README.md).

## Outbound client

### Transports

| Transport | Config value | Requirements |
| --- | --- | --- |
| stdio (default) | `stdio` | `command` (+ optional `args`, `cwd`, `env` / `env_vars`) |
| Streamable HTTP | `http` | `endpoint` |
| SSE (legacy) | `sse` | `endpoint` |
| WebSocket | `websocket` or `ws` | `endpoint` |

Optional bearer / custom headers apply on network transports. Stdio owns env
allow-listing, process-group cleanup, and PID-tree teardown.

### Config shape

Servers are configured under `mcp_servers` in config (typed as
`McpServerConfig` in `runtime/src/config/schema.ts`):

```toml
[mcp_servers.docs]
transport = "stdio"
command = "npx"
args = ["-y", "some-mcp-server"]
# enabled = true
# required = false
# timeout = 30000
# default_tools_approval_mode = "ask"
# enabled_tools = ["search"]
# disabled_tools = ["delete"]
```

Network example:

```toml
[mcp_servers.remote]
transport = "http"
endpoint = "https://mcp.example.com/mcp"
# headers = { Authorization = "Bearer …" }
```

Also: daemon method `session.mcp.addServer` (and related enable/disable/reconnect
paths on the dispatcher) for session-scoped server mutations. The public SDK
method registry includes `session.mcp.addServer`; see [`../sdk.md`](../sdk.md).

AgenC can also expose itself as an MCP server via `[mcp.server]`
(`enabled`, `transport` = `stdio` | `sse`, optional `host` / `port`).

### Tool bridge

- Namespaced tool names: `mcp.<serverName>.<toolName>`
- Permission integration via the same arbiter as built-ins
- Result size cap: `MAX_MCP_CALL_RESULT_BYTES` (5 MiB)
- Catalog policy: `enabled_tools` / `disabled_tools` /
  `default_tools_approval_mode` (normalized in the resilient client)
- Dead connections reconnect with exponential backoff
  (`ResilientMCPBridge`, 1 s → 30 s, ×2)
- Optional **supply-chain pin** (SHA-256 over the canonical tool catalog JSON)
  refuses to load if the advertised catalog drifts

Resources (list/read) and prompts (list/render into message pairs) are bridged
similarly, with a 5 MiB per-resource byte cap.

### Model-facing MCP tools

Built-in tools that help the agent work with MCP:

- `MCPTool` / MCP auth helpers
- `ListMcpResourcesTool` / `ReadMcpResourceTool`

Slash: `/mcp` opens the MCP connection menu in the TUI.

### Sampling & roots

Session-owned managers can route `sampling/createMessage` through the active
runtime provider. Sessionless compatibility connections return a graceful
unavailable result. Host roots are advertised per the MCP connection.

## Inbound server

`runtime/src/mcp-server/` hosts the framework, stdio and HTTP/SSE entrypoints,
and tool exposure so external hosts can call into AgenC-shaped tools. Prefer
config `[mcp.server]` and the `agenc mcp` CLI surfaces rather than importing
framework modules from embedders.

## Security notes

- Treat MCP tool results as **untrusted work data** (same framing discipline as
  channel payloads).
- Mutating Solana-like MCP tools still hit the SLM transaction guard when
  metadata marks them Solana + mutating — see
  [`../security/slm-transaction-guard.md`](../security/slm-transaction-guard.md).
- Prefer supply-chain pins for untrusted third-party servers.
- Stdio servers run as your user with the configured env — only pass secrets you
  intend the child to see.

## Related

- Tools / permissions overview: [`tools-permissions-sandbox.md`](tools-permissions-sandbox.md)
- Client README: [`../../runtime/src/mcp-client/README.md`](../../runtime/src/mcp-client/README.md)
- Architecture map: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
