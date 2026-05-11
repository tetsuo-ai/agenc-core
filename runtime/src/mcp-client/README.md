# mcp-client

Manages AgenC's outbound connections to external Model Context Protocol (MCP)
servers. Each connected server is exposed to the runtime as a unified
**tool bridge**, **resource bridge**, and **prompt bridge** that the
`ToolRegistry`, resource resolver, and prompt-template machinery can consume
without knowing the underlying transport.

## Purpose

- Drive the full MCP connection lifecycle (start, list, reconnect, shutdown)
  for one or many configured servers.
- Bridge MCP **tools** into runtime `Tool` instances with namespaced names
  (`mcp.<serverName>.<toolName>`), permission integration, and supply-chain
  pinning.
- Bridge MCP **resources** (read-only content: files, blobs, logs) with a
  per-read byte cap (I-76, see `resources.ts`).
- Bridge MCP **prompts** (parameterized server-side templates) into
  user/assistant message pairs.
- Detect dead connections on tool calls and reconnect with exponential
  backoff via `ResilientMCPBridge`.

## Origin and lineage

The connection-lifecycle and tool-bridge shape (manager, connection, tool
bridge, resilient client) follows the openclaude `src/services/mcp/` design: <!-- branding-scan: allow upstream lineage citation -->
a manager orchestrates many client connections, each client is created from a
typed server config, and a thin bridge layer adapts MCP RPC calls into the
runtime's tool/resource/prompt vocabulary.

AgenC diverges from this donor in transport organisation. The donor inlines
every transport (stdio, SSE, Streamable HTTP, WebSocket) in a single
`client.ts` and dispatches inside one factory. AgenC factors each transport
into its own module under `transports/` so that:

- Daemon-side stdio process management (env scrubbing, process-group cleanup,
  PID-tree teardown) stays self-contained and does not crowd network
  transports.
- Network transports (`sse`, `http`, `websocket`) can evolve independently
  and be unit-tested in isolation.
- `connection.ts` becomes a thin dispatch table that selects the correct
  transport factory from `config.transport`.

Per-directory dependency carving lives in `_deps/`: `Logger` /
`silentLogger` and the minimal duck-typed `Tool` / `ToolResult` /
`JSONSchema` shapes are re-exported there so this subsystem does not pull
the full reference `utils/logger.ts` or `tools/types.ts` surface area.

## AgenC extensions

`transports/` is AgenC-original layout. The transports themselves wrap the
upstream `@modelcontextprotocol/sdk` client transports plus the `ws` package,
but the split-per-file shape is not present in the donor.

| Transport     | File                          | Why AgenC needs it                                                                                                |
| ------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `stdio`       | `transports/stdio.ts`         | Default for locally-spawned MCP servers used by the daemon. Owns env-var allow-listing, `cwd`/`env` handling, and process-group termination so stale child trees do not leak after disconnect. |
| `sse`         | `transports/sse.ts`           | Compatibility transport for MCP servers that still speak Server-Sent Events (pre Streamable HTTP). Optional bearer / custom headers on the initial GET. |
| `http`        | `transports/http.ts`          | Spec-current **Streamable HTTP** transport. Multiplexes request/response pairs over a single long-poll or streaming HTTP connection — preferred for remote MCP servers. |
| `websocket`   | `transports/websocket.ts`     | First-class WebSocket transport (subprotocol `mcp`) for remote MCP servers that prefer a bidirectional socket. Includes graceful-close handling (`WEBSOCKET_CLOSE_WAIT_MS`). |

The dispatcher in `connection.ts` accepts `transport ∈ {"stdio" (default),
"sse", "http", "websocket", "ws"}` and delegates to the matching factory.
`stdio` requires `command`; the other three require `endpoint`.

## File map

Top-level entries under `runtime/src/mcp-client/`:

| Path                             | Role                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `manager.ts`                     | Multi-server connection manager. Drives startup (I-50 cancellable wait, I-20 required-server gates), per-server reconnect, tool/resource/prompt bridge aggregation, and `MCPConnectionState` tracking. |
| `connection.ts`                  | Transport dispatcher. Reads `config.transport` and delegates to the right `transports/<x>.ts` factory; the single import surface used by `manager.ts` and tests. |
| `tools.ts`                       | MCP→runtime `Tool` bridge. Namespaces tool names, attaches permission metadata (`MCPToolBridgePermissionOptions`), supports tool-catalog policy (`allowed`/`denied`/`default_tools_approval_mode`), and routes calls through the permissions arbiter. |
| `resources.ts`                   | MCP→runtime resource bridge. Lists/reads server resources with `MAX_RESOURCE_BYTES = 5 MiB` (I-76) and surfaces both namespaced and raw upstream URIs. |
| `prompts.ts`                     | MCP→runtime prompt-template bridge. Lists prompts, materializes them into message chains, applies a default 30 s RPC timeout. |
| `resilient-client.ts`            | `ResilientMCPBridge` wrapper that detects connection-error patterns on tool calls (epipe, channel closed, process exited, …) and reconnects with exponential backoff (1 s → 30 s, ×2). |
| `supply-chain.ts`                | I-74: SHA-256 pin over the canonical JSON of an MCP server's tool catalog. Refuses to load the bridge if the advertised catalog drifts from the pin. |
| `tui-connections.ts`             | Projects an `McpManagerLike` into the `MCPServerConnection[]` shape the TUI consumes for connection-status rendering. |
| `types.ts`                       | `MCPServerConfig`, `MCPToolBridge`, `MCPElicitationHandlers`, `MCPReconnectResult`, `MCPServerMutationResult`. The config shape covers all four transports. |
| `transports/`                    | Per-transport factories (stdio / sse / http / websocket). See table above. |
| `_deps/`                         | Per-directory dependency carving: minimal `Logger` and `Tool`/`ToolResult`/`JSONSchema` surfaces re-exported here to keep this subsystem isolated from broader reference modules. |
| `test-fixtures/`                 | Helper MCP servers for tests (e.g. `stdio-pid-server.cjs` exercised by `manager.stdio-lifecycle.test.ts`). |
| `*.test.ts`                      | Unit tests for each module (connection, manager, tools, resources, prompts, resilient client, supply chain, tui-connections, plus per-transport stdio + websocket tests). |

## Consumption

Consumers should treat `manager.ts` (and its `MCPManagerStartOpts`) as the
public entry point. Direct transport-factory calls are reserved for tests
and for `connection.ts` itself; everything else flows through the manager so
permission integration, reconnect, and supply-chain checks apply uniformly.
